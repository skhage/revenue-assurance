-- =============================================================================
-- Silver Layer: Document Intelligence (ai_parse_document + ai_extract)
-- Parses contract and invoice PDFs, extracts structured terms, and cross-checks
-- against source-of-truth tables to detect document-vs-database mismatches.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Contract Document Intelligence
-- Parse MSA PDFs → extract key terms → compare to Salesforce contract table
-- -----------------------------------------------------------------------------
CREATE OR REFRESH MATERIALIZED VIEW cdm_tmforum.revenue_assurance.silver_doc_intelligence_contracts
COMMENT 'AI-extracted contract terms from branded MSA PDFs cross-checked against salesforce_source.contract. Flags document-vs-database mismatches on SLA tier, term, auto-renew, and status.'
AS
WITH parsed_contracts AS (
  SELECT
    path AS file_name,
    ai_parse_document(content, MAP('version', '2.0')) AS parsed
  FROM read_files(
    '/Volumes/cdm_tmforum/ironclad_clm_source/contract_pdfs/',
    format => 'binaryFile',
    schema => 'path STRING, modificationTime TIMESTAMP, length BIGINT, content BINARY'
  )
),
extracted AS (
  SELECT
    file_name,
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
    ) AS extracted_data
  FROM parsed_contracts
  WHERE is_variant_null(parsed:error_status)
)
SELECT
  e.file_name,
  e.extracted_data:contract_number::STRING AS doc_contract_number,
  e.extracted_data:sla_tier::STRING AS doc_sla_tier,
  e.extracted_data:term_months::INT AS doc_term_months,
  e.extracted_data:auto_renew::BOOLEAN AS doc_auto_renew,
  e.extracted_data:status::STRING AS doc_status,
  c.ContractNumber AS db_contract_number,
  c.SLA_Tier__c AS db_sla_tier,
  c.ContractTerm AS db_term_months,
  c.Auto_Renew__c AS db_auto_renew,
  c.Status AS db_status,
  c.TMF_Customer_Id__c AS customer_id,
  a.Name AS account_name,
  -- Mismatch flags
  CASE WHEN e.extracted_data:sla_tier::STRING != c.SLA_Tier__c THEN TRUE ELSE FALSE END AS sla_mismatch,
  CASE WHEN e.extracted_data:term_months::INT != c.ContractTerm THEN TRUE ELSE FALSE END AS term_mismatch,
  CASE WHEN e.extracted_data:auto_renew::BOOLEAN != c.Auto_Renew__c THEN TRUE ELSE FALSE END AS auto_renew_mismatch,
  CASE WHEN e.extracted_data:status::STRING != c.Status THEN TRUE ELSE FALSE END AS status_mismatch,
  (CASE WHEN e.extracted_data:sla_tier::STRING != c.SLA_Tier__c THEN 1 ELSE 0 END
   + CASE WHEN e.extracted_data:term_months::INT != c.ContractTerm THEN 1 ELSE 0 END
   + CASE WHEN e.extracted_data:auto_renew::BOOLEAN != c.Auto_Renew__c THEN 1 ELSE 0 END
   + CASE WHEN e.extracted_data:status::STRING != c.Status THEN 1 ELSE 0 END) AS total_mismatches
FROM extracted e
LEFT JOIN cdm_tmforum.salesforce_source.contract c
  ON c.ContractNumber = e.extracted_data:contract_number::STRING
LEFT JOIN cdm_tmforum.salesforce_source.account a
  ON c.AccountId = a.Id;


-- -----------------------------------------------------------------------------
-- 2. Invoice Document Intelligence
-- Parse invoice PDFs → extract amounts → compare to Oracle AR invoices
-- -----------------------------------------------------------------------------
CREATE OR REFRESH MATERIALIZED VIEW cdm_tmforum.revenue_assurance.silver_doc_intelligence_invoices
COMMENT 'AI-extracted invoice data from branded PDF invoices cross-checked against oracle_erp_source.ra_customer_trx_all. Flags amount discrepancies between document and ERP.'
AS
WITH parsed_invoices AS (
  SELECT
    path AS file_name,
    ai_parse_document(content, MAP('version', '2.0')) AS parsed
  FROM read_files(
    '/Volumes/cdm_tmforum/ironclad_clm_source/invoice_pdfs/',
    format => 'binaryFile',
    schema => 'path STRING, modificationTime TIMESTAMP, length BIGINT, content BINARY'
  )
),
extracted AS (
  SELECT
    file_name,
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
    ) AS extracted_data
  FROM parsed_invoices
  WHERE is_variant_null(parsed:error_status)
)
SELECT
  e.file_name,
  e.extracted_data:invoice_number::STRING AS doc_invoice_number,
  e.extracted_data:total_amount::DOUBLE AS doc_total_amount,
  e.extracted_data:tax_amount::DOUBLE AS doc_tax_amount,
  e.extracted_data:customer_name::STRING AS doc_customer_name,
  t.TRX_NUMBER AS db_invoice_number,
  t.INVOICE_AMOUNT AS db_invoice_amount,
  t.TAX_AMOUNT AS db_tax_amount,
  t.TMF_BILL_ID,
  -- Amount mismatch detection (tolerance: $0.01)
  CASE
    WHEN ABS(COALESCE(e.extracted_data:total_amount::DOUBLE, 0) - COALESCE(t.INVOICE_AMOUNT, 0)) > 0.01
    THEN TRUE ELSE FALSE
  END AS amount_mismatch,
  ABS(COALESCE(e.extracted_data:total_amount::DOUBLE, 0) - COALESCE(t.INVOICE_AMOUNT, 0)) AS amount_variance
FROM extracted e
LEFT JOIN cdm_tmforum.oracle_erp_source.ra_customer_trx_all t
  ON e.extracted_data:invoice_number::STRING = t.TRX_NUMBER;
