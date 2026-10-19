// Thin client for the partner settlement API (server/routes/partner-settlement.ts).

import type { PartnerSettlementRecord, PartnerDispute, PartnerSettlementSummary } from './types';

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || res.statusText);
  }
  return res.json() as Promise<T>;
}

export interface PartnerReconcileFilters {
  partner_id?: number;
  settlement_type?: string;
  severity_filter?: string;
  min_amount?: number;
  limit?: number;
}

export interface PartnerDisputeFilters {
  top_n?: number;
  min_amount?: number;
  include_escalated?: boolean;
}

export const partnerSettlementApi = {
  /** Per-reconciliation detail with severity and root causes. */
  reconcile: (filters: PartnerReconcileFilters = {}, signal?: AbortSignal) => {
    const params = new URLSearchParams();
    if (filters.partner_id) params.set('partner_id', String(filters.partner_id));
    if (filters.settlement_type) params.set('settlement_type', filters.settlement_type);
    if (filters.severity_filter) params.set('severity_filter', filters.severity_filter);
    if (filters.min_amount) params.set('min_amount', String(filters.min_amount));
    if (filters.limit) params.set('limit', String(filters.limit));
    return fetch(`/api/partner-settlement/reconcile?${params}`, { signal }).then((r) =>
      json<PartnerSettlementRecord[]>(r)
    );
  },

  /** ROI-ranked partner dispute priority list. */
  disputes: (filters: PartnerDisputeFilters = {}, signal?: AbortSignal) => {
    const params = new URLSearchParams();
    if (filters.top_n) params.set('top_n', String(filters.top_n));
    if (filters.min_amount) params.set('min_amount', String(filters.min_amount));
    if (filters.include_escalated !== undefined) params.set('include_escalated', String(filters.include_escalated));
    return fetch(`/api/partner-settlement/disputes?${params}`, { signal }).then((r) =>
      json<PartnerDispute[]>(r)
    );
  },

  /** Headline metrics for the partner settlement tab. */
  summary: (signal?: AbortSignal) =>
    fetch('/api/partner-settlement/summary', { signal }).then((r) =>
      json<PartnerSettlementSummary>(r)
    ),
};
