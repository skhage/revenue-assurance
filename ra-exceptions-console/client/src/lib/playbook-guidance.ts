// Client API for the Investigation Playbook KA (server/routes/playbook-guidance.ts).

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || res.statusText);
  }
  return res.json() as Promise<T>;
}

const SEVERITIES = new Set(['critical', 'high', 'medium', 'low']);

export const playbookGuidanceApi = {
  /** Ask the playbook KA for investigation steps + resolution patterns for a check type. */
  get: (check_type: string, severity?: string, signal?: AbortSignal) => {
    const sev = severity?.toLowerCase();
    return fetch('/api/playbook-guidance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sev && SEVERITIES.has(sev) ? { check_type, severity: sev } : { check_type }),
      signal,
    }).then((r) => json<{ content: string; check_type: string }>(r));
  },
};
