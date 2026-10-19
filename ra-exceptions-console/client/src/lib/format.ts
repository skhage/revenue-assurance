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
// Keep in sync with the deployed gold_leakage_summary union — the register carries
// FX and contract-completeness variants beyond the original seven.
const CHECK_LABELS: Record<string, string> = {
  ar_collection_risk: 'AR collection risk',
  rev_rec_timing_mismatch: 'Revenue recognition timing',
  unauthorized_discount: 'Unauthorized discount',
  contract_price_mismatch: 'Contract price mismatch',
  contract_price_missing_erp: 'Contracted, not billed (ERP)',
  contract_price_missing_salesforce: 'Billed, no contract on file',
  expired_quote_active: 'Expired quote active',
  fx_rate_mismatch: 'FX rate mismatch',
  fx_rate_deviation: 'FX rate deviation',
  fx_unsupported_currency: 'FX unsupported currency',
  fx_missing_market_rate: 'FX missing market rate',
  fx_missing_applied_rate: 'FX missing applied rate',
  doc_contract_mismatch: 'Doc vs contract mismatch',
  doc_invoice_mismatch: 'Doc vs invoice mismatch',
  // Usage mediation checks (RA-DE-INTEGRATE-MEDIATION)
  usage_mediation_failure: 'Mediation failure',
  usage_subscriber_mismatch: 'Subscriber mismatch',
  usage_data_quality: 'Usage data quality',
  usage_late_cdr: 'Late CDR processing',
  usage_partial_rating: 'Partial rating',
  // Bill adjustment checks (RA-QA-BUG-BILLADJ-CASES)
  bill_adjustment_overcredit: 'Bill adj: overcredit',
  bill_adjustment_unapproved_revenue: 'Bill adj: unapproved revenue',
  bill_adjustment_overcredit_bypass: 'Bill adj: overcredit bypass',
  bill_adjustment_approval_bypass: 'Bill adj: approval bypass',
  bill_adjustment_unsupported_writeoff: 'Bill adj: unsupported writeoff',
  bill_adjustment_rep_collusion: 'Bill adj: rep collusion',
  // Payment reconciliation checks (RA-DE-PAYMENT-GOLD-VIEW)
  payment_duplicate: 'Duplicate payment',
  payment_overpayment: 'Overpayment',
  payment_underpayment: 'Underpayment',
  payment_unreconciled: 'Unreconciled payment',
  payment_unapplied_cash: 'Unapplied cash',
  // Fee regulatory compliance checks (RA-AI-FEE-REGULATORY)
  fee_over_regulatory_cap: 'Fee over regulatory cap',
  unauthorized_fee_waiver: 'Unauthorized fee waiver',
  high_value_writeoff: 'High-value writeoff',
  fee_net_variance: 'Fee net variance',
  // Revenue waterfall integrity (RA-DE-INTEGRATE-WATERFALL)
  revenue_waterfall_integrity: 'Revenue waterfall integrity',
  // Partner settlement (RA-APP-PARTNER-SETTLEMENT-TAB)
  partner_settlement_variance: 'Partner settlement variance',
  // Order-to-bill reconciliation (RA-APP-ORDER-TO-BILL-TAB)
  order_to_bill_reconciliation: 'Order-to-bill mismatch',
  // Commission leakage (RA-APP-COMMISSION-TAB)
  commission_cap_violation: 'Commission cap violation',
  duplicate_commission: 'Duplicate commission',
  cancelled_order_commission: 'Cancelled order commission',
  clawback_failure: 'Clawback failure',
  unauthorized_override: 'Unauthorized override',
  spec_max_exceeded: 'Spec maximum exceeded',
  commission_leakage: 'Commission leakage',
  // Billing dispute intelligence (gold_billing_dispute_leakage)
  compensation_mismatch: 'Compensation mismatch',
  fraud_pattern: 'Fraud pattern',
  over_credit: 'Over-credit',
  reopened_dispute: 'Reopened dispute',
  stale_dispute: 'Stale dispute',
  unauthorized_waiver: 'Unauthorized waiver',
  regulatory_escalation: 'Regulatory escalation',
  // Network incident integrity (gold_network_incident_leakage)
  critical_alarm_under_compensated: 'Critical alarm under-compensated',
  phantom_sla_credit: 'Phantom SLA credit',
  repeat_incident: 'Repeat incident',
  resolution_sla_breach: 'Resolution SLA breach',
  severity_escalation_gap: 'Severity escalation gap',
  sla_breach: 'SLA breach',
  sla_breach_disagreement: 'SLA breach disagreement',
  stale_incident: 'Stale incident',
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
  silver_usage_mediation_reconciliation: 'Mediation platform',
  silver_payment_reconciliation: 'Payment reconciliation',
  silver_fee_regulatory_reconciliation: 'Fee regulatory compliance',
  gold_bill_adjustment_leakage: 'Billing adjustments',
  gold_payment_leakage: 'Payment reconciliation',
  gold_fee_regulatory_leakage: 'Fee regulatory compliance',
  gold_order_to_bill_leakage: 'Order-to-bill',
  gold_commission_leakage: 'Commission leakage',
  silver_commission_leakage_reconciliation: 'Commission reconciliation',
  gold_fee_leakage: 'Fee regulatory compliance',
  gold_billing_dispute_leakage: 'Billing disputes',
  gold_network_incident_leakage: 'Network incidents',
};

export function sourceLabel(table: string | null | undefined): string {
  if (!table) return 'Unknown source system';
  const schema = table.split('.')[0];
  return SOURCE_LABELS[schema] ?? 'Other source system';
}

/** Compact person initials for avatars, e.g. "dana.whitfield@x" → "DW". */
export function initials(user: string | null | undefined): string {
  if (!user) return '—';
  const local = user.split('@')[0];
  const parts = local.split(/[.\-_]/).filter(Boolean);
  const chars = parts.length >= 2 ? parts[0][0] + parts[1][0] : local.slice(0, 2);
  return chars.toUpperCase();
}
