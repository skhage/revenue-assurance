// Thin client for the contract compliance API (server/routes/contract-compliance.ts).

import type {
  ContractViolationRow,
  ExpiringContractRow,
  LifecycleRiskRow,
  ContractRiskReportRow,
  ContractComplianceSummary,
} from './types';

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || res.statusText);
  }
  return res.json() as Promise<T>;
}

export interface ViolationsFilters {
  scan_scope?: 'ALL' | 'SLA_TIER_MISMATCH' | 'PRICE_DEVIATION' | 'SLA_BREACH_PENALTY' | 'INVOICE_DISCREPANCY';
  customer_id?: number;
  min_amount?: number;
}

export interface ExpiringFilters {
  days_ahead?: number;
  include_expired?: boolean;
  min_annual_revenue?: number;
}

export interface LifecycleFilters {
  customer_id?: number;
  risk_type?: string;
  horizon_days?: number;
}

export const contractComplianceApi = {
  /** Compliance violations: contract vs billing mismatches. */
  violations: (filters: ViolationsFilters = {}, signal?: AbortSignal) => {
    const params = new URLSearchParams();
    if (filters.scan_scope) params.set('scan_scope', filters.scan_scope);
    if (filters.customer_id !== undefined) params.set('customer_id', String(filters.customer_id));
    if (filters.min_amount !== undefined) params.set('min_amount', String(filters.min_amount));
    return fetch(`/api/contract-compliance/violations?${params}`, { signal }).then((r) =>
      json<ContractViolationRow[]>(r)
    );
  },

  /** Expiring contracts approaching renewal deadlines. */
  expiring: (filters: ExpiringFilters = {}, signal?: AbortSignal) => {
    const params = new URLSearchParams();
    if (filters.days_ahead !== undefined) params.set('days_ahead', String(filters.days_ahead));
    if (filters.include_expired !== undefined) params.set('include_expired', String(filters.include_expired));
    if (filters.min_annual_revenue !== undefined) params.set('min_annual_revenue', String(filters.min_annual_revenue));
    return fetch(`/api/contract-compliance/expiring?${params}`, { signal }).then((r) =>
      json<ExpiringContractRow[]>(r)
    );
  },

  /** Lifecycle risks with multi-dimensional scoring. */
  lifecycle: (filters: LifecycleFilters = {}, signal?: AbortSignal) => {
    const params = new URLSearchParams();
    if (filters.customer_id !== undefined) params.set('customer_id', String(filters.customer_id));
    if (filters.risk_type) params.set('risk_type', filters.risk_type);
    if (filters.horizon_days !== undefined) params.set('horizon_days', String(filters.horizon_days));
    return fetch(`/api/contract-compliance/lifecycle?${params}`, { signal }).then((r) =>
      json<LifecycleRiskRow[]>(r)
    );
  },

  /** Executive risk report — summary metrics from all compliance checks. */
  report: (signal?: AbortSignal) =>
    fetch('/api/contract-compliance/report', { signal }).then((r) =>
      json<ContractRiskReportRow[]>(r)
    ),

  /** Headline KPIs. */
  summary: (signal?: AbortSignal) =>
    fetch('/api/contract-compliance/summary', { signal }).then((r) =>
      json<ContractComplianceSummary>(r)
    ),
};
