-- =============================================================================
-- Silver Layer: Rule-Based Reconciliation Checks
-- Lakeflow Declarative Pipeline source (ADR-004). Part of `ra_medallion_pipeline`.
--
-- CATALOG PARAMETERIZATION (no hardcoded `cdm_tmforum` anywhere in this file):
--   The pipeline's `catalog` setting is bound to ${var.catalog} in
--   resources/reconciliation_pipeline.yml. Every read below is written as a
--   TWO-part name (`schema.table`), which Unity Catalog resolves against the
--   pipeline's current catalog:
--     "If the name is qualified with a schema, Databricks attempts to resolve
--      the table in the current catalog."
--   Outputs are UNQUALIFIED, so they publish to ${var.catalog}.${var.schema}.
--   Retargeting the whole layer to another catalog is therefore a one-line
--   change to the bundle variable — no find/replace in the SQL.
--
-- DATASET REFERENCES: in-pipeline datasets are referenced by bare name, which
--   is what creates the DAG edge. The deprecated LIVE schema is not used (it is
--   silently ignored in default publishing mode).
--
-- READ-ONLY CONTRACT: reads touch only tmf_* (golden, read-only) and *_source
--   (simulated upstream). Writes go only to the RA schema.
--
-- DQ EXPECTATIONS: inline `CONSTRAINT ... EXPECT` per demo-artifacts/08-test-plan.md
--   §2. Note that a materialized view carrying expectations is fully refreshed
--   on each update and does not support incremental refresh — an accepted
--   trade-off here, since DQ-as-code is a core demo beat (ADR-004 rationale).
--   Expectation expressions cannot contain aggregates or subqueries, so the
--   set-level DQ-1 source-volume and DQ-5 uniqueness checks live in
--   dq_audit.sql. DQ-9 is enforced by row-level expectations in the document
--   intelligence pipeline file.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- Contract Price Reconciliation
-- Contracted UnitPrice (Salesforce, the negotiated source of truth) vs actual
-- billed unit price (Oracle ERP's independent circuit-rate extract). Detects
-- price_mismatch where the two systems disagree on what a circuit costs.
--
-- INDEPENDENCE: `leakage_flag` on contract_line_item is ground-truth metadata
--   only (for `known_leakage_flag` downstream) — this check does NOT read it.
--   `price_mismatch_pct` and `reconciliation_status` below are derived purely
--   by comparing contracted_price to billed_unit_price, two independently
--   generated cross-system values (see data-sim/simulate_source_systems.py
--   section 4/5). A >1% relative divergence is what flags the row, matching
--   how a real price audit would work.
--
-- DQ-2: customer_id resolvable; billed rate present; amount at risk non-negative.
--   Action: warn (default, no ON VIOLATION) — invalid rows are still written
--   and surface in the event log, which is the point: the demo shows the
--   breach rather than silently hiding it.
-- -----------------------------------------------------------------------------
CREATE OR REFRESH MATERIALIZED VIEW silver_contract_price_reconciliation (
  CONSTRAINT dq2_customer_id_resolvable
    EXPECT (customer_id IS NOT NULL),
  CONSTRAINT dq2_billed_rate_resolvable
    EXPECT (billed_unit_price IS NOT NULL),
  CONSTRAINT dq2_amount_at_risk_non_negative
    EXPECT (estimated_amount_at_risk >= 0)
)
COMMENT 'Compares contracted circuit prices (salesforce_source.contract_line_item.UnitPrice, the negotiated source of truth) against the independently-derived billed unit price (oracle_erp_source.ra_billed_circuit_rates). Flags price_mismatch where the two systems disagree by more than 1% -- computed purely from the arithmetic comparison, not a leakage flag.'
AS
WITH contract_lines AS (
  SELECT
    cli.Id AS line_item_id,
    cli.Contract__c AS contract_id,
    cli.Service_Circuit_Id__c,
    cli.ProductCode,
    cli.UnitPrice AS contracted_price,
    cli.leakage_flag AS known_leakage_flag,
    c.AccountId,
    c.TMF_Customer_Id__c AS customer_id,
    c.ContractNumber
  FROM salesforce_source.contract_line_item cli
  JOIN salesforce_source.contract c
    ON cli.Contract__c = c.Id
),
-- price_mismatch_pct computed exactly once; every downstream flag reads it
-- back instead of re-deriving the ABS(...)/NULLIF(...) expression.
priced AS (
  SELECT
    cl.*,
    billed.BILLED_UNIT_PRICE AS billed_unit_price,
    ABS(cl.contracted_price - billed.BILLED_UNIT_PRICE)
      / NULLIF(cl.contracted_price, 0) AS price_mismatch_pct
  FROM contract_lines cl
  LEFT JOIN oracle_erp_source.ra_billed_circuit_rates billed
    ON billed.SERVICE_CIRCUIT_ID = cl.Service_Circuit_Id__c
    AND billed.SOURCE_CONTRACT_ID = cl.contract_id
)
SELECT
  p.line_item_id,
  p.contract_id,
  p.ContractNumber,
  p.Service_Circuit_Id__c,
  p.ProductCode,
  p.contracted_price,
  p.billed_unit_price,
  p.known_leakage_flag,
  p.customer_id,
  a.Name AS account_name,
  xw.SOURCE_PARTY_ID AS salesforce_account_id,
  p.price_mismatch_pct,
  CASE WHEN p.price_mismatch_pct > 0.01 THEN 'price_mismatch' ELSE NULL END AS leakage_flag,
  CASE WHEN p.price_mismatch_pct > 0.01 THEN 'LEAKAGE_CONFIRMED' ELSE 'CLEAN' END AS reconciliation_status,
  ABS(p.contracted_price - p.billed_unit_price) AS estimated_amount_at_risk,
  'rule_based' AS detection_method
FROM priced p
LEFT JOIN salesforce_source.account a
  ON p.AccountId = a.Id
LEFT JOIN mdm_source.customer_crosswalk xw
  ON xw.MASTER_CUSTOMER_ID = p.customer_id
  AND xw.SOURCE_SYSTEM = 'SALESFORCE';


-- -----------------------------------------------------------------------------
-- Discount Authorization Check
-- Applied discount vs approved ceiling. Flags unauthorized discounts.
--
-- DQ: discount percentages must sit in a sane 0-100 range, and the computed
--   overrun must never be negative (a negative overrun would mean the check
--   inverted its own comparison). Action: warn.
-- -----------------------------------------------------------------------------
CREATE OR REFRESH MATERIALIZED VIEW silver_discount_authorization_check (
  CONSTRAINT dq_applied_discount_pct_in_range
    EXPECT (applied_discount_pct IS NULL OR (applied_discount_pct BETWEEN 0 AND 100)),
  CONSTRAINT dq_discount_overrun_non_negative
    EXPECT (discount_overrun_amount >= 0)
)
COMMENT 'Checks that applied discounts on quote lines do not exceed the deal-desk approved ceiling from discount_approval__c. Also flags expired quotes still marked Approved.'
AS
SELECT
  ql.Id AS quote_line_id,
  q.Id AS quote_id,
  q.SBQQ__Account__c AS account_id,
  a.Name AS account_name,
  a.TMF_Customer_Id__c AS customer_id,
  ql.SBQQ__Product__c AS product_id,
  ql.SBQQ__Discount__c AS applied_discount_pct,
  da.Approved_Discount_Pct__c AS approved_discount_pct,
  q.SBQQ__ExpirationDate__c AS quote_expiration_date,
  q.SBQQ__Status__c AS quote_status,
  -- Unauthorized discount: applied > approved
  CASE
    WHEN ql.SBQQ__Discount__c > da.Approved_Discount_Pct__c THEN TRUE
    ELSE FALSE
  END AS unauthorized_discount,
  -- Expired quote still active
  CASE
    WHEN q.SBQQ__Status__c = 'Accepted'
      AND q.SBQQ__ExpirationDate__c < current_date()
    THEN TRUE
    ELSE FALSE
  END AS expired_quote_still_active,
  -- Amount at risk
  CASE
    WHEN ql.SBQQ__Discount__c > da.Approved_Discount_Pct__c
    THEN ql.SBQQ__CustomerPrice__c * (ql.SBQQ__Discount__c - da.Approved_Discount_Pct__c) / 100.0
    ELSE 0.0
  END AS discount_overrun_amount,
  'rule_based' AS detection_method
FROM salesforce_source.sbqq__quoteline__c ql
JOIN salesforce_source.sbqq__quote__c q
  ON ql.SBQQ__Quote__c = q.Id
JOIN salesforce_source.discount_approval__c da
  ON da.Quote__c = q.Id
LEFT JOIN salesforce_source.account a
  ON q.SBQQ__Account__c = a.Id;


-- -----------------------------------------------------------------------------
-- FX Rate Validation
-- Checks that the rate billing actually applied to a non-USD invoice
-- (oracle_erp_source.ra_customer_trx_all.APPLIED_EXCHANGE_RATE) matches the
-- Refinitiv market rate for that currency/date. Flags > 1% deviation.
--
-- INDEPENDENCE: both sides come from data-sim, but through unrelated formulas
--   (see simulate_source_systems.py) — APPLIED_EXCHANGE_RATE is not copied
--   from CONVERSION_RATE, so a real divergence must be injected for the two to
--   differ. USD invoices carry APPLIED_EXCHANGE_RATE = 1.0 and are excluded
--   from the deviation flag (there's no conversion to validate).
--
-- DQ: a matched market rate must be positive. A NULL rate means no Refinitiv
--   quote for that currency/date — legitimate and worth seeing, so this warns
--   rather than drops.
-- -----------------------------------------------------------------------------
CREATE OR REFRESH MATERIALIZED VIEW silver_fx_rate_validation (
  CONSTRAINT dq_market_rate_positive
    EXPECT (market_rate IS NULL OR market_rate > 0),
  CONSTRAINT dq_invoice_currency_present
    EXPECT (INVOICE_CURRENCY_CODE IS NOT NULL)
)
COMMENT 'Validates the FX rate billing actually applied to non-USD invoices (ra_customer_trx_all.APPLIED_EXCHANGE_RATE) against the independently-sourced Refinitiv market rate for that currency/date. Flags conversions deviating > 1% from market.'
AS
SELECT
  trx.CUSTOMER_TRX_ID,
  trx.TRX_NUMBER,
  trx.TRX_DATE,
  trx.INVOICE_CURRENCY_CODE,
  trx.INVOICE_AMOUNT,
  trx.APPLIED_EXCHANGE_RATE AS applied_rate,
  fx.CONVERSION_RATE AS market_rate,
  fx.CONVERSION_DATE,
  fx.SOURCE AS rate_source,
  ABS(trx.APPLIED_EXCHANGE_RATE - fx.CONVERSION_RATE)
    / NULLIF(fx.CONVERSION_RATE, 0) AS rate_deviation_pct,
  CASE
    WHEN trx.INVOICE_CURRENCY_CODE != 'USD'
      AND ABS(trx.APPLIED_EXCHANGE_RATE - fx.CONVERSION_RATE) / NULLIF(fx.CONVERSION_RATE, 0) > 0.01
    THEN TRUE
    ELSE FALSE
  END AS rate_deviation_flag,
  'rule_based' AS detection_method
FROM oracle_erp_source.ra_customer_trx_all trx
LEFT JOIN refinitiv_fx_source.gl_daily_rates fx
  ON fx.FROM_CURRENCY = trx.INVOICE_CURRENCY_CODE
  AND fx.TO_CURRENCY = 'USD'
  AND fx.CONVERSION_DATE = trx.TRX_DATE;


-- -----------------------------------------------------------------------------
-- AR Aging Analysis
-- Identifies collection risk: DSO, overdue accounts, worsening aging.
--
-- DQ-3: `total_outstanding` >= 0 and `collection_risk` in {LOW, MEDIUM, HIGH}.
--   Action: DROP ROW — the test plan specifies "drop invalid". This is the one
--   check where a bad row would corrupt a headline number: total_outstanding
--   flows straight into `amount_at_risk` on the ~$500M ar_collection_risk slice
--   of the register, so a negative value must not reach gold.
-- -----------------------------------------------------------------------------
CREATE OR REFRESH MATERIALIZED VIEW silver_ar_aging_analysis (
  CONSTRAINT dq3_total_outstanding_non_negative
    EXPECT (total_outstanding >= 0) ON VIOLATION DROP ROW,
  CONSTRAINT dq3_collection_risk_in_expected_set
    EXPECT (collection_risk IN ('LOW', 'MEDIUM', 'HIGH')) ON VIOLATION DROP ROW
)
COMMENT 'Analyzes accounts receivable aging from ar_payment_schedules_all. Calculates DSO, flags 90+ day overdue accounts, and quantifies collection risk by customer.'
AS
SELECT
  ps.BILL_TO_CUSTOMER_ID,
  hz.PARTY_NAME AS customer_name,
  hz.TMF_CUSTOMER_ID AS customer_id,
  ps.AGING_BUCKET,
  COUNT(*) AS invoice_count,
  SUM(ps.AMOUNT_DUE_REMAINING) AS total_outstanding,
  SUM(ps.AMOUNT_DUE_ORIGINAL) AS total_billed,
  -- DSO approximation: outstanding / (total_billed / days_in_period)
  CASE
    WHEN SUM(ps.AMOUNT_DUE_ORIGINAL) > 0
    THEN ROUND(SUM(ps.AMOUNT_DUE_REMAINING) / (SUM(ps.AMOUNT_DUE_ORIGINAL) / 365.0), 1)
    ELSE 0.0
  END AS estimated_dso_days,
  -- Risk classification
  CASE
    WHEN ps.AGING_BUCKET IN ('61-90', '90+') THEN 'HIGH'
    WHEN ps.AGING_BUCKET = '31-60' THEN 'MEDIUM'
    ELSE 'LOW'
  END AS collection_risk,
  'rule_based' AS detection_method
FROM oracle_erp_source.ar_payment_schedules_all ps
JOIN oracle_erp_source.hz_cust_accounts hz
  ON ps.BILL_TO_CUSTOMER_ID = hz.CUST_ACCOUNT_ID
WHERE ps.STATUS = 'OP'
GROUP BY ALL;


-- -----------------------------------------------------------------------------
-- Revenue Recognition Check
-- ASC-606 recognition schedule vs GL postings, compared at a COMPATIBLE grain.
--
-- GRAIN FIX: the prior version summed RECOGNIZED_AMOUNT by the schedule row's
--   OWN period (its ratable 1/12th recognition month) and compared that to
--   GL's full invoice-total posting in the INVOICE's month. Those are
--   different cohorts of invoices — a given period's rev-rec total blends
--   1/12th slices from up to 12 trailing invoice cohorts, while GL's total for
--   that same period is 100% of that one month's invoices. Comparing them
--   produced a large structural variance on almost every period that had
--   nothing to do with an actual timing error (verified live: 3-60% variance
--   even on clean data). Fixed by grouping the recognition schedule by the
--   ORIGINATING invoice's period (joining back to ra_customer_trx_all) so both
--   sides represent "total revenue attributable to invoices billed in period
--   X" — the same cohort, the same grain. On clean data these two totals are
--   equal by construction (the 12 ratable slices of an invoice sum to its
--   full billed amount); a real mismatch now only appears where the GL side
--   was independently modified (e.g. the forecast-anomaly GL step-change,
--   which intentionally does NOT touch the recognition schedule) or where a
--   billed invoice has no corresponding schedule at all.
--
-- DQ: every row must carry a period label, otherwise the rev-rec variance
--   cannot be attributed to a close period (and `reference_id` in the register
--   would be NULL). Action: warn.
-- -----------------------------------------------------------------------------
CREATE OR REFRESH MATERIALIZED VIEW silver_revenue_recognition_check (
  CONSTRAINT dq_period_name_present
    EXPECT (PERIOD_NAME IS NOT NULL)
)
COMMENT 'Compares the ASC-606 revenue recognition schedule against GL journal postings at a compatible grain: both sides are grouped by the ORIGINATING invoice period, so a period''s full recognition-schedule total (the sum of all 12 ratable slices for invoices billed that period) is compared against that same period''s GL revenue posting. Flags timing mismatches where the two diverge, e.g. from the forecast-anomaly GL step-change or an unscheduled invoice.'
AS
WITH rev_rec_by_origination_period AS (
  SELECT
    DATE_FORMAT(t.TRX_DATE, 'MMM-yy') AS PERIOD_NAME,
    SUM(r.RECOGNIZED_AMOUNT) AS scheduled_recognized_total,
    SUM(CASE WHEN r.STATUS = 'RECOGNIZED' THEN r.RECOGNIZED_AMOUNT ELSE 0 END) AS recognized_to_date,
    SUM(CASE WHEN r.STATUS = 'DEFERRED' THEN r.RECOGNIZED_AMOUNT ELSE 0 END) AS deferred_to_date,
    COUNT(*) AS schedule_entries
  FROM oracle_erp_source.revenue_recognition_schedule r
  JOIN oracle_erp_source.ra_customer_trx_all t
    ON t.CUSTOMER_TRX_ID = r.CUSTOMER_TRX_ID
  GROUP BY DATE_FORMAT(t.TRX_DATE, 'MMM-yy')
),
gl_revenue_by_period AS (
  SELECT
    h.PERIOD_NAME,
    SUM(l.ENTERED_CR) AS gl_revenue_posted
  FROM oracle_erp_source.gl_je_lines l
  JOIN oracle_erp_source.gl_je_headers h
    ON l.JE_HEADER_ID = h.JE_HEADER_ID
  JOIN oracle_erp_source.gl_code_combinations cc
    ON l.CODE_COMBINATION_ID = cc.CODE_COMBINATION_ID
  WHERE cc.ACCOUNT = '4000'  -- Revenue account
  GROUP BY h.PERIOD_NAME
)
SELECT
  COALESCE(rr.PERIOD_NAME, gl.PERIOD_NAME) AS PERIOD_NAME,
  rr.scheduled_recognized_total,
  rr.recognized_to_date,
  rr.deferred_to_date,
  rr.schedule_entries,
  gl.gl_revenue_posted,
  -- Variance between the full recognition-schedule total and GL posting,
  -- both anchored to the same invoice-origination period.
  COALESCE(rr.scheduled_recognized_total, 0) - COALESCE(gl.gl_revenue_posted, 0) AS recognition_variance,
  -- Flag material variance (> 5% difference)
  CASE
    WHEN ABS(COALESCE(rr.scheduled_recognized_total, 0) - COALESCE(gl.gl_revenue_posted, 0))
         / NULLIF(GREATEST(rr.scheduled_recognized_total, gl.gl_revenue_posted), 0) > 0.05
    THEN TRUE
    ELSE FALSE
  END AS material_timing_mismatch,
  'rule_based' AS detection_method
FROM rev_rec_by_origination_period rr
FULL OUTER JOIN gl_revenue_by_period gl
  ON rr.PERIOD_NAME = gl.PERIOD_NAME;
