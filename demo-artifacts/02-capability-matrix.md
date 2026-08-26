# RA Demo — Capability-to-Scene Matrix

> **Scrutiny summary**
>
> - **Ingestion framing:** Updated from "10 sources land here" (implying generation) to "10 sources already in `cdm_tmforum.tmf_*`" — the demo reads existing data, not builds a synthetic bronze layer. Row 1 now reflects Lakeflow Connect/Auto Loader as a *narrative beat* (showing how sources enter a governed catalog in production), with actual data sourcing from read-only `tmf_*`.
> - **Schema references:** Replaced invented `lumen_ra.bronze.*` with the real single schema `cdm_tmforum.revenue_assurance` — silver materialized views (one per check) and gold MVs (`gold_leakage_summary`, `gold_reconciliation_scorecard`, `gold_anomaly_scores`, `gold_revenue_forecast_anomalies`). `tmf_*` schemas are read-only.
> - **Schema/table + check-set correction (build-verified):** The build uses **one** `revenue_assurance` schema (not `ra_silver`/`ra_gold`), and the check set differs from earlier drafts: `silver_contract_price_reconciliation`, `silver_discount_authorization_check`, `silver_fx_rate_validation`, `silver_ar_aging_analysis`, `silver_revenue_recognition_check`, and two **AI document-intelligence** checks (`silver_doc_intelligence_contracts` / `_invoices`, via `ai_parse_document` + `ai_extract`) — not active-unbilled / usage-variance / billing-start-lag / partner-settlement. Exceptions land in `gold_leakage_summary` (~48K / ~$601M). No `reconciliation_exceptions` / `exception_case` / `leakage_kpis` / `revenue_forecast` tables and no materialized `service_instance` bridge; the app's case state lives in **Lakebase** (`ra.cases` / `ra.case_notes`), and the app is built on **Databricks AppKit** (React/TypeScript).
> - **Data asset lineage:** Updated all data-asset columns to point to real `cdm_tmforum` tables: `tmf_resource.logical_resource` (circuits), `tmf_service.resource_facing_service` (service identity), `tmf_customer` (billing/contracts), `tmf_enterprise.revenue_assurance_violation` (native exceptions), `tmf_enterprise.ra_trouble_ticket` (cases).
> - **Data realism caveat:** Added explicit note to row 7 (ML anomaly) and row 8 (forecasting) that `cdm_tmforum` data is statistically flat/uniform — the build must inject anomalies for these scenes to be compelling.
> - **Persona progression:** Clarified that Priya (data engineer) owns the platform scenes (1–5, 9), Marcus (analyst) owns investigation (11) and case management (12), Dana (VP) bookends with the dashboard (10 at open and close).
> - **Source simulation & anomaly injection correction:** Clarified row 6 that reconciliation checks join `*_source` → `tmf_*` directly without a materialized bridge. Rows 7–8 now specify that anomalies are injected into simulated `*_source` systems (not into silver/gold tables), making the ML/forecast scenes compelling while preserving read-only `tmf_*` base data.

---

## 1. The matrix

| # | Databricks capability | Demo scene / moment | UI surface | Data asset (`cdm_tmforum`) | Proof point | Persona |
| :---- | :---- | :---- | :---- | :---- | :---- | :---- |
| 1 | **Lakeflow Connect / Auto Loader** | "10 systems land in one governed place" | Notebook `01_ingest_and_pipeline` | `tmf_*` schemas (read-only sources: `tmf_resource`, `tmf_service`, `tmf_product`, `tmf_customer`, `tmf_businesspartner`, etc.) | Batch + streaming ingest of telecom sources into governed Unity Catalog without custom glue | Priya |
| 2 | **Delta Lake** | Malformed CDRs don't corrupt results | Notebook / pipeline event log | `tmf_resource.resource_usage` (with `mediation_status` field), `cdm_tmforum.revenue_assurance.silver_*` (conformed) | ACID + schema enforcement quarantines bad records, prevents garbage in/out | Priya |
| 3 | **Lakeflow Declarative Pipelines** | "One declarative pipeline builds the medallion" | Pipeline graph UI | `tmf_customer`, `tmf_product`, `tmf_service.resource_facing_service`, `tmf_customer.bill` (read-only `tmf_*`; silver checks run as post-ingest materialized views) | Data-quality expectations + lineage, incremental refresh without manual DAG coding | Priya |
| 4 | **Identity resolution (Spark SQL)** | "The hard part: making the systems agree" | Notebook (silver checks join `*_source` → `tmf_*` directly) | Silver checks in `cdm_tmforum.revenue_assurance` join identity via source keys (e.g., `salesforce_source.account.TMF_Customer_Id__c` ↔ `tmf_customer.customer`; no materialized `service_instance` bridge); resolves circuit ↔ contract ↔ billing ↔ invoice with ~92% coverage | Silver checks directly resolve identity without a separate bridge | Priya → Marcus |
| 5 | **Unity Catalog governance** | "Is this compliant?" | Catalog Explorer (lineage + tags) | `pii` tags on `tmf_customer.customer.customer_name`, `commitment.approver_name` | Column masking + end-to-end lineage shown live; `ra_analyst` role sees masked data | Dana / Priya |
| 6 | **Reconciliation (Databricks SQL)** | Seven checks surface leakage | SQL editor | `cdm_tmforum.revenue_assurance.silver_*` MVs (7 check types: `contract_price_mismatch`, `unauthorized_discount`, `expired_quote_active`, FX >1% deviation, `ar_collection_risk`, `rev_rec_timing_mismatch`, `doc_contract_mismatch`, `doc_invoice_mismatch`) → `gold_leakage_summary` | Auditable SQL detects each leakage type; register includes `check_type`, `severity`, `amount_at_risk`, `account_name`, `reference_id` | Marcus |
| 7 | **MLflow anomaly model** | Usage outgrows billing tier | Notebook `03_ml_anomaly` + MLflow UI | `cdm_tmforum.revenue_assurance.gold_anomaly_scores` (sourced from `tmf_resource.resource_usage` + `tmf_service.service_usage`, anomalies injected into source simulations) | Catches usage-vs-billing drift deterministic rules miss; **caveat:** `cdm_tmforum` base data is statistically flat/uniform — demo injects sharp anomalies into `*_source` for compelling detection | Priya → Marcus |
| 8 | **`ai_forecast` SQL function** | Expected-vs-actual revenue early warning | SQL editor / dashboard tile | `cdm_tmforum.revenue_assurance.gold_revenue_forecast_anomalies` (monthly GL revenue vs forecast + budget variance, sourced from `oracle_erp_source.gl_je_lines`, `oracle_erp_source.gl_budgets`, with historical 2018–2025 base from `tmf_customer`) | Variance flag before a manual audit would catch it; **caveat:** uniform base data requires anomaly injection into GL series for strong signal | Dana |
| 9 | **Databricks Workflows (serverless)** | "It all runs as one governed job" | Jobs UI (DAG) | Orchestrates medallion (3) → reconcile (6) → ML (7) → KPI refresh | Reproducible, serverless, no cluster babysitting; full pipeline in <15 min | Priya |
| 10 | **AI/BI Dashboard** | The leakage headline & the payoff | *Leakage Overview* dashboard (lvdash.json) | `cdm_tmforum.revenue_assurance.gold_leakage_summary`, `gold_reconciliation_scorecard` (sourced from 7 silver checks, pre-seeded ~$540M baseline + injected anomalies) | $ at risk (~$601M register total / ~$54M/month current), leakage rate, severity mix, recovered-to-date by product/region/month | Dana |
| 11 | **Genie** | Investigate one exception in plain English | Genie space | `cdm_tmforum.revenue_assurance.gold_leakage_summary`, `silver_*` checks, `tmf_resource.logical_resource`, `tmf_service.resource_facing_service` | Analyst self-service without SQL; e.g., "show usage for circuit X last 90 days" + "which contracts have unauthorized discounts?" | Marcus |
| 12 | **Databricks Apps** | Work & recover the exception | RA Exceptions Console (AppKit) | `cdm_tmforum.revenue_assurance.gold_leakage_summary` (read via SQL warehouse), `ra.cases` / `ra.case_notes` in Lakebase (write) | Closes the loop: New → Investigating → Recovering → Recovered; captures recovered $, writes case record to Lakebase | Marcus |
| 13 | **Databricks Assistant / coding agent** | "This whole demo was built with the agent" (meta) | IDE / notebook | `revenue-assurance` repo | Speed-to-build narrative for the field; agent wrote the reconciliation SQL, the Lakeflow Declarative Pipeline, the anomaly model | Priya |

---

## 2. Scene sequencing (live-demo order)

The scenes are ordered to tell the leakage story front-to-back — problem, platform, detection, investigation, recovery, payoff:

1. **Scene A — The problem** → *AI/BI Dashboard* (rows 10, 8): Dana sees ~$54M/month leaking (from ~$540M total estimated impact across seeded ~10K violations) by root cause, product, region.
2. **Scene B — The foundation** → *Ingestion + Pipeline + UC* (rows 1, 2, 3, 5): Priya shows sources already in `cdm_tmforum.tmf_*`, the declarative medallion reading from `tmf_*` + simulated `*_source`, and governance/lineage with PII masking.
3. **Scene C — The hard part** → *Identity resolution* (row 4): how the silver checks join identity via source keys without a materialized bridge (circuit ↔ contract ↔ billing ↔ invoice).
4. **Scene D — The detection** → *Reconciliation SQL + ML + Workflows* (rows 6, 7, 9): seven checks + the anomaly model populate `cdm_tmforum.revenue_assurance.gold_leakage_summary`, orchestrated by one serverless job; all sourcing from real `cdm_tmforum` tables + simulated `*_source`.
5. **Scene E — The investigation** → *Genie* (row 11): Marcus interrogates a high-severity exception in natural language; ad-hoc drill-down without writing SQL.
6. **Scene F — The recovery** → *RA Exceptions Console* (row 12): Marcus moves the case New → Investigating → Recovering → Recovered; console writes case state to Lakebase (`ra.cases`).
7. **Scene G — The payoff** → back to the *Dashboard* (row 10): recovered-$ and leakage-rate KPIs update; the loop closes; Dana sees progress.
8. **Scene H — The meta close (optional)** → *Databricks Assistant* (row 13): "and the agent built all of this — here's the repo, here's the notebooks."

> **Rule of thumb for sequencing:** never show a capability before the audience needs it. The dashboard opens *and* closes the demo so Dana's business question ("how much are we losing at Lakelink Fiber, and is our recovery improving?") frames every technical scene in between. Priya's platform/data scenes (B–D) build the trust that data is governed, lineage is traceable, and reconciliation is auditable. Marcus' analyst scenes (E–F) show that Genie + the Console deliver speed and insight.

---

## 3. Coverage check

Every capability in the Product Requirements "capabilities to showcase" list appears in at least one row above, and every row ties to a real `cdm_tmforum` asset defined in the Domain Model & Data Contract. No orphan features; no orphan tables. All scenes use real `cdm_tmforum` schemas (`tmf_*` read-only source, `revenue_assurance` for reconciliation logic; `*_source` for simulated upstreams) and the `demo-workspace` workspace.
