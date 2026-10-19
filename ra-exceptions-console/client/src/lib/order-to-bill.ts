// Thin client for the order-to-bill API (server/routes/order-to-bill.ts).

import type {
  OrderToBillSummary,
  OrderToBillVector,
  OrderToBillException,
} from './types';

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || res.statusText);
  }
  return res.json() as Promise<T>;
}

export interface OrderToBillListFilters {
  leakage_vector?: string;
  severity?: string;
  limit?: number;
}

export const orderToBillApi = {
  /** Headline metrics for the Order-to-Bill tab. */
  summary: (signal?: AbortSignal) =>
    fetch('/api/order-to-bill/summary', { signal }).then((r) =>
      json<OrderToBillSummary>(r)
    ),

  /** Leakage vector × severity breakdown. */
  vectors: (signal?: AbortSignal) =>
    fetch('/api/order-to-bill/vectors', { signal }).then((r) =>
      json<OrderToBillVector[]>(r)
    ),

  /** Filtered exception list. */
  list: (filters: OrderToBillListFilters = {}, signal?: AbortSignal) => {
    const params = new URLSearchParams();
    if (filters.leakage_vector) params.set('leakage_vector', filters.leakage_vector);
    if (filters.severity) params.set('severity', filters.severity);
    if (filters.limit) params.set('limit', String(filters.limit));
    return fetch(`/api/order-to-bill/list?${params}`, { signal }).then((r) =>
      json<OrderToBillException[]>(r)
    );
  },
};
