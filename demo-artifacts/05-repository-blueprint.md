# RA Demo — Repository Blueprint

> **Scrutiny summary**
> - **Catalog naming:** Original incorrectly used invented `lumen_ra` catalog. **Corrected to:** build new schemas (`ra_silver`, `ra_gold`) within the real `cdm_tmforum` catalog on the demo workspace; `tmf_*` schemas are read-only inputs.
> - **Data generation scope:** Original included synthetic data generation via Faker (`generate.py`, `job_generate_data.yml`). **Corrected to:** data already fully populated in `cdm_tmforum` (100K circuits, 10K violations, 2018–2025 billing). Demo builds reconciliation logic **on top** of existing data, not from-scratch bronze. Only `simulate_source_systems` notebook generates source-system data (landing in `salesforce_source`, `oracle_erp_source`, etc.).
> - **Schema naming:** Original used `lumen_ra.<layer>.<entity>`. **Corrected to:** new schemas are `ra_silver` and `ra_gold` within `cdm_tmforum`, reading from both `tmf_*` (golden) and `*_source` (simulated upstream).
> - **Repo tree:** Removed data-generation folder; added source-system simulation notebook; kept reconciliation checks mapped to real `cdm_tmforum` tables.
> - **Real scale:** Original invented numbers (~$1.9M). **Corrected to:** ~10K RA violations across 12 types, ~$540M estimated impact (tunable by type/date).
> - **Lakeflow Declarative Pipelines confirmed** as current product name (formerly DLT).

**Demo:** Revenue Assurance Lakehouse for Lakelink Fiber (pitched to Lumen Technologies)  
**Repo:** `revenue-assurance` | **IaC:** Databricks Asset Bundles (DABs)  
**Data source:** `cdm_tmforum` catalog on `demo-workspace` workspace (`demo` CLI profile)

Removes ambiguity about where every file belongs and clarifies the separation between **reading golden data** (`tmf_*` read-only) and **building new RA logic** (`ra_silver`/`ra_gold`).

---

## 1. Folder tree

```
revenue-assurance/
├── databricks.yml                  # DAB root: bundle name, variables, targets (dev/prod)
├── README.md                       # Setup, deploy, run, teardown
├── requirements.txt                # mlflow, databricks-sdk, pyspark
├── .gitignore
├── .github/workflows/validate.yml  # bundle validate on PR
│
├── resources/                      # DAB resource definitions (one concern per file)
│   ├── pipeline_medallion.yml      # Lakeflow Declarative Pipeline (tmf_* → ra_silver)
│   ├── job_reconciliation.yml      # ra_reconciliation (runs 6 checks → ra_gold)
│   ├── job_ml.yml                  # anomaly training + ai_forecast refresh
│   ├── dashboard.yml               # AI/BI leakage dashboard resource
│   └── app.yml                     # RA Exceptions Console Databricks App
│
├── src/
│   ├── common/
│   │   ├── config.py               # catalog=cdm_tmforum, schemas (ra_silver, ra_gold, etc.), scale
│   │   └── udfs.py                 # shared expressions / masking helpers
│   ├── pipelines/                  # Lakeflow Declarative Pipeline definitions
│   │   ├── silver_dimensions.py    # dim_customer (SCD2), dim_contract, dim_circuit
│   │   ├── silver_facts.py         # fact_usage, fact_billing (+ DQ expectations)
│   │   └── silver_service_instance.py  # identity resolution → canonical bridge (tmf_* → ra_silver)
│   ├── reconciliation/             # ONE module per check → ra_gold.reconciliation_exceptions
│   │   ├── check1_active_unbilled.sql        # against tmf_resource.logical_resource
│   │   ├── check2_contract_price_mismatch.sql # against tmf_customer.commitment / offering_price
│   │   ├── check3_expired_discount.sql       # against tmf_product.discount_prod_offer_price_alteration
│   │   ├── check4_usage_billing_variance.py  # calls ML model (anomaly detection)
│   │   ├── check5_billing_start_lag.sql      # against tmf_product.order_item
│   │   ├── check6_partner_settlement.sql     # against tmf_businesspartner.rev_share_reconciliation
│   │   └── assemble_exceptions.py  # unions checks, joins to tmf_enterprise.revenue_assurance_violation for seeded types, scores severity/$, writes ra_gold
│   ├── ml/
│   │   ├── train_anomaly.py        # MLflow: usage-vs-billing variance model (note: data is statistically flat; inject anomalies for compelling demo)
│   │   └── forecast_revenue.py     # ai_forecast → ra_gold.revenue_forecast
│   ├── gold/
│   │   └── build_kpis.sql          # ra_gold.leakage_kpis (derived from reconciliation exceptions + _metrics.* views)
│   └── data_simulation/
│       └── simulate_source_systems.py  # generates salesforce_source, oracle_erp_source, refinitiv_fx_source, ironclad_clm_source, mdm_source (keyed to cdm_tmforum customers)
│
├── app/                            # RA Exceptions Console (Databricks App)
│   ├── app.yaml                    # app config + SQL warehouse resource
│   ├── main.py                     # backend (FastAPI) — reads ra_gold.reconciliation_exceptions, reads/writes ra_gold.exception_case
│   ├── requirements.txt
│   └── ui/                         # frontend (list, detail, case, dashboard embed)
│
├── dashboards/
│   └── leakage_dashboard.lvdash.json   # AI/BI dashboard definition (queries ra_gold.*)
│
├── notebooks/                      # narration/demo notebooks (thin wrappers over src/)
│   ├── 00_overview.py
│   ├── 01_ingest_and_pipeline.py   # runs simulate_source_systems, then pipeline
│   ├── 02_reconciliation.py        # runs 6 checks, shows exceptions
│   └── 03_ml_anomaly.py            # shows anomaly model, ai_forecast
│
└── tests/
    ├── test_identity_resolution.py
    ├── test_reconciliation_checks.py   # asserts golden counts/$ per check against real tmf_* data
    ├── test_data_quality.py            # expectation coverage
    └── test_golden_outputs.py          # total seeded leakage $ matches tmf_enterprise.revenue_assurance_violation totals
```

---

## 2. Reconciliation check → file map (sourcing real `cdm_tmforum` tables)

| Check | File | Language | Evidence from `cdm_tmforum` |
| :---- | :---- | :---- | :---- |
| 1 Active-circuit-unbilled | `src/reconciliation/check1_active_unbilled.sql` | SQL | `tmf_resource.logical_resource.lifecycle_status='active'` w/ no bill via RFS→CFS→bill bridge |
| 2 Contract-price mismatch | `src/reconciliation/check2_contract_price_mismatch.sql` | SQL | `tmf_customer.commitment.amount` vs `actual_amount`/`variance_amount` + `salesforce_source.contract_line_item.UnitPrice` |
| 3 Expired/unauthorized discount | `src/reconciliation/check3_expired_discount.sql` | SQL | `tmf_product.discount_prod_offer_price_alteration` validity + approval; `salesforce_source.SBQQ__Quote__c.discount_approval__c` |
| 4 Usage–billing variance | `src/reconciliation/check4_usage_billing_variance.py` | Python (ML) | `tmf_resource.resource_usage` / `tmf_service.service_usage` vs `tmf_customer.bill.usage_charges_amount`; `mediation_status` |
| 5 Billing-start-date lag | `src/reconciliation/check5_billing_start_lag.sql` | SQL | `tmf_product.order_item`: ~50% have `billing_start_date > actual_completion_date` |
| 6 Partner-settlement mismatch | `src/reconciliation/check6_partner_settlement.sql` | SQL | `tmf_businesspartner.rev_share_reconciliation.variance_amount` with status `in_dispute`/`open` |

All 6 checks have corresponding pre-seeded violation types in `tmf_enterprise.revenue_assurance_violation` (12 types, ~10K rows, ~$540M estimated impact).

---

## 3. Data flow and schemas

| Schema | Role | Owner | Input/Output |
| :---- | :---- | :---- | :---- |
| `cdm_tmforum.tmf_*` | **Golden TM Forum SID** — network, billing, CRM, orders, AR, partner settlement | Databricks (read-only) | Input: 10K customers, 100K circuits, 2018–2025 billing |
| `cdm_tmforum.ra_silver` | **Conformed + bridge** — dim_customer, dim_contract, dim_circuit, fact_usage, fact_billing, service_instance | DAB (bundle-created) | Transform: tmf_* → flattened, SCD2 dims, canonical service_instance identity bridge |
| `cdm_tmforum.ra_gold` | **Reconciliation exceptions + KPIs** — reconciliation_exceptions (6 checks), exception_case (case management), revenue_forecast, leakage_kpis | DAB (bundle-created) | Serve: AI/BI dashboard, Genie space, RA Exceptions Console app |
| `<workspace>.salesforce_source`, `oracle_erp_source`, etc. | **Simulated upstream** — Account, Contract, quote, invoice, AR, GL, FX rates, CLM, MDM | DAB (simulate_source_systems job) | Input: keyed to golden customers; feeds reconciliation checks |

**Critical:** `tmf_*` schemas are **read-only** (per catalog owner comment). Build only in `ra_silver` and `ra_gold`.

---

## 4. Naming conventions

- **Catalogs:** `cdm_tmforum` (single, shared golden catalog).  
- **Schemas:** `ra_silver`, `ra_gold` (new RA layers; do not use `lumen_ra`).  
- **Tables:** `ra_silver.<layer>.<entity>`, `ra_gold.<entity>` — snake_case; facts prefixed `fact_`, dims `dim_`.  
- **Jobs:** `ra_<verb>` (e.g. `ra_reconciliation`, `ra_ml_and_forecast`).  
- **Pipeline:** `ra_medallion_pipeline` (Lakeflow Declarative).  
- **Files:** snake_case; checks numbered `checkN_<slug>`.  
- **App:** deployed name `ra-exceptions-console`; display "RA Exceptions Console".  
- **Variables (DAB):** `warehouse_id`, `seed` (catalog is fixed to `cdm_tmforum`).

---

## 5. Language & framework choices

- **Pipelines / reconciliation:** SQL where deterministic (checks 1–3, 5–6), PySpark/Python where ML is involved (check 4).  
- **Source simulation:** Python (`simulate_source_systems` notebook); generates Lakelink Fiber proxy data keyed to `cdm_tmforum.customer`.  
- **App backend:** Python FastAPI (Databricks Apps); reads `ra_gold` via SQL warehouse, writes `ra_gold.exception_case`.  
- **App frontend:** lightweight React/HTML served by the app.  
- **ML:** MLflow for anomaly model; `ai_forecast` SQL function for forecasting. **Note:** seeded data is statistically flat; inject anomalies for compelling anomaly demo.

---

## 6. Environment configuration

`databricks.yml` defines two targets (catalog is always `cdm_tmforum`; serverless warehouse id varies):

| Target | Warehouse | Compute | Purpose |
| :---- | :---- | :---- | :---- |
| `dev` | serverless SQL warehouse (variable) | serverless | build/iterate |
| `prod` | serverless SQL warehouse (variable) | serverless | demo delivery |

Variables (`warehouse_id`, `seed`) are overridable per target. No workspace URLs or secrets hard-coded — see Deployment Contract.

---

## 7. Real scale and data caveats

- **Customers:** ~10,000 (vs. original ~2,000).  
- **Circuits:** ~100,000 active `logical_resource` rows (vs. original ~25,000).  
- **RA violations:** ~10,000 seeded violations across 12 types, totaling ~**$540M estimated impact** (tunable by filtering violation type / date range; Lumen's pitch is $250M–$312M as reference).  
- **Billing history:** 2018–2025 (fully populated).  
- **Data realism:** `cdm_tmforum` is statistically **flat/uniform** — fine for deterministic reconciliation, weak for ML anomaly demo. The `simulate_source_systems` step includes **anomaly injection** for compelling ML scenes.
