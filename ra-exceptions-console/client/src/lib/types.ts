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
}
