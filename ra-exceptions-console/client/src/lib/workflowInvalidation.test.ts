import {
  getWorkflowRevision,
  pollWorkflowHealth,
  publishWorkflowInvalidation,
  subscribeWorkflowInvalidation,
} from './workflowInvalidation';
import { expect, it, vi } from 'vitest';

it('invalidates every subscribed app surface after a workflow mutation', () => {
  let calls = 0;
  const before = getWorkflowRevision();
  const unsubscribe = subscribeWorkflowInvalidation(() => {
    calls += 1;
  });
  publishWorkflowInvalidation();
  unsubscribe();
  expect(calls).toBe(1);
  expect(getWorkflowRevision()).toBe(before + 1);
});

it('observes a newer server revision from another session', async () => {
  let serverRevision = 41;
  const fetcher = vi.fn(() =>
    Promise.resolve({
      json: () => Promise.resolve({ revision: serverRevision }),
    })
  ) as unknown as typeof fetch;
  let calls = 0;
  const before = getWorkflowRevision();
  const unsubscribe = subscribeWorkflowInvalidation(() => {
    calls += 1;
  });

  await pollWorkflowHealth(fetcher);
  expect(calls).toBe(0);
  serverRevision = 42;
  await pollWorkflowHealth(fetcher);

  unsubscribe();
  expect(fetcher).toHaveBeenCalledWith('/api/workflow/health', { cache: 'no-store' });
  expect(calls).toBe(1);
  expect(getWorkflowRevision()).toBe(before + 1);
});
