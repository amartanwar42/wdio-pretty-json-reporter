/**
 * Programmatic API for tests to attach files/logs to the CTRF report.
 *
 * Usage in test files:
 *   import { ctrf } from 'wdio-pretty-json-reporter';
 *   ctrf.attach.screenshot('./path.png');
 *   ctrf.log.info('Custom message');
 */

import type { CtrfAttachment } from './types';
import * as shared from './shared-state';

type BrowserWithScreenshot = WebdriverIO.Browser & {
  saveScreenshot(filepath: string): Promise<unknown>;
};

declare const browser: BrowserWithScreenshot;

function now(): number {
  return Date.now();
}

function push(att: Omit<CtrfAttachment, 'timestamp'>): void {
  shared.addAttachment({ ...att, timestamp: now() });
}

export const attach = {
  /** Generic attachment */
  file(name: string, path: string, mimeType: string, category: CtrfAttachment['category'] = 'file'): void {
    push({ name, path, type: mimeType, category });
  },

  /** Screenshot file */
  screenshot(path: string, name?: string): void {
    push({
      name: name ?? `screenshot-${now()}.png`,
      path,
      type: 'image/png',
      category: 'screenshot',
    });
  },

  /** Video file */
  video(path: string, name?: string): void {
    push({
      name: name ?? `video-${now()}.mp4`,
      path,
      type: 'video/mp4',
      category: 'video',
    });
  },

  /** Text log file */
  logFile(path: string, name?: string): void {
    push({
      name: name ?? `log-${now()}.txt`,
      path,
      type: 'text/plain',
      category: 'log',
    });
  },

  /** Raw text content (inline, no file) */
  text(name: string, content: string): void {
    push({ name, content, type: 'text/plain', category: 'log' });
  },

  /** JSON content (inline) */
  json(name: string, data: unknown): void {
    push({
      name: `${name}.json`,
      content: JSON.stringify(data, null, 2),
      type: 'application/json',
      category: 'trace',
    });
  },

  /** HTML content (inline) */
  html(name: string, content: string): void {
    push({ name, content, type: 'text/html', category: 'trace' });
  },

  /** Appium server log file */
  appiumLog(path: string): void {
    push({ name: 'appium-server.log', path, type: 'text/plain', category: 'trace' });
  },

  /** Network HAR file */
  networkHar(path: string): void {
    push({ name: 'network.har', path, type: 'application/json', category: 'network' });
  },

  /** Custom attachment with full control */
  custom(attachment: Omit<CtrfAttachment, 'timestamp'>): void {
    push(attachment);
  },
};

export const log = {
  trace(message: string): void { shared.addLog('trace', message); },
  debug(message: string): void { shared.addLog('debug', message); },
  info(message: string): void { shared.addLog('info', message); },
  warn(message: string): void { shared.addLog('warn', message); },
  error(message: string): void { shared.addLog('error', message); },
};

/** Convenience: attach current browser screenshot by name */
export async function captureScreenshot(name?: string): Promise<void> {
  const screenshotPath = `./screenshots/${name ?? `capture-${now()}`}.png`;
  await browser.saveScreenshot(screenshotPath);
  attach.screenshot(screenshotPath, name);
}

export const ctrf = { attach, log, captureScreenshot };
