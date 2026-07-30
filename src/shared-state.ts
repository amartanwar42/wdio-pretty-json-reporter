/**
 * In-process shared state between Reporter, Service, and test API.
 * WDIO Reporter and Service run in the same Node process.
 */

import type { CtrfAttachment } from './types';
import type { CtrfLogEntry } from './types';

interface PendingTestState {
  suite: string;
  test: string;
  attachments: CtrfAttachment[];
  logs: CtrfLogEntry[];
}

interface ActiveGlobalHookState {
  suite: string;
  hookTitle: string;
  logs: CtrfLogEntry[];
  attachments: CtrfAttachment[];
}

/** Active test being executed */
let activeTest: PendingTestState | null = null;

/** Active global hook being executed (before all / after all) */
let activeGlobalHook: ActiveGlobalHookState | null = null;

/** Active test-level hook being executed (beforeEach / afterEach) */
let activeTestHook: { type: HookType; logs: CtrfLogEntry[] } | null = null;

/** All attachments/logs keyed by suite::test for reporter pickup */
const archive = new Map<string, { attachments: CtrfAttachment[]; logs: CtrfLogEntry[] }>();

/** Global hook logs keyed by suite::hookTitle for reporter pickup */
const globalHookLogs = new Map<string, CtrfLogEntry[]>();

/** Global hook attachments keyed by suite::hookTitle for reporter pickup */
const globalHookAttachments = new Map<string, CtrfAttachment[]>();

export type HookType = 'before' | 'after' | 'beforeEach' | 'afterEach' | 'unknown';

interface HookResult {
  failed: boolean;
  message?: string;
  trace?: string;
  attachments: CtrfAttachment[];
}

/**
 * Hook failures recorded by the service (source of truth for hook pass/fail).
 * Keyed by hook TYPE rather than title: WDIO's service `afterHook` receives the
 * associated test object, whose title never matches the reporter's HookStats
 * title, so title-based matching is unreliable. Both sides classify a hook to
 * the same type, so type-keyed FIFO queues link them robustly. Consumed by the
 * reporter at report-build time via `takeHookResult`. */
const hookResults = new Map<HookType, HookResult[]>();

/** Session-level attachments (e.g. appium.log) not tied to any single test. */
let globalAttachmentSink: CtrfAttachment[] = [];

export function setActiveTest(suite: string, test: string): void {
  activeTest = { suite, test, attachments: [], logs: [] };
}

export function clearActiveTest(): { suite: string; test: string; attachments: CtrfAttachment[]; logs: CtrfLogEntry[] } | null {
  const copy = activeTest;
  if (copy) {
    const key = `${copy.suite}::${copy.test}`;
    archive.set(key, { attachments: copy.attachments, logs: copy.logs });
  }
  activeTest = null;
  return copy;
}

export function getActiveTest(): PendingTestState | null {
  return activeTest;
}

export function setActiveGlobalHook(suite: string, hookTitle: string): void {
  activeGlobalHook = { suite, hookTitle, logs: [], attachments: [] };
}

export function clearActiveGlobalHook(): { suite: string; hookTitle: string; logs: CtrfLogEntry[]; attachments: CtrfAttachment[] } | null {
  const copy = activeGlobalHook;
  if (copy) {
    const key = `${copy.suite}::${copy.hookTitle}`;
    if (copy.logs.length > 0) {
      globalHookLogs.set(key, copy.logs);
    }
    if (copy.attachments.length > 0) {
      globalHookAttachments.set(key, copy.attachments);
    }
  }
  activeGlobalHook = null;
  return copy;
}

export function getActiveGlobalHook(): ActiveGlobalHookState | null {
  return activeGlobalHook;
}

/** Begin capturing logs emitted during a test-level (beforeEach/afterEach) hook body. */
export function setActiveTestHook(type: HookType): void {
  activeTestHook = { type, logs: [] };
}

/** Stop capturing and return the logs collected during the test-level hook body. */
export function clearActiveTestHook(): CtrfLogEntry[] {
  const logs = activeTestHook?.logs ?? [];
  activeTestHook = null;
  return logs;
}

export function addAttachment(att: CtrfAttachment): void {
  if (activeGlobalHook) {
    activeGlobalHook.attachments.push(att);
    return;
  }
  if (activeTest) {
    activeTest.attachments.push(att);
  }
}

export function addLog(level: string, message: string): void {
  const now = Date.now();
  const logEntry: CtrfLogEntry = {
    timestamp: now,
    level: normalizeLoglevel(level),
    message,
  };
  
  if (activeTest) {
    activeTest.logs.push(logEntry);
  }
  
  if (activeGlobalHook) {
    activeGlobalHook.logs.push(logEntry);
  }

  if (activeTestHook) {
    activeTestHook.logs.push(logEntry);
  }
}

export function pullTestData(suite: string, test: string): { attachments: CtrfAttachment[]; logs: CtrfLogEntry[] } {
  const key = `${suite}::${test}`;
  const data = archive.get(key) ?? { attachments: [], logs: [] };
  archive.delete(key);
  return data;
}

export function pullGlobalHookLogs(suite: string, hookTitle: string): CtrfLogEntry[] {
  const key = `${suite}::${hookTitle}`;
  const logs = globalHookLogs.get(key) ?? [];
  globalHookLogs.delete(key);
  return logs;
}

export function pullGlobalHookAttachments(suite: string, hookTitle: string): CtrfAttachment[] {
  const key = `${suite}::${hookTitle}`;
  const attachments = globalHookAttachments.get(key) ?? [];
  globalHookAttachments.delete(key);
  return attachments;
}

export function recordHookFailure(type: HookType, error?: Error): void {
  const queue = hookResults.get(type) ?? [];
  const result: HookResult = { failed: true, attachments: [] };
  if (error) {
    result.message = error.message;
    result.trace = error.stack;
  }
  queue.push(result);
  hookResults.set(type, queue);
}

export function addHookAttachment(type: HookType, att: CtrfAttachment): void {
  const queue = hookResults.get(type) ?? [];
  // Attach to the most recently recorded failure of this type (same hook that
  // is currently being processed by the service), creating one if needed.
  const target = queue[queue.length - 1] ?? { failed: true, attachments: [] };
  if (queue.length === 0) queue.push(target);
  target.attachments.push(att);
  hookResults.set(type, queue);
}

/** Shift (consume) the next recorded failure of the given hook type. */
export function takeHookResult(type: HookType): { failed: boolean; message?: string; trace?: string; attachments: CtrfAttachment[] } | undefined {
  const queue = hookResults.get(type);
  if (!queue || queue.length === 0) return undefined;
  return queue.shift();
}

/**
 * Shift any recorded hook failure. Used as a last-resort fallback: if the
 * service captured a hook-failure screenshot but classification did not match
 * the reporter hook, do not leave that known failure stranded as `passed`.
 */
export function takeAnyHookResult(): { failed: boolean; message?: string; trace?: string; attachments: CtrfAttachment[] } | undefined {
  for (const queue of hookResults.values()) {
    if (queue.length > 0) {
      return queue.shift();
    }
  }
  return undefined;
}

export function addGlobalAttachment(att: CtrfAttachment): void {
  globalAttachmentSink.push(att);
}

export function pullGlobalAttachments(): CtrfAttachment[] {
  const copy = globalAttachmentSink;
  globalAttachmentSink = [];
  return copy;
}

export function clearAll(): void {
  activeTest = null;
  activeGlobalHook = null;
  activeTestHook = null;
  archive.clear();
  globalHookLogs.clear();
  globalHookAttachments.clear();
  hookResults.clear();
  globalAttachmentSink = [];
}

function normalizeLoglevel(level: string): CtrfLogEntry['level'] {
  const normalized = level.toLowerCase();
  if (normalized === 'trace' || normalized === 'debug' || normalized === 'info' || normalized === 'warn' || normalized === 'error') {
    return normalized;
  }
  return 'info';
}
