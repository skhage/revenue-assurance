import { useSyncExternalStore } from 'react';

const KEY = 'ra-workflow-invalidation';
export const WORKFLOW_HEALTH_POLL_INTERVAL_MS = 5_000;
let revision = 0;
let observedServerRevision: number | null = null;
const listeners = new Set<() => void>();
let channel: BroadcastChannel | null = null;
let pollingTimer: ReturnType<typeof setInterval> | null = null;

function notify() {
  revision += 1;
  for (const listener of listeners) listener();
}

export async function pollWorkflowHealth(fetcher: typeof fetch = fetch) {
  try {
    const response = await fetcher('/api/workflow/health', { cache: 'no-store' });
    const health = (await response.json()) as { revision?: unknown };
    const nextRevision = Number(health.revision);
    if (!Number.isSafeInteger(nextRevision) || nextRevision < 0) return;
    if (observedServerRevision !== null && nextRevision !== observedServerRevision) notify();
    observedServerRevision = nextRevision;
  } catch {
    // The projection health endpoint is best-effort; normal data fetches surface actionable errors.
  }
}

export function startWorkflowHealthPolling() {
  if (pollingTimer || typeof window === 'undefined') return;
  void pollWorkflowHealth();
  pollingTimer = setInterval(() => void pollWorkflowHealth(), WORKFLOW_HEALTH_POLL_INTERVAL_MS);
}

export function stopWorkflowHealthPolling() {
  if (!pollingTimer) return;
  clearInterval(pollingTimer);
  pollingTimer = null;
}

if (typeof window !== 'undefined') {
  channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(KEY);
  channel?.addEventListener('message', notify);
  window.addEventListener('storage', (event) => {
    if (event.key === KEY) notify();
  });
  window.addEventListener('focus', () => {
    notify();
    void pollWorkflowHealth();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      notify();
      void pollWorkflowHealth();
    }
  });
  startWorkflowHealthPolling();
  import.meta.hot?.dispose(() => {
    stopWorkflowHealthPolling();
    channel?.close();
  });
}

export function publishWorkflowInvalidation() {
  notify();
  channel?.postMessage(Date.now());
  try {
    localStorage.setItem(KEY, String(Date.now()));
  } catch {
    // Storage can be disabled; BroadcastChannel and local listeners still work.
  }
}

export function subscribeWorkflowInvalidation(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getWorkflowRevision() {
  return revision;
}

export function useWorkflowRevision() {
  return useSyncExternalStore(subscribeWorkflowInvalidation, getWorkflowRevision, getWorkflowRevision);
}
