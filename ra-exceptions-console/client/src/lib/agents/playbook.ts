// Recovery Playbook agent — a deterministic, check-type-keyed template table.
// Every entry's numbers (recovery %, owner, deadline) are demo assumptions,
// not measured outcomes; they exist to make the recommendation legible, not
// to represent real recovery-rate history.

import type { ExceptionRow } from '../types';
import type { CheckType, PlaybookEntry, Recommendation } from './types';

export const PLAYBOOK: Record<CheckType, PlaybookEntry> = {
  contract_price_mismatch: {
    checkType: 'contract_price_mismatch',
    action: 'Issue price-correction memo and credit note; re-bill at the contracted rate.',
    recoveryPct: 0.85,
    ownerRole: 'Billing Ops',
    deadlineDays: 10,
  },
  unauthorized_discount: {
    checkType: 'unauthorized_discount',
    action: 'Revoke the discount, claw back via the next invoice adjustment, require retroactive CPQ approval.',
    recoveryPct: 0.75,
    ownerRole: 'Deal Desk',
    deadlineDays: 14,
  },
  expired_quote_active: {
    checkType: 'expired_quote_active',
    action:
      'Terminate the expired quote/subscription line, re-quote at the current price list, back-bill the lapsed period.',
    recoveryPct: 0.6,
    ownerRole: 'Sales Ops',
    deadlineDays: 15,
  },
  ar_collection_risk: {
    checkType: 'ar_collection_risk',
    action: 'Escalate to collections, evaluate a credit hold, negotiate a payment plan.',
    recoveryPct: 0.5,
    ownerRole: 'Collections',
    deadlineDays: 30,
  },
  rev_rec_timing_mismatch: {
    checkType: 'rev_rec_timing_mismatch',
    action: 'Correct the revenue-recognition schedule/GL entry, reclassify the period, flag for controller review.',
    recoveryPct: 0.95,
    ownerRole: 'Revenue Accounting',
    deadlineDays: 5,
  },
  doc_contract_mismatch: {
    checkType: 'doc_contract_mismatch',
    action: 'Reconcile the contract PDF against the CRM/ERP system of record; correct the losing system.',
    recoveryPct: 0.7,
    ownerRole: 'Contract Ops',
    deadlineDays: 12,
  },
  doc_invoice_mismatch: {
    checkType: 'doc_invoice_mismatch',
    action: 'Reconcile the invoice PDF against the billing system; issue a corrected invoice or credit memo.',
    recoveryPct: 0.8,
    ownerRole: 'Billing Ops',
    deadlineDays: 10,
  },
};

const FALLBACK_ENTRY: PlaybookEntry = {
  checkType: 'unknown',
  action: 'Route to a revenue-assurance analyst for manual triage; no check-specific playbook is defined yet.',
  recoveryPct: 0.5,
  ownerRole: 'RA Analyst',
  deadlineDays: 21,
};

export function playbookFor(checkType: string): PlaybookEntry {
  return (PLAYBOOK as Record<string, PlaybookEntry>)[checkType] ?? FALLBACK_ENTRY;
}

export function buildRecommendation(row: ExceptionRow, now: number = Date.now()): Recommendation {
  const entry = playbookFor(row.check_type);
  const expectedRecoveryUsd = Math.round(row.amount_at_risk * entry.recoveryPct);
  const deadline = new Date(now + entry.deadlineDays * 24 * 60 * 60 * 1000).toISOString();
  const rationale =
    `check_type=${row.check_type}, source_table=${row.source_table}, ` +
    `detection_method=${row.detection_method}, amount_at_risk=${row.amount_at_risk} ` +
    `⇒ ${entry.action}`;
  return { entry, expectedRecoveryUsd, deadline, rationale };
}
