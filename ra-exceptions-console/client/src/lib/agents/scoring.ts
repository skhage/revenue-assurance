// Smart Prioritization & Routing agent — deterministic scoring, no ML model.
// Weights are fixed and documented so the ranking is explainable in a demo:
// amount 35 + severity 25 + age 20 + evidence 20 = 100 max.

import type { ExceptionRow } from '../types';
import type { PriorityScore } from './types';
import { recommendAnalyst } from './roster';

const WEIGHTS = { amount: 35, severity: 25, age: 20, evidence: 20 } as const;

/**
 * Percentile rank of `amount` within `allAmounts`, log-scaled so one outlier
 * doesn't flatten every other score, then scaled to the amount weight.
 */
export function amountScore(amount: number, allAmounts: number[]): number {
  const positive = allAmounts.filter((a) => a > 0);
  if (positive.length === 0 || amount <= 0) return 0;
  const logged = positive.map((a) => Math.log1p(a));
  const target = Math.log1p(amount);
  const belowOrEqual = logged.filter((v) => v <= target).length;
  const percentile = belowOrEqual / logged.length; // (0, 1]
  return Math.round(percentile * WEIGHTS.amount * 10) / 10;
}

export function severityScore(severity: string | null | undefined): number {
  const key = (severity ?? '').toUpperCase();
  if (key === 'HIGH') return WEIGHTS.severity;
  if (key === 'MEDIUM') return Math.round(WEIGHTS.severity * 0.52 * 10) / 10; // 13
  return 0;
}

/** `caseCreatedAt` is null when no case has been opened yet (nothing to age). */
export function ageScore(caseCreatedAt: string | null, now: number = Date.now()): number {
  if (!caseCreatedAt) return 0;
  const created = new Date(caseCreatedAt).getTime();
  if (!Number.isFinite(created)) return 0;
  const days = Math.max(0, (now - created) / (1000 * 60 * 60 * 24));
  return Math.round(Math.min(days / 30, 1) * WEIGHTS.age * 10) / 10;
}

export function evidenceScore(knownLeakageFlag: boolean, detectionMethod: string | null | undefined): number {
  const flagPoints = knownLeakageFlag ? 12 : 0;
  const methodPoints = detectionMethod === 'rule_based' ? 8 : detectionMethod === 'ai_extracted' ? 4 : 0;
  return Math.min(flagPoints + methodPoints, WEIGHTS.evidence);
}

export function scoreException(
  row: ExceptionRow,
  caseCreatedAt: string | null,
  allAmounts: number[],
  openCountByAnalyst: Map<string, number> = new Map()
): PriorityScore {
  const breakdown = {
    amount: amountScore(row.amount_at_risk, allAmounts),
    severity: severityScore(row.severity),
    age: ageScore(caseCreatedAt),
    evidence: evidenceScore(row.known_leakage_flag, row.detection_method),
  };
  const score = Math.round((breakdown.amount + breakdown.severity + breakdown.age + breakdown.evidence) * 10) / 10;
  const { analyst, queue } = recommendAnalyst(row.check_type, openCountByAnalyst);
  return {
    exception_id: row.exception_id,
    score,
    breakdown,
    recommendedAnalyst: analyst,
    recommendedQueue: queue,
  };
}

/**
 * Ranks a batch of exceptions highest-score-first. `caseCreatedAtById` supplies
 * per-exception case-open timestamps where known (from Lakebase); exceptions
 * with no case yet score 0 on the age component.
 */
export function rankExceptions(rows: ExceptionRow[], caseCreatedAtById: Map<string, string | null>): PriorityScore[] {
  const allAmounts = rows.map((r) => r.amount_at_risk);
  const openCountByAnalyst = new Map<string, number>();
  const scores: PriorityScore[] = [];
  for (const row of rows) {
    const caseCreatedAt = caseCreatedAtById.get(row.exception_id) ?? null;
    const scored = scoreException(row, caseCreatedAt, allAmounts, openCountByAnalyst);
    openCountByAnalyst.set(scored.recommendedAnalyst, (openCountByAnalyst.get(scored.recommendedAnalyst) ?? 0) + 1);
    scores.push(scored);
  }
  return scores.sort((a, b) => b.score - a.score);
}

export const SCORING_WEIGHTS = WEIGHTS;
