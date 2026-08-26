# RA Demo — Domain Model & Data Contract

> **Scrutiny summary**
> - ❌ **WRONG:** Invented `lumen_ra.bronze.*` tables + from-scratch Faker generation. **FIXED:** Data already exists in `cdm_tmforum.tmf_*` schemas (TM Forum SID Common Data Model, fully populated). No bronze layer to build.
> - ❌ **WRONG:** Scales were ~2K customers, ~25K circuits. **FIXED:** Real scales are ~10K customers, ~100K circuits, ~100K service orders, with 2018–2025 billing history per data-source-assessment.md.
> - ❌ **WRONG:** Invented source tables. **FIXED:** Reference the real simulated `*_source` systems and `tmf_*` golden data (see §6/§7).
> - ❌ **WRONG (superseded):** Two-schema `ra_silver`/`ra_gold` split with conformed `dim_*`/`fact_*` tables, a materialized `service_instance` identity bridge, and `reconciliation_exceptions`/`exception_case`/`leakage_kpis`/`revenue_forecast` tables. **FIXED (as built):** a **single** `cdm_tmforum.revenue_assurance` schema of **silver check materialized views** + **gold serving materialized views** (`gold_leakage_summary`, `gold_reconciliation_scorecard`, `gold_anomaly_scores`, `gold_revenue_forecast_anomalies`). Checks join `*_source` → `tmf_*` **directly**; there is no materialized bridge, and **case-management state lives in Lakebase Postgres** (schema `ra`), not a Delta `exception_case`.
> - ❌ **WRONG (superseded):** The "6 checks" (active-circuit-unbilled, usage–billing variance, billing-start-lag, partner-settlement). **FIXED:** the built check **set changed** — seven silver checks centered on contract-price, discount authorization, FX validation, AR aging, rev-rec timing, and two AI document-intelligence checks (see §7).
> - ✅ **KEPT:** Personas (Dana Whitfield, Marcus Chen, Priya Nair), the RA Exceptions Console app, and UC-governed PII masking.
> - ✅ **2026-08 correction applied:** Unified single `cdm_tmforum.revenue_assurance` schema, 7 check_type enum values, Lakebase Postgres case store (`ra.cases`/`ra.case_notes`), AppKit architecture; all data bindings updated; `service_instance` bridge removed; ML/forecast via `ai_forecast` + `gold_revenue_forecast_anomalies`; ~48K rows, ~$601M at-risk register.

**Demo:** Revenue Assurance Lakehouse for Lakelink Fiber (Lumen pitch audience)  
**Catalog / schema:** `cdm_tmforum` (TM Forum SID, read-only) + one new `cdm_tmforum.revenue_assurance` schema  
**Case store:** Lakebase Postgres project `ra-console-lakebase`, schema `ra`  
**Workspace:** demo-workspace (`demo` CLI profile)  
**Purpose:** Define every entity, its schema, keys, PII classification, and the source→target flow so pipelines, reconciliation checks, ML, dashboards, and the app are all built against one coherent contract.

---

## 1. Entity-relationship overview

The demo hinges on **identity resolution across systems**: each source system uses a different key, and leakage lives in the gaps between them. Rather than materialize a canonical bridge table, each **silver check** resolves identity inline (e.g. `salesforce_source.account.TMF_Customer_Id__c ↔ tmf_customer.customer.customer_id`) and emits the leakage it finds; the checks are unioned into one register.

```
     cdm_tmforum.*_source (simulated upstream)     cdm_tmforum.tmf_* (read-only golden)
  salesforce_source  oracle_erp_source            customer  bill  logical_resource  gl_*
  refinitiv_fx_source  ironclad_clm_source         (joined for context + resolution)
  mdm_source
                       │  reconcile (7 silver checks, materialized views)
                       ▼
        cdm_tmforum.revenue_assurance  (silver check MVs)
   silver_contract_price_reconciliation   silver_discount_authorization_check
   silver_fx_rate_validation   silver_ar_aging_analysis
   silver_revenue_recognition_check
   silver_doc_intelligence_contracts   silver_doc_intelligence_invoices
                       │  union + aggregate + ML/forecast
                       ▼
        cdm_tmforum.revenue_assurance  (gold serving MVs)
   gold_leakage_summary   gold_reconciliation_scorecard
   gold_anomaly_scores    gold_revenue_forecast_anomalies
                       │  read (SQL warehouse)          write case state
                       ▼                                     ▼
        RA Exceptions Console (AppKit)  ───────────►  Lakebase  ra.cases / ra.case_notes
```

**Grain summary**

| Entity | Grain (one row =) |
| :---- | :---- |
| `revenue_assurance.silver_contract_price_reconciliation` | one contract line compared to billed amount |
| `revenue_assurance.silver_discount_authorization_check` | one quote line vs its approved discount ceiling |
| `revenue_assurance.silver_fx_rate_validation` | one multi-currency invoice vs Refinitiv mid-market rate |
| `revenue_assurance.silver_ar_aging_analysis` | one customer's AR aging / DSO position |
| `revenue_assurance.silver_revenue_recognition_check` | one ASC-606 recognition period vs GL |
| `revenue_assurance.silver_doc_intelligence_contracts` | one parsed contract PDF vs system-of-record |
| `revenue_assurance.silver_doc_intelligence_invoices` | one parsed invoice PDF vs system-of-record |
| `revenue_assurance.gold_leakage_summary` | one detected leakage exception (union of the silver checks) |
| `revenue_assurance.gold_reconciliation_scorecard` | one customer's reconciliation health score |
| `revenue_assurance.gold_revenue_forecast_anomalies` | one revenue month (actual vs `ai_forecast` vs budget) |
| `ra.cases` (Lakebase) | one worked case (lifecycle state) keyed by `exception_id` |
| `ra.case_notes` (Lakebase) | one investigation note on a case |

---

## 2. Silver check materialized views (detection)

All silver MVs are `CREATE OR REFRESH MATERIALIZED VIEW cdm_tmforum.revenue_assurance.<name>` reading from `*_source` joined to `tmf_*`. Representative leakage-bearing columns (each also carries a `detection_method` of `rule_based` or `ai_extracted`):

| Materialized view | Source of truth | Key leakage columns |
| :---- | :---- | :---- |
| `silver_contract_price_reconciliation` | `salesforce_source.contract_line_item.UnitPrice` vs `tmf_customer.bill` | `customer_id`, `account_name`, `estimated_amount_at_risk`, `leakage_flag` (`price_mismatch`…), `ContractNumber` |
| `silver_discount_authorization_check` | `salesforce_source.sbqq__quoteline__c` vs `sbqq__quote__c.discount_approval__c` | `customer_id`, `account_name`, `discount_overrun_amount`, `unauthorized_discount` (bool), `expired_quote_still_active` (bool), `quote_id` |
| `silver_fx_rate_validation` | `oracle_erp_source.ra_customer_trx_all` vs `refinitiv_fx_source` mid-market | invoice/currency keys, applied vs market rate, deviation % (flag >1%) |
| `silver_ar_aging_analysis` | `oracle_erp_source.ar_payment_schedules_all` | `customer_id`, `customer_name`, `total_outstanding`, `estimated_dso_days`, `collection_risk` (`HIGH`…), `BILL_TO_CUSTOMER_ID` |
| `silver_revenue_recognition_check` | ASC-606 `oracle_erp_source.revenue_recognition_schedule` vs `gl_je_lines` | `recognition_variance`, `material_timing_mismatch` (bool), `PERIOD_NAME` |
| `silver_doc_intelligence_contracts` | `ai_parse_document` + `ai_extract` on `ironclad_clm_source` contract PDFs vs system | `customer_id`, `account_name`, `doc_contract_number`, `total_mismatches` |
| `silver_doc_intelligence_invoices` | `ai_parse_document` + `ai_extract` on invoice PDFs vs system | `doc_invoice_number`, `amount_variance`, `amount_mismatch` (bool) |

> Identity is resolved **inside** each check — e.g. `salesforce_source.account.TMF_Customer_Id__c ↔ tmf_customer.customer.customer_id`. The native `tmf_*` chain (`logical_resource → resource_facing_service → customer_facing_service → customer/billing_account → bill`) remains available as **context** for drill-down, but is not materialized as a separate bridge table.

---

## 3. Gold serving materialized views + Lakebase case store

### revenue_assurance.gold_leakage_summary — **unified exception register (queue/KPI source)**

Union of every silver check's leakage rows. ~48K rows, ~$601M at risk, 7 `check_type`s.

| Column | Type | Description |
| :---- | :---- | :---- |
| check_type | STRING | `contract_price_mismatch`, `unauthorized_discount`, `expired_quote_active`, `ar_collection_risk`, `rev_rec_timing_mismatch`, `doc_contract_mismatch`, `doc_invoice_mismatch` |
| severity | STRING | `HIGH` / `MEDIUM` (driven by check + $) |
| customer_id | BIGINT | Owning customer (nullable for unattributed rows) |
| account_name | STRING | Customer/account name (nullable) |
| amount_at_risk | DOUBLE | Estimated leakage / amount at risk |
| source_table | STRING | Originating `*_source` table (evidence pointer) |
| detection_method | STRING | `rule_based` or `ai_extracted` |
| known_leakage_flag | BOOLEAN | TRUE where seeded ground-truth leakage |
| reference_id | STRING | Business reference (contract #, quote id, invoice #, period…) |

> The app synthesizes a stable `exception_id = md5(check_type | reference_id | customer_id | amount_at_risk)` at read time so case state can key on it without materializing all ~48K rows into Postgres.

### revenue_assurance.gold_reconciliation_scorecard — per-customer health

| Column | Type | Description |
| :---- | :---- | :---- |
| customer_id | BIGINT | Customer |
| account_name | STRING | From `salesforce_source.account` |
| account_status, arpu_tier, billing_currency | STRING | From `tmf_customer.customer` |
| price_accuracy_score, discount_compliance_score, collection_efficiency_score, doc_consistency_score | DOUBLE | 0–100 component scores |
| composite_health_score | DOUBLE | Weighted composite (0–100) |
| risk_tier | STRING | `GREEN` (≥90) / `AMBER` (≥70) / `RED` |
| total_amount_at_risk | DOUBLE | Sum of the customer's at-risk amounts |
| total_exceptions | BIGINT | Count of the customer's exceptions |

### revenue_assurance.gold_anomaly_scores — ML anomaly output
Per-entity anomaly scores from the MLflow model (usage/billing/revenue variance). Note: the golden data is statistically flat; the source generator injects sharp anomalies for a compelling ML scene.

### revenue_assurance.gold_revenue_forecast_anomalies — `ai_forecast`
Monthly GL revenue (`oracle_erp_source.gl_*`, account `4000`) forecast vs actual + budget variance.

| Column | Type | Description |
| :---- | :---- | :---- |
| revenue_month | DATE | Month |
| actual_revenue | DOUBLE | Actual monthly revenue |
| forecast_revenue, forecast_upper_bound, forecast_lower_bound | DOUBLE | `ai_forecast` prediction + interval |
| budget_amount | DOUBLE | From `gl_budgets` |
| anomaly_status | STRING | `ABOVE_EXPECTED` / `BELOW_EXPECTED` / `NORMAL` |
| budget_variance_pct | DOUBLE | Actual vs budget % |

### Lakebase case store (schema `ra`, owned by the app service principal)

`ra.cases` — one worked case per exception (created lazily on first action):

| Column | Type | Description |
| :---- | :---- | :---- |
| exception_id | TEXT (PK) | Synthesized id (matches `gold_leakage_summary`) |
| reference_id, account_name, check_type, severity | TEXT | Snapshot from the queue row |
| amount_at_risk | DOUBLE PRECISION | Snapshot |
| status | TEXT | `New` → `Investigating` → `Recovering` → `Recovered` / `WrittenOff` |
| assignee | TEXT | RA analyst (e.g. Marcus Chen) — **PII (internal)** |
| created_at, updated_at | TIMESTAMPTZ | Lifecycle timestamps |

`ra.case_notes` — append-only investigation notes (`id`, `exception_id` FK, `author`, `body`, `created_at`).

---

## 4. PII classification & governance

Delta reads via UC column masks + tags (lineage auto-captured); case PII lives in Lakebase.

| Column | Table | Class | Control |
| :---- | :---- | :---- | :---- |
| account_name | gold_leakage_summary / gold_reconciliation_scorecard | PII (Confidential) | UC tag `pii=true`; column mask to non-`ra_admin` groups |
| customer_id | gold_* | Sensitive-linkable | UC tag `sensitive` |
| assignee | `ra.cases` (Lakebase) | PII (Internal) | Visible to `ra_analyst` / `ra_admin`; app resolves signed-in user from request headers |

No raw PII leaves silver into gold except masked.

---

## 5. Real data volumes (not invented)

| Table | Real rows | Span / note |
| :---- | :---- | :---- |
| tmf_customer.customer | ~10,000 | MDM, ~10K unique accounts |
| tmf_resource.logical_resource | ~100,000 | Active + historical circuits (context) |
| tmf_customer.bill | 10K+ | Invoices spanning 2018–2025 |
| tmf_enterprise.revenue_assurance_violation | ~10,000 | Native RA layer, 12 types, ~$540M est. impact (**context only**) |
| **revenue_assurance.gold_leakage_summary** | **~48,000** | **Derived register the app/dashboard query — ~$601M at risk, 7 check types** |
| revenue_assurance.gold_reconciliation_scorecard | ~8,200 | One per affected customer |

`ar_collection_risk` dominates the register (~$500M), followed by `rev_rec_timing_mismatch` and `unauthorized_discount`.

---

## 6. Source-to-target mapping (lineage contract)

| Source (`*_source` + `tmf_*`) | → silver check MV | → gold serving MV |
| :---- | :---- | :---- |
| `salesforce_source.contract_line_item` + `tmf_customer.bill` | silver_contract_price_reconciliation | gold_leakage_summary, gold_reconciliation_scorecard |
| `salesforce_source.sbqq__quoteline__c` / `sbqq__quote__c` | silver_discount_authorization_check | gold_leakage_summary, gold_reconciliation_scorecard |
| `oracle_erp_source.ra_customer_trx_all` + `refinitiv_fx_source` | silver_fx_rate_validation | (FX deviation; not in the register union) |
| `oracle_erp_source.ar_payment_schedules_all` | silver_ar_aging_analysis | gold_leakage_summary, gold_reconciliation_scorecard |
| `oracle_erp_source.revenue_recognition_schedule` + `gl_je_lines` | silver_revenue_recognition_check | gold_leakage_summary |
| `ironclad_clm_source` contract PDFs (`ai_parse_document`/`ai_extract`) | silver_doc_intelligence_contracts | gold_leakage_summary, gold_reconciliation_scorecard |
| `ironclad_clm_source` invoice PDFs | silver_doc_intelligence_invoices | gold_leakage_summary |
| `oracle_erp_source.gl_*` (acct 4000) + `gl_budgets` | — | gold_revenue_forecast_anomalies (`ai_forecast`) |
| `_metrics.*` (71 pre-built views) | — | dashboards / KPIs (context) |
| gold_leakage_summary (read) | — | RA Exceptions Console → `ra.cases` (Lakebase write-back) |

---

## 7. The reconciliation checks — mapped to `check_type`

| Silver check (materialized view) | Evidence in data | `check_type` in `gold_leakage_summary` |
| :---- | :---- | :---- |
| **silver_contract_price_reconciliation** | `salesforce_source.contract_line_item.UnitPrice` vs `tmf_customer.bill` | `contract_price_mismatch` |
| **silver_discount_authorization_check** | `sbqq__quoteline__c` vs `sbqq__quote__c.discount_approval__c` | `unauthorized_discount`, `expired_quote_active` |
| **silver_fx_rate_validation** | `oracle_erp_source.ra_customer_trx_all` vs Refinitiv mid-market (>1% dev) | (FX deviation — not unioned into register) |
| **silver_ar_aging_analysis** | `oracle_erp_source.ar_payment_schedules_all` (DSO, 90+ days) | `ar_collection_risk` |
| **silver_revenue_recognition_check** | ASC-606 `revenue_recognition_schedule` vs `gl_je_lines` | `rev_rec_timing_mismatch` |
| **silver_doc_intelligence_contracts** | AI-parsed `ironclad_clm_source` contract PDFs vs system | `doc_contract_mismatch` |
| **silver_doc_intelligence_invoices** | AI-parsed invoice PDFs vs system | `doc_invoice_mismatch` |

The native `tmf_enterprise.revenue_assurance_violation` (12 types) / `ra_trouble_ticket` tables remain available as context, but the app's exceptions come from `gold_leakage_summary` and its case state from Lakebase. Each exception row carries a `source_table` + `reference_id` for drill-down in the RA Exceptions Console.

---

## 8. Notes on source systems (simulated separately)

Source systems (`salesforce_source`, `oracle_erp_source`, `refinitiv_fx_source`, `ironclad_clm_source`, `mdm_source`) are generated by `data-sim/simulate_source_systems.py` (+ `config.yaml`), keyed to golden `cdm_tmforum.customer` accounts, and are the **primary inputs to the silver checks** (joined to `tmf_*` for context). The generator also **injects sharp anomalies** for the ML / `ai_forecast` scenes, since the golden `cdm_tmforum` data is otherwise statistically flat.
