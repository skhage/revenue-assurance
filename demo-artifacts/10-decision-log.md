# RA Demo — Decision Log

**Demo:** Revenue Assurance Lakehouse for Lakelink Fiber (pitched to Lumen Technologies) · **Catalog:** `cdm_tmforum` · **App:** RA Exceptions Console · **Repo:** `revenue-assurance` · **Cloud:** FEVM (serverless, `demo` profile)

> **Scrutiny summary**
> - ❌ **Was:** 12 ADRs assuming synthetic bronze-layer generation (~2K customers, ~25K circuits) and a `lumen_ra` catalog
> - ✅ **Now:** Added **ADR-000** (reuse `cdm_tmforum` vs. generate), removed synthetic-data generation ADR, reframed 10 core ADRs around data reuse. **ADR-008** now states real scale (~10K customers, ~100K circuits).
> - ❌ **Was:** ADR-007 framed Azure as "flagship reference" per Rogers, asserting it as architectural fact
> - ✅ **Now:** ADR-007 acknowledges cloud is FEVM at deploy time; Rogers narrative is *reference*, not an assertion about this demo's cloud.
> - ✅ **Added:** ADR-013 (build `ra_silver`/`ra_gold` in `cdm_tmforum` vs. separate `lumen_ra` catalog) — reflects ground truth that `tmf_*` are read-only, new schemas stay in same catalog.
> - ✅ **Verified:** All product names (Lakeflow Declarative Pipelines, Unity Catalog, Genie, MLflow, Databricks Apps, DABs, serverless) are current and correctly cited per README and web-verifiable Databricks docs.

---

## Index

| ADR | Decision | Choice |
| :---- | :---- | :---- |
| ADR-000 | Data foundation: reuse vs. generate | Reuse `cdm_tmforum` (TM Forum SID); inject anomalies only |
| ADR-001 | Compute model | Serverless (SQL warehouse + serverless jobs) |
| ADR-002 | Reconciliation implementation language | SQL for deterministic checks; Python only where needed |
| ADR-003 | Ingestion pattern | Batch-first, streaming-capable narrative |
| ADR-004 | Transformation framework | Lakeflow Declarative Pipelines |
| ADR-005 | Case management surface | Databricks App + AI/BI dashboard (both) |
| ADR-006 | Detection technique per check | Deterministic rules for 5; ML anomaly for 1 |
| ADR-007 | Cloud & architecture | FEVM serverless (platform-agnostic; Rogers story as reference) |
| ADR-008 | Real-world data scale | Reuse existing ~10K customers / ~100K circuits |
| ADR-009 | IaC / packaging | Databricks Asset Bundles (DABs) |
| ADR-010 | Genie inclusion | Include Genie for natural-language Q&A |
| ADR-011 | Identity model | Single canonical `service_instance` bridge |
| ADR-012 | Data determinism | Fixed-seed simulation for reproducibility |
| ADR-013 | Schema organization | Build `ra_silver`/`ra_gold` in `cdm_tmforum`; keep `tmf_*` read-only |

---

## ADR-000 — Data foundation: reuse existing `cdm_tmforum` vs. generate synthetic

**Status:** Accepted (supersedes original "Synthetic Data Specification" approach)

**Decision.** Whether the demo builds a bronze/silver/gold medallion from scratch with a generator, or builds RA logic on top of existing TM Forum SID Common Data Model data.

**Options considered.**

1. Generate all source data deterministically from scratch (Faker + Salesforce/Oracle simulators) into a new `lumen_ra` catalog.
2. Reuse the existing `cdm_tmforum` catalog (fully populated TM Forum SID model, 1K–100K rows per table, 2018–2025 billing history); build reconciliation logic on top.
3. Hybrid: reuse base data, only generate anomalies for ML scenes.

**Choice.** Hybrid reuse + selective injection. The ~10K customers, ~100K circuits, and all associated billing/provisioning/settlement tables already exist in `cdm_tmforum`. Build RA reconciliation logic (`ra_silver.service_instance`, `ra_gold.reconciliation_exceptions`, `ra_gold.exception_case`) reading from read-only `tmf_*` schemas. Inject a small number of sharp anomalies (via `ra_simulate_source_systems` + source-system simulation) only for the ML/anomaly-detection scenes and to make the data compelling for live demo impact.

**Rationale.** 
- **Efficiency:** Eliminates a full data-generation pipeline; shifts the 80% effort from "build fake data" to "build reconciliation logic on real data" — a genuine RA problem, not a simulation artifact.
- **Realism:** The existing data is 8 years of real Lakelink Fiber billing (uniformly flat, but real dimensions, cardinalities, and relationships). A generated dataset risks looking fabricated to a prospect who knows telecom.
- **Scale believability:** ~10K customers and ~100K circuits are production-scale enough for a KPI dashboard and a 10K exception population to look credible. Regenerating from scratch introduces variance and reset friction.
- **Reproducibility:** Base data is static and deterministic; only the anomalies and derived reconciliation layer are seeded generators. This makes reset fast and reliable without a 10-minute data regeneration.
- **Cost:** Existing data is already ingested; reusing it costs zero extra egress/compute vs. regenerating millions of rows.

**Rejected alternatives.** 
- Pure generation (Option 1) was rejected: it requires maintaining a full Faker + source-system simulator, is harder to reason about when numbers drift, and introduces a layer of abstraction between the demo and real RA patterns.
- Pure reuse with no anomaly injection (partial Option 2) was rejected: the existing data is statistically flat (round row counts, 50/50 splits), which weakens the ML anomaly-detection narrative — a few injected sharp anomalies (e.g., a sudden usage spike with no corresponding billing) make the scene more compelling.

---

## ADR-001 — Serverless vs. jobs/classic compute

**Status:** Accepted

**Decision.** What compute backs the demo's pipelines, jobs, warehouse, and app.

**Options considered.**

1. Serverless SQL warehouse + serverless Jobs/pipelines (no cluster management).
2. Classic all-purpose clusters + classic job clusters.
3. Mix: serverless SQL for dashboards, classic clusters for pipelines.

**Choice.** Serverless everywhere — serverless SQL warehouse `ra_demo_wh` plus serverless Jobs and pipeline compute. No classic clusters in the demo.

**Rationale.** A demo lives or dies on time-to-first-pixel; a 5-minute cluster spin-up on stage is fatal. Serverless starts fast, requires zero cluster config in the repo, and mirrors where the platform is heading — reinforcing the "governed, low-ops" message to Dana and Priya. It also makes reset (regenerate → pipeline → checks) fast and predictable for a non-builder presenter.

**Rejected alternatives.** Classic clusters were rejected for slow cold starts, config sprawl in the bundle, and a weaker modernization story. The mixed model was rejected as needless complexity — two compute mental models to explain and two failure modes to recover on stage.

---

## ADR-002 — SQL vs. Python for reconciliation checks

**Status:** Accepted

**Decision.** Language for expressing the 6 reconciliation checks.

**Options considered.**

1. SQL for all deterministic checks.
2. PySpark/Python for all checks.
3. Hybrid: SQL for set-based deterministic checks, Python only where SQL is awkward.

**Choice.** Hybrid, SQL-first. The five deterministic checks (active-circuit-unbilled, contract-price mismatch, expired/unauthorized discount, billing-start-date lag, partner-settlement mismatch) are SQL joins/anti-joins against `ra_silver.service_instance`. Python is reserved for the ML anomaly check (ADR-006), the source-system simulator, and anomaly injection.

**Rationale.** The deterministic checks *are* set operations — "active circuits with no matching non-zero invoice line" is a textbook anti-join. SQL makes them short, auditable, and legible to the RA/finance audience, and they read well on screen. It also matches the buyer's skill base (analysts and finance write SQL, not Spark). Python is used only where it earns its place.

**Rejected alternatives.** All-Python was rejected as over-engineered for set logic and less readable to the target audience. All-SQL was rejected because the usage–billing variance check is genuinely an anomaly-detection problem, not a fixed threshold (see ADR-006).

---

## ADR-003 — Batch vs. streaming ingestion

**Status:** Accepted

**Decision.** How sources (both the reused TM Forum data and simulated source systems) flow into the medallion.

**Options considered.**

1. Pure batch ingestion of all sources.
2. Pure streaming for all sources.
3. Batch for CRM/billing/contract; streaming (or streaming-capable) framing for high-volume usage telemetry / CDRs.

**Choice.** Batch-first for the actual demo build, with the architecture and narration explicitly noting that usage telemetry and CDRs are the streaming-capable path (Auto Loader / Lakeflow Connect).

**Rationale.** RA reconciliation is fundamentally periodic — the business runs daily/monthly reconciliation, not per-event. Batch keeps the demo reproducible and the golden numbers stable (critical for a scripted 20-minute run). We keep the streaming *story* because the real-world pattern (high-volume CDR/IPDR) is streaming, and Lakeflow Connect/Auto Loader let us say "same pipeline, flip to streaming" without building live streams that could destabilize the demo.

**Rejected alternatives.** Pure streaming was rejected: it makes the demo non-deterministic (counts change mid-demo), adds live failure surface, and doesn't match how RA teams actually reconcile. Pure batch with no streaming mention was rejected because it undersells the platform for the genuinely high-volume telemetry source.

---

## ADR-004 — Lakeflow Declarative Pipelines vs. plain notebooks

**Status:** Accepted

**Decision.** How the medallion is built and orchestrated (source schemas + reused `tmf_*` → `ra_silver` → `ra_gold`).

**Options considered.**

1. Lakeflow Declarative Pipelines (formerly Delta Live Tables / DLT) with built-in expectations.
2. Plain notebooks chained in a Workflow.
3. Raw Spark scripts run as tasks.

**Choice.** Lakeflow Declarative Pipelines for the medallion transforms, with data-quality **expectations** enforced inline; the reconciliation checks and ML run as Workflow jobs downstream.

**Rationale.** The declarative pipeline gives us three demo assets for free: (a) a visual lineage/graph that shows source systems and `tmf_*` flowing into `ra_silver.service_instance` and `ra_gold` — a strong Priya beat; (b) inline data-quality expectations (null/PK/referential-integrity, identity match rate) that directly support the "bad CDRs are quarantined, not silently corrupting billing" narrative; (c) declarative dependency management so a non-builder can re-run the whole medallion with one command. It also embodies the DQ-as-code message central to RA credibility.

**Rejected alternatives.** Plain notebooks were rejected: no built-in expectations, no dependency graph to show, and manual orchestration to maintain. Raw Spark scripts were rejected as the least legible and hardest to reset reliably.

---

## ADR-005 — Databricks App vs. pure AI/BI dashboard for case management

**Status:** Accepted

**Decision.** Where analysts work exceptions and where executives view KPIs.

**Options considered.**

1. AI/BI dashboard only (read-only) for everything.
2. Databricks App only for everything, including exec KPIs.
3. Both: AI/BI dashboard for Dana's KPIs; a Databricks App ("RA Exceptions Console") for Marcus's case workflow.

**Choice.** Both, split by persona and by read-vs-write. AI/BI dashboard (`RA Leakage Overview`) serves Dana's board-level KPIs off `ra_gold.leakage_kpis` / `ra_gold.revenue_forecast`. The **RA Exceptions Console** Databricks App serves Marcus's case management, writing status transitions to `ra_gold.exception_case`.

**Rationale.** Case management is stateful and write-heavy — assign, note, move New → Investigating → Recovering → Recovered/WrittenOff. Dashboards are read-only and can't own that workflow. Conversely, forcing exec KPIs into a custom app wastes AI/BI's strength (fast, governed, zero-code viz + Genie). Splitting by persona keeps each surface doing what it's best at and tells a cleaner two-audience story.

**Rejected alternatives.** Dashboard-only was rejected because it can't close the loop (no write-back, no case state) — leaving the demo at "here's the leakage" instead of "here's how we recover it." App-only was rejected as reinventing AI/BI and slower to build for the exec view.

---

## ADR-006 — Deterministic rules vs. ML per check type

**Status:** Accepted

**Decision.** Detection technique for each of the 6 checks.

**Options considered.**

1. Deterministic rules for all 6.
2. ML for all 6.
3. Per-check: deterministic where the definition is exact; ML where the signal is statistical.

**Choice.** Per-check. Five checks are deterministic; one (**Usage–billing variance**, mapped to `usage_reconciliation_gap` / `mediation_failure` violations) is an ML anomaly-detection model in the `ml` schema, tracked in MLflow.

| Check | Technique | Why |
| :---- | :---- | :---- |
| Active-circuit-unbilled | Deterministic | Exact: active circuit, no non-zero invoice line (anti-join). |
| Contract-price mismatch | Deterministic | Exact: billed price ≠ CRM contract price. |
| Expired/unauthorized discount | Deterministic | Exact: discount past expiry or no approved CPQ record. |
| Usage–billing variance | **ML anomaly** | Statistical: usage rose materially but billing didn't — no single correct threshold; outlier detection. |
| Billing-start-date lag | Deterministic | Exact: delivered/order-complete but billing start > N days later. |
| Partner-settlement mismatch | Deterministic | Exact: leased capacity not reconciled to settlement feed. |

**Rationale.** Use ML only where it's genuinely warranted. Five of these are precise business rules; wrapping them in ML would add opacity and false positives with no benefit, and would undermine trust with an audit-minded RA/finance audience. Usage-vs-billing variance is the one with no fixed threshold — it's a real anomaly problem — so it earns MLflow and demonstrates the platform's ML story where it's credible.

**Rejected alternatives.** All-deterministic was rejected because it drops the (accurate) ML narrative and can't handle the variance case well. All-ML was rejected as indefensible over-modeling of exact rules — slower, less transparent, and a weaker story to auditors.

---

## ADR-007 — Cloud & architecture: FEVM serverless

**Status:** Accepted

**Decision.** Which cloud and architecture the demo targets.

**Options considered.**

1. Azure (Databricks FEVM).
2. AWS (Databricks on AWS).
3. GCP (Databricks on GCP).

**Choice.** Deploy to FEVM serverless at deploy time (confirm cloud at deploy time; do not assert cloud up front).

**Rationale.** The demo is cloud-agnostic and portable; the `demo` profile points to `demo-workspace`, which may be any cloud. Serverless-first keeps it low-ops. Narratively, Rogers Communications' "Revenue Assurance Data Lake" (a documented Databricks reference in the telecom space) provides an anchor to credibility, but it's a *reference* for the pattern, not an assertion about this demo's cloud. If Lumen's standard deployment is a different cloud, the bundle is portable and this decision is revisited.

**Rejected alternatives.** Asserting a specific cloud up front (AWS/Azure/GCP) was rejected as over-constraining; the demo's value is in the RA architecture and Databricks capabilities, not in cloud choice. The Rogers reference was rejected as a *prerequisite* because it would hide the portability story.

---

## ADR-008 — Real-world data scale: reuse existing ~10K customers / ~100K circuits

**Status:** Accepted (refocus from ADR-008 "synthetic scale")

**Decision.** How much data the demo showcases.

**Options considered.**

1. Tiny (hundreds of circuits) — instant, but unconvincing.
2. Production-representative (~10K customers, ~100K circuits, 8-year billing history) from `cdm_tmforum`.
3. Hyper-scale (millions of circuits) — overkill for a 20-min demo.

**Choice.** Production-representative: reuse the existing `cdm_tmforum` data (~10K customers, ~100K circuits, ~100K product orders, ~100K usage records, ~10K seeded RA violations across 12 types, $540M estimated impact). Inject a handful of sharp anomalies for the ML scenes.

**Rationale.** 
- **Big enough:** Dashboards, joins, and aggregations look real; millions of usage rows exercise the platform visibly.
- **Believable:** ~10K customers and ~100K circuits are production-scale relative to Lumen's $12.5bn business; the $540M seeded leakage is in the ballpark of the $250–312M pitch (distinct from, tunable by filtering).
- **Fast reset:** No generation pipeline; cold rebuild is a matter of minutes (source simulation + pipeline run).
- **Already exists:** No simulation overhead; the work is building reconciliation logic, not fabricating data.

**Rejected alternatives.** Tiny was rejected as unconvincing. Hyper-scale was rejected as overkill and costly; demo-scale data already proves the platform's capabilities without multi-hour reset cycles.

---

## ADR-009 — DABs vs. Terraform/manual deployment

**Status:** Accepted

**Decision.** How the demo is packaged and deployed.

**Options considered.**

1. Databricks Asset Bundles (DABs).
2. Terraform (Databricks provider).
3. Manual clicks / ad-hoc notebooks.

**Choice.** Databricks Asset Bundles in the `revenue-assurance` repo, with `dev` and `prod` targets.

**Rationale.** DABs are the native, Databricks-recommended way to version jobs, the pipeline, and the app as one deployable unit. `databricks bundle validate/deploy/run/destroy` gives a non-builder a four-verb operational contract (see the runbook), plus clean environment parity (dev vs. prod) via variables. It's also the honest "this is how you'd ship it" answer to a technical buyer, and makes teardown one command.

**Rejected alternatives.** Terraform was rejected as heavier than needed for a self-contained demo and less idiomatic for Databricks-native resources like pipelines and apps. Manual/ad-hoc was rejected outright — not reproducible, not resettable by someone other than the builder, and impossible to hand off.

---

## ADR-010 — Genie inclusion

**Status:** Accepted

**Decision.** Whether to include Genie natural-language Q&A.

**Options considered.**

1. Include Genie over the gold RA tables.
2. Exclude it; rely on the dashboard and app only.

**Choice.** Include Genie, scoped to the governed `ra_gold` tables, as Marcus's investigation entry point.

**Rationale.** Genie shows analysts starting an investigation without writing SQL, over the *same* governed, masked data — reinforcing the Unity Catalog governance story rather than bypassing it. It's a short, high-impact beat (~90s) and differentiates the platform. Because it reads `ra_gold`, it can't destabilize the deterministic pipeline.

**Rejected alternatives.** Excluding Genie was rejected as leaving a strong, on-message capability on the table — but note the runbook flags Genie as a **fallback-first** beat: the exact prompt is pre-tested during preflight and has a screenshot fallback, because live NL answers carry more variance than the deterministic surfaces.

---

## ADR-011 — Single canonical `service_instance` bridge vs. per-source joins

**Status:** Accepted

**Decision.** How the demo resolves identity across circuit → contract → billing → invoice.

**Options considered.**

1. One canonical `ra_silver.service_instance` bridge table that resolves all four IDs once, with a match-confidence score.
2. Per-check ad-hoc joins across `ra_silver` and `tmf_*` sources (each check re-joins circuit↔contract↔billing↔invoice itself).

**Choice.** A single canonical `ra_silver.service_instance` bridge (`service_instance_id, circuit_id, contract_id, billing_account_id, invoice_line_id, match_confidence`); all 6 checks join through it.

**Rationale.** Identity resolution is *the* hard problem and the actual point of most leakage — so it deserves to be a first-class, reusable asset, not logic duplicated inside six checks. Centralizing it means: one place to reason about match confidence; consistent results across checks and dashboards; a clean lineage/story beat ("once these are linked, leakage is just mismatches across the bridge"); and far simpler check SQL (ADR-002). It also mirrors real RA architecture and the research's explicit guidance to build one canonical service instance.

**Rejected alternatives.** Per-source ad-hoc joins were rejected: they duplicate the hardest logic six times, drift out of sync, make every check harder to read, and bury the single most important architectural idea of the whole demo. The bridge is the demo's spine — collapsing it into per-check joins would gut the narrative.

---

## ADR-012 — Deterministic seeded data vs. random generation

**Status:** Accepted

**Decision.** Whether anomalies and derived RA logic are reproducible run-to-run.

**Options considered.**

1. Fixed-seed, fully deterministic simulation (same output every run).
2. Random generation each run.

**Choice.** Fixed-seed, deterministic source-system simulator (Python + Faker with a pinned seed for anomaly injection). Every clean rebuild reproduces the identical exception population and impact totals — the "golden numbers."

**Rationale.** A scripted demo needs stable numbers: the presenter quotes totals, the dashboard shows them, the test plan asserts them, and the runbook verifies a reset landed by matching a golden baseline. Randomness would break all four and make "data drift" undetectable. Determinism is what makes the demo resettable by someone other than the builder.

**Rejected alternatives.** Random generation was rejected because it makes verification, golden-number assertions, and drift detection impossible, and would let the presenter's spoken figures diverge from what's on screen.

---

## ADR-013 — Schema organization: build `ra_silver`/`ra_gold` in `cdm_tmforum`, keep `tmf_*` read-only

**Status:** Accepted

**Decision.** Where to place the demo's new reconciliation logic (silver & gold RA layers).

**Options considered.**

1. Build into a separate `lumen_ra` catalog, reading from `cdm_tmforum.tmf_*`.
2. Build into new `ra_silver` and `ra_gold` schemas within `cdm_tmforum` itself.
3. Write back into `tmf_*` schemas (overwrite or augment the source data).

**Choice.** Option 2: new `ra_silver` and `ra_gold` schemas within `cdm_tmforum`. The `tmf_*` schemas remain read-only (per catalog ownership / governance).

**Rationale.** 
- **Simplicity:** Keeps all RA assets in one catalog for lineage and governance; Catalog Explorer shows the full story end-to-end.
- **Schema clarity:** `tmf_*` = source (read-only, owned by platform team). `ra_silver` = conformed identity bridge + DQ. `ra_gold` = exceptions, cases, KPIs (analyst-facing).
- **Permission model:** Single catalog grants make sense; split catalogs complicate UC governance.
- **Governance:** Unity Catalog treats the whole `cdm_tmforum` as one governed asset; lineage from `tmf_*` to `ra_gold` is clean and visible.
- **Narrative clarity:** "We built reconciliation logic *on top of* the TM Forum model, not into it — the source remains pristine."

**Rejected alternatives.** Separate `lumen_ra` catalog was rejected as unnecessary schema sprawl and harder to explain in the lineage story. Writing into `tmf_*` was rejected outright — those schemas are governed and read-only by design; overwriting them would corrupt the source data model.

---

## Cross-references

- Runbook §2.4 (golden numbers) depends on **ADR-012** (determinism) and **ADR-008** (scale).
- Runbook §5.4 (data-drift recovery) is the operational counterpart to **ADR-012**.
- The reconciliation SQL/ML split (**ADR-002**, **ADR-006**) drives the repo layout under `src/reconciliation` and `src/ml`.
- The `service_instance` bridge (**ADR-011**) is the join key referenced by every check and by the app's drill-down.
- **ADR-000** (data reuse) supersedes the original synthetic-data specification and reshapes **ADR-008** from generation to reuse.
- **ADR-013** resolves the catalog vs. schema question; compare against README ground truth §2 and data-source-assessment.md caveats §3.
