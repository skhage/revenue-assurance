-- =============================================================================
-- Silver Layer: Document Intelligence (ai_parse_document + ai_extract)
-- Lakeflow Declarative Pipeline source. Part of `ra_medallion_pipeline`.
--
-- Parses contract and invoice PDFs, extracts structured terms, and cross-checks
-- against source-of-truth tables to detect document-vs-database mismatches.
--
-- INCREMENTAL INGESTION: the raw PDF bytes now land in Auto Loader STREAMING
--   TABLES (`bronze_contract_pdfs` / `bronze_invoice_pdfs`) rather than being
--   re-listed by `read_files` on every refresh. Auto Loader tracks which files
--   it has already processed, so a refresh only picks up newly-arrived PDFs.
--   The parse/extract MVs then sit on top of those tables.
--
--   Why this matters beyond tidiness: `ai_parse_document` and `ai_extract` are
--   billed model-serving calls. Re-listing and re-reading every PDF on every
--   pipeline update is the most expensive thing this layer could do. Streaming
--   the raw bytes via Auto Loader is the documented pattern for exactly this.
--
--   The Volume path comes from the pipeline configuration key
--   `ra.clm_volume_root`, so the catalog is not hardcoded here either.
--
--   TODO(perf): the extract MVs below still re-run ai_extract over the full
--   accumulated PDF set on each refresh, because they are materialized views and
--   an MV carrying expectations is always fully refreshed. Making the AI step
--   itself incremental requires the parse/extract output to live in an
--   append-only streaming table fed by a STREAM read of the bronze tables. That
--   changes the semantics of the doc checks (append-only history, and a policy
--   for re-parsed/amended PDFs), so it is deliberately NOT bundled into this
--   foundation PR.
--
-- CATALOG PARAMETERIZATION: two-part `schema.table` reads resolve against the
--   pipeline's catalog; outputs are unqualified. See silver_reconciliation.sql.
--
-- COMPUTE REQUIREMENT: `ai_parse_document` is documented as available in
--   Lakeflow pipelines, but requires DBR 17.3+ and — on serverless — serverless
--   environment version 3+ for VARIANT support. If an update fails on the
--   VARIANT type, raise the pipeline's environment version.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- Bronze: raw contract PDF bytes, ingested incrementally via Auto Loader.
--
-- DQ-9 (ingestion half): a zero-length PDF is a broken upload. It is flagged but
--   KEPT, not dropped, because the test plan is explicit that unparseable docs
--   must be "flagged, not dropped silently".
-- -----------------------------------------------------------------------------
CREATE OR REFRESH STREAMING TABLE bronze_contract_pdfs (
  CONSTRAINT dq9_contract_pdf_non_empty
    EXPECT (length > 0),
  CONSTRAINT dq9_contract_pdf_path_present
    EXPECT (path IS NOT NULL)
)
COMMENT 'Raw Ironclad CLM contract PDF bytes, ingested incrementally with Auto Loader. One row per PDF file; content holds the binary document.'
AS
SELECT
  path,
  modificationTime,
  length,
  content
FROM STREAM read_files(
  '${ra.clm_volume_root}/contract_pdfs/',
  format => 'binaryFile',
  fileNamePattern => '*.{pdf,PDF}'
);


-- -----------------------------------------------------------------------------
-- Bronze: raw invoice PDF bytes, ingested incrementally via Auto Loader.
-- -----------------------------------------------------------------------------
CREATE OR REFRESH STREAMING TABLE bronze_invoice_pdfs (
  CONSTRAINT dq9_invoice_pdf_non_empty
    EXPECT (length > 0),
  CONSTRAINT dq9_invoice_pdf_path_present
    EXPECT (path IS NOT NULL)
)
COMMENT 'Raw Lakelink Fiber invoice PDF bytes, ingested incrementally with Auto Loader. One row per PDF file; content holds the binary document.'
AS
SELECT
  path,
  modificationTime,
  length,
  content
FROM STREAM read_files(
  '${ra.clm_volume_root}/invoice_pdfs/',
  format => 'binaryFile',
  fileNamePattern => '*.{pdf,PDF}'
);


-- -----------------------------------------------------------------------------
-- 1. Contract Document Intelligence
-- Parse MSA PDFs -> extract key terms -> compare to Salesforce contract table
--
-- DQ-9: extracted fields non-null on PARSEABLE PDFs; unparseable docs flagged,
--   not dropped. Action: warn.
--
--   BEHAVIOUR FIX: the previous version ended the extract CTE with
--   `WHERE is_variant_null(parsed:error_status)`, which silently DISCARDED every
--   PDF that failed to parse — the exact thing DQ-9 forbids. Parse failures are
--   now retained with `parse_succeeded = FALSE`, and the expectation is written
--   to only demand extracted fields where the parse actually succeeded.
-- -----------------------------------------------------------------------------
CREATE OR REFRESH MATERIALIZED VIEW silver_doc_intelligence_contracts (
  CONSTRAINT dq9_contract_number_extracted_when_parsed
    EXPECT (NOT parse_succeeded OR doc_contract_number IS NOT NULL),
  CONSTRAINT dq9_contract_matched_to_system
    EXPECT (db_contract_number IS NOT NULL),
  CONSTRAINT dq9_total_mismatches_non_negative
    EXPECT (total_mismatches >= 0)
)
COMMENT 'AI-extracted contract terms from branded MSA PDFs cross-checked against salesforce_source.contract. Flags document-vs-database mismatches on SLA tier, term, auto-renew, and status. Unparseable PDFs are retained with parse_succeeded = FALSE.'
AS
WITH parsed_contracts AS (
  SELECT
    path AS file_name,
    ai_parse_document(content, MAP('version', '2.0')) AS parsed
  FROM bronze_contract_pdfs
),
extracted AS (
  SELECT
    file_name,
    is_variant_null(parsed:error_status) AS parse_succeeded,
    -- Only pay for an ai_extract call when the parse succeeded; a failed parse
    -- yields NULL extracted_data and is still emitted as a row.
    CASE WHEN is_variant_null(parsed:error_status) THEN
      ai_extract(
        parsed,
        '{
          "contract_number": {"type": "string", "description": "Contract number (e.g. CN-00000123)"},
          "sla_tier": {"type": "string", "description": "SLA tier: Platinum, Gold, or Silver"},
          "term_months": {"type": "integer", "description": "Contract term length in months"},
          "auto_renew": {"type": "boolean", "description": "Whether auto-renewal is enabled"},
          "status": {"type": "string", "description": "Contract status: Activated or Expired"},
          "effective_date": {"type": "string", "description": "Contract start date"},
          "end_date": {"type": "string", "description": "Contract end date"}
        }',
        MAP('version', '2.1', 'instructions', 'These are Master Service Agreement contracts for Lakelink Fiber enterprise customers. Extract the contract metadata from the terms table.')
      )
    END AS extracted_data
  FROM parsed_contracts
)
SELECT
  e.file_name,
  e.parse_succeeded,
  e.extracted_data:response:contract_number:value::STRING AS doc_contract_number,
  e.extracted_data:response:sla_tier:value::STRING AS doc_sla_tier,
  e.extracted_data:response:term_months:value::INT AS doc_term_months,
  e.extracted_data:response:auto_renew:value::BOOLEAN AS doc_auto_renew,
  e.extracted_data:response:status:value::STRING AS doc_status,
  c.ContractNumber AS db_contract_number,
  c.SLA_Tier__c AS db_sla_tier,
  c.ContractTerm AS db_term_months,
  c.Auto_Renew__c AS db_auto_renew,
  c.Status AS db_status,
  c.TMF_Customer_Id__c AS customer_id,
  a.Name AS account_name,
  -- Mismatch flags
  CASE WHEN e.extracted_data:response:sla_tier:value::STRING != c.SLA_Tier__c THEN TRUE ELSE FALSE END AS sla_mismatch,
  CASE WHEN e.extracted_data:response:term_months:value::INT != c.ContractTerm THEN TRUE ELSE FALSE END AS term_mismatch,
  CASE WHEN e.extracted_data:response:auto_renew:value::BOOLEAN != c.Auto_Renew__c THEN TRUE ELSE FALSE END AS auto_renew_mismatch,
  CASE WHEN e.extracted_data:response:status:value::STRING != c.Status THEN TRUE ELSE FALSE END AS status_mismatch,
  (CASE WHEN e.extracted_data:response:sla_tier:value::STRING != c.SLA_Tier__c THEN 1 ELSE 0 END
   + CASE WHEN e.extracted_data:response:term_months:value::INT != c.ContractTerm THEN 1 ELSE 0 END
   + CASE WHEN e.extracted_data:response:auto_renew:value::BOOLEAN != c.Auto_Renew__c THEN 1 ELSE 0 END
   + CASE WHEN e.extracted_data:response:status:value::STRING != c.Status THEN 1 ELSE 0 END) AS total_mismatches
FROM extracted e
LEFT JOIN salesforce_source.contract c
  ON c.ContractNumber = e.extracted_data:response:contract_number:value::STRING
LEFT JOIN salesforce_source.account a
  ON c.AccountId = a.Id;


-- -----------------------------------------------------------------------------
-- 2. Invoice Document Intelligence
-- Parse invoice PDFs -> extract amounts -> compare to Oracle AR invoices
--
-- DQ-9: as above. `amount_variance` must be non-negative since it is an ABS()
--   and feeds `amount_at_risk` in the register.
-- -----------------------------------------------------------------------------
CREATE OR REFRESH MATERIALIZED VIEW silver_doc_intelligence_invoices (
  CONSTRAINT dq9_invoice_number_extracted_when_parsed
    EXPECT (NOT parse_succeeded OR doc_invoice_number IS NOT NULL),
  CONSTRAINT dq9_invoice_matched_to_system
    EXPECT (db_invoice_number IS NOT NULL),
  CONSTRAINT dq9_amount_variance_non_negative
    EXPECT (amount_variance >= 0)
)
COMMENT 'AI-extracted invoice data from branded PDF invoices cross-checked against oracle_erp_source.ra_customer_trx_all. Flags amount discrepancies between document and ERP. Unparseable PDFs are retained with parse_succeeded = FALSE.'
AS
WITH parsed_invoices AS (
  SELECT
    path AS file_name,
    ai_parse_document(content, MAP('version', '2.0')) AS parsed
  FROM bronze_invoice_pdfs
),
extracted AS (
  SELECT
    file_name,
    is_variant_null(parsed:error_status) AS parse_succeeded,
    CASE WHEN is_variant_null(parsed:error_status) THEN
      ai_extract(
        parsed,
        '{
          "invoice_number": {"type": "string", "description": "Invoice number (e.g. INV-0000010001)"},
          "total_amount": {"type": "number", "description": "Total invoice amount due"},
          "tax_amount": {"type": "number", "description": "Tax portion of the invoice"},
          "customer_name": {"type": "string", "description": "Bill-to customer name"},
          "billing_period_start": {"type": "string", "description": "Billing period start date"},
          "billing_period_end": {"type": "string", "description": "Billing period end date"},
          "due_date": {"type": "string", "description": "Payment due date"}
        }',
        MAP('version', '2.1', 'instructions', 'These are Lakelink Fiber enterprise invoices. Extract the financial summary from the invoice table.')
      )
    END AS extracted_data
  FROM parsed_invoices
)
SELECT
  e.file_name,
  e.parse_succeeded,
  e.extracted_data:response:invoice_number:value::STRING AS doc_invoice_number,
  e.extracted_data:response:total_amount:value::DOUBLE AS doc_total_amount,
  e.extracted_data:response:tax_amount:value::DOUBLE AS doc_tax_amount,
  e.extracted_data:response:customer_name:value::STRING AS doc_customer_name,
  t.TRX_NUMBER AS db_invoice_number,
  t.INVOICE_AMOUNT AS db_invoice_amount,
  t.TAX_AMOUNT AS db_tax_amount,
  t.TMF_BILL_ID,
  -- Amount mismatch detection (tolerance: $0.01)
  CASE
    WHEN ABS(COALESCE(e.extracted_data:response:total_amount:value::DOUBLE, 0) - COALESCE(t.INVOICE_AMOUNT, 0)) > 0.01
    THEN TRUE ELSE FALSE
  END AS amount_mismatch,
  ABS(COALESCE(e.extracted_data:response:total_amount:value::DOUBLE, 0) - COALESCE(t.INVOICE_AMOUNT, 0)) AS amount_variance
FROM extracted e
LEFT JOIN oracle_erp_source.ra_customer_trx_all t
  ON e.extracted_data:response:invoice_number:value::STRING = t.TRX_NUMBER;
