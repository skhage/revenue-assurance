import {
  getWorkflowRevision,
  publishWorkflowInvalidation,
  subscribeWorkflowInvalidation,
} from './workflowInvalidation';
import { expect, it } from 'vitest';

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
