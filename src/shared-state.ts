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

/** All attachments/logs keyed by suite::test for reporter pickup */
const archive = new Map<string, { attachments: CtrfAttachment[]; logs: CtrfLogEntry[] }>();

/** Global hook logs keyed by suite::hookTitle for reporter pickup */
const globalHookLogs = new Map<string, CtrfLogEntry[]>();

/** Global hook attachments keyed by suite::hookTitle for reporter pickup */
const globalHookAttachments = new Map<string, CtrfAttachment[]>();

interface HookResult {
  failed: boolean;
  message?: string;
  trace?: string;
  attachments: CtrfAttachment[];
}

/** Hook results recorded by the service (source of truth for hook pass/fail),
 *  keyed by hook title. Applied by the reporter at report-build time. */
const hookResults = new Map<string, HookResult>();

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

export function recordHookFailure(hookTitle: string, error?: Error): void {
  const existing = hookResults.get(hookTitle) ?? { failed: false, attachments: [] };
  existing.failed = true;
  if (error) {
    existing.message = error.message;
    existing.trace = error.stack;
  }
  hookResults.set(hookTitle, existing);
}

export function addHookAttachment(hookTitle: string, att: CtrfAttachment): void {
  const existing = hookResults.get(hookTitle) ?? { failed: false, attachments: [] };
  existing.attachments.push(att);
  hookResults.set(hookTitle, existing);
}

export function getHookResult(hookTitle: string): { failed: boolean; message?: string; trace?: string; attachments: CtrfAttachment[] } | undefined {
  return hookResults.get(hookTitle);
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
