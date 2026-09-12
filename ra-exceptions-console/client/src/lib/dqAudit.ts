// Thin client for the Pipeline Reliability read path (server/routes/dqAudit.ts).

import type { PipelineHealth } from './agents/types';

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || res.statusText);
  }
  return res.json() as Promise<T>;
}

export const dqAuditApi = {
  health: (signal?: AbortSignal) =>
    fetch('/api/dq/audit', { signal }).then((res) => json<{ health: PipelineHealth }>(res)),
};
