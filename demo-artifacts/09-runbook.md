# RA Demo — Demo Operations Runbook

**Demo:** Revenue Assurance Lakehouse for Lakelink Fiber (pitched to Lumen Technologies) · **Catalog:** `cdm_tmforum` · **App:** RA Exceptions Console · **Repo:** `revenue-assurance` · **Cloud:** FEVM (serverless, `demo` profile) · **IaC:** Databricks Asset Bundles (DABs)

> **Scrutiny summary**
> - ❌ **Was:** `lumen_ra` catalog with invented bronze layer (`network_provisioning`, `usage_telemetry`, etc.)
> - ✅ **Now:** `cdm_tmforum` (real TM Forum SID data); build `ra_silver` and `ra_gold` schemas reading from read-only `tmf_*`.
> - ❌ **Was:** ~2K customers, ~25K circuits; regenerate "from scratch"
> - ✅ **Now:** ~10K customers, ~100K circuits (already in `cdm_tmforum`). "Reset" = re-run source-system simulation + anomaly injection + rebuild RA layer, **not** regenerate base data.
> - ❌ **Was:** Golden baseline ~$1.9M/month leakage
> - ✅ **Now:** ~$540M estimated impact across 10K seeded violations (tunable; cite Lumen's $250–312M as pitch framing, distinct from demo data).
> - ❌ **Was:** Azure asserted as fact
> - ✅ **Now:** Deploy to `demo` FEVM workspace (confirm cloud at deploy time; don't assert Azure).
> - ✅ **Verified:** `databricks bundle validate/deploy/run/destroy`, Lakeflow Declarative Pipelines, Databricks Apps stop/start, serverless SQL warehouse behavior all current and documented. All runbook commands accurate.

---

## 0. Roles, environment, and conventions

| Item | Value |
| :---- | :---- |
| **Workspace** | `demo-workspace` (Databricks FEVM, serverless enabled) |
| **CLI profile** | `demo` (or your named profile — substitute `-p <profile>` in all commands) |
| **Bundle target** | `dev` for dry-runs, `prod` for the live demo (stable data + warm warehouse) |
| **Catalog** | `cdm_tmforum` (existing TM Forum SID data; we build new schemas: `ra_silver`, `ra_gold`) |
| **Source schemas** | `tmf_resource`, `tmf_service`, `tmf_product`, `tmf_customer`, `tmf_businesspartner`, `tmf_enterprise` (all read-only) + `*_source` (simulated source systems) |
| **SQL Warehouse** | Serverless SQL warehouse `ra_demo_wh` |
| **App** | RA Exceptions Console (Databricks App) |
| **Pipeline** | Lakeflow Declarative Pipeline `ra_medallion_pipeline` |
| **Jobs** | `ra_simulate_source_systems`, `ra_medallion_pipeline`, `ra_reconciliation_checks`, `ra_train_anomaly_model` |
| **Personas told on-screen** | Dana Whitfield (VP RA, Lakelink Fiber), Marcus Chen (Sr. RA Analyst), Priya Nair (Lead DE) |
| **Demo story** | We built a Lakelink Fiber revenue-assurance lakehouse to show Lumen what theirs could look like. |

**Command conventions.** All `databricks bundle` commands are run from the repo root of `revenue-assurance`. Where a specific job/pipeline name is referenced, it matches the resource keys in `resources/*.yml`. If your profile is not `demo`, append `-p <profile>` to every CLI command below.

---

## 1. Preflight checklist (run T-30 minutes)

Work top to bottom. Do not start the live demo until every box is green.

### 1.1 Access & entitlements

- [ ] You can log in to the Databricks `demo-workspace` workspace in the browser you'll present from.
- [ ] Your user (or the demo presenter user) is a member of groups with read on catalog `cdm_tmforum` and write on `ra_silver`/`ra_gold`. (Grants let you *see* masked vs. unmasked PII appropriately — do not present as account admin, or the PII-masking beat won't land.)
- [ ] **Serverless is enabled** for SQL and Jobs in the workspace (Settings → Compute). The demo uses no classic clusters.
- [ ] Genie is enabled and the **RA Genie space** is published and shared with you.
- [ ] The **RA Exceptions Console** app is deployed and you have "Can use" permission.
- [ ] Databricks CLI authenticates: `databricks auth describe -p demo` returns your identity.

### 1.2 Data & compute are warm

- [ ] Warehouse warm: run `databricks warehouses get <warehouse_id> -p demo` and confirm `state = RUNNING`. If `STOPPED`, start it now (see §5.1) — a cold serverless warehouse costs you 20–40s on the first query, which reads as a stall on stage.
- [ ] Base data seeded in `cdm_tmforum`: confirm `tmf_resource.logical_resource`, `tmf_service.resource_facing_service`, `tmf_customer.bill` have rows (non-zero counts).
- [ ] RA layer populated: quick count check (see command below) returns non-zero rows in `ra_silver` and `ra_gold`.
- [ ] `ra_gold.reconciliation_exceptions` has the expected seeded exception population (see golden numbers in §2.4).
- [ ] `ra_gold.exception_case` is in a **clean demo state** — see §2. If a previous run left cases in `Recovered`/`WrittenOff`, reset (§2.2).
- [ ] Latest pipeline run for `ra_medallion_pipeline` shows **all expectations green** (open Pipelines → `ra_medallion_pipeline` → latest update).

**Warm-up query (also proves the warehouse and seed in one shot):**

```sql
-- Run in a SQL editor attached to ra_demo_wh
SELECT 'tmf_resource.logical_resource' AS tbl, COUNT(*) AS n FROM cdm_tmforum.tmf_resource.logical_resource
UNION ALL SELECT 'ra_silver.service_instance', COUNT(*) FROM cdm_tmforum.ra_silver.service_instance
UNION ALL SELECT 'ra_gold.reconciliation_exceptions', COUNT(*) FROM cdm_tmforum.ra_gold.reconciliation_exceptions
UNION ALL SELECT 'ra_gold.exception_case', COUNT(*) FROM cdm_tmforum.ra_gold.exception_case;
```

### 1.3 Surfaces open and pre-loaded (browser tabs, left to right)

Open these tabs **in demo order** before you start so you never fumble for a URL on stage:

1. Notebook: `src/overview` (or the intro notebook) — for the opening.
2. Pipelines → `ra_medallion_pipeline` (graph view).
3. Catalog Explorer → `cdm_tmforum.ra_silver.service_instance` (Lineage tab pre-clicked).
4. AI/BI dashboard: **RA Leakage Overview** (bound to `ra_gold.leakage_kpis` / `ra_gold.revenue_forecast`).
5. Genie: **RA Genie space** (empty prompt).
6. **RA Exceptions Console** app (Exceptions queue screen).
- [ ] All six tabs load without error.
- [ ] Dashboard renders with data (not a spinner).
- [ ] App loads to the exceptions queue with rows visible.

### 1.4 Fallback assets ready (in case live fails — see §4)

- [ ] Screenshot deck `ra_demo_fallback.pdf` open in a background tab (one slide per demo beat).
- [ ] Screen recording `ra_demo_full.mp4` downloaded locally (not streamed).
- [ ] A pre-run results notebook exported to HTML (`ra_demo_prerun.html`) that shows exception counts and KPIs without touching live compute.

---

## 2. Reset to a clean demo state

Do this **before every delivery** (and after any dry-run). Total time ~4–6 minutes, most of it the pipeline run. Budget for it; don't reset in the 5 minutes before you present.

### 2.1 Full reset (source simulation + pipeline + checks) — the "clean slate"

Use when the RA layer (not base data) is drifted, partially loaded, or you're not sure of state. Runs the source-system simulator, rebuilds the RA medallion, and recomputes exceptions. **This does NOT touch the read-only `tmf_*` base data.**

```shell
# From revenue-assurance/ repo root. Uses the prod target for the live demo.
databricks bundle validate -t prod -p demo

# 1) Simulate source systems deterministically (seed is fixed in the job; see §2.4)
# Lands simulated Salesforce, Oracle, FX, CLM, MDM data into *_source schemas
databricks bundle run ra_simulate_source_systems -t prod -p demo

# 2) Rebuild the medallion (tmf_* + *_source -> ra_silver -> ra_gold) via the Lakeflow pipeline
databricks bundle run ra_medallion_pipeline -t prod -p demo

# 3) Recompute the 6 reconciliation checks -> ra_gold.reconciliation_exceptions
databricks bundle run ra_reconciliation_checks -t prod -p demo
```

Then confirm golden numbers (§2.4).

### 2.2 Reset only the case-management state (`ra_gold.exception_case`)

Use between back-to-back demos when the RA data is fine but you (or a prior audience) moved cases through the workflow. This is the fast reset (~10s) — it does **not** rebuild the pipeline.

```sql
-- Option A: truncate and let the app re-seed New cases from open exceptions
TRUNCATE TABLE cdm_tmforum.ra_gold.exception_case;

-- Re-seed one New case per open exception (mirrors what the seed job does)
INSERT INTO cdm_tmforum.ra_gold.exception_case (case_id, exception_id, assignee, status, notes, updated_at)
SELECT uuid(), e.exception_id, NULL, 'New', NULL, current_timestamp()
FROM cdm_tmforum.ra_gold.reconciliation_exceptions e
WHERE e.status = 'Open';
```

```sql
-- Option B: leave rows, just rewind statuses to New (keeps case_ids stable)
UPDATE cdm_tmforum.ra_gold.exception_case
SET status = 'New', assignee = NULL, notes = NULL, updated_at = current_timestamp();
```

> Prefer **Option B** if you want the same `case_id`s across runs (useful if you've bookmarked a specific case detail URL for the script). Prefer **Option A** if the case table itself is corrupted.

### 2.3 Redeploy the whole bundle (only if resources changed)

```shell
databricks bundle deploy -t prod -p demo
```

You normally do **not** need this before each demo. Only redeploy if code/resources changed since the last deploy.

### 2.4 Golden numbers — verify the reset landed

The source generator is seeded and reproducible, so a correct reset always produces the **same** exception population. Confirm these before going live. (Seeded leakage is a subset of the ~10K pre-seeded violations in `cdm_tmforum.tmf_enterprise.revenue_assurance_violation`.)

```sql
SELECT violation_type, COUNT(*) AS n, ROUND(SUM(estimated_revenue_impact_amount),0) AS impact_usd
FROM cdm_tmforum.ra_gold.reconciliation_exceptions
GROUP BY violation_type
ORDER BY impact_usd DESC;

SELECT COUNT(*) AS total_exceptions,
       ROUND(SUM(estimated_revenue_impact_amount),0) AS total_impact_usd
FROM cdm_tmforum.ra_gold.reconciliation_exceptions;
```

**Expected shape** (exact figures come from the seeded population — record your build's actuals here after first clean run and treat them as the golden baseline):

| violation_type | Detection | Expect present? |
| :---- | :---- | :---- |
| provisioning_discrepancy / billing_leakage | deterministic | ✅ largest single bucket |
| tariff_mismatch / rating_error | deterministic | ✅ |
| revenue_recognition_error / policy_violation | deterministic | ✅ |
| usage_reconciliation_gap / mediation_failure | ML anomaly | ✅ (depends on trained model in `ml`) |
| provisioning_discrepancy (billing-start-date lag) | deterministic | ✅ |
| partner_settlement_discrepancy | deterministic | ✅ |

> **Baseline to fill in on first clean build:** total exceptions ≈ `____`, total impact ≈ `$____`. Once recorded, any deviation on a later reset means data drift — see §5.4. Keep this figure consistent with the number quoted in the dashboard and test-plan golden outputs. Note: demo data ~10K violations across these types; the Lumen prospect pitch ($250–312M) is a separate business-case framing, not the demo's seeded figure.

---

## 3. Live demo script (ordered, ~15–20 min)

Deliver in this order. Each step lists the **action** (click/command), the **narration beat** (what you say), the **expected on-screen result**, and **timing**. The persona whose "job" you're doing is called out so the story stays coherent.

### Step 1 — Frame the problem (Dana) · 1:30

- **Action:** Tab 1 (intro notebook / title). Show the headline: Lumen, ~$12.5bn revenue, estimated 2–2.5% ($250–312M) leakage annually.
- **Narration:** "Lumen loses an estimated $250–312M a year to revenue leakage — active circuits that never get billed, prices that drift from the contract, discounts that outlive their approval. We built a Lakelink Fiber lakehouse to show what the solution looks like. A realistic recovery target is $125–220M. Today we show how one governed lakehouse on Databricks turns that from a quarterly spreadsheet hunt into a daily, automated control."
- **On screen:** Title / problem framing with the Lumen leakage economics.
- **Timing:** 1:30

### Step 2 — The hard problem: one canonical service instance (Priya) · 2:00

- **Action:** Tab 3 → Catalog Explorer on `cdm_tmforum.ra_silver.service_instance`. Show columns `service_instance_id, circuit_id, contract_id, billing_account_id, invoice_line_id, match_confidence`.
- **Narration:** "Every leakage type is really an identity problem — the network calls it a circuit, CRM calls it a contract, billing calls it an account and an invoice line. We built one canonical `service_instance` that resolves circuit → contract → billing → invoice. Once these are linked, leakage is just a set of mismatches across the bridge. Notice the match_confidence score — not every circuit lands cleanly."
- **On screen:** The `service_instance` schema; point at the four foreign keys and `match_confidence`.
- **Timing:** 2:00

### Step 3 — Show the medallion pipeline & data quality (Priya) · 2:30

- **Action:** Tab 2 → Pipelines → `ra_medallion_pipeline`. Show the graph: 6+ TM Forum source schemas + simulated source systems (Salesforce, Oracle, FX, CLM) → ra_silver conformed/dims/facts → `service_instance` → ra_gold. Click a node with **expectations** and show pass rates.
- **Narration:** "Multiple source systems land in bronze via Lakeflow Connect and simulation. A Lakeflow Declarative Pipeline conforms and identity-resolves them into silver, with data-quality expectations enforced inline — nulls, referential integrity, match rate. If the CDRs are malformed, they're quarantined here, not silently corrupted downstream. The base data comes from Lakelink Fiber's existing TMF SID common data model."
- **On screen:** Green pipeline graph; an expectations panel with pass %.
- **Timing:** 2:30

### Step 4 — Governance & lineage (Priya) · 1:30

- **Action:** Tab 3 → Lineage tab on `service_instance`. Then show a PII column (e.g. customer name/account) as **masked** for your analyst persona.
- **Narration:** "Unity Catalog gives us end-to-end lineage from invoice line back to the source circuit, and column masking so an analyst sees what they need without exposing customer PII. One governance model across every table, dashboard, and the app."
- **On screen:** Lineage graph upstream/downstream; a masked column value.
- **Timing:** 1:30

### Step 5 — The executive view: leakage KPIs (Dana) · 2:30

- **Action:** Tab 4 → AI/BI dashboard **RA Leakage Overview**. Walk the tiles: leakage rate, unbilled $, days-to-bill, leakage by violation type and region, expected-vs-actual (from `ra_gold.revenue_forecast`).
- **Narration:** "This is Dana's board view. Total leakage quantified, broken down by root cause and region, with an expected-vs-actual revenue line that flags variance as an early warning — not a post-mortem. Every number here is live off `ra_gold.leakage_kpis`."
- **On screen:** Populated dashboard; call out the biggest root-cause bucket.
- **Timing:** 2:30

### Step 6 — Ask in natural language (Marcus) · 1:30

- **Action:** Tab 5 → Genie. Type: *"What is the total unbilled leakage by region this quarter, and which product has the most provisioning_discrepancy exceptions?"*
- **Narration:** "Marcus doesn't write SQL to start an investigation. Genie answers in natural language over the governed ra_gold tables — same permissions, same masking."
- **On screen:** Genie returns a table/chart + the generated SQL.
- **Timing:** 1:30 *(pre-test this exact prompt during preflight — see §4 note.)*

### Step 7 — Work an exception in the app (Marcus) · 3:00

- **Action:** Tab 6 → **RA Exceptions Console**. (a) Show the exceptions queue sorted by `estimated_revenue_impact_amount` DESC. (b) Open a high-value **provisioning_discrepancy** (active-circuit-unbilled) case. (c) Drill to its `service_instance` to show the unlinked invoice line. (d) **Assign** to Marcus, add a **note**, move status **New → Investigating → Recovering**. (e) Mark one lower-value case **Recovered**.
- **Narration:** "This is where leakage gets closed. Marcus filters to the highest-dollar exceptions, opens one, and sees the exact circuit that's active with no invoice line. He assigns it, investigates, and drives it through Investigating → Recovering → Recovered. Every action writes back to `ra_gold.exception_case` — a full audit trail."
- **On screen:** Queue → detail → status transitions persist; KPI/overview count updates.
- **Timing:** 3:00

### Step 8 — Close the loop: ML + controls (Priya/Dana) · 1:30

- **Action:** Briefly show the `ml` anomaly model / MLflow run behind **usage_reconciliation_gap** / **mediation_failure**, and mention `ai_forecast` behind the expected-vs-actual tile.
- **Narration:** "The trickiest check — usage rose but billing didn't — isn't a hard rule, it's an anomaly model tracked in MLflow. And forecasting flags revenue variance before the month closes. Detected root causes become automated controls, so leakage shrinks over time instead of just being caught after the fact."
- **On screen:** MLflow run / model registry entry.
- **Timing:** 1:30

### Step 9 — The meta-narrative & close · 1:00

- **Action:** Return to Tab 1. Mention DABs + serverless + the Databricks Assistant used to build this.
- **Narration:** "Everything you saw — pipeline, checks, dashboard, app — is one repo deployed with Databricks Asset Bundles on serverless, built with help from the Databricks Assistant. Governed, reproducible, and recoverable in minutes. That's how we turned Lakelink Fiber's $540M problem into daily controls — and it's exactly what Lumen's lakehouse could look like."
- **On screen:** Title / recap.
- **Timing:** 1:00

**Total: ~17:00** (buffer to 20:00 for questions between beats).

---

## 3.1 Expected timings table

| # | Beat | Persona | Surface | Target | Running total |
| :---- | :---- | :---- | :---- | :---- | :---- |
| 1 | Frame the problem (Lumen $250–312M pitch) | Dana | Notebook | 1:30 | 1:30 |
| 2 | Canonical service instance | Priya | Catalog Explorer | 2:00 | 3:30 |
| 3 | Medallion pipeline + DQ | Priya | Pipeline graph | 2:30 | 6:00 |
| 4 | Governance & lineage | Priya | UC lineage / masking | 1:30 | 7:30 |
| 5 | Leakage KPIs (Lakelink data) | Dana | AI/BI dashboard | 2:30 | 10:00 |
| 6 | Natural-language Q&A | Marcus | Genie | 1:30 | 11:30 |
| 7 | Work an exception | Marcus | RA Exceptions Console | 3:00 | 14:30 |
| 8 | ML + controls | Priya/Dana | MLflow / forecast | 1:30 | 16:00 |
| 9 | Meta-narrative & close | — | Notebook | 1:00 | 17:00 |

> If you're short on time, the compressible beats are 4 and 8 (drop to 0:45 each). Never cut 2, 5, or 7 — they carry the story.

---

## 4. Fallback route (if something fails live)

**Rule of thumb:** if a live surface doesn't render within ~10 seconds, *narrate over the fallback and keep moving* — do not debug on stage. Recovery happens after, or during Q&A.

| If this fails live… | Immediate fallback |
| :---- | :---- |
| Dashboard won't render (Step 5) | Switch to the `ra_demo_fallback.pdf` slide for the KPI view; narrate the numbers from the golden baseline (§2.4). |
| Genie errors / bad answer (Step 6) | Skip the prompt; show the pre-run Genie screenshot in the fallback deck. Say "here's the same question answered a moment ago." |
| App won't load (Step 7) | Play the relevant segment of `ra_demo_full.mp4`, or use the exported `ra_demo_prerun.html`. |
| Pipeline graph is red (Step 3) | Show a screenshot of the last green run; pivot to Catalog Explorer to prove the tables exist. |
| Whole workspace is slow/down | Present entirely from `ra_demo_full.mp4` with live narration. State up front: "I'll walk you through a recorded run." |

**Pre-run insurance.** During preflight, run the whole script once end-to-end in `dev`, capture the six screenshots into `ra_demo_fallback.pdf`, and confirm `ra_demo_full.mp4` matches the current build. A fallback deck that's a version behind is worse than none.

---

## 5. Recovery commands for common failures

### 5.1 Warehouse cold / stopped

```shell
# Find the warehouse id
databricks warehouses list -p demo

# Start it and wait for RUNNING
databricks warehouses start <warehouse_id> -p demo
databricks warehouses get <warehouse_id> -p demo   # confirm state = RUNNING
```

Then run the warm-up query in §1.2. If serverless, expect ~20–40s to first result; run one throwaway query so the *demo's* first query is instant.

### 5.2 App crashed / won't load

```shell
# Check app status
databricks apps get ra-exceptions-console -p demo

# Restart (stop then start the app)
databricks apps stop ra-exceptions-console -p demo
databricks apps start ra-exceptions-console -p demo

# If code is stale, redeploy via the bundle then restart
databricks bundle deploy -t prod -p demo
```

Verify the app can reach its data: confirm `cdm_tmforum.ra_gold.exception_case` and `cdm_tmforum.ra_gold.reconciliation_exceptions` are queryable (warm-up query, §1.2). Most "app is blank" issues are actually a stopped warehouse (→ §5.1).

### 5.3 Pipeline failed / expectations red

```shell
# Re-run the medallion pipeline
databricks bundle run ra_medallion_pipeline -t prod -p demo
```

- If it fails on a **data-quality expectation**, the source data drifted — regenerate data first (§2.1 step 1), then re-run the pipeline.
- If it fails on **permissions**, confirm the run identity has `USE CATALOG cdm_tmforum` + write on the target schemas (`ra_silver`, `ra_gold`).
- Open Pipelines → `ra_medallion_pipeline` → the failed update → click the red node to read the exact expectation that tripped.

### 5.4 Data drift (numbers don't match the golden baseline)

Symptom: exception counts / total impact in §2.4 differ from your recorded baseline, or the dashboard shows unfamiliar numbers.

```shell
# Deterministic full rebuild restores the golden baseline
databricks bundle run ra_simulate_source_systems -t prod -p demo   # fixed seed -> same data
databricks bundle run ra_medallion_pipeline       -t prod -p demo
databricks bundle run ra_reconciliation_checks    -t prod -p demo
databricks bundle run ra_train_anomaly_model      -t prod -p demo   # only if variance check drifted
```

Then re-verify §2.4 and reset case state (§2.2). Because the generator is seeded, a clean rebuild must reproduce the baseline exactly; if it doesn't, the seed or generator code changed — flag to the builder, don't present drifted numbers.

### 5.5 Nuclear option — rebuild the RA layer from scratch

```shell
databricks bundle destroy -t prod -p demo     # drops ra_* schemas, app, jobs (NOT tmf_*)
databricks bundle deploy  -t prod -p demo
# then run the four jobs in §5.4 order, verify §2.4, reset §2.2
```

This **does not** touch the read-only `tmf_*` base data — it only tears down and rebuilds the `ra_*` schemas and app. Only do this with time to spare (10–15 min end-to-end). Never inside the hour before a demo.

---

## 6. Post-demo teardown (optional)

If the environment is ephemeral or you're handing the workspace back:

```shell
databricks bundle destroy -t prod -p demo   # removes ra_silver, ra_gold, app, jobs — NOT tmf_*
```

Leave `prod` standing between demos if the same environment will be reused — resetting (§2) is faster and cheaper than a full destroy/deploy cycle.

---

## 7. One-page quick reference (print this)

**Before:** warehouse RUNNING · base data (`tmf_*`) seeded · RA layer (`ra_silver`/`ra_gold`) built · `ra_gold.exception_case` reset · pipeline green · 6 tabs open · fallback deck ready.

**Reset fast:** `TRUNCATE + INSERT` on `exception_case` (§2.2).

**Reset full:** `ra_simulate_source_systems` → `ra_medallion_pipeline` → `ra_reconciliation_checks` (§2.1).

**Script order:** Problem (Lumen $250–312M) → Service instance → Pipeline/DQ → Lineage/PII → KPIs (Lakelink data) → Genie → Work exception → ML/controls → Close.

**If it breaks:** 10-second rule → fallback deck / recording → keep talking.

**Warehouse cold:** `databricks warehouses start <id> -p demo`.

**App dead:** `databricks apps stop/start ra-exceptions-console -p demo`.

**Numbers wrong:** deterministic rebuild (§5.4).

**The story:** "We built a Lakelink Fiber revenue-assurance lakehouse to show Lumen what theirs could look like."
