# RA Demo — Repository Blueprint

> **Scrutiny summary**
> - ✅ **2026-08-26:** Aligned to the **built** repo. One schema `cdm_tmforum.revenue_assurance` (not `ra_silver`/`ra_gold`); the reconciliation layer is **materialized views** in `reconciliation/transformations/*.sql`; source simulation is `data-sim/simulate_source_systems.py`; the app is a **Databricks AppKit** project at `ra-exceptions-console/` (React/TypeScript), not a `src/`-based FastAPI app. Table names, the check set, and the folder tree corrected.
> - **Catalog/schema naming:** ❌ Original built `ra_silver`/`ra_gold` (and, older, a `lumen_ra` catalog). ✅ Now a single `cdm_tmforum.revenue_assurance` schema of silver + gold MVs; `tmf_*` read-only inputs, `*_source` simulated upstream.
> - **Check set:** ❌ Original's six checks (active-unbilled, usage–billing variance, billing-start-lag, partner-settlement, …). ✅ The built set is **seven** silver checks: contract-price, discount-authorization, FX-validation, AR-aging, rev-rec timing, and two AI document-intelligence checks → unioned into `gold_leakage_summary`.
> - **Case state:** ❌ `ra_gold.exception_case` (Delta). ✅ Case state lives in **Lakebase Postgres** (`ra.cases`/`ra.case_notes`), owned by the app.
> - **Real scale:** derived register ~48K exceptions / ~$601M at risk across 7 check_types; native `revenue_assurance_violation` ~10K / ~$540M (context).

**Demo:** Revenue Assurance Lakehouse for Lakelink Fiber (pitched to Lumen Technologies)
**Repo:** `revenue-assurance` | **IaC:** Databricks Asset Bundles (DABs) + `databricks apps`
**Data source:** `cdm_tmforum` catalog on `demo-workspace` (`demo` CLI profile)

Removes ambiguity about where every file belongs and clarifies the separation between **reading golden data** (`tmf_*` read-only) and **building new RA logic** (the single `revenue_assurance` schema + the AppKit app).

---

## 1. Folder tree (as built)

```
revenue-assurance/
├── CLAUDE.md                        # repo guidance (ground rules, redaction, architecture)
├── data-source-assessment.md        # which data exists vs. must be simulated
│
├── reconciliation/
│   └── transformations/             # the reconciliation layer as materialized views
│       ├── silver_reconciliation.sql     # contract-price, discount-auth, FX, AR-aging, rev-rec MVs
│       ├── silver_doc_intelligence.sql   # ai_parse_document + ai_extract on contract/invoice PDFs
│       └── gold_aggregation.sql          # gold_leakage_summary, _scorecard, _forecast_anomalies
│
├── data-sim/
│   ├── simulate_source_systems.py   # generates salesforce_source, oracle_erp_source,
│   │                                #   refinitiv_fx_source, ironclad_clm_source, mdm_source
│   └── config.yaml                  # scale/seed/anomaly-injection config
│
├── Lakelink Fiber — Revenue Assurance Command Center.lvdash.json   # AI/BI dashboard
│
├── ra-exceptions-console/           # RA Exceptions Console — Databricks AppKit app
│   ├── databricks.yml               # DAB: app resource (sql-warehouse + lakebase), sync.include
│   ├── app.yaml                     # runtime command + resource env bindings
│   ├── config/queries/*.sql         # analytics queries (kpi_summary, rootcause_breakdown,
│   │                                #   exceptions_list, exception_detail) — type-safe
│   ├── server/                      # Express backend: case routes (Lakebase) + /api/whoami
│   │   └── routes/cases.ts          # ra.cases / ra.case_notes CRUD + status lifecycle guard
│   ├── client/src/                  # React UI: Overview, Exception queue + drawer, My cases
│   │   ├── pages/  components/  lib/ # (client/src/lib re-included past the Python .gitignore)
│   └── shared/appkit-types/         # generated types from config/queries
│
├── demo-artifacts/                  # the 10 numbered planning docs (this set)
└── .claude/skills/                  # ra-data-explorer, ra-demo-build, ra-source-simulation
```

---

## 2. Reconciliation check → file map (sourcing real `cdm_tmforum` data)

Each check is a **materialized view** in `cdm_tmforum.revenue_assurance`; flagged rows union into `gold_leakage_summary`.

| Silver check (MV) | File | Evidence (source → `tmf_*`) | `check_type` |
| :---- | :---- | :---- | :---- |
| `silver_contract_price_reconciliation` | `silver_reconciliation.sql` | `salesforce_source.contract_line_item.UnitPrice` vs `tmf_customer.bill` | `contract_price_mismatch` |
| `silver_discount_authorization_check` | `silver_reconciliation.sql` | `salesforce_source.sbqq__quoteline__c` vs `sbqq__quote__c.discount_approval__c` | `unauthorized_discount`, `expired_quote_active` |
| `silver_fx_rate_validation` | `silver_reconciliation.sql` | `oracle_erp_source.ra_customer_trx_all` vs Refinitiv mid-market (>1%) | (FX deviation; not in register) |
| `silver_ar_aging_analysis` | `silver_reconciliation.sql` | `oracle_erp_source.ar_payment_schedules_all` (DSO, 90+d) | `ar_collection_risk` |
| `silver_revenue_recognition_check` | `silver_reconciliation.sql` | ASC-606 `oracle_erp_source.revenue_recognition_schedule` vs `gl_je_lines` | `rev_rec_timing_mismatch` |
| `silver_doc_intelligence_contracts` | `silver_doc_intelligence.sql` | `ai_parse_document`+`ai_extract` on `ironclad_clm_source` contract PDFs vs system | `doc_contract_mismatch` |
| `silver_doc_intelligence_invoices` | `silver_doc_intelligence.sql` | `ai_parse_document`+`ai_extract` on invoice PDFs vs system | `doc_invoice_mismatch` |

Identity resolution joins the `*_source` systems to `tmf_*` **directly** (e.g. `salesforce_source.account.TMF_Customer_Id__c` ↔ `tmf_customer.customer.customer_id`) — there is **no** materialized `service_instance` bridge; the native `tmf_*` `logical_resource → RFS → CFS → customer → bill` chain is context only.

---

## 3. Data flow and schemas

| Schema | Role | Owner | Input/Output |
| :---- | :---- | :---- | :---- |
| `cdm_tmforum.tmf_*` | **Golden TM Forum SID** — network, billing, CRM, orders, AR, partner settlement | Databricks (read-only) | Input: 10K customers, 100K circuits, 2018–2025 billing |
| `cdm_tmforum.*_source` | **Simulated upstream** — Salesforce, Oracle ERP, Refinitiv FX, Ironclad CLM, MDM | `simulate_source_systems` | Input: keyed to golden customers; feeds the checks |
| `cdm_tmforum.revenue_assurance` | **RA layer** — 7 silver check MVs + 4 gold MVs (`gold_leakage_summary`, `gold_reconciliation_scorecard`, `gold_anomaly_scores`, `gold_revenue_forecast_anomalies`) | demo build | Serve: AI/BI dashboard, Genie, RA Exceptions Console |
| Lakebase `ra` (project `ra-console-lakebase`) | **Case state** — `ra.cases`, `ra.case_notes` | app service principal | Read/write: assign, status lifecycle, notes |

**Critical:** `tmf_*` schemas are **read-only**. Build only in `revenue_assurance` (and the `*_source` schemas). Mutable case state is **not** Delta — it is Lakebase Postgres.

---

## 4. Naming conventions

- **Catalog:** `cdm_tmforum` (single, shared golden catalog).
- **Schema:** `revenue_assurance` (one new RA schema; do **not** use `ra_silver`/`ra_gold` or `lumen_ra`).
- **Tables (MVs):** `silver_<check>` and `gold_<subject>` — snake_case.
- **Reconciliation SQL:** `reconciliation/transformations/*.sql` (silver_reconciliation, silver_doc_intelligence, gold_aggregation).
- **App:** deployed name `ra-exceptions-console`; display "RA Exceptions Console".
- **Lakebase:** project `ra-console-lakebase`, schema `ra` (`ra.cases`, `ra.case_notes`).
- **Variables (DAB):** `sql_warehouse_id`, `postgres_project/branch/database` (catalog fixed to `cdm_tmforum`).

---

## 5. Language & framework choices

- **Reconciliation:** **SQL materialized views** (`CREATE OR REFRESH MATERIALIZED VIEW`) — deterministic checks + `ai_parse_document`/`ai_extract` (document intelligence) + `ai_forecast` (revenue anomalies). ML anomaly scoring in `gold_anomaly_scores`.
- **Source simulation:** Python (`data-sim/simulate_source_systems.py` + `config.yaml`); generates Lakelink Fiber proxy data keyed to `cdm_tmforum` customers, with anomaly injection for the ML/forecast scenes.
- **RA Exceptions Console:** **Databricks AppKit** — React/TypeScript frontend + Express/Node backend. Reads analytics via the `analytics` plugin (SQL warehouse, type-safe `config/queries/*.sql`); writes case state via the `lakebase` plugin (Postgres). **Not** a Python FastAPI app.
- **Serving:** AI/BI dashboard (`*.lvdash.json`), a Genie space over `revenue_assurance.*`, and the app.

---

## 6. Environment configuration

The app's `databricks.yml` uses a single default target; the workspace **host resolves from the CLI profile** (never hardcoded). Variables: `sql_warehouse_id`, `postgres_project`, `postgres_branch`, `postgres_database`. Deploy with `databricks apps deploy --profile <name>` (see artifact 06).

---

## 7. Real scale and data caveats

- **Customers:** ~10,000. **Circuits:** ~100,000 `logical_resource` rows. **Billing history:** 2018–2025.
- **Native RA violations:** ~10,000 across 12 types, ~**$540M** estimated impact (context; Lumen's pitch is $250M–$312M as reference framing).
- **Derived register (`gold_leakage_summary`):** **~48K exceptions / ~$601M at risk** across 7 `check_type`s — the figures the app and dashboard actually show.
- **Data realism:** `cdm_tmforum` is statistically **flat/uniform** — fine for deterministic reconciliation, weak for ML anomaly. `simulate_source_systems` injects sharp anomalies for the ML/`ai_forecast` scenes.
