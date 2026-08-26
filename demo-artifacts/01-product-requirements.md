# RA Demo — Product Requirements & Build Contract

> **Scrutiny summary**
>
> - **Data sourcing and catalog naming:** Corrected from invented "build a `lumen_ra` catalog with synthesized `bronze.*` schemas" to reality: data lives in the read-only `cdm_tmforum.tmf_*` schemas on the `demo-workspace` workspace. The reconciliation layer is built as a single new schema `cdm_tmforum.revenue_assurance` (per the catalog's ownership model) — do not generate a bronze layer.
> - **Schema/table correction (build-verified):** The build uses **one** schema `cdm_tmforum.revenue_assurance` (not an `ra_silver`/`ra_gold` split): silver materialized views per check (`silver_contract_price_reconciliation` → `contract_price_mismatch`, `silver_discount_authorization_check` → `unauthorized_discount` + `expired_quote_active`, `silver_fx_rate_validation` → FX >1% deviation, `silver_ar_aging_analysis` → `ar_collection_risk`, `silver_revenue_recognition_check` → `rev_rec_timing_mismatch`, `silver_doc_intelligence_contracts` → `doc_contract_mismatch`, `silver_doc_intelligence_invoices` → `doc_invoice_mismatch`) feed gold MVs (`gold_leakage_summary`, `gold_reconciliation_scorecard`, `gold_anomaly_scores`, `gold_revenue_forecast_anomalies`). The invented `reconciliation_exceptions` / `exception_case` / `leakage_kpis` / `revenue_forecast` tables and the materialized `service_instance` bridge are gone; the app's case state lives in **Lakebase** (`ra.cases` / `ra.case_notes`), not Delta. The derived register `gold_leakage_summary` holds **~48K exceptions / ~$601M at risk** across 7 `check_type`s.
> - **Demo dataset scale:** Fixed from invented "~2,000 customers, ~25,000 circuits, ~910 exceptions, ~$1.9M/month leakage" to real seeded data: ~10,000 customers, ~100,000 circuits, ~10,000 RA violations across 12 pre-seeded types, ~$540M estimated impact total. Lumen's business-case framing ($250M–$312M / 2–2.5%) is the *pitch context*, distinct from the demo dataset's seeded figure.
> - **Real tables cited:** Replaced invented tables with actual `cdm_tmforum` schemas: `tmf_resource.logical_resource` (circuits), `tmf_service.resource_facing_service`/`service_usage` (service identity + usage), `tmf_customer.bill`/`commitment` (billing + contracts), `tmf_enterprise.revenue_assurance_violation` (native exceptions with 12 violation types), `tmf_enterprise.ra_trouble_ticket` (case management).
> - **Cloud / deployment:** Updated from "Azure workspace, serverless-first (mirrors Rogers)" to "deploy to the `demo-workspace` workspace via the `demo` profile; confirm cloud at deploy time."
> - **ML data realism caveat:** Added note that `cdm_tmforum` data is statistically flat/uniform — strong for deterministic reconciliation, weak for compelling ML demo; the build must inject a handful of sharp anomalies for the anomaly-detection and forecasting scenes.

---

## 1. Purpose & business scenario

Lumen Technologies (approximately $12.5 billion in B2B broadband & enterprise networking revenue) loses an estimated **2–2.5% of revenue** to revenue leakage: active circuits that never get billed, prices that drift from contract, expired discounts still applied, usage that outgrows its billing tier, delayed billing starts, and partner-settlement gaps. The gross leakage impact is roughly **$250 million to $312.5 million annually**. The root cause is **siloed systems and manual reconciliation** — network provisioning, CRM, billing, CPQ, and partner feeds never agree on what a customer *should* be billed.

This demo shows how a Databricks lakehouse reads all those sources (which already exist in the TM Forum Common Data Model), reconciles the simulated upstream systems against the golden data, and runs automated reconciliation + anomaly detection to surface leakage in minutes instead of months — then routes each exception to an analyst for recovery.

## 2. Target personas

| Persona | Role | What they need from the demo |
| :---- | :---- | :---- |
| **Dana Whitfield** | VP, Revenue Assurance (economic buyer) | Board-level leakage $, recovery trend, "is this getting better?" |
| **Marcus Chen** | Senior RA Analyst (primary user) | A prioritized exception queue, the ability to investigate in plain language, and a way to action recovery |
| **Priya Nair** | Lead Data Engineer | Trust that pipelines are governed, tested, and reproducible |

## 3. Demo narrative / storyline

1. **The problem** — Dana opens the *Leakage Overview* dashboard: ~$54M/month currently detected across Lakelink Fiber's ~10K customers and ~100K circuits (representing ~$540M estimated total impact across all seeded violation types).
2. **The platform** — Priya shows the medallion pipeline: the 10 source systems already landed in `cdm_tmforum.tmf_*` schemas, plus the simulated `*_source` upstreams (salesforce_source, oracle_erp_source, refinitiv_fx_source, ironclad_clm_source, mdm_source) → silver reconciliation materialized views in `cdm_tmforum.revenue_assurance` (one per check), joining source systems to the golden `tmf_*` data.
3. **The detection** — seven reconciliation checks (contract-price, discount authorization, FX validation, AR aging, rev-rec timing, and two AI document-intelligence checks) plus an ML anomaly model feed `revenue_assurance.gold_leakage_summary`, all orchestrated by a single serverless Databricks Workflow.
4. **The investigation** — Marcus filters the *Exceptions Queue* to high-severity, opens one high-value *contract-price-mismatch* case, and asks Genie plain-language follow-ups ("show billed vs contracted price for this account").
5. **The recovery** — Marcus works the case in the **RA Exceptions Console** app: New → Investigating → Recovering → Recovered, capturing the recovered $.
6. **The payoff** — the dashboard's recovered-to-date and leakage-rate KPIs update; Dana sees the loop close.

## 4. Must-have flows (in scope)

- **F1 — Ingest & govern:** Read from all 10 source schemas already present in `cdm_tmforum` (`tmf_resource`, `tmf_service`, `tmf_product`, `tmf_customer`, `tmf_businesspartner`, etc.); PII columns (customer_name, approver) are tagged and masked in Unity Catalog.
- **F2 — Reconciliation layer:** the checks are built as SQL **materialized views** in `cdm_tmforum.revenue_assurance` (silver, one per check), joining the simulated `*_source` systems to the golden `tmf_*` data. There is no separate materialized identity bridge — checks resolve identity via source keys (e.g. `salesforce_source.account.TMF_Customer_Id__c` ↔ `tmf_customer.customer`).
- **F3 — Reconciliation:** the silver checks union into **`revenue_assurance.gold_leakage_summary`** — one row per detected exception with `check_type`, `severity`, `amount_at_risk`, `account_name`, `reference_id`, `source_table`, `detection_method`, and `known_leakage_flag`. Per-customer health rolls up into `gold_reconciliation_scorecard`.
- **F4 — ML anomaly + forecast:** an ML anomaly model writes `gold_anomaly_scores` and `ai_forecast` writes `gold_revenue_forecast_anomalies` (monthly GL revenue vs forecast + budget variance); data realism caveat: `cdm_tmforum` data is statistically flat, so anomaly injection is needed for a compelling demo.
- **F5 — Dashboard:** AI/BI *Leakage Overview* shows leakage $, rate, and root-cause mix over `revenue_assurance.gold_*`.
- **F6 — Genie:** natural-language Q&A over the `revenue_assurance.gold_*` tables for ad-hoc investigation by analysts.
- **F7 — RA Exceptions Console app:** built on **Databricks AppKit** (React/TypeScript); reads `cdm_tmforum.revenue_assurance.gold_leakage_summary` via a SQL warehouse and writes case state — assign, lifecycle (New → Investigating → Recovering → Recovered / WrittenOff), and notes — to **Lakebase Postgres** (`ra.cases` / `ra.case_notes`).
- **F8 — Reset & reproduce:** the whole environment rebuilds to a known seeded state (deterministic leakage totals: ~$540M across 12 violation types in ~10K seeded exceptions).

## 5. Success criteria (measurable)

| # | Criterion | Target |
| :---- | :---- | :---- |
| S1 | Pipeline builds all layers from raw to gold | < 15 min on serverless |
| S2 | Seeded exceptions detected | ≥ 95% of the ~10K seeded violations surfaced, per-type counts within ±2% of golden |
| S3 | Identity resolution coverage | ≥ 92% of active circuits resolved (`match_method` exact/fuzzy) |
| S4 | Headline leakage figure | Deterministic derived register (`cdm_tmforum.revenue_assurance.gold_leakage_summary` ≈ ~$601M at risk / ~48K exceptions) on every reset |
| S5 | Genie answers | 5 scripted questions answer correctly with sources |
| S6 | Case lifecycle | An exception can move New→Recovered and the dashboard KPI reflects it live |
| S7 | Governance | PII masked for `ra_analyst`; lineage visible end-to-end |
| S8 | Live-demo runtime | Full narrated flow in ≤ 25 min |

## 6. Non-goals / out of scope

- Real Lumen data or live source-system connectors (Lakelink Fiber synthetic data only).
- Automated write-back to billing/CRM systems (recovery is recorded in the app, not executed downstream).
- Multi-tenant security, SSO, or production hardening of the app.
- Real-time streaming SLAs (batch + micro-batch is sufficient for the story).
- Full ASC 606 revenue-recognition accounting.
- Model accuracy tuning beyond "detects the seeded anomalies."

## 7. Databricks capabilities to showcase (and why each earns its place)

| Capability | Why it's in the demo |
| :---- | :---- |
| Lakeflow Connect / Auto Loader | Shows how disparate telecom sources land in a governed catalog (already ingested into `cdm_tmforum`) |
| Lakeflow Declarative Pipelines | Declarative medallion + data-quality expectations = trustworthy reconciliation inputs |
| Delta Lake | ACID + schema enforcement stops malformed CDRs corrupting reconciliation |
| Unity Catalog | Governance, lineage, PII masking — the compliance story RA teams demand |
| Databricks Workflows (serverless) | One orchestrated job runs medallion→reconcile→ML→KPI refresh; reproducible, no cluster management |
| Databricks SQL + AI/BI dashboards | Business-facing leakage KPIs for Dana without a separate BI tool |
| Genie | Analysts investigate in natural language — democratizes access without SQL expertise |
| **AI Functions (`ai_parse_document`, `ai_extract`)** | Document intelligence: parse Ironclad contract & invoice PDFs and extract terms, then reconcile against the system of record (the `silver_doc_intelligence_*` checks) |
| MLflow anomaly model | Catches drift deterministic rules can't → `gold_anomaly_scores` (with data-realism caveat on uniform data) |
| `ai_forecast` SQL function | Expected-vs-actual revenue variance as an early-warning signal → `gold_revenue_forecast_anomalies` |
| Databricks Apps (AppKit) | The RA Exceptions Console (React/TypeScript on AppKit) closes the loop from insight → action, with Lakebase-backed case management |

## 8. Proof points mapped to Lumen's leakage story

- **"We can't see leakage until months later"** → reconciliation runs in one job; exceptions appear same-run.
- **"Our systems don't agree"** → reconciliation joins resolve contract ↔ billing ↔ invoice across the simulated source systems and the golden `tmf_*` data.
- **"Manual audits miss things"** → seven automated checks (incl. AI document-intelligence on contract/invoice PDFs) + ML anomaly across ~10K customers.
- **"We can't prove recovery"** → case lifecycle + recovered-$ KPI quantifies the win.
- **"Is this compliant?"** → UC lineage + PII masking shown live.

## 9. Assumptions & constraints

- Deployed to the `demo-workspace` workspace via the `demo` profile; cloud environment to be confirmed at deployment time.
- Data sourced from `cdm_tmforum` TM Forum Common Data Model (read-only `tmf_*` schemas); build new reconciliation logic in the `cdm_tmforum.revenue_assurance` schema (silver + gold materialized views).
- Lakelink Fiber synthetic dataset at demo scale: ~10,000 customers, ~100,000 active circuits, ~10,000 seeded RA violations across 12 violation types, totaling ~$540M estimated impact, with deterministic seeded leakage.
- **Data realism caveat:** `cdm_tmforum` data is statistically flat/uniform (round counts, ~50/50 splits) — excellent for deterministic reconciliation, weaker for compelling ML anomaly-detection scenes. The build must inject a handful of sharp anomalies for F4 (ML) and related forecasting demos.
- Deployed via Databricks Asset Bundles from the `revenue-assurance` repo; teardown via `databricks bundle destroy` (cleans only the new `cdm_tmforum.revenue_assurance` and `*_source` schemas, the Lakebase project, the app, and orchestration jobs; never touches read-only `tmf_*` source).
- All table names and schemas per the canonical spec in `data-source-assessment.md`.
