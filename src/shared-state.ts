/**
 * In-process shared state between Reporter, Service, and test API.
 * WDIO Reporter and Service run in the same Node process.
 *
 * NOTE: In parallel mode, all state is partitioned by `cid` (capability ID)
 * so that multiple workers do not overwrite each other's data.
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

const DEFAULT_CID = '__default__';
function resolveCid(cid?: string): string {
  return cid || DEFAULT_CID;
}

function getOrCreate<K, V>(map: Map<K, V>, key: K, factory: () => V): V {
  if (!map.has(key)) {
    map.set(key, factory());
  }
  return map.get(key)!;
}

/** Active test being executed, keyed by cid */
const activeTests = new Map<string, PendingTestState | null>();

/** Active global hook being executed (before all / after all), keyed by cid */
const activeGlobalHooks = new Map<string, ActiveGlobalHookState | null>();

/**
 * Reporter-driven log destination, keyed by cid. The reporter is the only component that is
 * always loaded (the service is optional and, on some cloud grids, stripped),
 * and it alone knows the precise test/hook boundaries. It sets this sink at the
 * start of every test and hook so logs emitted via the `ctrf` API are attributed
 * to the correct owner regardless of whether the service is present.
 */
const logSinks = new Map<string, ((entry: CtrfLogEntry) => void) | null>();

/** All attachments/logs keyed by suite::test for reporter pickup, nested by cid */
const archives = new Map<string, Map<string, { attachments: CtrfAttachment[]; logs: CtrfLogEntry[] }>>();

/** Global hook logs keyed by suite::hookTitle for reporter pickup, nested by cid */
const globalHookLogs = new Map<string, Map<string, CtrfLogEntry[]>>();

/** Global hook attachments keyed by suite::hookTitle for reporter pickup, nested by cid */
const globalHookAttachments = new Map<string, Map<string, CtrfAttachment[]>>();

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
 * reporter at report-build time via `takeHookResult`. Nested by cid. */
const hookResults = new Map<string, Map<HookType, HookResult[]>>();

/** Session-level attachments (e.g. appium.log) not tied to any single test. Nested by cid. */
const globalAttachmentSinks = new Map<string, CtrfAttachment[]>();

export function setActiveTest(suite: string, test: string, cid?: string): void {
  const key = resolveCid(cid);
  activeTests.set(key, { suite, test, attachments: [], logs: [] });
}

export function clearActiveTest(cid?: string): { suite: string; test: string; attachments: CtrfAttachment[]; logs: CtrfLogEntry[] } | null {
  const key = resolveCid(cid);
  const copy = activeTests.get(key) ?? null;
  if (copy) {
    const archiveKey = `${copy.suite}::${copy.test}`;
    const archive = getOrCreate(archives, key, () => new Map());
    archive.set(archiveKey, { attachments: copy.attachments, logs: copy.logs });
  }
  activeTests.set(key, null);
  return copy;
}

export function getActiveTest(cid?: string): PendingTestState | null {
  return activeTests.get(resolveCid(cid)) ?? null;
}

export function setActiveGlobalHook(suite: string, hookTitle: string, cid?: string): void {
  const key = resolveCid(cid);
  activeGlobalHooks.set(key, { suite, hookTitle, logs: [], attachments: [] });
}

export function clearActiveGlobalHook(cid?: string): { suite: string; hookTitle: string; logs: CtrfLogEntry[]; attachments: CtrfAttachment[] } | null {
  const key = resolveCid(cid);
  const copy = activeGlobalHooks.get(key) ?? null;
  if (copy) {
    const hookKey = `${copy.suite}::${copy.hookTitle}`;
    const logsMap = getOrCreate(globalHookLogs, key, () => new Map());
    const attachmentsMap = getOrCreate(globalHookAttachments, key, () => new Map());
    if (copy.logs.length > 0) {
      logsMap.set(hookKey, copy.logs);
    }
    if (copy.attachments.length > 0) {
      attachmentsMap.set(hookKey, copy.attachments);
    }
  }
  activeGlobalHooks.set(key, null);
  return copy;
}

export function getActiveGlobalHook(cid?: string): ActiveGlobalHookState | null {
  return activeGlobalHooks.get(resolveCid(cid)) ?? null;
}

/**
 * Set (or clear, with `null`) the destination for subsequently emitted logs.
 * Driven by the reporter at each test/hook boundary.
 */
export function setLogSink(sink: ((entry: CtrfLogEntry) => void) | null, cid?: string): void {
  logSinks.set(resolveCid(cid), sink);
}

export function addAttachment(att: CtrfAttachment, cid?: string): void {
  const key = resolveCid(cid);
  const globalHook = activeGlobalHooks.get(key);
  if (globalHook) {
    globalHook.attachments.push(att);
    return;
  }
  const test = activeTests.get(key);
  if (test) {
    test.attachments.push(att);
  }
}

export function addLog(level: string, message: string, cid?: string): void {
  const key = resolveCid(cid);
  const now = Date.now();
  const logEntry: CtrfLogEntry = {
    timestamp: now,
    level: normalizeLoglevel(level),
    message,
  };

  // The reporter-driven sink is authoritative: it knows exactly which test or
  // hook is executing. Fall back to the service's active-test / global-hook
  // context only for logs emitted outside any reporter boundary.
  const sink = logSinks.get(key);
  if (sink) {
    sink(logEntry);
    return;
  }
  const test = activeTests.get(key);
  if (test) {
    test.logs.push(logEntry);
  } else {
    const hook = activeGlobalHooks.get(key);
    if (hook) {
      hook.logs.push(logEntry);
    }
  }
}

export function pullTestData(suite: string, test: string, cid?: string): { attachments: CtrfAttachment[]; logs: CtrfLogEntry[] } {
  const key = resolveCid(cid);
  const archive = archives.get(key);
  const dataKey = `${suite}::${test}`;
  const data = archive?.get(dataKey) ?? { attachments: [], logs: [] };
  archive?.delete(dataKey);
  return data;
}

export function pullGlobalHookLogs(suite: string, hookTitle: string, cid?: string): CtrfLogEntry[] {
  const key = resolveCid(cid);
  const logsMap = globalHookLogs.get(key);
  const dataKey = `${suite}::${hookTitle}`;
  const logs = logsMap?.get(dataKey) ?? [];
  logsMap?.delete(dataKey);
  return logs;
}

export function pullGlobalHookAttachments(suite: string, hookTitle: string, cid?: string): CtrfAttachment[] {
  const key = resolveCid(cid);
  const attachmentsMap = globalHookAttachments.get(key);
  const dataKey = `${suite}::${hookTitle}`;
  const attachments = attachmentsMap?.get(dataKey) ?? [];
  attachmentsMap?.delete(dataKey);
  return attachments;
}

export function recordHookFailure(type: HookType, error?: Error, cid?: string): void {
  const key = resolveCid(cid);
  const resultsMap = getOrCreate(hookResults, key, () => new Map<HookType, HookResult[]>());
  const queue = resultsMap.get(type) ?? [];
  const result: HookResult = { failed: true, attachments: [] };
  if (error) {
    result.message = error.message;
    result.trace = error.stack;
  }
  queue.push(result);
  resultsMap.set(type, queue);
}

export function addHookAttachment(type: HookType, att: CtrfAttachment, cid?: string): void {
  const key = resolveCid(cid);
  const resultsMap = getOrCreate(hookResults, key, () => new Map<HookType, HookResult[]>());
  const queue = resultsMap.get(type) ?? [];
  // Attach to the most recently recorded failure of this type (same hook that
  // is currently being processed by the service), creating one if needed.
  const target = queue[queue.length - 1] ?? { failed: true, attachments: [] };
  if (queue.length === 0) queue.push(target);
  target.attachments.push(att);
  resultsMap.set(type, queue);
}

/** Shift (consume) the next recorded failure of the given hook type. */
export function takeHookResult(type: HookType, cid?: string): { failed: boolean; message?: string; trace?: string; attachments: CtrfAttachment[] } | undefined {
  const key = resolveCid(cid);
  const resultsMap = hookResults.get(key);
  if (!resultsMap) return undefined;
  const queue = resultsMap.get(type);
  if (!queue || queue.length === 0) return undefined;
  const result = queue.shift();
  if (queue.length === 0) {
    resultsMap.delete(type);
  }
  return result;
}

/**
 * Shift any recorded hook failure. Used as a last-resort fallback: if the
 * service captured a hook-failure screenshot but classification did not match
 * the reporter hook, do not leave that known failure stranded as `passed`.
 */
export function takeAnyHookResult(cid?: string): { failed: boolean; message?: string; trace?: string; attachments: CtrfAttachment[] } | undefined {
  const key = resolveCid(cid);
  const resultsMap = hookResults.get(key);
  if (!resultsMap) return undefined;
  for (const [type, queue] of resultsMap) {
    if (queue.length > 0) {
      const result = queue.shift();
      if (queue.length === 0) {
        resultsMap.delete(type);
      }
      return result;
    }
  }
  return undefined;
}

export function addGlobalAttachment(att: CtrfAttachment, cid?: string): void {
  const sink = getOrCreate(globalAttachmentSinks, resolveCid(cid), () => []);
  sink.push(att);
}

export function pullGlobalAttachments(cid?: string): CtrfAttachment[] {
  const key = resolveCid(cid);
  const copy = globalAttachmentSinks.get(key) ?? [];
  globalAttachmentSinks.set(key, []);
  return copy;
}

export function clearAll(cid?: string): void {
  const key = resolveCid(cid);
  activeTests.delete(key);
  activeGlobalHooks.delete(key);
  logSinks.delete(key);
  archives.delete(key);
  globalHookLogs.delete(key);
  globalHookAttachments.delete(key);
  hookResults.delete(key);
  globalAttachmentSinks.delete(key);
}

function normalizeLoglevel(level: string): CtrfLogEntry['level'] {
  const normalized = level.toLowerCase();
  if (normalized === 'trace' || normalized === 'debug' || normalized === 'info' || normalized === 'warn' || normalized === 'error') {
    return normalized;
  }
  return 'info';
}
