import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from '@jest/globals';
import CtrfReporter from './reporter';
import * as shared from './shared-state';
import { ctrf } from './api';
import type { CtrfReport, CtrfSuite } from './types';

function makeReporter(outputDir: string, cid: string): CtrfReporter {
  return new CtrfReporter({
    stdout: true,
    writeStream: { write: () => true },
    outputDir,
    logLevel: 'silent',
    cid,
  } as never);
}

function readReport(outputDir: string): CtrfReport {
  const file = fs.readdirSync(outputDir).find((f) => f.endsWith('.json'));
  return JSON.parse(fs.readFileSync(path.join(outputDir, file!), 'utf-8'));
}

function suiteOf(report: CtrfReport, name: string): CtrfSuite {
  const suite = report.suite?.find((s) => s.name === name);
  if (!suite) throw new Error(`suite ${name} not found`);
  return suite;
}

/** WDIO's real HookStats/TestStats are one object mutated in place across its
 *  start/end events (the reporter stashes `_ctrfHook` on it in onHookStart and
 *  reads it back in onHookEnd) - so tests must pass the same reference through,
 *  not two separate literals, or the link onHookStart established is lost. */
function hook(title: string, parent: string, currentTest: string): Record<string, unknown> {
  return { title, parent, currentTest };
}

describe('CtrfReporter parallel-run correctness', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    shared.clearAll('worker-1');
    shared.setCurrentWorkerCid();
  });

  it('attributes beforeEach/afterEach to the correct test even when hook:end races behind the next test:start', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctrf-'));
    const reporter = makeReporter(tmpDir, 'worker-1');

    reporter.onRunnerStart({ cid: 'worker-1', specs: ['spec.ts'], config: {}, capabilities: {} } as never);
    reporter.onSuiteStart({ title: 'My Suite', uid: 'suite-1' } as never);

    // Test A: beforeEach hook:end fires AFTER test A's test:start (the race
    // observed in production - WDIO does not guarantee ordering here).
    const beforeEachA = hook('"before each" hook', 'My Suite', 'Test A');
    reporter.onHookStart(beforeEachA as never);
    reporter.onTestStart({ title: 'Test A', parent: 'My Suite' } as never);
    beforeEachA.state = 'passed';
    reporter.onHookEnd(beforeEachA as never);
    reporter.onTestPass({ title: 'Test A', parent: 'My Suite' } as never);
    const afterEachA = hook('"after each" hook', 'My Suite', 'Test A');
    reporter.onHookStart(afterEachA as never);
    afterEachA.state = 'passed';
    reporter.onHookEnd(afterEachA as never);
    reporter.onTestEnd({ title: 'Test A', parent: 'My Suite', state: 'passed' } as never);

    // Test B starts right after - its own beforeEach must not receive test A's
    // orphaned hook, and must not be missing its own.
    const beforeEachB = hook('"before each" hook', 'My Suite', 'Test B');
    reporter.onHookStart(beforeEachB as never);
    reporter.onTestStart({ title: 'Test B', parent: 'My Suite' } as never);
    beforeEachB.state = 'passed';
    reporter.onHookEnd(beforeEachB as never);
    reporter.onTestPass({ title: 'Test B', parent: 'My Suite' } as never);
    const afterEachB = hook('"after each" hook', 'My Suite', 'Test B');
    reporter.onHookStart(afterEachB as never);
    afterEachB.state = 'passed';
    reporter.onHookEnd(afterEachB as never);
    reporter.onTestEnd({ title: 'Test B', parent: 'My Suite', state: 'passed' } as never);

    reporter.onRunnerEnd({} as never);

    const report = readReport(tmpDir);
    const suite = suiteOf(report, 'My Suite');
    const testA = suite.tests.find((t) => t.name === 'Test A')!;
    const testB = suite.tests.find((t) => t.name === 'Test B')!;

    expect(testA.hooks?.map((h) => h.type)).toEqual(['beforeEach', 'afterEach']);
    expect(testB.hooks?.map((h) => h.type)).toEqual(['beforeEach', 'afterEach']);
  });

  it('does not drop an attachment made during a test-level afterEach hook', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctrf-'));
    const reporter = makeReporter(tmpDir, 'worker-1');
    shared.setCurrentWorkerCid('worker-1');

    reporter.onRunnerStart({ cid: 'worker-1', specs: ['spec.ts'], config: {}, capabilities: {} } as never);
    reporter.onSuiteStart({ title: 'My Suite', uid: 'suite-1' } as never);

    reporter.onTestStart({ title: 'Test A', parent: 'My Suite' } as never);
    reporter.onTestFail({ title: 'Test A', parent: 'My Suite', error: { message: 'boom' } } as never);
    reporter.onTestEnd({ title: 'Test A', parent: 'My Suite', state: 'failed' } as never);

    // Simulate the test suite's own afterEach calling a screenshot helper via
    // the public `ctrf` API - by this point the service's active-test window
    // (beforeTest/afterTest) has already closed.
    const afterEachA = hook('"after each" hook', 'My Suite', 'Test A');
    reporter.onHookStart(afterEachA as never);
    ctrf.attach.screenshot('/tmp/failure.png', 'failure');
    afterEachA.state = 'passed';
    reporter.onHookEnd(afterEachA as never);

    reporter.onRunnerEnd({} as never);

    const report = readReport(tmpDir);
    const suite = suiteOf(report, 'My Suite');
    const testA = suite.tests.find((t) => t.name === 'Test A')!;
    const afterEachHook = testA.hooks?.find((h) => h.type === 'afterEach');

    expect(afterEachHook?.attachments?.[0]?.name).toBe('failure');
    expect(afterEachHook?.attachments?.[0]?.category).toBe('screenshot');
  });

  it('resets hooks per retry attempt instead of accumulating them across attempts', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctrf-'));
    const reporter = makeReporter(tmpDir, 'worker-1');

    reporter.onRunnerStart({ cid: 'worker-1', specs: ['spec.ts'], config: {}, capabilities: {} } as never);
    reporter.onSuiteStart({ title: 'My Suite', uid: 'suite-1' } as never);

    // Attempt 1: fails.
    const beforeEach1 = hook('"before each" hook', 'My Suite', 'Flaky Test');
    reporter.onHookStart(beforeEach1 as never);
    reporter.onTestStart({ title: 'Flaky Test', parent: 'My Suite' } as never);
    beforeEach1.state = 'passed';
    reporter.onHookEnd(beforeEach1 as never);
    reporter.onTestFail({ title: 'Flaky Test', parent: 'My Suite', error: { message: 'flake' } } as never);
    reporter.onTestEnd({ title: 'Flaky Test', parent: 'My Suite', state: 'failed' } as never);

    // Attempt 2 (retry): passes.
    const beforeEach2 = hook('"before each" hook', 'My Suite', 'Flaky Test');
    reporter.onHookStart(beforeEach2 as never);
    reporter.onTestStart({ title: 'Flaky Test', parent: 'My Suite' } as never);
    beforeEach2.state = 'passed';
    reporter.onHookEnd(beforeEach2 as never);
    reporter.onTestPass({ title: 'Flaky Test', parent: 'My Suite' } as never);
    reporter.onTestEnd({ title: 'Flaky Test', parent: 'My Suite', state: 'passed' } as never);

    reporter.onRunnerEnd({} as never);

    const report = readReport(tmpDir);
    const suite = suiteOf(report, 'My Suite');
    const test = suite.tests.find((t) => t.name === 'Flaky Test')!;

    // Only attempt 2's beforeEach should remain on the test - not both attempts'.
    expect(test.hooks?.filter((h) => h.type === 'beforeEach')).toHaveLength(1);
    // Attempt 1's hooks are preserved for debugging in the retry detail instead.
    expect(test.retriesDetail?.[0]?.hooks).toHaveLength(1);
  });
});
