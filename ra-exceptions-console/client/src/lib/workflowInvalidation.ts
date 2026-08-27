import { useSyncExternalStore } from 'react';

const KEY = 'ra-workflow-invalidation';
let revision = 0;
const listeners = new Set<() => void>();
let channel: BroadcastChannel | null = null;

function notify() {
  revision += 1;
  for (const listener of listeners) listener();
}

if (typeof window !== 'undefined') {
  channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(KEY);
  channel?.addEventListener('message', notify);
  window.addEventListener('storage', (event) => {
    if (event.key === KEY) notify();
  });
  window.addEventListener('focus', notify);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') notify();
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
