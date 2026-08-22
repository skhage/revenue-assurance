# RA Demo — Product Requirements & Build Contract

> **Scrutiny summary**
>
> - **Data sourcing and catalog naming:** Corrected from invented "build a `lumen_ra` catalog with synthesized `bronze.*` schemas" to reality: data lives in the read-only `cdm_tmforum.tmf_*` schemas on the `demo-workspace` workspace. Build new `ra_silver` and `ra_gold` schemas *within `cdm_tmforum`* (per Osama Mansour's ownership model) to host reconciliation logic, conformed dimensions, and RA exceptions — do not generate a bronze layer.
> - **Demo dataset scale:** Fixed from invented "~2,000 customers, ~25,000 circuits, ~910 exceptions, ~$1.9M/month leakage" to real seeded data: ~10,000 customers, ~100,000 circuits, ~10,000 RA violations across 12 pre-seeded types, ~$540M estimated impact total. Lumen's business-case framing ($250M–$312M / 2–2.5%) is the *pitch context*, distinct from the demo dataset's seeded figure.
> - **Real tables cited:** Replaced invented tables with actual `cdm_tmforum` schemas: `tmf_resource.logical_resource` (circuits), `tmf_service.resource_facing_service`/`service_usage` (service identity + usage), `tmf_customer.bill`/`commitment` (billing + contracts), `tmf_enterprise.revenue_assurance_violation` (native exceptions with 12 violation types), `tmf_enterprise.ra_trouble_ticket` (case management).
> - **Cloud / deployment:** Updated from "Azure workspace, serverless-first (mirrors Rogers)" to "deploy to the `demo-workspace` workspace via the `demo` profile; confirm cloud at deploy time."
> - **ML data realism caveat:** Added note that `cdm_tmforum` data is statistically flat/uniform — strong for deterministic reconciliation, weak for compelling ML demo; the build must inject a handful of sharp anomalies for the anomaly-detection and forecasting scenes.

---

## 1. Purpose & business scenario

Lumen Technologies (approximately $12.5 billion in B2B broadband & enterprise networking revenue) loses an estimated **2–2.5% of revenue** to revenue leakage: active circuits that never get billed, prices that drift from contract, expired discounts still applied, usage that outgrows its billing tier, delayed billing starts, and partner-settlement gaps. The gross leakage impact is roughly **$250 million to $312.5 million annually**. The root cause is **siloed systems and manual reconciliation** — network provisioning, CRM, billing, CPQ, and partner feeds never agree on what a customer *should* be billed.

This demo shows how a Databricks lakehouse ingests all those sources (which already exist in the TM Forum Common Data Model), resolves them into one canonical **service instance**, and runs automated reconciliation + anomaly detection to surface leakage in minutes instead of months — then routes each exception to an analyst for recovery.

## 2. Target personas

| Persona | Role | What they need from the demo |
| :---- | :---- | :---- |
| **Dana Whitfield** | VP, Revenue Assurance (economic buyer) | Board-level leakage $, recovery trend, "is this getting better?" |
| **Marcus Chen** | Senior RA Analyst (primary user) | A prioritized exception queue, the ability to investigate in plain language, and a way to action recovery |
| **Priya Nair** | Lead Data Engineer | Trust that pipelines are governed, tested, and reproducible |

## 3. Demo narrative / storyline

1. **The problem** — Dana opens the *Leakage Overview* dashboard: ~$54M/month currently detected across Lakelink Fiber's ~10K customers and ~100K circuits (representing ~$540M estimated total impact across all seeded violation types).
2. **The platform** — Priya shows the medallion pipeline: the 10 source systems already landed in `cdm_tmforum.tmf_*` schemas → conformed silver dims/facts in `ra_silver` → the `service_instance` bridge that solves identity resolution (the hard part).
3. **The detection** — six deterministic reconciliation checks + one ML anomaly model populate `ra_gold.reconciliation_exceptions`, all orchestrated by a single serverless Databricks Workflow.
4. **The investigation** — Marcus filters the *Exceptions Queue* to high-severity, opens one *active-circuit-unbilled* case, and asks Genie plain-language follow-ups ("show usage for this circuit last 90 days").
5. **The recovery** — Marcus works the case in the **RA Exceptions Console** app: New → Investigating → Recovering → Recovered, capturing the recovered $.
6. **The payoff** — the dashboard's recovered-to-date and leakage-rate KPIs update; Dana sees the loop close.

## 4. Must-have flows (in scope)

- **F1 — Ingest & govern:** Read from all 10 source schemas already present in `cdm_tmforum` (`tmf_resource`, `tmf_service`, `tmf_product`, `tmf_customer`, `tmf_businesspartner`, etc.); PII columns (customer_name, approver) are tagged and masked in Unity Catalog.
- **F2 — Medallion + identity resolution:** Lakeflow Declarative Pipelines builds silver dims/facts in `ra_silver` and materializes the `service_instance` bridge (circuit ↔ contract ↔ billing account ↔ invoice), with exact + fuzzy matching and `match_confidence`.
- **F3 — Reconciliation:** all six checks run deterministic SQL and write typed exceptions with `leakage_amount_usd`, `root_cause`, and `violation_type` to `ra_gold.reconciliation_exceptions` (aligns with pre-seeded `tmf_enterprise.revenue_assurance_violation` types).
- **F4 — ML anomaly:** the usage-vs-billing model scores circuits and feeds check #4 (usage_reconciliation_gap); data realism caveat: `cdm_tmforum` data is statistically flat, so anomaly injection is needed for a compelling demo.
- **F5 — Dashboard:** AI/BI *Leakage Overview* shows leakage $, rate, days-to-bill, and recovered-to-date by product/region/month.
- **F6 — Genie:** natural-language Q&A over the `ra_gold` + `ra_silver` tables for ad-hoc investigation by analysts.
- **F7 — RA Exceptions Console app:** queue → detail → case lifecycle (New → Investigating → Recovering → Recovered), writing to `ra_gold.exception_case` (aligns with native `tmf_enterprise.ra_trouble_ticket`).
- **F8 — Reset & reproduce:** the whole environment rebuilds to a known seeded state (deterministic leakage totals: ~$540M across 12 violation types in ~10K seeded exceptions).

## 5. Success criteria (measurable)

| # | Criterion | Target |
| :---- | :---- | :---- |
| S1 | Pipeline builds all layers from raw to gold | < 15 min on serverless |
| S2 | Seeded exceptions detected | ≥ 95% of the ~10K seeded violations surfaced, per-type counts within ±2% of golden |
| S3 | Identity resolution coverage | ≥ 92% of active circuits resolved (`match_method` exact/fuzzy) |
| S4 | Headline leakage figure | Deterministic (~$540M total / ~$54M/month average) on every reset |
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
| MLflow anomaly model | Catches usage-vs-billing drift deterministic rules can't (with data-realism caveat on uniform data) |
| `ai_forecast` SQL function | Expected-vs-actual revenue variance as an early-warning signal |
| Databricks Apps | The RA Exceptions Console closes the loop from insight → action |

## 8. Proof points mapped to Lumen's leakage story

- **"We can't see leakage until months later"** → reconciliation runs in one job; exceptions appear same-run.
- **"Our systems don't agree"** → `service_instance` bridge resolves circuit ↔ contract ↔ billing ↔ invoice.
- **"Manual audits miss things"** → six automated checks + ML anomaly on ~100K circuits.
- **"We can't prove recovery"** → case lifecycle + recovered-$ KPI quantifies the win.
- **"Is this compliant?"** → UC lineage + PII masking shown live.

## 9. Assumptions & constraints

- Deployed to the `demo-workspace` workspace via the `demo` profile; cloud environment to be confirmed at deployment time.
- Data sourced from `cdm_tmforum` TM Forum Common Data Model (read-only `tmf_*` schemas); build new reconciliation logic in `ra_silver` and `ra_gold` schemas within the same catalog.
- Lakelink Fiber synthetic dataset at demo scale: ~10,000 customers, ~100,000 active circuits, ~10,000 seeded RA violations across 12 violation types, totaling ~$540M estimated impact, with deterministic seeded leakage.
- **Data realism caveat:** `cdm_tmforum` data is statistically flat/uniform (round counts, ~50/50 splits) — excellent for deterministic reconciliation, weaker for compelling ML anomaly-detection scenes. The build must inject a handful of sharp anomalies for F4 (ML) and related forecasting demos.
- Deployed via Databricks Asset Bundles from the `revenue-assurance` repo; teardown via `databricks bundle destroy` (cleans only new `ra_*`, `*_source` schemas, the app, and orchestration jobs; never touches `tmf_*` source).
- All table names and schemas per the canonical spec in `data-source-assessment.md`.
