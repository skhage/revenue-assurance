export interface ApprovedRun {
  idempotencyKey: string;
  approvedAt: string;
}

function storageKey(agentSlug: string, exceptionId: string): string {
  return `ra:pending-agent-run:${agentSlug}:${exceptionId}`;
}

function readRun(value: string | null): ApprovedRun | null {
  if (value == null) return null;
  try {
    const parsed = JSON.parse(value) as Partial<ApprovedRun>;
    return typeof parsed.idempotencyKey === 'string' && typeof parsed.approvedAt === 'string'
      ? { idempotencyKey: parsed.idempotencyKey, approvedAt: parsed.approvedAt }
      : null;
  } catch {
    return null;
  }
}

export function beginApprovedRun(agentSlug: string, exceptionId: string): ApprovedRun {
  const key = storageKey(agentSlug, exceptionId);
  const existing = readRun(localStorage.getItem(key));
  if (existing) return existing;

  const runId = crypto.randomUUID();
  const run = {
    idempotencyKey: `agent:${agentSlug}:${exceptionId}:${runId}`,
    approvedAt: new Date().toISOString(),
  };
  localStorage.setItem(key, JSON.stringify(run));
  return run;
}

export function completeApprovedRun(agentSlug: string, exceptionId: string, idempotencyKey: string): void {
  const key = storageKey(agentSlug, exceptionId);
  const existing = readRun(localStorage.getItem(key));
  if (existing?.idempotencyKey === idempotencyKey) localStorage.removeItem(key);
}
