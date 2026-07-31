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

function push(att: Omit<CtrfAttachment, 'timestamp'>, cid?: string): void {
  shared.addAttachment({ ...att, timestamp: now() }, cid);
}

/**
 * Build an attachment API bound to one WDIO worker. The default export keeps
 * the public API unchanged; the service uses a CID-bound instance so browser
 * commands never fall back to the shared default bucket in parallel runs.
 */
export function createAttachApi(cid?: string) {
  const add = (att: Omit<CtrfAttachment, 'timestamp'>): void => push(att, cid);
  return {
  /** Generic attachment */
  file(name: string, path: string, mimeType: string, category: CtrfAttachment['category'] = 'file'): void {
    add({ name, path, type: mimeType, category });
  },

  /** Screenshot file */
  screenshot(path: string, name?: string): void {
    add({
      name: name ?? `screenshot-${now()}.png`,
      path,
      type: 'image/png',
      category: 'screenshot',
    });
  },

  /** Video file */
  video(path: string, name?: string): void {
    add({
      name: name ?? `video-${now()}.mp4`,
      path,
      type: 'video/mp4',
      category: 'video',
    });
  },

  /** Text log file */
  logFile(path: string, name?: string): void {
    add({
      name: name ?? `log-${now()}.txt`,
      path,
      type: 'text/plain',
      category: 'log',
    });
  },

  /** Raw text content (inline, no file) */
  text(name: string, content: string): void {
    add({ name, content, type: 'text/plain', category: 'log' });
  },

  /** JSON content (inline) */
  json(name: string, data: unknown): void {
    add({
      name: `${name}.json`,
      content: JSON.stringify(data, null, 2),
      type: 'application/json',
      category: 'trace',
    });
  },

  /** HTML content (inline) */
  html(name: string, content: string): void {
    add({ name, content, type: 'text/html', category: 'trace' });
  },

  /** Appium server log file */
  appiumLog(path: string): void {
    add({ name: 'appium-server.log', path, type: 'text/plain', category: 'trace' });
  },

  /** Network HAR file */
  networkHar(path: string): void {
    add({ name: 'network.har', path, type: 'application/json', category: 'network' });
  },

  /** Custom attachment with full control */
  custom(attachment: Omit<CtrfAttachment, 'timestamp'>): void {
    add(attachment);
  },
};
}

export const attach = createAttachApi();

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
