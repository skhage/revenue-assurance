---
name: ra-data-explorer
description: Explore and query the revenue-assurance data in the cdm_tmforum TM Forum SID catalog — the table map, the identity-resolution bridge join, the seven silver reconciliation checks as materialized views with their check_types, the gold views (leakage register, scorecard, anomaly, forecast), and the native RA violation/case taxonomy. Use when querying RA data, running a reconciliation or leakage check, validating a check against real columns, or locating where an entity lives in cdm_tmforum.
---

# RA Data Explorer (cdm_tmforum)

The demo runs on the pre-populated **`cdm_tmforum`** catalog (TM Forum SID Common Data
Model). Full analysis: [`data-source-assessment.md`](../../../data-source-assessment.md).
Naming + ground truth: [`demo-artifacts/README.md`](../../../demo-artifacts/README.md).

**Rules:** `tmf_*` schemas are **read-only** — never write to them. Route through the
`databricks-core` skill; never auto-select a CLI profile (pass `--profile <name>`; get it
from `databricks auth profiles` or ask the user). Query via
`databricks experimental aitools tools query "<SQL>" --profile <profile>`.

## Where things live
| Need | Table |
|---|---|
| Circuits | `tmf_resource.logical_resource` (`bandwidth_mbps`, `lifecycle_status`, `activation_date`) |
| Usage + mediation | `tmf_resource.resource_usage` (`mediation_status`), `tmf_service.service_usage` |
| Bills / invoice lines | `tmf_customer.bill`, `applied_customer_billing_*` |
| Contracts / pricing | `tmf_customer.commitment` (`amount` vs `actual_amount`, `variance_amount`), `tmf_product.offering_price` |
| Orders | `tmf_product.order_item` (`billing_start_date`, `actual_completion_date`) |
| Partner settlement | `tmf_businesspartner.rev_share_reconciliation` (`operator_billed_amount`, `partner_reported_amount`, `variance_amount`) |
| Customer master | `tmf_customer.customer` |
| **Native leakage** | `tmf_enterprise.revenue_assurance_violation` (12 `violation_type`s, `estimated_revenue_impact_amount`) |
| **Case mgmt** | `tmf_enterprise.ra_trouble_ticket` (`service_id`, `investigation_status`) |
| Pre-built KPIs | `_metrics.*` |

## The identity bridge (the "hard problem", already keyed)
```sql
SELECT lr.logical_resource_id AS circuit_id, rfs.resource_facing_service_id,
       cfs.customer_facing_service_id, cfs.customer_id, cfs.billing_account_id, b.bill_id
FROM cdm_tmforum.tmf_resource.logical_resource lr
JOIN cdm_tmforum.tmf_service.resource_facing_service rfs ON rfs.logical_resource_id = lr.logical_resource_id
JOIN cdm_tmforum.tmf_service.customer_facing_service  cfs ON cfs.service_id = rfs.resource_facing_service_id
LEFT JOIN cdm_tmforum.tmf_customer.bill b ON b.billing_account_id = cfs.billing_account_id;
```
This native chain resolves circuit→customer→bill. The built checks join the `*_source` systems to
`tmf_*` directly (e.g. `salesforce_source.account.TMF_Customer_Id__c` ↔ `tmf_customer.customer`)
rather than materializing a `service_instance` bridge (an earlier draft did) — use this join for
evidence drill-downs, not as a stored table.

## The 7 silver reconciliation checks (materialized views in `revenue_assurance`)
Query these as ready-built views; confirm column names with `information_schema.columns` before adapting.
1. **`silver_contract_price_reconciliation`** (check_type: `contract_price_mismatch`) — Derives from `commitment.actual_amount <> commitment.amount` via bridge to invoices. Maps to native `tariff_mismatch`/`rating_error`.
2. **`silver_discount_authorization_check`** (check_type: `unauthorized_discount` + `expired_quote_active`) — Expired or unapproved pricing alteration in `offering_price.approval_status` or `discount_prod_offer_price_alteration` validity window. Maps to `revenue_recognition_error`/`policy_violation`.
3. **`silver_fx_rate_validation`** (check_type: `FX>1% deviation`) — Validates FX rates from `refinitiv_fx_source` against applied GL rates; flags >1% variance. Maps to `rating_error`.
4. **`silver_ar_aging_analysis`** (check_type: `ar_collection_risk`) — AR age bucketing from `bill.bill_date` vs current, derives DSO risk. Maps to collection-related violations.
5. **`silver_revenue_recognition_check`** (check_type: `rev_rec_timing_mismatch`) — ASC-606 timing from `oracle_erp_source.GL_JE_LINES` vs `tmf_customer.bill.invoice_date`; flags period mismatch. Maps to `revenue_recognition_error`.
6. **`silver_doc_intelligence_contracts`** (check_type: `doc_contract_mismatch`) — Uses `ai_parse_document` + `ai_extract` on `ironclad_clm_source` PDFs to derive contract terms vs catalog pricing.
7. **`silver_doc_intelligence_invoices`** (check_type: `doc_invoice_mismatch`) — Uses `ai_parse_document` + `ai_extract` on `ironclad_clm_source` invoice PDFs to derive line items vs recorded billing.

Inspect a table's real columns first:
```sql
SELECT column_name, data_type FROM cdm_tmforum.information_schema.columns
WHERE table_schema='tmf_customer' AND table_name='bill' ORDER BY ordinal_position;
```
