import * as shared from './shared-state';
import { afterEach, describe, expect, it } from '@jest/globals';

describe('shared state worker isolation', () => {
  const firstWorker = 'worker-a';
  const secondWorker = 'worker-b';

  afterEach(() => {
    shared.clearAll(firstWorker);
    shared.clearAll(secondWorker);
    shared.setCurrentWorkerCid();
  });

  it('keeps logs and attachments in their worker bucket', () => {
    shared.setActiveTest('Suite', 'Test', firstWorker);
    shared.setActiveTest('Suite', 'Test', secondWorker);
    shared.addLog('info', 'first worker', firstWorker);
    shared.addLog('info', 'second worker', secondWorker);
    shared.clearActiveTest(firstWorker);
    shared.clearActiveTest(secondWorker);

    expect(shared.pullTestData('Suite', 'Test', firstWorker).logs.map((entry) => entry.message)).toEqual(['first worker']);
    expect(shared.pullTestData('Suite', 'Test', secondWorker).logs.map((entry) => entry.message)).toEqual(['second worker']);
  });

  it('does not overwrite completed tests with identical suite and title', () => {
    shared.setActiveTest('Repeated suite', 'repeated test', firstWorker);
    shared.addLog('info', 'first attempt', firstWorker);
    shared.clearActiveTest(firstWorker);
    shared.setActiveTest('Repeated suite', 'repeated test', firstWorker);
    shared.addLog('info', 'second attempt', firstWorker);
    shared.clearActiveTest(firstWorker);

    expect(shared.pullTestData('Repeated suite', 'repeated test', firstWorker).logs.map((entry) => entry.message)).toEqual(['first attempt']);
    expect(shared.pullTestData('Repeated suite', 'repeated test', firstWorker).logs.map((entry) => entry.message)).toEqual(['second attempt']);
  });

  it('routes the public API default bucket to the configured worker', () => {
    shared.setCurrentWorkerCid(firstWorker);
    shared.setActiveTest('Suite', 'public API test');
    shared.addLog('info', 'from the public API');
    shared.clearActiveTest();

    expect(shared.pullTestData('Suite', 'public API test', firstWorker).logs.map((entry) => entry.message)).toEqual(['from the public API']);
  });
});
