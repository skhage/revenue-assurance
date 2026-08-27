// Row shape returned by the canonical workflow queue API.
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
  case_version: number;
}

export interface RootCauseSummary {
  check_type: string;
  exception_count: number;
  amount_at_risk: number;
}

export interface KpiSummary {
  open_exceptions: number;
  total_at_risk: number;
  high_severity: number;
  accounts_affected: number;
}
