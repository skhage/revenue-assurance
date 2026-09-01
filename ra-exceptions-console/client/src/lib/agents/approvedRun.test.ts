// @vitest-environment jsdom
import { beginApprovedRun, completeApprovedRun } from './approvedRun';

describe('beginApprovedRun / completeApprovedRun', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('mints a fresh idempotency key scoped to the agent and exception', () => {
    const run = beginApprovedRun('recovery-playbook', 'exc-1');
    expect(run.idempotencyKey).toMatch(/^agent:recovery-playbook:exc-1:[0-9a-f-]{36}$/);
    expect(run.approvedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('returns the SAME pending run on a second call before completion (resumable across a lost response/remount)', () => {
    const first = beginApprovedRun('recovery-playbook', 'exc-1');
    const second = beginApprovedRun('recovery-playbook', 'exc-1');
    expect(second).toEqual(first);
  });

  it('a full page reload is simulated by re-reading from localStorage — the same pending run resumes', () => {
    const first = beginApprovedRun('recovery-playbook', 'exc-1');
    // Nothing clears localStorage between "page loads" in this simulation,
    // so re-invoking begin* after a "reload" must resume, not mint a new key.
    const afterReload = beginApprovedRun('recovery-playbook', 'exc-1');
    expect(afterReload).toEqual(first);
  });

  it('mints a NEW idempotency key once the previous run is completed (a later independent approval is distinct)', () => {
    const first = beginApprovedRun('recovery-playbook', 'exc-1');
    completeApprovedRun('recovery-playbook', 'exc-1', first.idempotencyKey);
    const second = beginApprovedRun('recovery-playbook', 'exc-1');
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
  });

  it('completeApprovedRun is a no-op if the stored key does not match (stale completion call)', () => {
    const first = beginApprovedRun('recovery-playbook', 'exc-1');
    completeApprovedRun('recovery-playbook', 'exc-1', 'agent:recovery-playbook:exc-1:not-the-real-run-id');
    // Since the stored run was not cleared, begin* still resumes it.
    const resumed = beginApprovedRun('recovery-playbook', 'exc-1');
    expect(resumed).toEqual(first);
  });

  it('different agents for the same exception get independent pending runs', () => {
    const recovery = beginApprovedRun('recovery-playbook', 'exc-1');
    const prioritization = beginApprovedRun('smart-prioritization', 'exc-1');
    expect(recovery.idempotencyKey).not.toBe(prioritization.idempotencyKey);
  });

  it('the same agent for different exceptions gets independent pending runs', () => {
    const a = beginApprovedRun('recovery-playbook', 'exc-1');
    const b = beginApprovedRun('recovery-playbook', 'exc-2');
    expect(a.idempotencyKey).not.toBe(b.idempotencyKey);
  });
});
