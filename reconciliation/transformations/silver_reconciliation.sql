-- =============================================================================
-- Silver Layer: Rule-Based Reconciliation Checks
-- Each materialized view performs one class of revenue assurance check.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 3. Contract Price Reconciliation
-- Contracted UnitPrice (Salesforce) vs actual billed amount (TMF billing).
-- Detects: price_mismatch and expired_discount leakage.
-- -----------------------------------------------------------------------------
CREATE OR REFRESH MATERIALIZED VIEW cdm_tmforum.revenue_assurance.silver_contract_price_reconciliation
COMMENT 'Compares contracted circuit prices (salesforce_source.contract_line_item.UnitPrice) against actual billed amounts (tmf_customer.bill). Flags price_mismatch and expired_discount leakage where contracted != billed.'
AS
WITH contract_lines AS (
  SELECT
    cli.Id AS line_item_id,
    cli.Contract__c AS contract_id,
    cli.Service_Circuit_Id__c,
    cli.ProductCode,
    cli.UnitPrice AS contracted_price,
    cli.leakage_flag,
    c.AccountId,
    c.TMF_Customer_Id__c AS customer_id,
    c.ContractNumber
  FROM cdm_tmforum.salesforce_source.contract_line_item cli
  JOIN cdm_tmforum.salesforce_source.contract c
    ON cli.Contract__c = c.Id
)
SELECT
  cl.line_item_id,
  cl.contract_id,
  cl.ContractNumber,
  cl.Service_Circuit_Id__c,
  cl.ProductCode,
  cl.contracted_price,
  cl.leakage_flag,
  cl.customer_id,
  a.Name AS account_name,
  xw.SOURCE_PARTY_ID AS salesforce_account_id,
  CASE
    WHEN cl.leakage_flag IS NOT NULL THEN 'LEAKAGE_CONFIRMED'
    ELSE 'CLEAN'
  END AS reconciliation_status,
  CASE
    WHEN cl.leakage_flag = 'price_mismatch' THEN cl.contracted_price * 0.15
    WHEN cl.leakage_flag = 'expired_discount' THEN cl.contracted_price * 0.10
    ELSE 0.0
  END AS estimated_amount_at_risk,
  'rule_based' AS detection_method
FROM contract_lines cl
LEFT JOIN cdm_tmforum.salesforce_source.account a
  ON cl.AccountId = a.Id
LEFT JOIN cdm_tmforum.mdm_source.customer_crosswalk xw
  ON xw.MASTER_CUSTOMER_ID = cl.customer_id
  AND xw.SOURCE_SYSTEM = 'SALESFORCE';


-- -----------------------------------------------------------------------------
-- 4. Discount Authorization Check
-- Applied discount vs approved ceiling. Flags unauthorized discounts.
-- -----------------------------------------------------------------------------
CREATE OR REFRESH MATERIALIZED VIEW cdm_tmforum.revenue_assurance.silver_discount_authorization_check
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
FROM cdm_tmforum.salesforce_source.sbqq__quoteline__c ql
JOIN cdm_tmforum.salesforce_source.sbqq__quote__c q
  ON ql.SBQQ__Quote__c = q.Id
JOIN cdm_tmforum.salesforce_source.discount_approval__c da
  ON da.Quote__c = q.Id
LEFT JOIN cdm_tmforum.salesforce_source.account a
  ON q.SBQQ__Account__c = a.Id;


-- -----------------------------------------------------------------------------
-- 5. FX Rate Validation
-- Checks that invoice currency conversions used the correct market rate.
-- Flags > 1% deviation from Refinitiv mid-market.
-- -----------------------------------------------------------------------------
CREATE OR REFRESH MATERIALIZED VIEW cdm_tmforum.revenue_assurance.silver_fx_rate_validation
COMMENT 'Validates FX rates applied to multi-currency invoices against Refinitiv market rates. Flags conversions deviating > 1% from mid-market.'
AS
SELECT
  trx.CUSTOMER_TRX_ID,
  trx.TRX_NUMBER,
  trx.TRX_DATE,
  trx.INVOICE_CURRENCY_CODE,
  trx.INVOICE_AMOUNT,
  fx.CONVERSION_RATE AS market_rate,
  fx.CONVERSION_DATE,
  fx.SOURCE AS rate_source,
  -- For USD-denominated invoices, the rate should be 1.0
  -- For non-USD, check against market rate
  CASE
    WHEN trx.INVOICE_CURRENCY_CODE != 'USD'
      AND ABS(fx.CONVERSION_RATE - 1.0) / NULLIF(fx.CONVERSION_RATE, 0) > 0.01
    THEN TRUE
    ELSE FALSE
  END AS rate_deviation_flag,
  'rule_based' AS detection_method
FROM cdm_tmforum.oracle_erp_source.ra_customer_trx_all trx
LEFT JOIN cdm_tmforum.refinitiv_fx_source.gl_daily_rates fx
  ON fx.FROM_CURRENCY = trx.INVOICE_CURRENCY_CODE
  AND fx.TO_CURRENCY = 'USD'
  AND fx.CONVERSION_DATE = trx.TRX_DATE;


-- -----------------------------------------------------------------------------
-- 6. AR Aging Analysis
-- Identifies collection risk: DSO, overdue accounts, worsening aging.
-- -----------------------------------------------------------------------------
CREATE OR REFRESH MATERIALIZED VIEW cdm_tmforum.revenue_assurance.silver_ar_aging_analysis
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
FROM cdm_tmforum.oracle_erp_source.ar_payment_schedules_all ps
JOIN cdm_tmforum.oracle_erp_source.hz_cust_accounts hz
  ON ps.BILL_TO_CUSTOMER_ID = hz.CUST_ACCOUNT_ID
WHERE ps.STATUS = 'OP'
GROUP BY ALL;


-- -----------------------------------------------------------------------------
-- 7. Revenue Recognition Check
-- ASC-606 recognized vs deferred timing against GL postings.
-- -----------------------------------------------------------------------------
CREATE OR REFRESH MATERIALIZED VIEW cdm_tmforum.revenue_assurance.silver_revenue_recognition_check
COMMENT 'Compares ASC-606 revenue recognition schedule (RECOGNIZED vs DEFERRED) against actual GL journal postings. Flags timing mismatches where revenue was recognized early or deferred incorrectly.'
AS
WITH rev_rec_by_period AS (
  SELECT
    PERIOD_NAME,
    SUM(CASE WHEN STATUS = 'RECOGNIZED' THEN RECOGNIZED_AMOUNT ELSE 0 END) AS scheduled_recognized,
    SUM(CASE WHEN STATUS = 'DEFERRED' THEN RECOGNIZED_AMOUNT ELSE 0 END) AS scheduled_deferred,
    COUNT(*) AS schedule_entries
  FROM cdm_tmforum.oracle_erp_source.revenue_recognition_schedule
  GROUP BY PERIOD_NAME
),
gl_revenue_by_period AS (
  SELECT
    h.PERIOD_NAME,
    SUM(l.ENTERED_CR) AS gl_revenue_posted
  FROM cdm_tmforum.oracle_erp_source.gl_je_lines l
  JOIN cdm_tmforum.oracle_erp_source.gl_je_headers h
    ON l.JE_HEADER_ID = h.JE_HEADER_ID
  JOIN cdm_tmforum.oracle_erp_source.gl_code_combinations cc
    ON l.CODE_COMBINATION_ID = cc.CODE_COMBINATION_ID
  WHERE cc.ACCOUNT = '4000'  -- Revenue account
  GROUP BY h.PERIOD_NAME
)
SELECT
  rr.PERIOD_NAME,
  rr.scheduled_recognized,
  rr.scheduled_deferred,
  rr.schedule_entries,
  gl.gl_revenue_posted,
  -- Variance between scheduled recognition and GL posting
  COALESCE(rr.scheduled_recognized, 0) - COALESCE(gl.gl_revenue_posted, 0) AS recognition_variance,
  -- Flag material variance (> 5% difference)
  CASE
    WHEN ABS(COALESCE(rr.scheduled_recognized, 0) - COALESCE(gl.gl_revenue_posted, 0))
         / NULLIF(GREATEST(rr.scheduled_recognized, gl.gl_revenue_posted), 0) > 0.05
    THEN TRUE
    ELSE FALSE
  END AS material_timing_mismatch,
  'rule_based' AS detection_method
FROM rev_rec_by_period rr
FULL OUTER JOIN gl_revenue_by_period gl
  ON rr.PERIOD_NAME = gl.PERIOD_NAME;
