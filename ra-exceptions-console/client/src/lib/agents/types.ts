// Shared types for the Agent Workbench. Every "agent" here is deterministic,
// rule-based TypeScript over data the app already reads — there is no LLM or
// model-serving endpoint behind these panels. See DemoBadge for the UI label
// convention that keeps this honest in the product itself.

export type CheckType =
  | 'contract_price_mismatch'
  | 'unauthorized_discount'
  | 'expired_quote_active'
  | 'ar_collection_risk'
  | 'rev_rec_timing_mismatch'
  | 'doc_contract_mismatch'
  | 'doc_invoice_mismatch';

export interface DqAuditRow {
  check_type: string;
  dataset: string;
  expectation_name: string;
  update_id: string | null;
  observed_at: string | null;
  observed_records: number;
  passed_records: number;
  failed_records: number;
  status: 'GREEN' | 'RED';
  expected_condition: string;
}

export type PipelineState = 'unavailable' | 'red' | 'stale' | 'ok';

export interface PipelineHealth {
  state: PipelineState;
  reason: string;
  rows: DqAuditRow[];
  freshestObservedAt: string | null;
}

export interface PriorityScoreBreakdown {
  amount: number;
  severity: number;
  age: number;
  evidence: number;
}

export interface PriorityScore {
  exception_id: string;
  score: number;
  breakdown: PriorityScoreBreakdown;
  recommendedAnalyst: string;
  recommendedQueue: string;
}

export interface Hypothesis {
  text: string;
  confidence: number;
  citedFields: string[];
  nextStep: string;
}

export interface PlaybookEntry {
  checkType: CheckType | 'unknown';
  action: string;
  recoveryPct: number;
  ownerRole: string;
  deadlineDays: number;
}

export interface Recommendation {
  entry: PlaybookEntry;
  expectedRecoveryUsd: number;
  deadline: string;
  rationale: string;
}

/**
 * Blocks downstream agent panels — the Pipeline Reliability agent's veto.
 * `stale` is included: recommending against evidence that might be out of
 * date is exactly the failure mode this gate exists to prevent, so stale
 * evidence fails closed (blocked) rather than rendering with a soft warning.
 */
export function isBlocked(state: PipelineState): boolean {
  return state === 'unavailable' || state === 'red' || state === 'stale';
}
