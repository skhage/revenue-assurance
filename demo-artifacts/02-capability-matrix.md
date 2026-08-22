# RA Demo — Capability-to-Scene Matrix

> **Scrutiny summary**
>
> - **Ingestion framing:** Updated from "10 sources land here" (implying generation) to "10 sources already in `cdm_tmforum.tmf_*`" — the demo reads existing data, not builds a synthetic bronze layer. Row 1 now reflects Lakeflow Connect/Auto Loader as a *narrative beat* (showing how sources enter a governed catalog in production), with actual data sourcing from read-only `tmf_*`.
> - **Schema references:** Replaced invented `lumen_ra.bronze.*`, `lumen_ra.silver.*` with real names: `cdm_tmforum.ra_silver.*` (conformed dims/facts + `service_instance` bridge) and `cdm_tmforum.ra_gold.*` (exceptions, cases, KPIs). Clarified that `tmf_*` schemas are read-only per catalog governance.
> - **Data asset lineage:** Updated all data-asset columns to point to real `cdm_tmforum` tables: `tmf_resource.logical_resource` (circuits), `tmf_service.resource_facing_service` (service identity), `tmf_customer` (billing/contracts), `tmf_enterprise.revenue_assurance_violation` (native exceptions), `tmf_enterprise.ra_trouble_ticket` (cases).
> - **Data realism caveat:** Added explicit note to row 7 (ML anomaly) and row 8 (forecasting) that `cdm_tmforum` data is statistically flat/uniform — the build must inject anomalies for these scenes to be compelling.
> - **Persona progression:** Clarified that Priya (data engineer) owns the platform scenes (1–5, 9), Marcus (analyst) owns investigation (11) and case management (12), Dana (VP) bookends with the dashboard (10 at open and close).

---

## 1. The matrix

| # | Databricks capability | Demo scene / moment | UI surface | Data asset (`cdm_tmforum`) | Proof point | Persona |
| :---- | :---- | :---- | :---- | :---- | :---- | :---- |
| 1 | **Lakeflow Connect / Auto Loader** | "10 systems land in one governed place" | Notebook `01_ingest_and_pipeline` | `tmf_*` schemas (read-only sources: `tmf_resource`, `tmf_service`, `tmf_product`, `tmf_customer`, `tmf_businesspartner`, etc.) | Batch + streaming ingest of telecom sources into governed Unity Catalog without custom glue | Priya |
| 2 | **Delta Lake** | Malformed CDRs don't corrupt results | Notebook / pipeline event log | `tmf_resource.resource_usage` (with `mediation_status` field), `ra_silver.fact_usage` (conformed) | ACID + schema enforcement quarantines bad records, prevents garbage in/out | Priya |
| 3 | **Lakeflow Declarative Pipelines** | "One declarative pipeline builds the medallion" | Pipeline graph UI | `ra_silver.dim_customer`, `ra_silver.dim_product`, `ra_silver.fact_usage`, `ra_silver.fact_billing` | Data-quality expectations + lineage, incremental refresh without manual DAG coding | Priya |
| 4 | **Identity resolution (Spark SQL)** | "The hard part: making the systems agree" | Notebook + `service_instance` table | `ra_silver.service_instance` (canonical bridge: circuit ↔ contract ↔ billing account ↔ invoice; sourced from `tmf_resource.logical_resource`, `tmf_service.resource_facing_service`, `tmf_customer.commitment`, `tmf_customer.bill`) | circuit ↔ contract ↔ billing ↔ invoice resolved with `match_confidence` (exact/fuzzy); ~92% coverage | Priya → Marcus |
| 5 | **Unity Catalog governance** | "Is this compliant?" | Catalog Explorer (lineage + tags) | `pii` tags on `tmf_customer.customer.customer_name`, `commitment.approver_name` | Column masking + end-to-end lineage shown live; `ra_analyst` role sees masked data | Dana / Priya |
| 6 | **Reconciliation (Databricks SQL)** | Six checks surface leakage | SQL editor | `ra_gold.reconciliation_exceptions` (6 check types, each linked to pre-seeded `tmf_enterprise.revenue_assurance_violation` types: `billing_leakage`, `tariff_mismatch`, `revenue_recognition_error`, `usage_reconciliation_gap`, `provisioning_discrepancy`, `partner_settlement_discrepancy`) | Auditable SQL detects each leakage type; exceptions include `leakage_amount_usd`, `root_cause`, `violation_type` | Marcus |
| 7 | **MLflow anomaly model** | Usage outgrows billing tier | Notebook `03_ml_anomaly` + MLflow UI | `ra_silver.fact_usage` (sourced from `tmf_resource.resource_usage` + `tmf_service.service_usage`) | Catches usage-vs-billing drift deterministic rules miss (check #4); **caveat:** `cdm_tmforum` data is statistically flat/uniform — demo injects sharp anomalies for compelling detection | Priya → Marcus |
| 8 | **`ai_forecast` SQL function** | Expected-vs-actual revenue early warning | SQL editor / dashboard tile | `ra_gold.revenue_forecast` (sourced from `tmf_customer.bill`, `ra_silver.fact_usage`, with historical 2018–2025 base from `tmf_customer`) | Variance flag before a manual audit would catch it; **caveat:** uniform data requires anomaly injection for strong signal | Dana |
| 9 | **Databricks Workflows (serverless)** | "It all runs as one governed job" | Jobs UI (DAG) | Orchestrates medallion (3) → reconcile (6) → ML (7) → KPI refresh | Reproducible, serverless, no cluster babysitting; full pipeline in <15 min | Priya |
| 10 | **AI/BI Dashboard** | The leakage headline & the payoff | *Leakage Overview* dashboard | `ra_gold.leakage_kpis`, `ra_gold.reconciliation_exceptions`, `ra_gold.exception_case` (sourced ultimately from `tmf_enterprise.revenue_assurance_violation` + `tmf_enterprise.ra_trouble_ticket`) | $ leaked (~$540M total / ~$54M/month), leakage rate, days-to-bill, recovered-to-date by product/region/month | Dana |
| 11 | **Genie** | Investigate one exception in plain English | Genie space | `ra_gold.reconciliation_exceptions`, `ra_silver.fact_usage`, `ra_silver.dim_contract` (all sourced from `tmf_*`) | Analyst self-service without SQL; e.g., "show usage for circuit X last 90 days" + "which orders are unbilled?" | Marcus |
| 12 | **Databricks Apps** | Work & recover the exception | RA Exceptions Console | `ra_gold.reconciliation_exceptions` (read), `ra_gold.exception_case` (write; mirrors lifecycle of `tmf_enterprise.ra_trouble_ticket`) | Closes the loop: New → Investigating → Recovering → Recovered; captures recovered $, writes case record | Marcus |
| 13 | **Databricks Assistant / coding agent** | "This whole demo was built with the agent" (meta) | IDE / notebook | `revenue-assurance` repo | Speed-to-build narrative for the field; agent wrote the reconciliation SQL, the Lakeflow Declarative Pipeline, the anomaly model | Priya |

---

## 2. Scene sequencing (live-demo order)

The scenes are ordered to tell the leakage story front-to-back — problem, platform, detection, investigation, recovery, payoff:

1. **Scene A — The problem** → *AI/BI Dashboard* (rows 10, 8): Dana sees ~$54M/month leaking (from ~$540M total estimated impact across seeded ~10K violations) by root cause, product, region.
2. **Scene B — The foundation** → *Ingestion + Pipeline + UC* (rows 1, 2, 3, 5): Priya shows sources already in `cdm_tmforum.tmf_*`, the declarative medallion building `ra_silver`, and governance/lineage with PII masking.
3. **Scene C — The hard part** → *Identity resolution* (row 4): the `ra_silver.service_instance` bridge that makes leakage detectable (circuit ↔ contract ↔ billing ↔ invoice).
4. **Scene D — The detection** → *Reconciliation SQL + ML + Workflows* (rows 6, 7, 9): six checks + the anomaly model populate `ra_gold.reconciliation_exceptions`, orchestrated by one serverless job; all sourcing from real `cdm_tmforum` tables.
5. **Scene E — The investigation** → *Genie* (row 11): Marcus interrogates a high-severity exception in natural language; ad-hoc drill-down without writing SQL.
6. **Scene F — The recovery** → *RA Exceptions Console* (row 12): Marcus moves the case New → Investigating → Recovering → Recovered; console writes `ra_gold.exception_case`.
7. **Scene G — The payoff** → back to the *Dashboard* (row 10): recovered-$ and leakage-rate KPIs update; the loop closes; Dana sees progress.
8. **Scene H — The meta close (optional)** → *Databricks Assistant* (row 13): "and the agent built all of this — here's the repo, here's the notebooks."

> **Rule of thumb for sequencing:** never show a capability before the audience needs it. The dashboard opens *and* closes the demo so Dana's business question ("how much are we losing at Lakelink Fiber, and is our recovery improving?") frames every technical scene in between. Priya's platform/data scenes (B–D) build the trust that data is governed, lineage is traceable, and reconciliation is auditable. Marcus' analyst scenes (E–F) show that Genie + the Console deliver speed and insight.

---

## 3. Coverage check

Every capability in the Product Requirements "capabilities to showcase" list appears in at least one row above, and every row ties to a real `cdm_tmforum` asset defined in the Domain Model & Data Contract. No orphan features; no orphan tables. All scenes use real `cdm_tmforum` schemas (`tmf_*` read-only source, `ra_silver` and `ra_gold` for reconciliation logic) and the `demo-workspace` workspace.
