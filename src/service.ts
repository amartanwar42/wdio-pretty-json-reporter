import type { Services } from '@wdio/types';
import * as fs from 'fs';
import * as path from 'path';
import type { CtrfServiceOptions, CtrfAttachment } from './types';
import * as shared from './shared-state';
import { attach } from './api';

type BrowserWithWdioCommands = WebdriverIO.Browser & {
  saveScreenshot(filepath: string): Promise<unknown>;
  getPageSource(): Promise<string>;
  ctrf?: unknown;
};

// WDIO injects `browser` global at runtime
declare const browser: BrowserWithWdioCommands;

const DEFAULT_SCREENSHOT_PATH = './screenshots';
const DEFAULT_VIDEO_PATH = './videos';

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
        screenshot: (p: string, n?: string) => attach.screenshot(p, n),
        video: (p: string, n?: string) => attach.video(p, n),
        logFile: (p: string, n?: string) => attach.logFile(p, n),
        text: (n: string, c: string) => attach.text(n, c),
        json: (n: string, d: unknown) => attach.json(n, d),
        html: (n: string, c: string) => attach.html(n, c),
        appiumLog: (p: string) => attach.appiumLog(p),
        networkHar: (p: string) => attach.networkHar(p),
        file: (n: string, p: string, t: string, c?: CtrfAttachment['category']) => attach.file(n, p, t, c),
        custom: (a: Omit<CtrfAttachment, 'timestamp'>) => attach.custom(a),
      },
      log: {
        trace: (m: string) => shared.addLog('trace', m),
        debug: (m: string) => shared.addLog('debug', m),
        info: (m: string) => shared.addLog('info', m),
        warn: (m: string) => shared.addLog('warn', m),
        error: (m: string) => shared.addLog('error', m),
      },
    };
  }

  beforeTest(test: { parent: string; title: string }): void {
    shared.setActiveTest(test.parent, test.title);
  }

  async afterHook(
    _test: unknown,
    _context: unknown,
    result: { passed: boolean; error?: Error }
  ): Promise<void> {
    // Capture a screenshot when a hook (e.g. `before all`) fails, so the
    // failure has visual context. The reporter routes this attachment to the
    // active global hook via shared state.
    if (result?.passed !== false) return;
    if (!this.opts.screenshot.enabled) return;

    const fileName = `hook_failure_${Date.now()}.png`;
    const screenshotPath = path.resolve(this.opts.screenshot.path, fileName);
    try {
      await browser.saveScreenshot(screenshotPath);
      attach.screenshot(screenshotPath, fileName.replace(/\.png$/, ''));
    } catch (e) {
      shared.addLog('warn', `Failed to capture hook screenshot: ${(e as Error).message}`);
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
          attach.screenshot(screenshotPath, fileName.replace(/\.png$/, ''));
        } catch (e) {
          shared.addLog('warn', `Failed to capture screenshot: ${(e as Error).message}`);
        }
      }
    }

    // ── Auto page source ──
    if (this.opts.pageSource.enabled) {
      if (!this.opts.pageSource.onFailureOnly || failed) {
        try {
          const source = await browser.getPageSource();
          attach.html('page-source.html', source);
        } catch (e) {
          shared.addLog('warn', `Failed to capture page source: ${(e as Error).message}`);
        }
      }
    }

    // ── Attach configured log files ──
    for (const logPath of this.opts.attachLogs) {
      if (fs.existsSync(logPath)) {
        attach.logFile(logPath, path.basename(logPath));
      }
    }

    // ── Attach Appium log ──
    if (this.opts.appiumLogPath && fs.existsSync(this.opts.appiumLogPath)) {
      attach.appiumLog(this.opts.appiumLogPath);
    }

    // ── Attach network HAR ──
    if (this.opts.networkHarPath && fs.existsSync(this.opts.networkHarPath)) {
      attach.networkHar(this.opts.networkHarPath);
    }

    // Archive for reporter
    shared.clearActiveTest();
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
