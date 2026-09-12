import { describe, it, expect } from 'vitest';
import {
  amountScore,
  severityScore,
  ageScore,
  evidenceScore,
  scoreException,
  rankExceptions,
  SCORING_WEIGHTS,
} from './scoring';
import type { ExceptionRow } from '../types';

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

describe('weights', () => {
  it('sum to 100', () => {
    expect(SCORING_WEIGHTS.amount + SCORING_WEIGHTS.severity + SCORING_WEIGHTS.age + SCORING_WEIGHTS.evidence).toBe(
      100
    );
  });
});

describe('amountScore', () => {
  it('returns 0 for a non-positive amount or empty comparison set', () => {
    expect(amountScore(0, [100, 200])).toBe(0);
    expect(amountScore(100, [])).toBe(0);
  });

  it('scores the largest amount at the full weight', () => {
    expect(amountScore(1000, [10, 100, 1000])).toBe(SCORING_WEIGHTS.amount);
  });

  it('scores a mid-range amount lower than the max', () => {
    const mid = amountScore(100, [10, 100, 1000]);
    const max = amountScore(1000, [10, 100, 1000]);
    expect(mid).toBeLessThan(max);
    expect(mid).toBeGreaterThan(0);
  });
});

describe('severityScore', () => {
  it('ranks HIGH > MEDIUM > LOW/unknown', () => {
    expect(severityScore('HIGH')).toBe(25);
    expect(severityScore('MEDIUM')).toBeCloseTo(13, 0);
    expect(severityScore('LOW')).toBe(0);
    expect(severityScore(null)).toBe(0);
  });
});

describe('ageScore', () => {
  const now = new Date('2026-08-31T00:00:00Z').getTime();

  it('is 0 when there is no case yet', () => {
    expect(ageScore(null, now)).toBe(0);
  });

  it('caps at the age weight for cases open 30+ days', () => {
    const old = new Date(now - 40 * 24 * 60 * 60 * 1000).toISOString();
    expect(ageScore(old, now)).toBe(SCORING_WEIGHTS.age);
  });

  it('scales linearly under 30 days', () => {
    const fifteenDaysAgo = new Date(now - 15 * 24 * 60 * 60 * 1000).toISOString();
    expect(ageScore(fifteenDaysAgo, now)).toBeCloseTo(SCORING_WEIGHTS.age / 2, 0);
  });
});

describe('evidenceScore', () => {
  it('rewards known leakage and rule-based detection most', () => {
    expect(evidenceScore(true, 'rule_based')).toBe(20);
    expect(evidenceScore(true, 'ai_extracted')).toBe(16);
    expect(evidenceScore(false, 'rule_based')).toBe(8);
    expect(evidenceScore(false, 'unknown')).toBe(0);
  });

  it('never exceeds the evidence weight', () => {
    expect(evidenceScore(true, 'rule_based')).toBeLessThanOrEqual(SCORING_WEIGHTS.evidence);
  });
});

describe('scoreException / rankExceptions', () => {
  it('produces a score within [0, 100] and a recommended analyst/queue', () => {
    const scored = scoreException(row(), null, [10000]);
    expect(scored.score).toBeGreaterThanOrEqual(0);
    expect(scored.score).toBeLessThanOrEqual(100);
    expect(scored.recommendedAnalyst).toBeTruthy();
    expect(scored.recommendedQueue).toBeTruthy();
  });

  it('ranks a HIGH-severity, high-amount, known-leakage exception above a LOW-severity one', () => {
    const rows = [
      row({ exception_id: 'a', severity: 'HIGH', amount_at_risk: 50000, known_leakage_flag: true }),
      row({
        exception_id: 'b',
        severity: 'LOW',
        amount_at_risk: 100,
        known_leakage_flag: false,
        detection_method: 'ai_extracted',
      }),
    ];
    const ranked = rankExceptions(rows, new Map());
    expect(ranked[0].exception_id).toBe('a');
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });

  it('is deterministic across repeated calls with the same input', () => {
    const rows = [row({ exception_id: 'a' }), row({ exception_id: 'b', check_type: 'unauthorized_discount' })];
    const first = rankExceptions(rows, new Map());
    const second = rankExceptions(rows, new Map());
    expect(first).toEqual(second);
  });
});
