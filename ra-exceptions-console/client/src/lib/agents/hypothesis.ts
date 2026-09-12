// Exception Investigation agent — builds a cited, deterministic root-cause
// hypothesis from the same `exception_detail` evidence the drawer already
// shows (see config/queries/exception_detail.sql). "Cited" means every claim
// in the hypothesis text names the literal evidence field it came from; no
// fact here is invented or model-generated.

import type { CheckType } from './types';
import type { Hypothesis } from './types';
import { playbookFor } from './playbook';

/** Row shape returned by the `exception_detail` named query (see shared/appkit-types/analytics.d.ts). */
export interface ExceptionDetailRow {
  exception_id: string;
  reference_id: string;
  account_name: string;
  check_type: string;
  severity: string;
  amount_at_risk: number;
  detection_method: string;
  source_table: string;
  customer_id: number;
  known_leakage_flag: boolean;
  risk_tier: string | null;
  composite_health_score: number | null;
  arpu_tier: string | null;
  billing_currency: string | null;
  account_status: string | null;
  price_accuracy_score: number | null;
  discount_compliance_score: number | null;
  collection_efficiency_score: number | null;
  doc_consistency_score: number | null;
  customer_total_exceptions: number | null;
  customer_total_at_risk: number | null;
}

type ScoreField =
  | 'price_accuracy_score'
  | 'discount_compliance_score'
  | 'collection_efficiency_score'
  | 'doc_consistency_score'
  | 'composite_health_score';

/** rev_rec_timing_mismatch has no dedicated component score, so it falls back to the composite. */
const SCORE_FIELD_BY_CHECK: Record<CheckType, ScoreField> = {
  contract_price_mismatch: 'price_accuracy_score',
  unauthorized_discount: 'discount_compliance_score',
  expired_quote_active: 'discount_compliance_score',
  ar_collection_risk: 'collection_efficiency_score',
  rev_rec_timing_mismatch: 'composite_health_score',
  doc_contract_mismatch: 'doc_consistency_score',
  doc_invoice_mismatch: 'doc_consistency_score',
};

const SCORE_LABEL: Record<ScoreField, string> = {
  price_accuracy_score: 'price_accuracy_score',
  discount_compliance_score: 'discount_compliance_score',
  collection_efficiency_score: 'collection_efficiency_score',
  doc_consistency_score: 'doc_consistency_score',
  composite_health_score: 'composite_health_score',
};

export function computeConfidence(detail: ExceptionDetailRow): number {
  let score = detail.detection_method === 'rule_based' ? 80 : detail.detection_method === 'ai_extracted' ? 60 : 50;
  if (detail.known_leakage_flag) score += 15;
  const tier = (detail.risk_tier ?? '').toUpperCase();
  if (tier === 'RED') score += 5;
  else if (tier === 'AMBER') score += 2;
  return Math.max(0, Math.min(100, score));
}

export function buildHypothesis(detail: ExceptionDetailRow): Hypothesis {
  const scoreField = SCORE_FIELD_BY_CHECK[detail.check_type as CheckType] ?? 'composite_health_score';
  const scoreValue = detail[scoreField];
  const confidence = computeConfidence(detail);
  const riskTier = detail.risk_tier ?? 'unscored';

  const citedFields = ['check_type', 'source_table', 'risk_tier', SCORE_LABEL[scoreField]];
  const text =
    `check_type=${detail.check_type}, source_table=${detail.source_table}, risk_tier=${riskTier}, ` +
    `${SCORE_LABEL[scoreField]}=${scoreValue ?? 'n/a'} ⇒ this exception is consistent with a ` +
    `${detail.detection_method === 'ai_extracted' ? 'document-extraction' : 'rule-based'} leakage pattern ` +
    `for ${detail.check_type.replace(/_/g, ' ')}.`;

  const nextStep = playbookFor(detail.check_type).action;

  return { text, confidence, citedFields, nextStep };
}
