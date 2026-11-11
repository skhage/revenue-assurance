// Row shape returned by exceptions_list.sql (kept in sync with the query).
export interface ExceptionRow {
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
  status: string;
  assignee: string | null;
}

export interface KpiSummary {
  open_exceptions: number;
  total_at_risk: number;
  high_severity: number;
  accounts_affected: number;
  recovered_amount: number;
  recovered_count: number;
}

// Triage types — from UC functions built by @ai-engineer (RA-AI-BUILD-TRIAGE).

export type TriagePriority = 'P1' | 'P2' | 'P3' | 'P4';

export interface TriageClassification {
  priority: TriagePriority;
  urgency_score: number;
  assigned_analyst: string;
  rationale: string;
  sla_hours: number;
}

export interface PlaybookStep {
  step_number: number;
  action: string;
  data_source: string;
  query_hint: string;
  escalation_trigger: string;
}

export interface P1Summary {
  p1_count: number;
  p1_amount: number;
}

export interface PriorityDistribution {
  priority: TriagePriority;
  exception_count: number;
  total_at_risk: number;
}

// Recovery types — from UC functions built by @ai-engineer (RA-AI-RECOVERY-ORCHESTRATOR).

export interface RecoveryOpportunity {
  recovery_rank: number;
  customer_id: number;
  account_name: string;
  risk_tier: string;
  composite_health_score: number;
  total_amount_at_risk: number;
  estimated_recoverable: number;
  recovery_confidence: string;
  top_check_type: string;
  exception_count: number;
  highest_anomaly_score: number;
  action_plan: string;
  assigned_analyst: string;
  sla_target: string;
  escalation_needed: boolean;
}

export interface RecoverySummary {
  opportunity_count: number;
  total_recoverable: number;
  total_at_risk: number;
}

// Alerts types — from UC functions built by @ai-engineer (RA-AI-PREDICTIVE-BUILD).

export type RiskSignal = 'CRITICAL' | 'ELEVATED' | 'WATCH';

export interface EmergingRisk {
  customer_id: number;
  account_name: string;
  risk_tier: string;
  composite_health_score: number;
  total_exceptions: number;
  total_amount_at_risk: number;
  high_priority_count: number;
  dominant_check_type: string;
  max_anomaly_score: number;
  avg_anomaly_score: number;
  anomaly_concentration: number;
  emerging_risk_signal: RiskSignal;
  risk_rationale: string;
}

export interface LeakageAlert {
  alert_id: string;
  alert_type: string;
  severity: string;
  title: string;
  description: string;
  affected_customers: number;
  total_amount_at_risk: number;
  recommended_action: string;
  data_source: string;
  generated_at: string;
}

export interface CriticalSummary {
  critical_count: number;
  critical_amount: number;
}

// Compliance types — from UC functions built by @ai-engineer (RA-AI-COMPLIANCE-BUILD).

export interface ComplianceContract {
  contract_number: string;
  file_name: string;
  customer_id: number;
  account_name: string;
  doc_sla_tier: string;
  db_sla_tier: string;
  doc_term_months: number;
  db_term_months: number;
  doc_auto_renew: boolean;
  doc_status: string;
  sla_mismatch: boolean;
  term_mismatch: boolean;
  auto_renew_mismatch: boolean;
  status_mismatch: boolean;
  total_mismatches: number;
  matched_to_billing: boolean;
  billing_line_items: number;
  billing_amount_at_risk: number;
  compliance_status: string;
  compliance_detail: string;
}

export interface ComplianceStatusCount {
  compliance_status: string;
  contract_count: number;
}

// Adaptive triage types — from UC function built by @ai-engineer (RA-AI-LEARNING-LOOP).

export interface AdaptiveTriageResult {
  adaptive_priority: TriagePriority;
  recommended_method: string;
  recommended_analyst: string;
  expected_recovery_rate: number;
  expected_recovery_value: number;
  expected_hours: number;
  recovery_roi_per_hour: number;
  learning_confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'INSUFFICIENT';
  routing_rationale: string | null;
  compound_risk_flag: boolean;
}

// Partner Settlement types — from UC functions built by @ai-engineer (RA-AI-PARTNER-SETTLEMENT).

export interface PartnerSettlementRecord {
  rev_share_reconciliation_id: number;
  partner_party_role_id: number;
  operator_billed_amount: number;
  partner_reported_amount: number;
  variance_amount: number;
  variance_percentage: number;
  recon_status: string;
  settlement_type: string;
  settlement_severity: string;
  amount_at_risk: number;
  discrepancy_count: number;
  open_discrepancies: number;
  root_causes: string[];
  has_sla_breach: boolean;
  has_escalation: boolean;
  total_gross_revenue: number;
  avg_split_pct: number;
  resolution_deadline_date: string;
  recommended_action: string;
}

export interface PartnerDispute {
  partner_party_role_id: number;
  total_reconciliations: number;
  actionable_recons: number;
  actionable_amount_at_risk: number;
  total_open_discrepancies: number;
  avg_variance_pct: number;
  worst_severity: string;
  any_sla_breach: boolean;
  any_escalation: boolean;
  settlement_types: string[];
  recovery_priority_score: number;
  dispute_strategy: string;
}

export interface PartnerSettlementSummary {
  total_records: number;
  actionable_count: number;
  actionable_amount: number;
  partners_affected: number;
}

// Order-to-Bill types — check type #13 (RA-AI-ORDER-TO-BILL).

export interface OrderToBillSummary {
  total_exceptions: number;
  total_at_risk: number;
  vector_count: number;
  sla_breached_count: number;
}

export interface OrderToBillVector {
  leakage_vector: string;
  severity: string;
  exception_count: number;
  total_at_risk: number;
  sla_breached: number;
  avg_days_since_order: number;
}

export interface OrderToBillException {
  exception_id: number;
  customer_id: number;
  order_id: number;
  order_status: string;
  provisioning_status: string;
  service_state: string;
  service_type: string;
  leakage_vector: string;
  severity: string;
  amount_at_risk: number;
  recommended_action: string;
  is_sla_breached: boolean;
  days_since_order: number;
  recovery_urgency: string;
  annualized_impact: number;
}

// Collections Intelligence types — from gold_collections_optimization (RA-AI-COLLECTIONS-INTEL).

export type CollectionsAction =
  | 'STOP_DUNNING'
  | 'ADJUST_DUNNING'
  | 'REVIEW_WRITE_OFF'
  | 'EXPEDITE_COLLECTION'
  | 'INVESTIGATE';

export interface CollectionsRecord {
  customer_id: number;
  account_name: string;
  customer_segment: string;
  recommended_action: CollectionsAction;
  collections_priority_score: number;
  ra_exception_count: number;
  ra_total_at_risk: number;
  ra_check_types: string[];
  dunning_active_cases: number;
  dunning_active_overdue: number;
  dunning_escalated_cases: number;
  dunning_written_off_amount: number;
  disputed_payment_count: number;
  estimated_recoverable_amount: number;
  has_legal_action: boolean;
  ra_explains_pct_of_overdue: number;
  queue_position: number;
  investigation_guidance: string;
}

export interface CollectionsSummary {
  total_customers: number;
  total_recoverable: number;
  total_at_risk: number;
  total_dunning_cases: number;
  legal_action_count: number;
}

export interface CollectionsActionBreakdown {
  recommended_action: CollectionsAction;
  customer_count: number;
  recoverable: number;
  at_risk: number;
}

// Commission leakage types — from silver_commission_leakage_reconciliation (RA-APP-COMMISSION-TAB).

export type CommissionSubCheckType =
  | 'clawback_failure'
  | 'commission_cap_violation'
  | 'cancelled_order_commission'
  | 'unauthorized_override'
  | 'spec_max_exceeded'
  | 'duplicate_commission';

export interface CommissionRecord {
  commission_id: number;
  customer_id: number;
  sales_agent_id: number;
  product_order_id: number;
  sub_check_type: CommissionSubCheckType;
  amount_at_risk: number;
  commission_paid: number;
  rule_maximum: number | null;
  spec_maximum: number | null;
  commission_status: string;
  commission_type: string;
  clawback_flag: boolean;
  override_flag: boolean;
  split_commission_flag: boolean;
  customer_segment: string;
  product_category: string;
  service_type: string;
  earned_date: string;
  paid_date: string;
  severity: string;
  description: string;
}

export interface CommissionSummary {
  total_exceptions: number;
  total_at_risk: number;
  agents_involved: number;
  clawback_failures: number;
  critical_count: number;
}

export interface CommissionSubTypeBreakdown {
  sub_check_type: CommissionSubCheckType;
  exception_count: number;
  total_at_risk: number;
  agent_count: number;
  severity_mode: string;
}

export interface CommissionAgentSummary {
  sales_agent_id: number;
  exception_count: number;
  total_at_risk: number;
  sub_check_types: string[];
  worst_severity: string;
  clawback_count: number;
  override_count: number;
}

// Billing Dispute types — from gold_billing_dispute_leakage (RA-APP-DISPUTE-TAB).

export type DisputeCheckType =
  | 'over_credit'
  | 'fraud_pattern'
  | 'sla_breach'
  | 'stale_dispute'
  | 'regulatory_escalation'
  | 'reopened_dispute'
  | 'unauthorized_waiver';

export interface DisputeRecord {
  reference_id: string;
  customer_id: number;
  account_name: string;
  check_type: DisputeCheckType;
  severity: string;
  amount_at_risk: number;
  source_table: string;
  detection_method: string;
  known_leakage_flag: boolean;
}

export interface DisputeSummary {
  total_exceptions: number;
  total_at_risk: number;
  customers_affected: number;
  critical_count: number;
  stale_dispute_count: number;
  fraud_pattern_count: number;
}

export interface DisputeCheckTypeBreakdown {
  check_type: DisputeCheckType;
  exception_count: number;
  total_at_risk: number;
  customer_count: number;
  severity_mode: string;
}

export interface DisputeCustomerSummary {
  customer_id: number;
  account_name: string;
  exception_count: number;
  total_at_risk: number;
  check_types: string[];
  worst_severity: string;
  fraud_count: number;
  stale_count: number;
  regulatory_count: number;
}

// Smart Queue / Predictive Recovery types — from UC functions built by @ai-engineer (RA-AI-PREDICTIVE-RECOVERY).

export type UrgencyTier = 'IMMEDIATE' | 'PRIORITY' | 'STANDARD';

export interface SmartQueueItem {
  queue_position: number;
  exception_id: string;
  check_type: string;
  customer_id: number;
  account_name: string;
  amount_at_risk: number;
  predicted_recovery_value: number;
  predicted_recovery_rate: number;
  roi_per_hour: number;
  expected_hours: number;
  urgency_tier: UrgencyTier;
  investigation_starter: string;
}

export interface SmartQueueSummary {
  queue_size: number;
  total_predicted_recovery: number;
  total_at_risk: number;
  avg_roi_per_hour: number;
}

export interface PredictedRecoveryItem {
  opportunity_rank: number;
  exception_id: string;
  check_type: string;
  customer_id: number;
  account_name: string;
  amount_at_risk: number;
  predicted_recovery_rate: number;
  predicted_recovery_value: number;
  confidence: string;
  review_priority: string;
  composite_anomaly_score: number;
  customer_risk_tier: string;
  recovery_reasoning: string;
}

export interface TriageEffectivenessRow {
  check_type: string;
  total_cases: number;
  triage_accuracy_pct: number;
  avg_priority_error: string;
  most_common_misclass: string;
  recommended_adjustment: string;
  recovery_rate_when_accurate: number;
  recovery_rate_when_inaccurate: number;
  accuracy_delta_impact_pct: number;
}

// Prevention Intelligence types — from UC functions built by @ai-engineer (RA-AI-CLOSEDLOOP-RECOVERY-V2).

export type ImplementationComplexity = 'HIGH' | 'MEDIUM' | 'LOW';

export interface PreventionIntelligenceRow {
  prevention_category: string;
  check_type: string;
  systemic_root_cause: string;
  affected_customers: number;
  total_exceptions: number;
  annual_leakage_at_risk: number;
  annual_written_off: number;
  prevention_rate_estimate: number;
  preventable_amount: number;
  recurrence_rate: number;
  avg_detection_to_resolution_hrs: number;
  recommended_control: string;
  implementation_complexity: ImplementationComplexity;
  priority_score: number;
}

export interface PreventionSummary {
  root_cause_count: number;
  total_preventable: number;
  total_written_off: number;
  category_count: number;
  avg_prevention_rate: number;
}

export interface PreventionRuleRow {
  rule_id: string;
  rule_name: string;
  prevention_category: string;
  target_check_types: string;
  trigger_condition: string;
  validation_logic: string;
  enforcement_point: string;
  estimated_annual_prevention: number;
  affected_customer_count: number;
  exception_reduction_pct: number;
  implementation_steps: string;
  data_sources_required: string;
  complexity: ImplementationComplexity;
  roi_score: number;
}

export interface PreventionRoiRow {
  initiative_name: string;
  prevention_category: string;
  check_types_covered: string;
  annual_leakage_prevented: number;
  annual_investigation_cost_saved: number;
  annual_write_off_avoided: number;
  total_annual_benefit: number;
  estimated_implementation_cost: number;
  payback_period_months: number;
  net_roi_pct: number;
  cumulative_benefit: number;
  customers_protected: number;
  exceptions_eliminated: number;
  priority_rank: number;
  recommendation: string;
}

// Contract Compliance types — from UC functions built by @ai-engineer (RA-AI-CONTRACT-COMPLIANCE-AGENT).

export interface ContractViolationRow {
  compliance_check: string;
  severity: string;
  customer_id: number;
  account_name: string;
  contract_number: string;
  finding: string;
  amount_at_risk: number;
  recommended_action: string;
  data_sources: string;
}

export interface ExpiringContractRow {
  urgency: string;
  customer_id: number;
  account_name: string;
  contract_number: string;
  sla_tier: string;
  contract_status: string;
  start_date: string;
  end_date: string;
  days_until_expiry: number;
  term_months: number;
  auto_renew: boolean;
  annual_revenue: number;
  risk_category: string;
  recommended_action: string;
}

export interface LifecycleRiskRow {
  contract_id: string;
  contract_number: string;
  customer_id: number;
  account_name: string;
  sla_tier: string;
  contract_status: string;
  contract_term_months: number;
  start_date: string;
  end_date: string;
  auto_renew: boolean;
  days_to_expiry: number;
  line_item_count: number;
  total_mrr: number;
  risk_type: string;
  risk_score: number;
  risk_detail: string;
  recommended_action: string;
  existing_exceptions: number;
  existing_leakage_amount: number;
}

export interface ContractRiskReportRow {
  section: string;
  section_order: number;
  metric_name: string;
  metric_value: string;
  detail: string;
}

export interface ContractComplianceSummary {
  violation_count: number;
  total_at_risk: number;
  customers_affected: number;
  expiring_count: number;
  high_risk_count: number;
}

// Chat types — for the recovery orchestrator assistant (/api/chat).

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}
