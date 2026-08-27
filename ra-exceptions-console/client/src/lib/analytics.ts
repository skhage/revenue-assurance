import type { ExceptionRow, KpiSummary, RootCauseSummary } from './types';

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || res.statusText);
  }
  return res.json() as Promise<T>;
}

export interface QueueFilters {
  check_type: string;
  severity: string;
  search: string;
  row_limit: number;
  row_offset: number;
}

export const analyticsApi = {
  exceptions: (filters: QueueFilters, signal?: AbortSignal) => {
    const query = new URLSearchParams(Object.entries(filters).map(([key, value]) => [key, String(value)]));
    return fetch(`/api/analytics/exceptions?${query}`, { signal }).then((res) => json<ExceptionRow[]>(res));
  },
  kpis: (signal?: AbortSignal) => fetch('/api/analytics/kpis', { signal }).then((res) => json<KpiSummary>(res)),
  rootCauses: (signal?: AbortSignal) =>
    fetch('/api/analytics/root-causes', { signal }).then((res) => json<RootCauseSummary[]>(res)),
};
