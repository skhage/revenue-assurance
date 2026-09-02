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
