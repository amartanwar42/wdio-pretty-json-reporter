import WDIOReporter, { RunnerStats, SuiteStats, TestStats, HookStats } from '@wdio/reporter';
import type { Reporters } from '@wdio/types';
import * as fs from 'fs';
import * as path from 'path';
import type {
  CtrfReport,
  CtrfTest,
  CtrfHook,
  CtrfRetry,
  CtrfEnvironment,
  CtrfLogEntry,
  CtrfAttachment,
  CtrfSuite,
} from './types';
import * as shared from './shared-state';

export interface CtrfReporterOptions extends Reporters.Options {
  outputDir?: string;
  outputFile?: string;
  logLevel?: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'silent';
  captureLogs?: boolean;
  environment?: Partial<CtrfEnvironment>;
  tags?: string[];
  testType?: string;
  metadata?: Record<string, unknown>;
  transformTest?: (test: CtrfTest) => CtrfTest | null;
  onComplete?: (report: CtrfReport, outputPath: string) => void | Promise<void>;
}

interface InternalTestState {
  ctrfTest: CtrfTest;
  logs: CtrfLogEntry[];
  hooks: CtrfHook[];
  retries: CtrfRetry[];
  currentAttempt: number;
  attemptLogs: CtrfLogEntry[];
  attemptStartTime: number;
}

interface InternalSuiteState {
  hooks: CtrfHook[];
  globalHooks: CtrfHook[]; // before all / after all
  globalHookLogs: CtrfLogEntry[]; // logs from global hooks
}

const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'silent'] as const;
type LogLevel = (typeof LOG_LEVELS)[number];

export default class CtrfReporter extends WDIOReporter {
  private opts: Required<Pick<CtrfReporterOptions,
    'outputDir' | 'outputFile' | 'logLevel' | 'captureLogs' | 'tags' | 'testType' | 'metadata'
  >> & Pick<CtrfReporterOptions, 'environment' | 'transformTest' | 'onComplete'> & {
    includeHooks: true;
    includeRetries: true;
    markFlaky: true;
    structureByHooks: true;
    captureGlobalHookLogs: true;
  };

  private report: CtrfReport;
  private testMap = new Map<string, InternalTestState>();
  private suiteMap = new Map<string, InternalSuiteState>();
  private suiteCount = 0;
  private currentSuite = '';
  private currentSpecFile = '';
  private runnerStartTime = 0;
  private runnerEndTime = 0;
  private globalAttachments: CtrfAttachment[] = [];
  private currentGlobalHookBeingProcessed: CtrfHook | null = null;
  private pendingBeforeEachHooks: CtrfHook[] = [];
  private lastStartedTestState: InternalTestState | null = null;

  constructor(options: CtrfReporterOptions) {
    super(options);
    this.opts = {
      outputDir: options.outputDir ?? './ctrf',
      outputFile: options.outputFile ?? 'wdio-ctrf-report.json',
      logLevel: options.logLevel ?? 'info',
      captureLogs: options.captureLogs ?? true,
      tags: options.tags ?? [],
      testType: options.testType ?? 'e2e',
      metadata: options.metadata ?? {},
      includeHooks: true,
      includeRetries: true,
      markFlaky: true,
      structureByHooks: true,
      captureGlobalHookLogs: true,
      environment: options.environment ?? {},
      transformTest: options.transformTest,
      onComplete: options.onComplete,
    };
    this.report = this.createEmptyReport();
  }

  onRunnerStart(runner: RunnerStats): void {
    this.runnerStartTime = Date.now();
    this.currentSpecFile = runner.specs?.[0] ?? '';
    shared.clearAll();

    this.report.tool = {
      name: 'wdio-appium-mocha-ts',
      version: runner.config?.framework ?? 'unknown',
    };

    const caps = runner.capabilities as Record<string, unknown> | undefined;
    if (caps) {
      this.report.environment = {
        platformName: this.getCap(caps, 'platformName', 'platform') ?? 'unknown',
        platformVersion: this.getCap(caps, 'platformVersion', 'os_version') ?? 'unknown',
        deviceName: this.getCap(caps, 'deviceName', 'appium:deviceName', 'wdio:deviceName') ?? 'unknown',
        browser: this.getCap(caps, 'browserName', 'appium:browserName') ?? 'unknown',
        browserVersion: this.getCap(caps, 'browserVersion', 'version') ?? 'unknown',
        appName: this.getCap(caps, 'appium:app', 'app') ?? undefined,
        ...this.opts.environment,
      };
    }

    this.log('trace', `Runner started: ${runner.cid}`);
  }

  onSuiteStart(suite: SuiteStats): void {
    this.currentSuite = suite.title;
    const state: InternalSuiteState = { 
      hooks: [],
      globalHooks: [],
      globalHookLogs: [],
    };
    this.suiteMap.set(suite.uid, state);
    this.suiteMap.set(suite.title, state);
    this.suiteCount += 1;
    this.log('trace', `Suite started: ${suite.title}`);
  }

  onTestStart(test: TestStats): void {
    const key = this.getTestKey(test);
    const now = Date.now();

    if (this.testMap.has(key)) {
      const state = this.testMap.get(key)!;
      this.saveRetryAttempt(state, now);
      state.currentAttempt += 1;
      state.attemptLogs = [];
      state.attemptStartTime = now;
    } else {
      this.createTestState(test, now);
    }

    this.attachPendingHooks(this.testMap.get(key)!);

    this.log('trace', `Test started: ${test.title} (attempt ${this.testMap.get(key)!.currentAttempt})`);
  }

  /** Assigns the beforeEach hooks that ran immediately before this test and
   *  marks it as the target for the afterEach hooks that follow. */
  private attachPendingHooks(state: InternalTestState): void {
    if (this.pendingBeforeEachHooks.length > 0) {
      state.hooks.push(...this.pendingBeforeEachHooks);
      this.pendingBeforeEachHooks = [];
    }
    this.lastStartedTestState = state;
  }

  private createTestState(test: TestStats, now: number): InternalTestState {
    const key = this.getTestKey(test);
    const ctrfTest: CtrfTest = {
      name: test.title,
      status: 'other',
      duration: 0,
      start: now,
      stop: now,
      suite: this.currentSuite,
      filepath: this.currentSpecFile,
      tags: [...this.opts.tags],
      type: this.opts.testType,
      retries: 0,
      flaky: false,
      metadata: { ...this.opts.metadata },
      ...this.extractDeviceInfo(),
    };

    const state: InternalTestState = {
      ctrfTest,
      logs: [],
      hooks: [],
      retries: [],
      currentAttempt: 1,
      attemptLogs: [],
      attemptStartTime: now,
    };
    this.testMap.set(key, state);
    return state;
  }

  onTestPass(test: TestStats): void {
    this.finalizeTest(test, 'passed');
    this.log('info', `PASSED: ${test.title}`);
  }

  onTestFail(test: TestStats): void {
    this.finalizeTest(test, 'failed');
    this.log('error', `FAILED: ${test.title}`);
    if (test.error?.message) {
      this.log('error', `  Error: ${test.error.message}`);
    }
  }

  onTestSkip(test: TestStats): void {
    this.finalizeTest(test, 'skipped');
    this.log('warn', `SKIPPED: ${test.title}`);
  }

  onTestEnd(test: TestStats): void {
    const key = this.getTestKey(test);
    const state = this.testMap.get(key);
    if (!state) return;

    if (state.ctrfTest.status === 'other') {
      state.ctrfTest.status = this.mapWdioStateToCtrf(test.state, Boolean(test.error));
      state.ctrfTest.rawStatus = test.state ?? state.ctrfTest.status;
      if (test.error) {
        state.ctrfTest.message = test.error.message;
        state.ctrfTest.trace = test.error.stack;
      }
    }

    const now = Date.now();
    state.ctrfTest.stop = now;
    state.ctrfTest.duration = now - state.ctrfTest.start;

    const sharedData = shared.pullTestData(this.currentSuite, test.title);
    if (sharedData.attachments.length > 0) {
      const normalizedAttachments = sharedData.attachments.map((attachment) => {
        if (!attachment.path) return attachment;
        if (path.isAbsolute(attachment.path)) return attachment;
        return { ...attachment, path: path.resolve(attachment.path) };
      });

      const screenshotAttachments = normalizedAttachments.filter((attachment) => attachment.category === 'screenshot');
      const nonScreenshotAttachments = normalizedAttachments.filter((attachment) => attachment.category !== 'screenshot');

      if (screenshotAttachments.length > 0) {
        state.ctrfTest.attachments = [...(state.ctrfTest.attachments ?? []), ...screenshotAttachments];
      }
      if (nonScreenshotAttachments.length > 0) {
        this.globalAttachments.push(...nonScreenshotAttachments);
      }
    }

    if (sharedData.logs.length > 0) {
      state.logs.push(...sharedData.logs);
      state.attemptLogs.push(...sharedData.logs);
    }

    if (this.opts.captureLogs) {
      const allLogs = [...state.logs];
      state.ctrfTest.logs = allLogs.length > 0 ? allLogs : undefined;
    }
  }

  onHookStart(hook: HookStats): void {
    if (!this.opts.includeHooks) return;
    const hookData: CtrfHook = {
      type: this.classifyHook(hook.title),
      title: hook.title,
      status: 'pending',
      duration: 0,
      start: Date.now(),
      stop: Date.now(),
    };
    
    // Global (before/after all) hooks are tracked at the suite level.
    // Test-level (beforeEach/afterEach) hooks are attributed to individual
    // tests in onHookEnd to avoid accumulating across the whole suite.
    if (hookData.type === 'before' || hookData.type === 'after') {
      const suiteState = this.suiteMap.get(hook.parent) ?? this.suiteMap.get(this.currentSuite);
      if (suiteState) {
        suiteState.globalHooks.push(hookData);
      }
      this.currentGlobalHookBeingProcessed = hookData; // Track for log capture

      if (this.opts.captureGlobalHookLogs) {
        shared.setActiveGlobalHook(this.currentSuite, hookData.title);
      }
    }
    
    (hook as unknown as Record<string, unknown>)._ctrfHook = hookData;
  }

  onHookEnd(hook: HookStats): void {
    if (!this.opts.includeHooks) return;
    const ctrfHook = (hook as unknown as Record<string, unknown>)._ctrfHook as CtrfHook | undefined;
    if (ctrfHook) {
      ctrfHook.stop = Date.now();
      ctrfHook.duration = ctrfHook.stop - ctrfHook.start;

      // WDIO surfaces hook failures inconsistently: sometimes via `error`,
      // sometimes via an `errors[]` array, and sometimes only via `state`.
      const hookRecord = hook as unknown as Record<string, unknown>;
      const errorList = hookRecord.errors;
      const hookError = hook.error
        ?? (Array.isArray(errorList) && errorList.length > 0 ? (errorList[0] as Error) : undefined);
      const hookFailed = Boolean(hookError) || hookRecord.state === 'failed';

      ctrfHook.status = hookFailed ? 'failed' : 'passed';
      if (hookError) {
        ctrfHook.message = hookError.message;
        ctrfHook.trace = hookError.stack;
        ctrfHook.logs = [{
          timestamp: ctrfHook.stop,
          level: 'error',
          message: hookError.message,
        }];
      }
      
      // Capture logs + attachments (e.g. failure screenshots) from global hooks
      if (this.opts.captureGlobalHookLogs && (ctrfHook.type === 'before' || ctrfHook.type === 'after')) {
        const clearResult = shared.clearActiveGlobalHook();
        if (clearResult) {
          if (clearResult.logs.length > 0 && ctrfHook.logs === undefined) {
            ctrfHook.logs = clearResult.logs;
          }
          if (clearResult.attachments.length > 0) {
            const normalized = clearResult.attachments.map((att) =>
              att.path && !path.isAbsolute(att.path) ? { ...att, path: path.resolve(att.path) } : att
            );
            ctrfHook.attachments = [...(ctrfHook.attachments ?? []), ...normalized];
          }
        }
      } else if (ctrfHook.type === 'beforeEach') {
        // Attribute to the next test that starts.
        this.pendingBeforeEachHooks.push(ctrfHook);
      } else if (ctrfHook.type === 'afterEach') {
        // Attribute to the test that just ran.
        if (this.lastStartedTestState) {
          this.lastStartedTestState.hooks.push(ctrfHook);
        } else {
          this.pendingBeforeEachHooks.push(ctrfHook);
        }
      }
      
      // Clear the current global hook reference after processing
      if (this.currentGlobalHookBeingProcessed === ctrfHook) {
        this.currentGlobalHookBeingProcessed = null;
      }
    }
  }

  onRunnerEnd(_runner: RunnerStats): void {
    this.runnerEndTime = Date.now();
    this.buildReport();
    this.writeReport();
  }

  private createEmptyReport(): CtrfReport {
    return {
      version: '1.0',
      tool: { name: 'wdio-appium-mocha-ts', version: 'unknown' },
      summary: {
        tests: 0,
        passed: 0,
        failed: 0,
        pending: 0,
        skipped: 0,
        other: 0,
        start: 0,
        stop: 0,
      },
      tests: [],
      environment: {},
    };
  }

  private getTestKey(test: TestStats): string {
    const suite = test.parent ?? this.currentSuite;
    const file = this.currentSpecFile;
    return `${file}::${suite}::${test.title}`;
  }

  private saveRetryAttempt(state: InternalTestState, now: number): void {
    if (!this.opts.includeRetries) return;
    state.retries.push({
      attempt: state.currentAttempt,
      status: state.ctrfTest.status === 'other' ? 'failed' : state.ctrfTest.status,
      duration: now - state.attemptStartTime,
      start: state.attemptStartTime,
      stop: now,
      message: state.ctrfTest.message,
      trace: state.ctrfTest.trace,
      logs: state.attemptLogs.length > 0 ? [...state.attemptLogs] : undefined,
    });
  }

  private finalizeTest(test: TestStats, status: CtrfTest['status']): void {
    const key = this.getTestKey(test);
    // Tests skipped via `it.skip` / `this.skip()` never fire onTestStart,
    // so create their state here to ensure they appear in the report.
    let state = this.testMap.get(key);
    if (!state) {
      state = this.createTestState(test, Date.now());
      this.attachPendingHooks(state);
    }

    const now = Date.now();
    state.ctrfTest.status = status;
    state.ctrfTest.stop = now;
    state.ctrfTest.duration = now - state.ctrfTest.start;
    state.ctrfTest.rawStatus = test.state ?? status;

    if (test.error) {
      state.ctrfTest.message = test.error.message;
      state.ctrfTest.trace = test.error.stack;
    }

    state.ctrfTest.retries = state.currentAttempt - 1;

    if (this.opts.markFlaky && status === 'passed' && state.currentAttempt > 1) {
      state.ctrfTest.flaky = true;
    }

    if (this.opts.includeRetries) {
      state.ctrfTest.retriesDetail = [...state.retries];
    }
  }

  private buildReport(): void {
    const tests: CtrfTest[] = [];
    let passed = 0;
    let failed = 0;
    let pending = 0;
    let skipped = 0;
    let other = 0;
    let flaky = 0;

    for (const state of this.testMap.values()) {
      if (this.opts.includeHooks) {
        state.ctrfTest.hooks = state.hooks.length > 0 ? [...state.hooks] : undefined;
      }

      let test = state.ctrfTest;

      if (test.status === 'other' && test.duration === 0 && !test.message && !test.trace) {
        test = { ...test, status: 'skipped', rawStatus: test.rawStatus ?? 'skipped' };
      }

      if (this.opts.transformTest) {
        const transformed = this.opts.transformTest(test);
        if (transformed === null) continue;
        test = transformed;
      }

      tests.push(test);
      switch (test.status) {
        case 'passed':
          passed += 1;
          if (test.flaky) flaky += 1;
          break;
        case 'failed':
          failed += 1;
          break;
        case 'pending':
          pending += 1;
          break;
        case 'skipped':
          skipped += 1;
          break;
        default:
          other += 1;
          break;
      }
    }

    this.report.summary = {
      tests: tests.length,
      passed,
      failed,
      pending,
      skipped,
      other,
      start: this.runnerStartTime,
      stop: this.runnerEndTime,
      duration: this.runnerEndTime - this.runnerStartTime,
      suites: this.suiteCount,
      flaky,
    };
    
    // Build hierarchical structure if structureByHooks is enabled
    if (this.opts.structureByHooks) {
      this.report.suite = this.buildSuiteHierarchy(tests);
      delete this.report.tests;
    } else {
      this.report.tests = tests;
    }
    
    // Merge per-test global attachments with session-level attachments
    // (e.g. appium.log) captured by the service, de-duplicating by content.
    const sessionAttachments = shared.pullGlobalAttachments().map((att) => this.normalizeAttachment(att));
    const combinedAttachments = this.dedupeAttachments([...this.globalAttachments, ...sessionAttachments]);
    this.report.attachments = combinedAttachments.length > 0 ? combinedAttachments : undefined;
  }

  private normalizeAttachment(att: CtrfAttachment): CtrfAttachment {
    if (att.path && !path.isAbsolute(att.path)) {
      return { ...att, path: path.resolve(att.path) };
    }
    return att;
  }

  private dedupeAttachments(attachments: CtrfAttachment[]): CtrfAttachment[] {
    const seen = new Set<string>();
    const result: CtrfAttachment[] = [];
    for (const att of attachments) {
      const key = `${att.category}|${att.path ?? att.content ?? att.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(att);
    }
    return result;
  }

  private buildSuiteHierarchy(tests: CtrfTest[]): CtrfSuite[] {
    // Group tests by suite and filepath
    const suiteHierarchyMap = new Map<string, { suite: CtrfSuite; tests: CtrfTest[] }>();
    
    for (const test of tests) {
      const suite = test.suite ?? 'default';
      const filepath = test.filepath ?? 'unknown';
      const key = `${filepath}::${suite}`;
      
      if (!suiteHierarchyMap.has(key)) {
        const suiteState = this.suiteMap.get(suite);
        const ctrfSuite: CtrfSuite = {
          name: suite,
          filepath,
          tests: [],
        };
        
        // Add global hooks if present
        if (this.opts.includeHooks && suiteState && suiteState.globalHooks.length > 0) {
          for (const globalHook of suiteState.globalHooks) {
            const hookResult = shared.takeHookResult(globalHook.type ?? 'unknown');
            if (!hookResult) continue;
            if (hookResult.failed) {
              globalHook.status = 'failed';
              if (hookResult.message && !globalHook.message) globalHook.message = hookResult.message;
              if (hookResult.trace && !globalHook.trace) globalHook.trace = hookResult.trace;
            }
            if (hookResult.attachments.length > 0) {
              const normalized = hookResult.attachments.map((att) => this.normalizeAttachment(att));
              globalHook.attachments = [...(globalHook.attachments ?? []), ...normalized];
            }
          }
          ctrfSuite.globalHooks = suiteState.globalHooks;
        }
        
        suiteHierarchyMap.set(key, { suite: ctrfSuite, tests: [] });
      }
      
      suiteHierarchyMap.get(key)!.tests.push(test);
    }
    
    // Convert to array with tests assigned
    const suites: CtrfSuite[] = [];
    for (const { suite, tests: suiteTests } of suiteHierarchyMap.values()) {
      suite.tests = suiteTests;
      suites.push(suite);
    }
    
    return suites;
  }

  private writeReport(): void {
    const outputDir = path.resolve(this.opts.outputDir);
    const outputPath = path.join(outputDir, this.opts.outputFile);
    try {
      if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(outputPath, JSON.stringify(this.report, null, 2), 'utf-8');
      this.log('info', `CTRF report written to: ${outputPath}`);
      if (this.opts.onComplete) {
        Promise.resolve(this.opts.onComplete(this.report, outputPath)).catch((err) => {
          this.log('error', `onComplete error: ${(err as Error).message}`);
        });
      }
    } catch (err) {
      this.log('error', `Failed to write report: ${(err as Error).message}`);
      throw err;
    }
  }

  private getCap(caps: Record<string, unknown>, ...keys: string[]): string | undefined {
    for (const key of keys) {
      if (caps[key] !== undefined && caps[key] !== null) return String(caps[key]);
    }
    return undefined;
  }

  private extractDeviceInfo(): Pick<CtrfTest, 'platform' | 'device' | 'browser' | 'appVersion'> {
    const env = this.report.environment;
    return {
      platform: env?.platformName,
      device: env?.deviceName,
      browser: env?.browser,
      appVersion: env?.appVersion,
    };
  }

  private classifyHook(title: string): CtrfHook['type'] {
    const lower = title.toLowerCase();
    if (lower.includes('before each') || lower.includes('beforeeach')) return 'beforeEach';
    if (lower.includes('after each') || lower.includes('aftereach')) return 'afterEach';
    if (lower.includes('before all') || lower.includes('beforeall')) return 'before';
    if (lower.includes('after all') || lower.includes('afterall')) return 'after';
    if (lower.includes('before')) return 'before';
    if (lower.includes('after')) return 'after';
    return 'unknown';
  }

  private mapWdioStateToCtrf(state: string | undefined, hasError: boolean): CtrfTest['status'] {
    const normalized = (state ?? '').toLowerCase();
    if (normalized === 'pass' || normalized === 'passed') return 'passed';
    if (normalized === 'fail' || normalized === 'failed') return 'failed';
    if (normalized === 'skip' || normalized === 'skipped') return 'skipped';
    if (normalized === 'pending') return 'skipped';
    return hasError ? 'failed' : 'other';
  }

  private shouldLog(level: string): boolean {
    const configIdx = LOG_LEVELS.indexOf(this.opts.logLevel as LogLevel);
    const msgIdx = LOG_LEVELS.indexOf(level.toLowerCase() as LogLevel);
    return msgIdx >= configIdx && configIdx < LOG_LEVELS.indexOf('silent');
  }

  private log(level: string, message: string): void {
    if (!this.shouldLog(level)) return;
    // eslint-disable-next-line no-console
    console.log(`[CTRFReporter] [${level.toUpperCase()}] ${message}`);
  }
}
