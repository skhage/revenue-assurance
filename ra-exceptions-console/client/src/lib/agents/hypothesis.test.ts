import { describe, it, expect } from 'vitest';
import { buildHypothesis, computeConfidence, type ExceptionDetailRow } from './hypothesis';

function detail(overrides: Partial<ExceptionDetailRow> = {}): ExceptionDetailRow {
  return {
    exception_id: 'exc-1',
    reference_id: 'REF-1',
    account_name: 'Acme Fiber',
    check_type: 'doc_contract_mismatch',
    severity: 'HIGH',
    amount_at_risk: 5000,
    detection_method: 'ai_extracted',
    source_table: 'ironclad_clm_source.contract_pdfs',
    customer_id: 1,
    known_leakage_flag: false,
    risk_tier: 'RED',
    composite_health_score: 42.3,
    arpu_tier: 'Enterprise',
    billing_currency: 'USD',
    account_status: 'Active',
    price_accuracy_score: null,
    discount_compliance_score: null,
    collection_efficiency_score: null,
    doc_consistency_score: 55.1,
    customer_total_exceptions: 4,
    customer_total_at_risk: 12000,
    ...overrides,
  };
}

describe('computeConfidence', () => {
  it('stays within [0, 100]', () => {
    expect(
      computeConfidence(detail({ detection_method: 'rule_based', known_leakage_flag: true, risk_tier: 'RED' }))
    ).toBeLessThanOrEqual(100);
    expect(
      computeConfidence(detail({ detection_method: 'ai_extracted', known_leakage_flag: false, risk_tier: 'GREEN' }))
    ).toBeGreaterThanOrEqual(0);
  });

  it('scores rule_based detection higher than ai_extracted, all else equal', () => {
    const rule = computeConfidence(detail({ detection_method: 'rule_based' }));
    const ai = computeConfidence(detail({ detection_method: 'ai_extracted' }));
    expect(rule).toBeGreaterThan(ai);
  });

  it('boosts confidence for known_leakage_flag and RED risk_tier', () => {
    const base = computeConfidence(detail({ known_leakage_flag: false, risk_tier: 'GREEN' }));
    const boosted = computeConfidence(detail({ known_leakage_flag: true, risk_tier: 'RED' }));
    expect(boosted).toBeGreaterThan(base);
  });
});

describe('buildHypothesis', () => {
  it('cites the literal evidence values it used, not invented facts', () => {
    const h = buildHypothesis(detail());
    expect(h.text).toContain('check_type=doc_contract_mismatch');
    expect(h.text).toContain('source_table=ironclad_clm_source.contract_pdfs');
    expect(h.text).toContain('risk_tier=RED');
    expect(h.text).toContain('doc_consistency_score=55.1');
  });

  it('maps rev_rec_timing_mismatch to the composite score, which has no dedicated component', () => {
    const h = buildHypothesis(detail({ check_type: 'rev_rec_timing_mismatch', composite_health_score: 71 }));
    expect(h.citedFields).toContain('composite_health_score');
    expect(h.text).toContain('composite_health_score=71');
  });

  it('provides a next step matching the recovery playbook action for the check_type', () => {
    const h = buildHypothesis(detail({ check_type: 'ar_collection_risk' }));
    expect(h.nextStep).toMatch(/collections/i);
  });

  it('returns a confidence in [0, 100]', () => {
    const h = buildHypothesis(detail());
    expect(h.confidence).toBeGreaterThanOrEqual(0);
    expect(h.confidence).toBeLessThanOrEqual(100);
  });
});
