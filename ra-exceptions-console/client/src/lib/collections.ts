// Thin client for the collections intelligence API (server/routes/collections.ts).

import type { CollectionsRecord, CollectionsSummary, CollectionsActionBreakdown } from './types';

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || res.statusText);
  }
  return res.json() as Promise<T>;
}

export interface CollectionsQueueFilters {
  action?: string;
  limit?: number;
}

export const collectionsApi = {
  /** Headline KPIs for the collections intelligence tab. */
  summary: (signal?: AbortSignal) =>
    fetch('/api/collections/summary', { signal }).then((r) => json<CollectionsSummary>(r)),

  /** Per-action breakdown (STOP / ADJUST / REVIEW_WRITE_OFF / etc.). */
  actions: (signal?: AbortSignal) =>
    fetch('/api/collections/actions', { signal }).then((r) => json<CollectionsActionBreakdown[]>(r)),

  /** Priority-ranked customer queue, optionally filtered by action. */
  queue: (filters: CollectionsQueueFilters = {}, signal?: AbortSignal) => {
    const params = new URLSearchParams();
    if (filters.action) params.set('action', filters.action);
    if (filters.limit) params.set('limit', String(filters.limit));
    return fetch(`/api/collections/queue?${params}`, { signal }).then((r) =>
      json<CollectionsRecord[]>(r)
    );
  },
};
