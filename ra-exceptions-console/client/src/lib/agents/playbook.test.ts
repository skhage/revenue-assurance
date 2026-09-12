import { describe, it, expect } from 'vitest';
import { PLAYBOOK, playbookFor, buildRecommendation } from './playbook';
import type { ExceptionRow } from '../types';

const ALL_CHECK_TYPES = [
  'contract_price_mismatch',
  'unauthorized_discount',
  'expired_quote_active',
  'ar_collection_risk',
  'rev_rec_timing_mismatch',
  'doc_contract_mismatch',
  'doc_invoice_mismatch',
];

function row(overrides: Partial<ExceptionRow> = {}): ExceptionRow {
  return {
    exception_id: 'exc-1',
    reference_id: 'REF-1',
    account_name: 'Acme Fiber',
    check_type: 'contract_price_mismatch',
    severity: 'HIGH',
    amount_at_risk: 10000,
    detection_method: 'rule_based',
    source_table: 'salesforce_source.contract_line_item',
    customer_id: 1,
    known_leakage_flag: true,
    status: 'New',
    assignee: null,
    ...overrides,
  };
}

describe('PLAYBOOK', () => {
  it('has a valid entry for every known check_type', () => {
    for (const checkType of ALL_CHECK_TYPES) {
      const entry = playbookFor(checkType);
      expect(entry.checkType).toBe(checkType);
      expect(entry.recoveryPct).toBeGreaterThan(0);
      expect(entry.recoveryPct).toBeLessThanOrEqual(1);
      expect(entry.deadlineDays).toBeGreaterThan(0);
      expect(entry.ownerRole).toBeTruthy();
      expect(entry.action).toBeTruthy();
    }
    expect(Object.keys(PLAYBOOK)).toHaveLength(7);
  });

  it('falls back safely for an unknown check_type instead of throwing', () => {
    const entry = playbookFor('some_future_check_type');
    expect(entry.checkType).toBe('unknown');
    expect(entry.action).toBeTruthy();
  });
});

describe('buildRecommendation', () => {
  it('computes expected recovery as amount_at_risk * recoveryPct', () => {
    const rec = buildRecommendation(row({ check_type: 'rev_rec_timing_mismatch', amount_at_risk: 20000 }));
    expect(rec.expectedRecoveryUsd).toBe(19000); // 20000 * 0.95
  });

  it('computes a deadline offset by the playbook entry deadlineDays', () => {
    const now = new Date('2026-08-31T00:00:00Z').getTime();
    const rec = buildRecommendation(row({ check_type: 'ar_collection_risk' }), now);
    expect(rec.deadline).toBe(new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString());
  });

  it('cites the actual evidence fields, not invented facts', () => {
    const r = row({
      check_type: 'doc_invoice_mismatch',
      source_table: 'ironclad_clm_source.invoice_pdfs',
      amount_at_risk: 500,
    });
    const rec = buildRecommendation(r);
    expect(rec.rationale).toContain('check_type=doc_invoice_mismatch');
    expect(rec.rationale).toContain('source_table=ironclad_clm_source.invoice_pdfs');
    expect(rec.rationale).toContain('amount_at_risk=500');
  });
});
