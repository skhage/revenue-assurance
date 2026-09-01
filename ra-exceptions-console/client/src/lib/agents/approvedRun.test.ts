// @vitest-environment jsdom
import { beginApprovedRun, completeApprovedRun } from './approvedRun';

const recoveryNote = (output = 'recover') => (approvedAt: string) => `run_at=${approvedAt}; output=${output}`;

describe('beginApprovedRun / completeApprovedRun', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('mints a fresh idempotency key scoped to the agent and exception', () => {
    const run = beginApprovedRun('recovery-playbook', 'exc-1', recoveryNote());
    expect(run.idempotencyKey).toMatch(/^agent:recovery-playbook:exc-1:[0-9a-f-]{36}$/);
    expect(run.approvedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(run.noteBody).toBe(`run_at=${run.approvedAt}; output=recover`);
  });

  it('returns the SAME pending run for the same exact note (resumable across a lost response/remount)', () => {
    const first = beginApprovedRun('recovery-playbook', 'exc-1', recoveryNote());
    const second = beginApprovedRun('recovery-playbook', 'exc-1', recoveryNote());
    expect(second).toEqual(first);
  });

  it('a full page reload resumes the same pending run and exact stored note', () => {
    const first = beginApprovedRun('recovery-playbook', 'exc-1', recoveryNote());
    const afterReload = beginApprovedRun('recovery-playbook', 'exc-1', recoveryNote());
    expect(afterReload).toEqual(first);
  });

  it('mints a NEW durable identity when recommendation or note text materially changes', () => {
    const first = beginApprovedRun('recovery-playbook', 'exc-1', recoveryNote('recover-v1'));
    const changed = beginApprovedRun('recovery-playbook', 'exc-1', recoveryNote('recover-v2'));

    expect(changed.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(changed.noteBody).toContain('output=recover-v2');
    expect(beginApprovedRun('recovery-playbook', 'exc-1', recoveryNote('recover-v2'))).toEqual(changed);
  });

  it('replaces a legacy pending run that lacks its approved note identity', () => {
    localStorage.setItem(
      'ra:pending-agent-run:recovery-playbook:exc-1',
      JSON.stringify({ idempotencyKey: 'legacy-key', approvedAt: '2026-01-01T00:00:00.000Z' })
    );

    const run = beginApprovedRun('recovery-playbook', 'exc-1', recoveryNote());
    expect(run.idempotencyKey).not.toBe('legacy-key');
    expect(run.noteBody).toContain('output=recover');
  });

  it('mints a NEW idempotency key once the previous run is completed', () => {
    const first = beginApprovedRun('recovery-playbook', 'exc-1', recoveryNote());
    completeApprovedRun('recovery-playbook', 'exc-1', first.idempotencyKey);
    const second = beginApprovedRun('recovery-playbook', 'exc-1', recoveryNote());
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
  });

  it('completeApprovedRun is a no-op if the stored key does not match', () => {
    const first = beginApprovedRun('recovery-playbook', 'exc-1', recoveryNote());
    completeApprovedRun('recovery-playbook', 'exc-1', 'agent:recovery-playbook:exc-1:not-the-real-run-id');
    const resumed = beginApprovedRun('recovery-playbook', 'exc-1', recoveryNote());
    expect(resumed).toEqual(first);
  });

  it('different agents for the same exception get independent pending runs', () => {
    const recovery = beginApprovedRun('recovery-playbook', 'exc-1', recoveryNote());
    const prioritization = beginApprovedRun('smart-prioritization', 'exc-1', recoveryNote());
    expect(recovery.idempotencyKey).not.toBe(prioritization.idempotencyKey);
  });

  it('the same agent for different exceptions gets independent pending runs', () => {
    const a = beginApprovedRun('recovery-playbook', 'exc-1', recoveryNote());
    const b = beginApprovedRun('recovery-playbook', 'exc-2', recoveryNote());
    expect(a.idempotencyKey).not.toBe(b.idempotencyKey);
  });
});
