// Formatting + domain-label helpers shared across the RA console.

const compactUsd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 1,
});

const fullUsd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

const compactNum = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const fullNum = new Intl.NumberFormat('en-US');

/** Compact currency, e.g. $601.5M — for KPIs, chart labels, dense cells. */
export function usdCompact(v: number | null | undefined): string {
  return compactUsd.format(v ?? 0);
}

/** Full currency, e.g. $8,420 — for the detail drawer. */
export function usd(v: number | null | undefined): string {
  return fullUsd.format(v ?? 0);
}

export function numCompact(v: number | null | undefined): string {
  return compactNum.format(v ?? 0);
}

export function num(v: number | null | undefined): string {
  return fullNum.format(v ?? 0);
}

// Human labels for the reconciliation check types (gold_leakage_summary.check_type).
const CHECK_LABELS: Record<string, string> = {
  ar_collection_risk: 'AR collection risk',
  rev_rec_timing_mismatch: 'Revenue recognition timing',
  unauthorized_discount: 'Unauthorized discount',
  contract_price_mismatch: 'Contract price mismatch',
  expired_quote_active: 'Expired quote active',
  doc_contract_mismatch: 'Doc vs contract mismatch',
  doc_invoice_mismatch: 'Doc vs invoice mismatch',
};

export function checkLabel(check: string | null | undefined): string {
  if (!check) return 'Unknown';
  return CHECK_LABELS[check] ?? check.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function accountLabel(name: string | null | undefined): string {
  return name && name.trim().length > 0 ? name : 'Unattributed';
}

export function detectionLabel(method: string | null | undefined): string {
  if (!method) return '—';
  return method === 'ai_extracted' ? 'AI-extracted' : method === 'rule_based' ? 'Rule-based' : method;
}

// Friendly names for the simulated upstream source systems (schema.table).
const SOURCE_LABELS: Record<string, string> = {
  salesforce_source: 'CRM (Salesforce)',
  oracle_erp_source: 'ERP (Oracle)',
  refinitiv_fx_source: 'FX rates (Refinitiv)',
  ironclad_clm_source: 'Contracts (Ironclad CLM)',
  mdm_source: 'Master data (MDM)',
};

export function sourceLabel(table: string | null | undefined): string {
  if (!table) return 'Unknown source system';
  const schema = table.split('.')[0];
  return SOURCE_LABELS[schema] ?? 'Other source system';
}

/** Compact person initials for avatars, e.g. "stephen.hage@x" → "SH". */
export function initials(user: string | null | undefined): string {
  if (!user) return '—';
  const local = user.split('@')[0];
  const parts = local.split(/[.\-_]/).filter(Boolean);
  const chars = parts.length >= 2 ? parts[0][0] + parts[1][0] : local.slice(0, 2);
  return chars.toUpperCase();
}
