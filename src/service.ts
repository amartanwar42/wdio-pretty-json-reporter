import type { Services } from '@wdio/types';
import * as fs from 'fs';
import * as path from 'path';
import type { CtrfServiceOptions, CtrfAttachment } from './types';
import * as shared from './shared-state';
import { attach, createAttachApi } from './api';

type BrowserWithWdioCommands = WebdriverIO.Browser & {
  saveScreenshot(filepath: string): Promise<unknown>;
  getPageSource(): Promise<string>;
  ctrf?: unknown;
};

// WDIO injects `browser` global at runtime
declare const browser: BrowserWithWdioCommands;

const DEFAULT_SCREENSHOT_PATH = './screenshots';
const DEFAULT_VIDEO_PATH = './videos';

/**
 * Classify a hook name/title to its type. Mirrors the reporter's classifier so
 * both sides agree on the type used to link service-recorded hook failures to
 * the reporter's hooks, regardless of title-string differences.
 */
function classifyHookType(name: string): shared.HookType {
  const lower = name.toLowerCase();
  if (lower.includes('before each') || lower.includes('beforeeach')) return 'beforeEach';
  if (lower.includes('after each') || lower.includes('aftereach')) return 'afterEach';
  if (lower.includes('before all') || lower.includes('beforeall')) return 'before';
  if (lower.includes('after all') || lower.includes('afterall')) return 'after';
  if (lower.includes('before')) return 'before';
  if (lower.includes('after')) return 'after';
  return 'unknown';
}

type ResolvedCtrfServiceOptions = {
  screenshot: Required<NonNullable<CtrfServiceOptions['screenshot']>>;
  pageSource: Required<NonNullable<CtrfServiceOptions['pageSource']>>;
  video: Required<NonNullable<CtrfServiceOptions['video']>>;
  attachLogs: string[];
  appiumLogPath?: string;
  networkHarPath?: string;
};

export default class CtrfService implements Services.ServiceInstance {
  private opts: ResolvedCtrfServiceOptions;
  /** Capability ID for this WDIO worker. Every shared-state call must use it. */
  private cid = '';
  private attachApi = attach;

  constructor(serviceOptions: CtrfServiceOptions) {
    this.opts = {
      screenshot: {
        enabled: serviceOptions.screenshot?.enabled ?? true,
        path: serviceOptions.screenshot?.path ?? DEFAULT_SCREENSHOT_PATH,
        onFailureOnly: serviceOptions.screenshot?.onFailureOnly ?? true,
        naming: serviceOptions.screenshot?.naming ?? 'default',
      },
      pageSource: {
        enabled: serviceOptions.pageSource?.enabled ?? true,
        onFailureOnly: serviceOptions.pageSource?.onFailureOnly ?? true,
      },
      video: {
        enabled: serviceOptions.video?.enabled ?? false,
        path: serviceOptions.video?.path ?? DEFAULT_VIDEO_PATH,
        scope: serviceOptions.video?.scope ?? 'test',
      },
      attachLogs: serviceOptions.attachLogs ?? [],
      appiumLogPath: serviceOptions.appiumLogPath,
      networkHarPath: serviceOptions.networkHarPath,
    };
  }

  beforeSession(
    _config: Parameters<NonNullable<Services.ServiceInstance['beforeSession']>>[0],
    _capabilities: Parameters<NonNullable<Services.ServiceInstance['beforeSession']>>[1],
    _specs: Parameters<NonNullable<Services.ServiceInstance['beforeSession']>>[2],
    cid: string,
  ): void {
    this.cid = cid;
    shared.setCurrentWorkerCid(cid);
    this.attachApi = createAttachApi(cid);
  }

  async before(): Promise<void> {
    // Ensure screenshot directory exists
    if (this.opts.screenshot.enabled) {
      fs.mkdirSync(path.resolve(this.opts.screenshot.path), { recursive: true });
    }
    if (this.opts.video.enabled) {
      fs.mkdirSync(path.resolve(this.opts.video.path), { recursive: true });
    }

    // Expose browser.ctrf API
    (browser as any).ctrf = {
      attach: {
        screenshot: (p: string, n?: string) => this.attachApi.screenshot(p, n),
        video: (p: string, n?: string) => this.attachApi.video(p, n),
        logFile: (p: string, n?: string) => this.attachApi.logFile(p, n),
        text: (n: string, c: string) => this.attachApi.text(n, c),
        json: (n: string, d: unknown) => this.attachApi.json(n, d),
        html: (n: string, c: string) => this.attachApi.html(n, c),
        appiumLog: (p: string) => this.attachApi.appiumLog(p),
        networkHar: (p: string) => this.attachApi.networkHar(p),
        file: (n: string, p: string, t: string, c?: CtrfAttachment['category']) => this.attachApi.file(n, p, t, c),
        custom: (a: Omit<CtrfAttachment, 'timestamp'>) => this.attachApi.custom(a),
      },
      log: {
        trace: (m: string) => shared.addLog('trace', m, this.cid),
        debug: (m: string) => shared.addLog('debug', m, this.cid),
        info: (m: string) => shared.addLog('info', m, this.cid),
        warn: (m: string) => shared.addLog('warn', m, this.cid),
        error: (m: string) => shared.addLog('error', m, this.cid),
      },
    };
  }

  beforeTest(test: { parent: string; title: string }): void {
    shared.setActiveTest(test.parent, test.title, this.cid);
  }

  async afterHook(
    test: { title?: string; parent?: string },
    _context: unknown,
    result: { passed: boolean; error?: Error },
    hookName?: string
  ): Promise<void> {
    // Capture failure context when a hook (e.g. `before all`) fails. The
    // service is the source of truth for hook pass/fail because the reporter's
    // HookStats often lacks the error. WDIO's `afterHook` signature is
    // `(test, context, result, hookName)` — the first arg is the associated
    // test, NOT the hook, so we classify by hook TYPE (derived from hookName /
    // test title) and let the reporter match by type at build time.
    if (result?.passed !== false) return;

    const type = classifyHookType(hookName ?? test?.title ?? test?.parent ?? '');
    shared.recordHookFailure(type, result.error, this.cid);

    if (this.opts.screenshot.enabled) {
      const fileName = `hook_failure_${Date.now()}.png`;
      const screenshotPath = path.resolve(this.opts.screenshot.path, fileName);
      try {
        await browser.saveScreenshot(screenshotPath);
        shared.addHookAttachment(type, {
          name: fileName.replace(/\.png$/, ''),
          path: screenshotPath,
          type: 'image/png',
          category: 'screenshot',
          timestamp: Date.now(),
        }, this.cid);
      } catch (e) {
        shared.addLog('warn', `Failed to capture hook screenshot: ${(e as Error).message}`, this.cid);
      }
    }

    if (this.opts.pageSource.enabled) {
      try {
        const source = await browser.getPageSource();
        shared.addHookAttachment(type, {
          name: 'page-source.html',
          content: source,
          type: 'text/html',
          category: 'trace',
          timestamp: Date.now(),
        }, this.cid);
      } catch (e) {
        shared.addLog('warn', `Failed to capture hook page source: ${(e as Error).message}`, this.cid);
      }
    }
  }

  async afterTest(
    test: { parent: string; title: string },
    _context: unknown,
    result: { passed: boolean; error?: Error }
  ): Promise<void> {
    const suite = test.parent;
    const title = test.title;
    const failed = !result.passed;

    // ── Auto screenshot ──
    if (this.opts.screenshot.enabled) {
      if (!this.opts.screenshot.onFailureOnly || failed) {
        const fileName = this.buildScreenshotName(suite, title);
        const screenshotPath = path.resolve(this.opts.screenshot.path, fileName);
        try {
          await browser.saveScreenshot(screenshotPath);
          this.attachApi.screenshot(screenshotPath, fileName.replace(/\.png$/, ''));
        } catch (e) {
          shared.addLog('warn', `Failed to capture screenshot: ${(e as Error).message}`, this.cid);
        }
      }
    }

    // ── Auto page source ──
    if (this.opts.pageSource.enabled) {
      if (!this.opts.pageSource.onFailureOnly || failed) {
        try {
          const source = await browser.getPageSource();
          this.attachApi.html('page-source.html', source);
        } catch (e) {
          shared.addLog('warn', `Failed to capture page source: ${(e as Error).message}`, this.cid);
        }
      }
    }

    // Archive for reporter
    shared.clearActiveTest(this.cid);
  }

  /**
   * Attach session-level artifacts (Appium log, configured logs, network HAR)
   * once per worker. Done here rather than in `afterTest` so they are captured
   * even when every test is skipped (e.g. a failed `before all` hook) and are
   * not duplicated across tests.
   */
  after(): void {
    for (const logPath of this.opts.attachLogs) {
      if (fs.existsSync(logPath)) {
        shared.addGlobalAttachment({
          name: path.basename(logPath),
          path: path.resolve(logPath),
          type: 'text/plain',
          category: 'log',
          timestamp: Date.now(),
        }, this.cid);
      }
    }

    if (this.opts.appiumLogPath && fs.existsSync(this.opts.appiumLogPath)) {
      shared.addGlobalAttachment({
        name: 'appium-server.log',
        path: path.resolve(this.opts.appiumLogPath),
        type: 'text/plain',
        category: 'trace',
        timestamp: Date.now(),
      }, this.cid);
    }

    if (this.opts.networkHarPath && fs.existsSync(this.opts.networkHarPath)) {
      shared.addGlobalAttachment({
        name: 'network.har',
        path: path.resolve(this.opts.networkHarPath),
        type: 'application/json',
        category: 'network',
        timestamp: Date.now(),
      }, this.cid);
    }
  }

  private buildScreenshotName(suite: string, test: string): string {
    const ts = Date.now();
    if (typeof this.opts.screenshot.naming === 'function') {
      return `${this.opts.screenshot.naming(suite, test, ts)}.png`;
    }
    const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 60);
    return `${safe(suite)}_${safe(test)}_${ts}.png`;
  }
}
