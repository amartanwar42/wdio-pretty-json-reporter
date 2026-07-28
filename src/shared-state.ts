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

/** Active test being executed */
let activeTest: PendingTestState | null = null;

/** All attachments/logs keyed by suite::test for reporter pickup */
const archive = new Map<string, { attachments: CtrfAttachment[]; logs: CtrfLogEntry[] }>();

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

export function addAttachment(att: CtrfAttachment): void {
  if (activeTest) {
    activeTest.attachments.push(att);
  }
}

export function addLog(level: string, message: string): void {
  if (activeTest) {
    const normalized = level.toLowerCase();
    const safeLevel: CtrfLogEntry['level'] =
      normalized === 'trace' || normalized === 'debug' || normalized === 'info' || normalized === 'warn' || normalized === 'error'
        ? normalized
        : 'info';
    activeTest.logs.push({
      timestamp: Date.now(),
      level: safeLevel,
      message,
    });
  }
}

export function pullTestData(suite: string, test: string): { attachments: CtrfAttachment[]; logs: CtrfLogEntry[] } {
  const key = `${suite}::${test}`;
  const data = archive.get(key) ?? { attachments: [], logs: [] };
  archive.delete(key);
  return data;
}

export function clearAll(): void {
  activeTest = null;
  archive.clear();
}
