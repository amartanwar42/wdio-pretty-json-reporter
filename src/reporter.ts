import WDIOReporter, { RunnerStats, SuiteStats, TestStats, HookStats, BeforeCommandArgs } from '@wdio/reporter';
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
  outputFileStrategy?: 'unique' | 'static';
  logLevel?: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'silent';
  captureLogs?: boolean;
  /** Automatically log meaningful WebDriver/Appium commands (click, setValue,
   * navigation, etc.) as they happen. Sensitive input values are never logged. */
  captureCommands?: boolean;
  environment?: Partial<CtrfEnvironment>;
  tags?: string[];
  testType?: string;
  metadata?: Record<string, unknown>;
  transformTest?: ((test: CtrfTest) => CtrfTest | null) | undefined;
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

interface WorkerState {
  report: CtrfReport;
  testMap: Map<string, InternalTestState>;
  suiteMap: Map<string, InternalSuiteState>;
  suiteCount: number;
  currentSuite: string;
  currentSpecFile: string;
  runnerCid: string;
  runnerStartTime: number;
  runnerEndTime: number;
  globalAttachments: CtrfAttachment[];
  currentGlobalHookBeingProcessed: CtrfHook | null;
  pendingBeforeEachHooks: CtrfHook[];
  lastStartedTestState: InternalTestState | null;
  activeSink: ((entry: CtrfLogEntry) => void) | null;
}

const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'silent'] as const;
type LogLevel = (typeof LOG_LEVELS)[number];

export default class CtrfReporter extends WDIOReporter {
private opts = {} as {
  outputDir: string;
  outputFile: string;
  outputFileStrategy: 'unique' | 'static';
  logLevel: LogLevel;
  captureLogs: boolean;
  captureCommands: boolean;
  environment: Partial<CtrfEnvironment>;
  tags: string[];
  testType: string;
  metadata: Record<string, unknown>;

  includeHooks: true;
  includeRetries: true;
  markFlaky: true;
  structureByHooks: true;
  captureGlobalHookLogs: true;

  transformTest?: (test: CtrfTest) => CtrfTest | null;
  onComplete?: (report: CtrfReport, outputPath: string) => void | Promise<void>;
};


  private workerStates = new Map<string, WorkerState>();

  constructor(options: CtrfReporterOptions) {
    super(options);
    this.opts = {
      outputDir: options.outputDir ?? './ctrf',
      outputFile: options.outputFile ?? 'wdio-ctrf-report.json',
      outputFileStrategy: options.outputFileStrategy ?? 'unique',
      logLevel: options.logLevel ?? 'info',
      captureLogs: options.captureLogs ?? true,
      captureCommands: options.captureCommands ?? true,
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
  }

  private getWorkerState(cid: string): WorkerState {
    if (!this.workerStates.has(cid)) {
      this.workerStates.set(cid, this.createWorkerState());
    }
    return this.workerStates.get(cid)!;
  }

  private createWorkerState(): WorkerState {
    return {
      report: this.createEmptyReport(),
      testMap: new Map(),
      suiteMap: new Map(),
      suiteCount: 0,
      currentSuite: '',
      currentSpecFile: '',
      runnerCid: '',
      runnerStartTime: 0,
      runnerEndTime: 0,
      globalAttachments: [],
      currentGlobalHookBeingProcessed: null,
      pendingBeforeEachHooks: [],
      lastStartedTestState: null,
      activeSink: null,
    };
  }

  onRunnerStart(runner: RunnerStats): void {
    const cid = runner.cid ?? '';
    const ws = this.getWorkerState(cid);
    ws.runnerStartTime = Date.now();
    ws.currentSpecFile = runner.specs?.[0] ?? '';
    ws.runnerCid = cid;
    shared.clearAll(cid);

    ws.report.tool = {
      name: 'wdio-appium-mocha-ts',
      version: runner.config?.framework ?? 'unknown',
    };

    const caps = runner.capabilities as Record<string, unknown> | undefined;
    if (caps) {
      ws.report.environment = {
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
    const cid = suite.cid ?? '';
    const ws = this.getWorkerState(cid);
    ws.currentSuite = suite.title;
    this.routeLogsTo(null, cid);
    const state: InternalSuiteState = {
      hooks: [],
      globalHooks: [],
      globalHookLogs: [],
    };
    ws.suiteMap.set(suite.uid, state);
    ws.suiteMap.set(suite.title, state);
    ws.suiteCount += 1;
    this.log('trace', `Suite started: ${suite.title} (cid=${cid})`);
  }

  onTestStart(test: TestStats): void {
    const cid = test.cid ?? '';
    const ws = this.getWorkerState(cid);
    const key = this.getTestKey(test, ws.currentSpecFile, ws.currentSuite);
    const now = Date.now();

    if (ws.testMap.has(key)) {
      const state = ws.testMap.get(key)!;
      this.saveRetryAttempt(state, now);
      state.currentAttempt += 1;
      state.attemptLogs = [];
      state.attemptStartTime = now;
    } else {
      this.createTestState(test, now, ws);
    }

    this.attachPendingHooks(ws.testMap.get(key)!, ws);

    // The reporter owns log attribution: route logs emitted during this test
    // body directly into the test's state, independent of the service.
    if (this.opts.captureLogs) {
      const state = ws.testMap.get(key)!;
      this.routeLogsTo((entry) => {
        state.logs.push(entry);
        state.attemptLogs.push(entry);
      }, cid);
    }

    this.log('trace', `Test started: ${test.title} (attempt ${ws.testMap.get(key)!.currentAttempt}, cid=${cid})`);
  }

  /** Assigns the beforeEach hooks that ran immediately before this test and
   * marks it as the target for the afterEach hooks that follow. */
  private attachPendingHooks(state: InternalTestState, ws: WorkerState): void {
    if (ws.pendingBeforeEachHooks.length > 0) {
      state.hooks.push(...ws.pendingBeforeEachHooks);
      ws.pendingBeforeEachHooks = [];
    }
    ws.lastStartedTestState = state;
  }

  private createTestState(test: TestStats, now: number, ws: WorkerState): InternalTestState {
    const key = this.getTestKey(test, ws.currentSpecFile, ws.currentSuite);
    const ctrfTest: CtrfTest = {
      name: test.title,
      status: 'other',
      duration: 0,
      start: now,
      stop: now,
      suite: ws.currentSuite,
      filepath: ws.currentSpecFile,
      tags: [...this.opts.tags],
      type: this.opts.testType,
      retries: 0,
      flaky: false,
      metadata: { ...this.opts.metadata },
      ...this.extractDeviceInfo(ws),
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
    ws.testMap.set(key, state);
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
    const cid = test.cid ?? '';
    const ws = this.getWorkerState(cid);
    const key = this.getTestKey(test, ws.currentSpecFile, ws.currentSuite);
    const state = ws.testMap.get(key);
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

    // Stop routing logs to this test; the following afterEach hook (if any)
    // sets its own sink in onHookStart.
    this.routeLogsTo(null, cid);

    this.applySharedTestData(state, state.ctrfTest.suite, test.title, cid);
  }

  private applySharedTestData(state: InternalTestState, suite: string | undefined, title: string, cid: string): void {
    if (!suite) return;

    const sharedData = shared.pullTestData(suite, title, cid);
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
        const ws = this.getWorkerState(cid);
        ws.globalAttachments.push(...nonScreenshotAttachments);
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
    const cid = hook.cid ?? '';
    const ws = this.getWorkerState(cid);

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
      const suiteState = ws.suiteMap.get(hook.parent) ?? ws.suiteMap.get(ws.currentSuite);
      if (suiteState) {
        suiteState.globalHooks.push(hookData);
      }
      ws.currentGlobalHookBeingProcessed = hookData; // Track for log capture

      if (this.opts.captureGlobalHookLogs) {
        shared.setActiveGlobalHook(ws.currentSuite, hookData.title, cid);
      }
    }

    // Route logs emitted during this hook body straight to the hook, regardless
    // of hook type. Works with or without the service loaded.
    if (this.opts.captureLogs) {
      this.routeLogsTo((entry) => {
        (hookData.logs ??= []).push(entry);
      }, cid);
    }

    (hook as unknown as Record<string, any>)._ctrfHook = hookData;
  }

  onHookEnd(hook: HookStats): void {
    if (!this.opts.includeHooks) return;
    const cid = hook.cid ?? '';
    const ws = this.getWorkerState(cid);
    const ctrfHook = (hook as unknown as Record<string, any>)._ctrfHook as CtrfHook | undefined;

    if (ctrfHook) {
      ctrfHook.stop = Date.now();
      ctrfHook.duration = ctrfHook.stop - ctrfHook.start;

      // Stop routing logs to this hook now that its body has finished.
      this.routeLogsTo(null, cid);

      // WDIO surfaces hook failures inconsistently: sometimes via `error`,
      // sometimes via an `errors[]` array, and sometimes only via `state`.
      const hookRecord = hook as unknown as Record<string, any>;
      const errorList = hookRecord.errors;
      const hookError = hook.error
        ?? (Array.isArray(errorList) && errorList.length > 0 ? (errorList[0] as Error) : undefined);
      const hookFailed = Boolean(hookError) || hookRecord.state === 'failed';

      ctrfHook.status = hookFailed ? 'failed' : 'passed';
      if (hookError) {
        ctrfHook.message = hookError.message;
        ctrfHook.trace = hookError.stack;
        // Preserve any logs captured during the hook body and append the error.
        (ctrfHook.logs ??= []).push({
          timestamp: ctrfHook.stop,
          level: 'error',
          message: hookError.message,
        });
      }

      // Capture attachments (e.g. failure screenshots) from global hooks. Logs
      // are already attached to `ctrfHook.logs` via the reporter log sink.
      if (this.opts.captureGlobalHookLogs && (ctrfHook.type === 'before' || ctrfHook.type === 'after')) {
        const clearResult = shared.clearActiveGlobalHook(cid);
        if (clearResult) {
          if (clearResult.logs.length > 0) {
            ctrfHook.logs = [...(ctrfHook.logs ?? []), ...clearResult.logs];
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
        ws.pendingBeforeEachHooks.push(ctrfHook);
      } else if (ctrfHook.type === 'afterEach') {
        // Attribute to the test that just ran.
        if (ws.lastStartedTestState) {
          ws.lastStartedTestState.hooks.push(ctrfHook);
        } else {
          ws.pendingBeforeEachHooks.push(ctrfHook);
        }
      }

      // Clear the current global hook reference after processing
      if (ws.currentGlobalHookBeingProcessed === ctrfHook) {
        ws.currentGlobalHookBeingProcessed = null;
      }
    }
  }

  onRunnerEnd(runner: RunnerStats): void {
    const cid = runner.cid ?? '';
    const ws = this.getWorkerState(cid);
    ws.runnerEndTime = Date.now();
    this.buildReport(ws, cid);
    this.writeReport(ws);
  }

  /** Single owner of log attribution. Points both the in-process log API
   * (shared.setLogSink, used by browser.ctrf.log / CommonUtil.log) and the
   * command-event handlers at the same test/hook target. */
  private routeLogsTo(sink: ((entry: CtrfLogEntry) => void) | null, cid: string): void {
    const ws = this.getWorkerState(cid);
    ws.activeSink = sink;
    shared.setLogSink(sink, cid);
  }

  /** WDIO emits this for every WebDriver/Appium command in-process, correctly
   * ordered relative to test/hook events. We turn the meaningful ones into
   * human-readable log lines so a test always has an activity trail — even
   * when the optional service is not loaded and no manual logs are written. */
  onBeforeCommand(command: BeforeCommandArgs): void {
    if (!this.opts.captureCommands) return;

    // Extract cid from the command payload. WDIO includes this at runtime
    // even if the TypeScript types do not declare it.
    let cid = (command as any).cid as string | undefined;

    if (!cid) {
      // Fallback: if exactly one worker has an active sink, attribute to it.
      // This handles WDIO versions where BeforeCommandArgs does not include cid.
      const active = Array.from(this.workerStates.entries())
        .filter(([_, ws]) => ws.activeSink !== null)
        .map(([c, _]) => c);
      if (active.length === 1) {
        cid = active[0];
      } else if (active.length > 1) {
        this.log('trace', 'Skipping command log: multiple active workers, cannot attribute command without cid');
        return;
      } else {
        return;
      }
    }

    const ws = this.workerStates.get(cid);
    if (!ws || !ws.activeSink) return;

    const message = this.describeCommand(command.method, command.endpoint, command.body);
    if (message) {
      ws.activeSink({ timestamp: Date.now(), level: 'debug', message });
    }
  }

  /** Translate a raw WebDriver/Appium request into a readable action label.
   * Returns null for noisy, non-actionable commands (element lookups, polling,
   * attribute/state reads). Never includes typed text (may be a password). */
  private describeCommand(method: string | undefined, endpoint: string | undefined, body: unknown): string | null {
    if (!endpoint) return null;
    const b = (body ?? {}) as Record<string, unknown>;

    if (/\/element\/[^/]+\/click$/.test(endpoint)) return 'Clicked element';
    if (/\/element\/[^/]+\/value$/.test(endpoint)) return 'Entered text into element';
    if (/\/element\/[^/]+\/clear$/.test(endpoint)) return 'Cleared element';
    if (/\/url$/.test(endpoint) && method === 'POST') {
      return b.url ? `Navigated to ${String(b.url)}` : 'Navigated to url';
    }
    if (/\/back$/.test(endpoint)) return 'Navigated back';
    if (/\/forward$/.test(endpoint)) return 'Navigated forward';
    if (/\/refresh$/.test(endpoint)) return 'Refreshed page';
    if (/\/actions$/.test(endpoint) && method === 'POST') return 'Performed touch/pointer actions';
    if (/\/appium\/device\/(long_)?press_keycode$/.test(endpoint)) {
      return b.keycode !== undefined ? `Pressed keycode ${String(b.keycode)}` : 'Pressed keycode';
    }
    if (/\/appium\/device\/(hide_keyboard|press_keycode)$/.test(endpoint)) return 'Hid keyboard';
    if (/\/appium\/app\/launch$/.test(endpoint)) return 'Launched app';
    if (/\/appium\/app\/(close|terminate)$/.test(endpoint)) return 'Closed app';
    if (/\/appium\/app\/(background)$/.test(endpoint)) return 'Backgrounded app';
    if (/\/appium\/app\/(reset)$/.test(endpoint)) return 'Reset app';
    if (/\/execute(\/sync)?$/.test(endpoint) && method === 'POST') {
      const script = typeof b.script === 'string' ? b.script.split('\n')[0].slice(0, 120) : '';
      return script ? `Executed script: ${script}` : 'Executed script';
    }
    return null;
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

  private getTestKey(test: TestStats, file: string, suite: string): string {
    const testSuite = test.parent ?? suite;
    return `${file}::${testSuite}::${test.title}`;
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
    const cid = test.cid ?? '';
    const ws = this.getWorkerState(cid);
    const key = this.getTestKey(test, ws.currentSpecFile, ws.currentSuite);

    // Tests skipped via `it.skip` / `this.skip()` never fire onTestStart,
    // so create their state here to ensure they appear in the report.
    let state = ws.testMap.get(key);
    if (!state) {
      state = this.createTestState(test, Date.now(), ws);
      this.attachPendingHooks(state, ws);
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

  private buildReport(ws: WorkerState, cid: string): void {
    const tests: CtrfTest[] = [];
    let passed = 0;
    let failed = 0;
    let pending = 0;
    let skipped = 0;
    let other = 0;
    let flaky = 0;

    if (this.opts.includeHooks) {
      this.applyRecordedGlobalHookFailures(ws, cid);
    }

    for (const state of ws.testMap.values()) {
      // In parallel runs, reporter `onTestEnd` can fire before service
      // `afterTest` archives active test logs/attachments. Pull again at build
      // time, using the stored suite/name, after service hooks have run.
      this.applySharedTestData(state, state.ctrfTest.suite, state.ctrfTest.name, cid);

      if (this.opts.includeHooks) {
        state.ctrfTest.hooks = state.hooks.length > 0 ? [...state.hooks] : undefined;
        // Apply service-recorded failures to test-level hooks (beforeEach /
        // afterEach). The reporter's HookStats often lacks the error, so the
        // service is the source of truth. Consumed in execution order.
        if (state.ctrfTest.hooks) {
          for (const hook of state.ctrfTest.hooks) {
            this.applyRecordedHookFailure(hook, false, cid);
          }
        }
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

    ws.report.summary = {
      tests: tests.length,
      passed,
      failed,
      pending,
      skipped,
      other,
      start: ws.runnerStartTime,
      stop: ws.runnerEndTime,
      duration: ws.runnerEndTime - ws.runnerStartTime,
      suites: ws.suiteCount,
      flaky,
    };

    // Build hierarchical structure if structureByHooks is enabled
    if (this.opts.structureByHooks) {
      ws.report.suite = this.buildSuiteHierarchy(tests, ws);
      delete ws.report.tests;
    } else {
      ws.report.tests = tests;
    }

    // Merge per-test global attachments with session-level attachments
    // (e.g. appium.log) captured by the service, de-duplicating by content.
    const sessionAttachments = shared.pullGlobalAttachments(cid).map((att) => this.normalizeAttachment(att));
    const combinedAttachments = this.dedupeAttachments([...ws.globalAttachments, ...sessionAttachments]);
    ws.report.attachments = combinedAttachments.length > 0 ? combinedAttachments : undefined;
  }

  /**
   * Apply a service-recorded hook failure (status + message/trace + attachments
   * such as the failure screenshot) to a hook. The service is the source of
   * truth for hook pass/fail because the reporter's HookStats frequently lacks
   * the error. Failures are consumed FIFO from per-type queues so they align
   * with execution order.
   */
  private applyRecordedHookFailure(hook: CtrfHook, allowUnknownFallback: boolean, cid: string): void {
    let result = shared.takeHookResult(hook.type ?? 'unknown', cid);
    if (!result && allowUnknownFallback) {
      result = shared.takeHookResult('unknown', cid);
    }
    if (!result && allowUnknownFallback) {
      result = shared.takeAnyHookResult(cid);
    }
    if (!result) return;
    if (result.failed) {
      hook.status = 'failed';
      if (result.message && !hook.message) hook.message = result.message;
      if (result.trace && !hook.trace) hook.trace = result.trace;
    }
    if (result.attachments.length > 0) {
      const normalized = result.attachments.map((att) => this.normalizeAttachment(att));
      hook.attachments = [...(hook.attachments ?? []), ...normalized];
    }
  }

  private applyRecordedGlobalHookFailures(ws: WorkerState, cid: string): void {
    for (const suiteState of ws.suiteMap.values()) {
      for (const globalHook of suiteState.globalHooks) {
        this.applyRecordedHookFailure(globalHook, true, cid);
      }
    }
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

  private buildSuiteHierarchy(tests: CtrfTest[], ws: WorkerState): CtrfSuite[] {
    // Group tests by suite and filepath
    const suiteHierarchyMap = new Map<string, { suite: CtrfSuite; tests: CtrfTest[] }>();

    for (const test of tests) {
      const suite = test.suite ?? 'default';
      const filepath = test.filepath ?? 'unknown';
      const key = `${filepath}::${suite}`;

      if (!suiteHierarchyMap.has(key)) {
        const suiteState = ws.suiteMap.get(suite);
        const ctrfSuite: CtrfSuite = {
          name: suite,
          filepath,
          tests: [],
        };

        // Add global hooks if present
        if (this.opts.includeHooks && suiteState && suiteState.globalHooks.length > 0) {
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

  private writeReport(ws: WorkerState): void {
    const outputDir = path.resolve(this.opts.outputDir);
    const outputPath = this.resolveOutputPath(outputDir, ws);
    try {
      if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
      const tmpPath = `${outputPath}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(ws.report, null, 2), 'utf-8');
      fs.renameSync(tmpPath, outputPath);
      this.log('info', `CTRF report written to: ${outputPath}`);
      if (this.opts.onComplete) {
        Promise.resolve(this.opts.onComplete(ws.report, outputPath)).catch((err) => {
          this.log('error', `onComplete error: ${(err as Error).message}`);
        });
      }
    } catch (err) {
      this.log('error', `Failed to write report: ${(err as Error).message}`);
      throw err;
    }
  }

  private resolveOutputPath(outputDir: string, ws: WorkerState): string {
    if (this.opts.outputFileStrategy === 'static') {
      return path.join(outputDir, this.opts.outputFile);
    }

    const parsed = path.parse(this.opts.outputFile);
    const baseName = parsed.name || 'wdio-ctrf-report';
    const extension = parsed.ext || '.json';
    const specName = ws.currentSpecFile
      ? path.basename(ws.currentSpecFile, path.extname(ws.currentSpecFile))
      : 'worker';
    const parts = [baseName, ws.runnerCid, specName, String(process.pid), String(ws.runnerStartTime)]
      .filter(Boolean)
      .map((part) => this.safeFilePart(part));

    return path.join(outputDir, `${parts.join('-')}${extension}`);
  }

  private safeFilePart(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_').slice(0, 80) || 'unknown';
  }

  private getCap(caps: Record<string, unknown>, ...keys: string[]): string | undefined {
    for (const key of keys) {
      if (caps[key] !== undefined && caps[key] !== null) return String(caps[key]);
    }
    return undefined;
  }

  private extractDeviceInfo(ws: WorkerState): Pick<CtrfTest, 'platform' | 'device' | 'browser' | 'appVersion'> {
    const env = ws.report.environment;
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
