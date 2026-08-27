-- =============================================================================
-- Gold Layer: Aggregated Intelligence
-- Lakeflow Declarative Pipeline source. Part of `ra_medallion_pipeline`.
--
-- Unified leakage register + per-customer health scorecard. These are the
-- serving surfaces the AI/BI dashboard, Genie, and the RA Exceptions Console
-- read, so the column contract here is load-bearing:
-- ra-exceptions-console/config/queries/*.sql select these names by hand.
--
-- IN-PIPELINE REFERENCES: the silver datasets are referenced by BARE NAME
--   (`silver_ar_aging_analysis`, not a 3-part name). That is what makes these
--   gold views true downstream nodes of the pipeline DAG rather than loose
--   warehouse DDL reading a table that happens to exist.
--
-- known_leakage_flag (this column, below): its NAME is preserved as an
--   app-facing schema contract -- ra-exceptions-console's TypeScript types
--   (shared/appkit-types/analytics.d.ts), server routes
--   (server/routes/analytics.ts), and React components
--   (client/src/pages/CasesPage.tsx, client/src/components/
--   ExceptionDrawer.tsx) all reference this exact column name, and that app
--   is out of scope for this reconciliation-controls work. Substantively,
--   though, every arm below publishes a hardcoded `FALSE` literal, never a
--   value derived from any simulator ground-truth/leakage column -- no
--   "known truth" data actually flows through it. That is what satisfies
--   the audit requirement to remove leakage/truth-flag DATA from production
--   outputs: silver_contract_price_reconciliation (reconciliation/pipelines/
--   silver_reconciliation.sql) no longer even HAS a leakage_flag column to
--   read from, so there is nothing upstream this constant could reflect.
--
-- NOT IN THIS FILE:
--   * `gold_anomaly_scores` — owned by the separate ML workstream. It is NOT
--     defined here and this file does not reference it, so the pipeline is
--     complete and green without it. The AI/BI dashboard does have a tile bound
--     to `gold_anomaly_scores`; that tile will error until the ML workstream
--     lands the object. That is a pre-existing gap, not one introduced here, and
--     no placeholder is invented for it.
--   * Revenue forecasting stays warehouse-executed because `ai_forecast` is not
--     part of this pipeline DAG. The warehouse SQL also owns its DQ-6 checks, so
--     this pipeline has no first-run dependency on that separately built object.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 8. Unified Leakage Summary
-- Union of all silver checks into one register for dashboard consumption.
--
-- DQ-4: `check_type` in the 7 known types; `severity` in {HIGH, MEDIUM};
--   `amount_at_risk` >= 0. Action: FAIL UPDATE — the test plan specifies "fail".
--   This is the correct place to be strict: this register IS the demo's headline
--   number (~48K exceptions / ~$601M at risk) and the app's queue. A bad
--   check_type here silently breaks the dashboard's GROUP BY and the app's
--   filters, so the update should stop rather than publish a corrupt register.
-- -----------------------------------------------------------------------------
CREATE OR REFRESH MATERIALIZED VIEW gold_leakage_summary (
  CONSTRAINT dq4_check_type_in_known_set
    EXPECT (check_type IN (
      'contract_price_mismatch',
      'contract_price_missing_erp',
      'contract_price_missing_salesforce',
      'unauthorized_discount',
      'expired_quote_active',
      'doc_contract_mismatch',
      'doc_invoice_mismatch',
      'rev_rec_timing_mismatch',
      'ar_collection_risk'
    )) ON VIOLATION FAIL UPDATE,
  CONSTRAINT dq4_severity_in_known_set
    EXPECT (severity IN ('HIGH', 'MEDIUM')) ON VIOLATION FAIL UPDATE,
  CONSTRAINT dq4_amount_at_risk_non_negative
    EXPECT (amount_at_risk >= 0) ON VIOLATION FAIL UPDATE
)
COMMENT 'Unified revenue leakage register combining all silver-layer reconciliation checks. Each row is one detected exception with severity, amount at risk, and detection method (rule-based vs AI-extracted).'
AS
-- Contract price mismatches (detected independently from billed vs contracted price).
-- FULL-SIDED: silver_contract_price_reconciliation publishes an explicit
-- reconciliation_status in {MATCHED, MISMATCH, MISSING_ERP,
-- MISSING_SALESFORCE} -- only MATCHED represents "nothing wrong"; every
-- other status is a distinct exception with its own check_type so the
-- register can distinguish a price disagreement from a record that exists
-- on only one side.
SELECT
  'contract_price_mismatch' AS check_type,
  CASE WHEN price_mismatch_pct > 0.05 THEN 'HIGH' ELSE 'MEDIUM' END AS severity,
  customer_id,
  account_name,
  estimated_amount_at_risk AS amount_at_risk,
  'oracle_erp_source.ra_billed_circuit_rates' AS source_table,
  detection_method,
  FALSE AS known_leakage_flag,
  ContractNumber AS reference_id
FROM silver_contract_price_reconciliation
WHERE reconciliation_status = 'MISMATCH'

UNION ALL

-- Contract line exists in Salesforce with no corresponding ERP billed rate
-- -- the full contracted commitment is unbilled/at risk.
SELECT
  'contract_price_missing_erp' AS check_type,
  'HIGH' AS severity,
  customer_id,
  account_name,
  estimated_amount_at_risk AS amount_at_risk,
  'oracle_erp_source.ra_billed_circuit_rates' AS source_table,
  detection_method,
  FALSE AS known_leakage_flag,
  ContractNumber AS reference_id
FROM silver_contract_price_reconciliation
WHERE reconciliation_status = 'MISSING_ERP'

UNION ALL

-- ERP billed rate exists with no corresponding Salesforce contract line --
-- being charged with no contract on file.
SELECT
  'contract_price_missing_salesforce' AS check_type,
  'HIGH' AS severity,
  customer_id,
  account_name,
  estimated_amount_at_risk AS amount_at_risk,
  'oracle_erp_source.ra_billed_circuit_rates' AS source_table,
  detection_method,
  FALSE AS known_leakage_flag,
  CAST(line_item_id AS STRING) AS reference_id
FROM silver_contract_price_reconciliation
WHERE reconciliation_status = 'MISSING_SALESFORCE'

UNION ALL

-- Unauthorized discounts
SELECT
  'unauthorized_discount' AS check_type,
  'HIGH' AS severity,
  customer_id,
  account_name,
  discount_overrun_amount AS amount_at_risk,
  'salesforce_source.sbqq__quoteline__c' AS source_table,
  detection_method,
  FALSE AS known_leakage_flag,
  quote_id AS reference_id
FROM silver_discount_authorization_check
WHERE unauthorized_discount = TRUE

UNION ALL

-- Expired quotes still active. GRAIN FIX: silver_discount_authorization_check
-- is built at quote-LINE grain (one row per sbqq__quoteline__c, ~1-3 lines per
-- quote), but expired_quote_still_active is a quote-level fact (it only
-- depends on the quote's own status/expiration, which is identical across
-- all of a quote's lines). Selecting it unfiltered would emit the same
-- expired quote 1-3 times, inflating the check_type's count in the register
-- and any downstream per-customer rollup. DISTINCT here collapses each
-- expired quote to exactly one row -- safe because customer_id, account_name,
-- and detection_method are all quote-invariant (constant across a quote's lines).
SELECT DISTINCT
  'expired_quote_active' AS check_type,
  'MEDIUM' AS severity,
  customer_id,
  account_name,
  0.0 AS amount_at_risk,
  'salesforce_source.sbqq__quote__c' AS source_table,
  detection_method,
  FALSE AS known_leakage_flag,
  quote_id AS reference_id
FROM silver_discount_authorization_check
WHERE expired_quote_still_active = TRUE

UNION ALL

-- Document-vs-database contract mismatches
SELECT
  'doc_contract_mismatch' AS check_type,
  'HIGH' AS severity,
  CAST(customer_id AS BIGINT) AS customer_id,
  account_name,
  0.0 AS amount_at_risk,
  'ironclad_clm_source.contract_pdfs' AS source_table,
  'ai_extracted' AS detection_method,
  FALSE AS known_leakage_flag,
  doc_contract_number AS reference_id
FROM silver_doc_intelligence_contracts
WHERE total_mismatches > 0

UNION ALL

-- Document-vs-database invoice amount mismatches
SELECT
  'doc_invoice_mismatch' AS check_type,
  'HIGH' AS severity,
  customer_id,
  account_name,
  amount_variance AS amount_at_risk,
  'ironclad_clm_source.invoice_pdfs' AS source_table,
  'ai_extracted' AS detection_method,
  FALSE AS known_leakage_flag,
  doc_invoice_number AS reference_id
FROM silver_doc_intelligence_invoices
WHERE amount_mismatch = TRUE

UNION ALL

-- Revenue recognition timing mismatches
SELECT
  'rev_rec_timing_mismatch' AS check_type,
  'MEDIUM' AS severity,
  NULL AS customer_id,
  NULL AS account_name,
  ABS(recognition_variance) AS amount_at_risk,
  'oracle_erp_source.revenue_recognition_schedule' AS source_table,
  detection_method,
  FALSE AS known_leakage_flag,
  PERIOD_NAME AS reference_id
FROM silver_revenue_recognition_check
WHERE material_timing_mismatch = TRUE

UNION ALL

-- High-risk AR aging (90+ days)
SELECT
  'ar_collection_risk' AS check_type,
  'HIGH' AS severity,
  customer_id,
  customer_name AS account_name,
  total_outstanding AS amount_at_risk,
  'oracle_erp_source.ar_payment_schedules_all' AS source_table,
  detection_method,
  FALSE AS known_leakage_flag,
  CAST(BILL_TO_CUSTOMER_ID AS STRING) AS reference_id
FROM silver_ar_aging_analysis
WHERE collection_risk = 'HIGH';


-- -----------------------------------------------------------------------------
-- 10. Reconciliation Scorecard
-- Per-customer health score for dashboard consumption.
--
-- COVERAGE FIX: the prior version scored only 4 of the 7 reconciliation
--   controls (price, discount/unauthorized, AR/collection, doc-contract) --
--   omitting revenue-recognition, invoice-document mismatch, and expired-quote
--   entirely, despite all three having customer-attributable evidence. All 7
--   controls are now represented as named components, each weighted so the
--   composite still sums to 1.0 (0.20/0.15/0.10/0.20/0.15/0.10/0.10 for
--   price/discount/expired-quote/AR/rev-rec/doc-contract/doc-invoice).
--
-- DQ-5: `composite_health_score` in [0,100]; `risk_tier` in {GREEN, AMBER, RED}.
--   Action: FAIL UPDATE per the test plan. The "one row per scored customer"
--   half of DQ-5 is a set-level uniqueness property — it cannot be expressed as
--   a row expectation (no aggregates or subqueries allowed), so it is enforced by
--   `dq_audit_scorecard_uniqueness` in dq_audit.sql.
--
-- Each component score is computed exactly once (in `scored`) and the
-- composite/risk_tier are derived from that single value, so a future edit
-- can't make risk_tier disagree with composite_health_score.
-- -----------------------------------------------------------------------------
CREATE OR REFRESH MATERIALIZED VIEW gold_reconciliation_scorecard (
  CONSTRAINT dq5_composite_health_score_in_range
    EXPECT (composite_health_score BETWEEN 0 AND 100) ON VIOLATION FAIL UPDATE,
  CONSTRAINT dq5_risk_tier_in_known_set
    EXPECT (risk_tier IN ('GREEN', 'AMBER', 'RED')) ON VIOLATION FAIL UPDATE,
  CONSTRAINT dq5_customer_id_present
    EXPECT (customer_id IS NOT NULL) ON VIOLATION FAIL UPDATE
)
COMMENT 'Per-customer reconciliation health scorecard. Aggregates all seven silver checks into a single score per customer: price accuracy, discount compliance, expired-quote compliance, collection (AR) efficiency, revenue-recognition accuracy, and doc-vs-system consistency (contract + invoice).'
AS
-- price_check is customer-grain, so it can only aggregate rows with a
-- resolvable customer_id. A MISSING_SALESFORCE row has no Salesforce
-- contract line to resolve customer_id from (see silver_contract_price_
-- reconciliation) and is therefore excluded here -- it still surfaces in
-- gold_leakage_summary with customer_id = NULL, consistent with how other
-- checks (e.g. rev_rec_timing_mismatch) represent unattributed exceptions.
-- total_lines/price_exceptions now key off reconciliation_status, not the
-- removed leakage_flag column (see silver_contract_price_reconciliation).
price_check AS (
  SELECT
    customer_id,
    COUNT(*) AS total_lines,
    SUM(CASE WHEN reconciliation_status != 'MATCHED' THEN 1 ELSE 0 END) AS price_exceptions,
    SUM(estimated_amount_at_risk) AS price_risk_amount
  FROM silver_contract_price_reconciliation
  WHERE customer_id IS NOT NULL
  GROUP BY customer_id
),
discount_check AS (
  SELECT
    customer_id,
    COUNT(*) AS total_lines,
    SUM(CASE WHEN unauthorized_discount = TRUE THEN 1 ELSE 0 END) AS discount_exceptions,
    SUM(discount_overrun_amount) AS discount_risk_amount
  FROM silver_discount_authorization_check
  GROUP BY customer_id
),
-- Expired-quote compliance at QUOTE grain (a quote's expiry status is
-- constant across its lines; DISTINCT quote_id avoids counting the same
-- expired quote once per line, matching the fix in gold_leakage_summary).
expired_quote_check AS (
  SELECT
    customer_id,
    COUNT(DISTINCT quote_id) AS total_quotes,
    COUNT(DISTINCT CASE WHEN expired_quote_still_active THEN quote_id END) AS expired_quotes
  FROM silver_discount_authorization_check
  GROUP BY customer_id
),
-- AR EXCEPTION-CONSISTENCY FIX: `ar_risk_amount` sums total_outstanding only
-- for HIGH-risk (exception) aging buckets, matching `ar_exceptions`' count --
-- not every aging bucket regardless of risk. Summing all buckets would put a
-- customer's ENTIRE outstanding balance (including current/LOW-risk
-- receivables) into total_amount_at_risk even when zero buckets are actually
-- flagged as exceptions, inflating exposure for accounts with large but
-- healthy AR alongside a small high-risk sliver.
collection_check AS (
  SELECT
    customer_id,
    SUM(CASE WHEN collection_risk = 'HIGH' THEN total_outstanding ELSE 0 END) AS ar_risk_amount,
    MAX(estimated_dso_days) AS max_dso_days,
    SUM(CASE WHEN collection_risk = 'HIGH' THEN 1 ELSE 0 END) AS ar_exceptions
  FROM silver_ar_aging_analysis
  GROUP BY customer_id
),
-- Revenue-recognition accuracy per customer, built from the SAME full
-- invoice universe as silver_revenue_recognition_check (reconciliation/
-- pipelines/silver_reconciliation.sql) -- not a re-derivation with its own
-- (looser) join. FULL-UNIVERSE FIX: this CTE previously INNER JOINed
-- revenue_recognition_schedule to ra_customer_trx_all, so a GL-only invoice
-- (GL posting exists, no recognition-schedule rows) would be silently
-- absent from this customer rollup even after the silver check itself was
-- fixed to include it -- the scorecard and the silver check would disagree
-- on which invoices count. Fixed by starting from ra_customer_trx_all (the
-- full invoice universe) and LEFT JOINing per-invoice schedule/GL totals
-- with the missing side COALESCEd to 0, exactly mirroring silver's
-- `invoice_level` CTE.
invoice_recognition AS (
  SELECT
    CUSTOMER_TRX_ID,
    SUM(RECOGNIZED_AMOUNT) AS recognized_total
  FROM oracle_erp_source.revenue_recognition_schedule
  GROUP BY CUSTOMER_TRX_ID
),
invoice_gl AS (
  SELECT
    h.CUSTOMER_TRX_ID,
    SUM(l.ENTERED_CR) AS gl_posted
  FROM oracle_erp_source.gl_je_lines l
  JOIN oracle_erp_source.gl_je_headers h ON l.JE_HEADER_ID = h.JE_HEADER_ID
  JOIN oracle_erp_source.gl_code_combinations cc ON l.CODE_COMBINATION_ID = cc.CODE_COMBINATION_ID
  WHERE cc.ACCOUNT = '4000'
  GROUP BY h.CUSTOMER_TRX_ID
),
rev_rec_by_invoice AS (
  SELECT
    t.CUSTOMER_TRX_ID,
    hz.TMF_CUSTOMER_ID AS customer_id,
    COALESCE(ir.recognized_total, 0) AS invoice_recognized_total,
    COALESCE(ig.gl_posted, 0) AS invoice_gl_posted
  FROM oracle_erp_source.ra_customer_trx_all t
  LEFT JOIN oracle_erp_source.hz_cust_accounts hz
    ON t.BILL_TO_CUSTOMER_ID = hz.CUST_ACCOUNT_ID
  LEFT JOIN invoice_recognition ir ON ir.CUSTOMER_TRX_ID = t.CUSTOMER_TRX_ID
  LEFT JOIN invoice_gl ig ON ig.CUSTOMER_TRX_ID = t.CUSTOMER_TRX_ID
),
-- EXCEPTION-CONSISTENCY FIX (matches the AR fix pattern above):
-- rev_rec_risk_amount must sum variance only for invoices that actually
-- BREACH the 5% material-timing threshold, consistent with
-- rev_rec_exceptions' count -- not every invoice's variance regardless of
-- materiality. Summing all variance would put every invoice's rounding
-- noise into total_amount_at_risk even when rev_rec_exceptions = 0 for
-- that customer, inflating exposure for accounts with many small,
-- immaterial timing differences.
rev_rec_check AS (
  SELECT
    customer_id,
    COUNT(*) AS total_invoices,
    SUM(CASE
      WHEN ABS(invoice_recognized_total - invoice_gl_posted)
           / NULLIF(GREATEST(invoice_recognized_total, invoice_gl_posted), 0) > 0.05
      THEN 1 ELSE 0
    END) AS rev_rec_exceptions,
    SUM(CASE
      WHEN ABS(invoice_recognized_total - invoice_gl_posted)
           / NULLIF(GREATEST(invoice_recognized_total, invoice_gl_posted), 0) > 0.05
      THEN ABS(invoice_recognized_total - invoice_gl_posted) ELSE 0
    END) AS rev_rec_risk_amount
  FROM rev_rec_by_invoice
  GROUP BY customer_id
),
doc_contract_check AS (
  SELECT
    customer_id,
    COUNT(*) AS total_docs,
    SUM(CASE WHEN total_mismatches > 0 THEN 1 ELSE 0 END) AS doc_contract_exceptions
  FROM silver_doc_intelligence_contracts
  WHERE customer_id IS NOT NULL
  GROUP BY customer_id
),
doc_invoice_check AS (
  SELECT
    customer_id,
    COUNT(*) AS total_invoice_docs,
    SUM(CASE WHEN amount_mismatch THEN 1 ELSE 0 END) AS doc_invoice_exceptions,
    SUM(CASE WHEN amount_mismatch THEN amount_variance ELSE 0 END) AS doc_invoice_risk_amount
  FROM silver_doc_intelligence_invoices
  WHERE customer_id IS NOT NULL
  GROUP BY customer_id
),
-- Component scores computed exactly once each. Every component is COALESCEd
-- to 100 HERE (not just inside the composite below) -- a customer with no
-- applicable rows in a given check has nothing wrong on that dimension, so
-- the PUBLISHED per-component column must read 100, not NULL. Previously
-- only composite_raw's internal COALESCE covered this: the composite came
-- out correct, but a customer with e.g. zero doc-invoice records would show
-- doc_invoice_consistency_score = NULL in the published scorecard row even
-- though their composite already (correctly) treated it as 100.
scored AS (
  SELECT
    cust.customer_id,
    a.Name AS account_name,
    cust.account_status,
    cust.arpu_tier,
    cust.billing_currency,
    COALESCE(100.0 * (1 - COALESCE(pc.price_exceptions, 0) / NULLIF(pc.total_lines, 0)), 100.0)
      AS price_accuracy_score,
    COALESCE(100.0 * (1 - COALESCE(dc.discount_exceptions, 0) / NULLIF(dc.total_lines, 0)), 100.0)
      AS discount_compliance_score,
    COALESCE(100.0 * (1 - COALESCE(eq.expired_quotes, 0) / NULLIF(eq.total_quotes, 0)), 100.0)
      AS expired_quote_compliance_score,
    CASE
      WHEN COALESCE(cc.max_dso_days, 0) <= 30 THEN 100.0
      WHEN cc.max_dso_days <= 60 THEN 75.0
      WHEN cc.max_dso_days <= 90 THEN 50.0
      ELSE 25.0
    END AS collection_efficiency_score,
    COALESCE(100.0 * (1 - COALESCE(rr.rev_rec_exceptions, 0) / NULLIF(rr.total_invoices, 0)), 100.0)
      AS rev_rec_accuracy_score,
    COALESCE(100.0 * (1 - COALESCE(docc.doc_contract_exceptions, 0) / NULLIF(docc.total_docs, 0)), 100.0)
      AS doc_consistency_score,
    COALESCE(100.0 * (1 - COALESCE(doci.doc_invoice_exceptions, 0) / NULLIF(doci.total_invoice_docs, 0)), 100.0)
      AS doc_invoice_consistency_score,
    COALESCE(pc.price_risk_amount, 0) + COALESCE(dc.discount_risk_amount, 0)
      + COALESCE(cc.ar_risk_amount, 0) + COALESCE(rr.rev_rec_risk_amount, 0)
      + COALESCE(doci.doc_invoice_risk_amount, 0) AS total_amount_at_risk,
    COALESCE(pc.price_exceptions, 0) + COALESCE(dc.discount_exceptions, 0)
      + COALESCE(eq.expired_quotes, 0) + COALESCE(cc.ar_exceptions, 0)
      + COALESCE(rr.rev_rec_exceptions, 0) + COALESCE(docc.doc_contract_exceptions, 0)
      + COALESCE(doci.doc_invoice_exceptions, 0) AS total_exceptions
  FROM tmf_customer.customer cust
  LEFT JOIN salesforce_source.account a
    ON a.TMF_Customer_Id__c = cust.customer_id
  LEFT JOIN price_check pc ON pc.customer_id = cust.customer_id
  LEFT JOIN discount_check dc ON dc.customer_id = cust.customer_id
  LEFT JOIN expired_quote_check eq ON eq.customer_id = cust.customer_id
  LEFT JOIN collection_check cc ON cc.customer_id = cust.customer_id
  LEFT JOIN rev_rec_check rr ON rr.customer_id = cust.customer_id
  LEFT JOIN doc_contract_check docc ON docc.customer_id = cust.customer_id
  LEFT JOIN doc_invoice_check doci ON doci.customer_id = cust.customer_id
),
-- Composite computed exactly once, reading the already-defaulted component
-- scores from `scored` -- no COALESCE needed here anymore since every
-- component is guaranteed non-NULL (except collection_efficiency_score,
-- which is a CASE with no NULL branch and therefore never NULL).
composite AS (
  SELECT
    *,
    0.20 * price_accuracy_score
      + 0.15 * discount_compliance_score
      + 0.10 * expired_quote_compliance_score
      + 0.20 * collection_efficiency_score
      + 0.15 * rev_rec_accuracy_score
      + 0.10 * doc_consistency_score
      + 0.10 * doc_invoice_consistency_score AS composite_raw
  FROM scored
)
SELECT
  customer_id,
  account_name,
  account_status,
  arpu_tier,
  billing_currency,
  ROUND(price_accuracy_score, 1) AS price_accuracy_score,
  ROUND(discount_compliance_score, 1) AS discount_compliance_score,
  ROUND(expired_quote_compliance_score, 1) AS expired_quote_compliance_score,
  collection_efficiency_score,
  ROUND(rev_rec_accuracy_score, 1) AS rev_rec_accuracy_score,
  ROUND(doc_consistency_score, 1) AS doc_consistency_score,
  ROUND(doc_invoice_consistency_score, 1) AS doc_invoice_consistency_score,
  ROUND(composite_raw, 1) AS composite_health_score,
  CASE
    WHEN composite_raw >= 90 THEN 'GREEN'
    WHEN composite_raw >= 70 THEN 'AMBER'
    ELSE 'RED'
  END AS risk_tier,
  total_amount_at_risk,
  total_exceptions
FROM composite;
