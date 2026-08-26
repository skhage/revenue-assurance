# RA Demo — Demo Operations Runbook

**Demo:** Revenue Assurance Lakehouse for Lakelink Fiber (pitched to Lumen Technologies) · **Catalog:** `cdm_tmforum` · **App:** RA Exceptions Console · **Repo:** `revenue-assurance` · **Cloud:** FEVM (serverless, `demo` profile) · **IaC:** Databricks Asset Bundles (DABs)

> **Scrutiny summary**
> - ✅ **2026-08-25:** Schema simplified to single `cdm_tmforum.revenue_assurance` (not ra_silver/ra_gold split); 7 silver checks refined with new names; no materialized service_instance bridge; case state in Lakebase Postgres (ra-console-lakebase project); app is Databricks AppKit; reconciliation SQL files: reconciliation/transformations/{silver_reconciliation.sql, silver_doc_intelligence.sql, gold_aggregation.sql}.
> - ❌ **Was:** `lumen_ra` catalog with invented bronze layer (`network_provisioning`, `usage_telemetry`, etc.)
> - ✅ **Now:** `cdm_tmforum` (real TM Forum SID data); build single `revenue_assurance` schema reading from read-only `tmf_*`.
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
| **Catalog** | `cdm_tmforum` (existing TM Forum SID data; we build new `revenue_assurance` schema with silver + gold materialized views) |
| **RA schemas** | `revenue_assurance` (silver MVs + gold MVs, read-write for app SP) |
| **Source schemas** | `tmf_resource`, `tmf_service`, `tmf_product`, `tmf_customer`, `tmf_businesspartner`, `tmf_enterprise` (all read-only) + `*_source` (simulated source systems) |
| **SQL Warehouse** | Serverless SQL warehouse (referenced by id) — powers the MVs, dashboard, Genie, and the app's analytics reads |
| **App** | RA Exceptions Console — **Databricks AppKit** (React/TypeScript); analytics via SQL warehouse, case state in Lakebase (`ra-console-lakebase`, schema `ra`) |
| **Reconciliation layer** | Silver + gold **materialized views** in `cdm_tmforum.revenue_assurance`, defined in `reconciliation/transformations/{silver_reconciliation.sql, silver_doc_intelligence.sql, gold_aggregation.sql}` (`CREATE OR REFRESH MATERIALIZED VIEW`) |
| **Source simulation** | `data-sim/simulate_source_systems.py` (+ `config.yaml`) → `*_source` schemas |
| **Personas told on-screen** | Dana Whitfield (VP RA, Lakelink Fiber), Marcus Chen (Sr. RA Analyst), Priya Nair (Lead DE) |
| **Demo story** | We built a Lakelink Fiber revenue-assurance lakehouse to show Lumen what theirs could look like. |

**Command conventions.** All `databricks bundle` commands are run from the repo root of `revenue-assurance`. Where a specific job/pipeline name is referenced, it matches the resource keys in `resources/*.yml`. If your profile is not `demo`, append `-p <profile>` to every CLI command below.

---

## 1. Preflight checklist (run T-30 minutes)

Work top to bottom. Do not start the live demo until every box is green.

### 1.1 Access & entitlements

- [ ] You can log in to the Databricks `demo-workspace` workspace in the browser you'll present from.
- [ ] Your user (or the demo presenter user) is a member of groups with read on catalog `cdm_tmforum` and write on `cdm_tmforum.revenue_assurance`. (Grants let you *see* masked vs. unmasked PII appropriately — do not present as account admin, or the PII-masking beat won't land.)
- [ ] **Serverless is enabled** for SQL and Jobs in the workspace (Settings → Compute). The demo uses no classic clusters.
- [ ] Genie is enabled and the **RA Genie space** is published and shared with you.
- [ ] The **RA Exceptions Console** app is deployed and you have "Can use" permission.
- [ ] Databricks CLI authenticates: `databricks auth describe -p demo` returns your identity.

### 1.2 Data & compute are warm

- [ ] Warehouse warm: run `databricks warehouses get <warehouse_id> -p demo` and confirm `state = RUNNING`. If `STOPPED`, start it now (see §5.1) — a cold serverless warehouse costs you 20–40s on the first query, which reads as a stall on stage.
- [ ] Base data seeded in `cdm_tmforum`: confirm `tmf_resource.logical_resource`, `tmf_service.resource_facing_service`, `tmf_customer.bill` have rows (non-zero counts).
- [ ] RA layer populated: quick count check (see command below) returns non-zero rows in `revenue_assurance` silver and gold materialized views.
- [ ] `cdm_tmforum.revenue_assurance.gold_leakage_summary` has the expected seeded exception population (~48K / ~$601M, see golden numbers in §2.4).
- [ ] Lakebase project `ra-console-lakebase` schema `ra` (tables `ra.cases` / `ra.case_notes`) is in a **clean demo state** — see §2. If a previous run left cases in `Recovered`/`WrittenOff`, reset (§2.2).
- [ ] Latest pipeline run for `ra_medallion_pipeline` shows **all expectations green** (open Pipelines → `ra_medallion_pipeline` → latest update).

**Warm-up query (also proves the warehouse and seed in one shot):**

```sql
-- Run in a SQL editor attached to ra_demo_wh
SELECT 'tmf_resource.logical_resource' AS tbl, COUNT(*) AS n FROM cdm_tmforum.tmf_resource.logical_resource
UNION ALL SELECT 'revenue_assurance.silver_contract_price_reconciliation', COUNT(*) FROM cdm_tmforum.revenue_assurance.silver_contract_price_reconciliation
UNION ALL SELECT 'revenue_assurance.gold_leakage_summary', COUNT(*) FROM cdm_tmforum.revenue_assurance.gold_leakage_summary
UNION ALL SELECT 'revenue_assurance.gold_reconciliation_scorecard', COUNT(*) FROM cdm_tmforum.revenue_assurance.gold_reconciliation_scorecard;
-- Note: ra.cases and ra.case_notes live in Lakebase Postgres (project ra-console-lakebase), not queryable via SQL warehouse
```

### 1.3 Surfaces open and pre-loaded (browser tabs, left to right)

Open these tabs **in demo order** before you start so you never fumble for a URL on stage:

1. Notebook: `src/overview` (or the intro notebook) — for the opening.
2. Pipelines → `ra_medallion_pipeline` (graph view).
3. Catalog Explorer → `cdm_tmforum.revenue_assurance.gold_leakage_summary` (Lineage tab pre-clicked).
4. AI/BI dashboard: **RA Leakage Overview** (bound to `cdm_tmforum.revenue_assurance.gold_leakage_summary` / `gold_reconciliation_scorecard` / `gold_revenue_forecast_anomalies`).
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
# From revenue-assurance/ repo root.

# 1) Simulate source systems deterministically (fixed seed; see §2.4).
# Lands simulated Salesforce, Oracle, FX, CLM, MDM data into *_source schemas.
# Run data-sim/simulate_source_systems.py on the workspace (+ config.yaml).

# 2) Refresh the reconciliation layer — the silver + gold materialized views in
#    cdm_tmforum.revenue_assurance. Re-apply reconciliation/transformations/*.sql
#    (CREATE OR REFRESH MATERIALIZED VIEW), or REFRESH the existing MVs, on the
#    serverless SQL warehouse, e.g.:
databricks experimental aitools tools query -p demo \
  "REFRESH MATERIALIZED VIEW cdm_tmforum.revenue_assurance.gold_leakage_summary"
# (repeat for the other gold MVs; silver MVs refresh first as their upstream)
```

Then confirm golden numbers (§2.4).

### 2.2 Reset only the case-management state (Lakebase: `ra.cases` / `ra.case_notes`)

Use between back-to-back demos when the RA data is fine but you (or a prior audience) moved cases through the workflow. This is the fast reset (~10s) — it does **not** rebuild the pipeline. Lakebase case state is managed via the app or direct Postgres queries; contact the Lakebase admin or use the app's reset function.

**Option A (via Lakebase Postgres):** Clear case state and re-seed from leakage summary:

```sql
-- Run in Lakebase workspace SQL
TRUNCATE TABLE ra.case_notes;
TRUNCATE TABLE ra.cases;

-- Re-seed one New case per open exception from gold_leakage_summary
INSERT INTO ra.cases (exception_id, assignee, status, created_at, updated_at)
SELECT DISTINCT exception_id, NULL, 'New', current_timestamp(), current_timestamp()
FROM cdm_tmforum.revenue_assurance.gold_leakage_summary;
```

**Option B (via the RA Exceptions Console app):** Use the app's built-in reset button or menu (if available) to rewind all cases to New.

> Prefer **Option B** for simplicity if the app provides it. Use **Option A** for programmatic reset between demos.

### 2.3 Redeploy the whole bundle (only if resources changed)

```shell
databricks bundle deploy -t prod -p demo
```

You normally do **not** need this before each demo. Only redeploy if code/resources changed since the last deploy.

### 2.4 Golden numbers — verify the reset landed

The source generator is seeded and reproducible, so a correct reset always produces the **same** exception population. Confirm these before going live. (Seeded leakage is a subset of the ~10K pre-seeded violations in `cdm_tmforum.tmf_enterprise.revenue_assurance_violation`.)

```sql
SELECT check_type, COUNT(*) AS n, ROUND(SUM(amount_at_risk),0) AS impact_usd
FROM cdm_tmforum.revenue_assurance.gold_leakage_summary
GROUP BY check_type
ORDER BY impact_usd DESC;

SELECT COUNT(*) AS total_exceptions,
       ROUND(SUM(amount_at_risk),0) AS total_impact_usd
FROM cdm_tmforum.revenue_assurance.gold_leakage_summary;
```

**Expected shape** (seeded population is deterministic; rebuild always produces the same totals):

| check_type | Detection | Approx. $ at risk |
| :---- | :---- | :---- |
| `ar_collection_risk` | deterministic | ~$500M |
| `unauthorized_discount` | deterministic | ~$13.9M |
| `contract_price_mismatch` | deterministic | ~$1.6M |
| `rev_rec_timing_mismatch` | deterministic | ~$85.7M |
| `expired_quote_active` | deterministic | ~$0 |
| `doc_contract_mismatch` | AI extract | present (AI-detected) |
| `doc_invoice_mismatch` | AI extract | present (AI-detected) |

> **Baseline from fixed seed:** total exceptions ≈ 48K, total impact ≈ $601M. Once recorded, any deviation on a later reset means data drift — see §5.4. Keep this figure consistent with the number quoted in the dashboard and test-plan golden outputs. Note: demo leakage ~$601M across these 7 check types; the Lumen prospect pitch ($250–312M annually) is a separate business-case framing, not the demo's seeded figure.

---

## 3. Live demo script (ordered, ~15–20 min)

Deliver in this order. Each step lists the **action** (click/command), the **narration beat** (what you say), the **expected on-screen result**, and **timing**. The persona whose "job" you're doing is called out so the story stays coherent.

### Step 1 — Frame the problem (Dana) · 1:30

- **Action:** Tab 1 (intro notebook / title). Show the headline: Lumen, ~$12.5bn revenue, estimated 2–2.5% ($250–312M) leakage annually.
- **Narration:** "Lumen loses an estimated $250–312M a year to revenue leakage — active circuits that never get billed, prices that drift from the contract, discounts that outlive their approval. We built a Lakelink Fiber lakehouse to show what the solution looks like. A realistic recovery target is $125–220M. Today we show how one governed lakehouse on Databricks turns that from a quarterly spreadsheet hunt into a daily, automated control."
- **On screen:** Title / problem framing with the Lumen leakage economics.
- **Timing:** 1:30

### Step 2 — The unified leakage register (Priya) · 2:00

- **Action:** Tab 3 → Catalog Explorer on `cdm_tmforum.revenue_assurance.gold_leakage_summary`. Show columns `check_type, severity, amount_at_risk, account_name, detection_method`.
- **Narration:** "Leakage types are diverse — contract mismatches, unauthorized discounts, FX deviations, AR aging, revenue recognition timing, and AI-detected document anomalies. We built a unified register that surfaces all of them: 48K exceptions across 7 check types, ~$601M at risk. Each row traces back to the exact source data and the check that caught it — whether it's a hard rule or an anomaly flag."
- **On screen:** The `gold_leakage_summary` schema; scroll to show rows grouped by `check_type`, point at the severity and amount columns.
- **Timing:** 2:00

### Step 3 — Show the reconciliation layer & AI checks (Priya) · 2:30

- **Action:** Tab 2 → Catalog → `cdm_tmforum.revenue_assurance`. Show the 7 **silver** check materialized views (contract-price, discount-auth, FX, AR-aging, rev-rec, doc-intelligence×2) feeding the 4 **gold** MVs (`gold_leakage_summary`, `gold_reconciliation_scorecard`, `gold_anomaly_scores`, `gold_revenue_forecast_anomalies`). Open `silver_doc_intelligence_contracts` and point out `ai_parse_document` + `ai_extract`.
- **Narration:** "The golden TMF SID data plus simulated source systems — Salesforce, Oracle ERP, Refinitiv FX, Ironclad CLM — feed seven reconciliation checks, each a materialized view. Two of them use Databricks AI functions to read contract and invoice PDFs and compare them to the system of record. They all union into one leakage register the whole demo runs off."
- **On screen:** The `revenue_assurance` schema browser; the `ai_extract` SQL in a doc-intelligence MV.
- **Timing:** 2:30

### Step 4 — Governance & lineage (Priya) · 1:30

- **Action:** Tab 3 → Lineage tab on `revenue_assurance.gold_leakage_summary` (trace upstream to the `*_source` + `tmf_*` inputs). Then show a PII column (e.g. `gold_reconciliation_scorecard.account_name`) as **masked** for your analyst persona.
- **Narration:** "Unity Catalog gives us end-to-end lineage from invoice line back to the source circuit, and column masking so an analyst sees what they need without exposing customer PII. One governance model across every table, dashboard, and the app."
- **On screen:** Lineage graph upstream/downstream; a masked column value.
- **Timing:** 1:30

### Step 5 — The executive view: leakage KPIs (Dana) · 2:30

- **Action:** Tab 4 → AI/BI dashboard **RA Leakage Overview**. Walk the tiles: leakage rate, total at risk, by check_type, by customer (from `revenue_assurance.gold_leakage_summary`), expected-vs-actual (from `gold_revenue_forecast_anomalies`), risk scorecard (from `gold_reconciliation_scorecard`).
- **Narration:** "This is Dana's board view. Total leakage quantified, broken down by root cause and customer, with an expected-vs-actual revenue line that flags variance as an early warning — not a post-mortem. The scorecard shows which customers are highest-risk. Every number here is live off the RA gold layer."
- **On screen:** Populated dashboard; call out the biggest root-cause bucket.
- **Timing:** 2:30

### Step 6 — Ask in natural language (Marcus) · 1:30

- **Action:** Tab 5 → Genie. Type: *"What is the total amount at risk by check_type, and which accounts have the most contract_price_mismatch exceptions?"*
- **Narration:** "Marcus doesn't write SQL to start an investigation. Genie answers in natural language over the governed revenue_assurance tables — same permissions, same masking."
- **On screen:** Genie returns a table/chart + the generated SQL.
- **Timing:** 1:30 *(pre-test this exact prompt during preflight — see §4 note.)*

### Step 7 — Work an exception in the app (Marcus) · 3:00

- **Action:** Tab 6 → **RA Exceptions Console**. (a) On **Overview**, show the KPI tiles + root-cause bar chart. (b) Go to **Exception queue**, sorted by `amount_at_risk` DESC; filter to a high-value **contract_price_mismatch** (or **ar_collection_risk**) exception. (c) Open the row → the detail **drawer** shows the detection evidence + the customer **reconciliation scorecard** (risk tier, health score). (d) **Assign to me**, add a **note**, move status **New → Investigating → Recovering**. (e) Mark one lower-value case **Recovered**. (Try an illegal jump, e.g. Investigating → Recovered, to show the guard reject it.)
- **Narration:** "This is where leakage gets closed. Marcus filters to the highest-dollar exceptions by check_type, opens one, and reads the evidence and the customer's reconciliation scorecard. He assigns it, adds a note, and drives it through Investigating → Recovering → Recovered — the lifecycle is guarded so illegal transitions are blocked. Every action writes to Lakebase (project ra-console-lakebase, schema ra) — a full audit trail."
- **On screen:** Queue → detail → status transitions persist; KPI/overview count updates.
- **Timing:** 3:00

### Step 8 — Close the loop: ML + controls (Priya/Dana) · 1:30

- **Action:** Briefly show `revenue_assurance.gold_anomaly_scores` (the ML anomaly scores) and `gold_revenue_forecast_anomalies` (the `ai_forecast` expected-vs-actual with `anomaly_status`), and the tile they back on the dashboard.
- **Narration:** "Not every signal is a hard rule. `ai_forecast` projects expected monthly revenue and flags months where actual falls outside the confidence band — variance caught before the month closes, not in a post-mortem. Anomaly scores surface the outliers a fixed threshold would miss. Detected root causes become controls, so leakage shrinks over time."
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

Verify the app can reach its data: confirm `cdm_tmforum.revenue_assurance.gold_leakage_summary` is queryable and Lakebase `ra-console-lakebase` is reachable (warm-up query, §1.2). Most "app is blank" issues are actually a stopped warehouse (→ §5.1).

### 5.3 Reconciliation layer failed / stale

```shell
# Re-apply / refresh the materialized views
databricks experimental aitools tools query -p demo \
  "REFRESH MATERIALIZED VIEW cdm_tmforum.revenue_assurance.gold_leakage_summary"
```

- If a **silver** MV errors, its upstream `*_source` data drifted or is missing — regenerate sources first (§2.1 step 1), then refresh silver → gold.
- If it fails on **permissions**, confirm the run identity has `USE CATALOG cdm_tmforum` + write on the `cdm_tmforum.revenue_assurance` schema, and that the **app SP** has `USE CATALOG` + `USE SCHEMA`/`SELECT` on `revenue_assurance` (else the app build/queries fail).
- Read the MV refresh error in the query history / SQL editor to see the exact failing expression.

### 5.4 Data drift (numbers don't match the golden baseline)

Symptom: exception counts / total impact in §2.4 differ from your recorded baseline, or the dashboard shows unfamiliar numbers.

```shell
# Deterministic full rebuild restores the golden baseline:
# 1) re-run data-sim/simulate_source_systems.py (fixed seed -> same *_source data)
# 2) refresh the silver MVs, then the gold MVs:
databricks experimental aitools tools query -p demo \
  "REFRESH MATERIALIZED VIEW cdm_tmforum.revenue_assurance.gold_leakage_summary"
# (repeat for gold_reconciliation_scorecard, gold_anomaly_scores, gold_revenue_forecast_anomalies)
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
databricks bundle destroy -t prod -p demo   # removes revenue_assurance schema, app, jobs; DOES NOT touch tmf_* or Lakebase
```

Leave `prod` standing between demos if the same environment will be reused — resetting (§2) is faster and cheaper than a full destroy/deploy cycle.

---

## 7. One-page quick reference (print this)

**Before:** warehouse RUNNING · base data (`tmf_*`) seeded · RA layer (`revenue_assurance` schema) built · Lakebase cases reset · pipeline green · 6 tabs open · fallback deck ready.

**Reset fast:** Reset Lakebase cases via app or `TRUNCATE ra.cases` (§2.2).

**Reset full:** `ra_simulate_source_systems` → `ra_medallion_pipeline` → `ra_reconciliation_checks` (§2.1).

**Script order:** Problem (Lumen $250–312M) → Leakage register → Pipeline/DQ → Lineage/PII → KPIs (Lakelink data) → Genie → Work exception → ML/controls → Close.

**If it breaks:** 10-second rule → fallback deck / recording → keep talking.

**Warehouse cold:** `databricks warehouses start <id> -p demo`.

**App dead:** `databricks apps stop/start ra-exceptions-console -p demo`.

**Numbers wrong:** deterministic rebuild (§5.4).

**The story:** "We built a Lakelink Fiber revenue-assurance lakehouse to show Lumen what theirs could look like."
