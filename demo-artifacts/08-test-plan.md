# RA Demo — Test Plan & Acceptance Criteria

> **Scrutiny summary**
> 
> - ✅ **2026-08-25:** Architecture refined — single `cdm_tmforum.revenue_assurance` schema confirmed (no ra_silver/ra_gold split); 7 silver checks (contract-price, discount-auth, FX, AR-aging, rev-rec, doc-intelligence×2) feed gold_leakage_summary; no materialized service_instance bridge; case state in Lakebase Postgres (`ra-console-lakebase` project); app is Databricks AppKit (React/TS).
> - ❌ **Was:** Catalog `lumen_ra` with bronze/silver/gold layers; invented source tables like `bronze.usage_telemetry`, `bronze.billing_invoice_lines`. ✅ **Now:** All real data lives in `cdm_tmforum` (TM Forum SID model). Demo builds a single **`cdm_tmforum.revenue_assurance`** schema (silver + gold materialized views) *within* `cdm_tmforum`, reading from read-only `tmf_*` and the simulated `*_source` schemas (`salesforce_source`, `oracle_erp_source`, `refinitiv_fx_source`, `ironclad_clm_source`, `mdm_source`).
> - ❌ **Was:** Golden outputs "~910 exceptions, ~$1.9M/month leakage" (~3–4% of ~25K circuits). ✅ **Now:** The derived register `revenue_assurance.gold_leakage_summary` holds **~48K exceptions / ~$601M at risk** across **7 `check_type`s**. The native `tmf_enterprise.revenue_assurance_violation` (~10K / ~$540M) remains as context. Data is statistically flat — inject sharp anomalies for the ML/`ai_forecast` scenes.
> - ❌ **Was:** Two-schema `ra_silver`/`ra_gold` split; a materialized `service_instance` identity bridge; the "6 checks" being active-unbilled / usage–billing variance / billing-start-lag / partner-settlement; case state in a Delta `exception_case` ↔ `ra_trouble_ticket`. ✅ **Now:** One `revenue_assurance` schema; **no materialized bridge** (checks join `*_source` → `tmf_*` directly); the **7 silver checks** are contract-price, discount-authorization, FX-validation, AR-aging, rev-rec timing, and two AI document-intelligence checks; **case state lives in Lakebase Postgres** (project `ra-console-lakebase`, schema `ra`: `ra.cases` / `ra.case_notes`).
> - ❌ **Was:** App implied FastAPI/HTML; golden table `reconciliation_exceptions`, `leakage_kpis`, `revenue_forecast`. ✅ **Now:** RA Exceptions Console is a **Databricks AppKit** app (React/TypeScript + type-safe SQL): reads via the analytics plugin (SQL warehouse) over `revenue_assurance.gold_*`, writes case state via the lakebase plugin. Serving tables are `gold_leakage_summary`, `gold_reconciliation_scorecard`, `gold_anomaly_scores`, `gold_revenue_forecast_anomalies`.
> - ✅ **Kept:** Scenario structure (Given/When/Then), reconciliation-check coverage, ML/forecast test, case workflow, data-quality expectations, security/governance, smoke tests. Updated assertion targets and data bindings to the real tables.

**Demo:** Revenue Assurance Lakehouse for Lakelink Fiber (pitched to Lumen Technologies) | **Catalog:** `cdm_tmforum` (reading `tmf_*`; building the `revenue_assurance` schema; sources simulated in `*_source`) | **Scope:** source simulation → the reconciliation checks (silver) → the unified leakage register + scorecard + forecast (gold) → ML/`ai_forecast` → RA Exceptions Console case workflow (Lakebase) → governance & smoke tests → golden outputs.

All scenarios assume a deterministic seed on the fixed `cdm_tmforum` dataset, so counts and dollar totals are reproducible on every run.

---

## 1. Given/When/Then scenarios

### 1.1 Source simulation (into `*_source` schemas)

| ID | Given | When | Then |
| :---- | :---- | :---- | :---- |
| ING-1 | The source-system simulator (`data-sim/simulate_source_systems.py` + `config.yaml`) exists | The simulator runs | All `*_source` schemas populated and non-empty (e.g., `salesforce_source.contract_line_item`, `oracle_erp_source.ar_payment_schedules_all`, `ironclad_clm_source` contract/invoice PDFs) |
| ING-2 | Source rows keyed to golden customers | Simulator runs | `salesforce_source.account.TMF_Customer_Id__c` values resolve to `tmf_customer.customer`; no orphaned keys beyond the intended anomaly set |
| ING-3 | A re-run with the same seed | Simulator runs again | Row counts identical (idempotent); matches prior run exactly |
| ING-4 | A malformed record (negative amount, bad date) | Simulator runs | Row is captured/flagged, not silently dropped; visible to the DQ layer |

### 1.2 The reconciliation checks (silver MVs → `revenue_assurance.gold_leakage_summary`)

Each check is a `CREATE OR REFRESH MATERIALIZED VIEW` in `cdm_tmforum.revenue_assurance`; flagged rows union into `gold_leakage_summary` (`check_type`, `severity`, `amount_at_risk`, `account_name`, `reference_id`, `source_table`, `detection_method`, `known_leakage_flag`).

| ID | Silver check (MV) | Given | When | Then (`check_type` in `gold_leakage_summary`) |
| :---- | :---- | :---- | :---- | :---- |
| CHK-1 | `silver_contract_price_reconciliation` | `salesforce_source.contract_line_item.UnitPrice` diverges from billed `tmf_customer.bill` | Refresh runs | `contract_price_mismatch`; `amount_at_risk` = contracted − billed; HIGH/MEDIUM by size |
| CHK-2 | `silver_discount_authorization_check` | A quote line discount exceeds `sbqq__quote__c.discount_approval__c`, or an expired quote is still Approved | Refresh runs | `unauthorized_discount` (HIGH) and/or `expired_quote_active` (MEDIUM) |
| CHK-3 | `silver_fx_rate_validation` | An invoice FX rate on `oracle_erp_source.ra_customer_trx_all` deviates > 1% from the Refinitiv mid-market rate | Refresh runs | FX-deviation row flagged (validation check; not unioned into the register) |
| CHK-4 | `silver_ar_aging_analysis` | `oracle_erp_source.ar_payment_schedules_all` shows 90+ day overdue / high DSO | Refresh runs | `ar_collection_risk` (HIGH); `amount_at_risk` = outstanding |
| CHK-5 | `silver_revenue_recognition_check` | ASC-606 `revenue_recognition_schedule` diverges from `gl_je_lines` postings | Refresh runs | `rev_rec_timing_mismatch` (MEDIUM); `amount_at_risk` = |recognition variance| |
| CHK-6 | `silver_doc_intelligence_contracts` | `ai_parse_document` + `ai_extract` on an `ironclad_clm_source` contract PDF disagrees with the system record | Refresh runs | `doc_contract_mismatch` (HIGH); `detection_method='ai_extracted'` |
| CHK-7 | `silver_doc_intelligence_invoices` | `ai_extract` on an invoice PDF shows an amount mismatch vs the system | Refresh runs | `doc_invoice_mismatch` (HIGH); `detection_method='ai_extracted'` |
| CHK-0 | No false positives | A cleanly-reconciling customer (no seeded defect in any source) | Refresh runs | **No** row in `gold_leakage_summary` for it |

### 1.3 Scorecard reconciliation (customer-level risk assessment)

| ID | Given | When | Then |
| :---- | :---- | :---- | :---- |
| SCR-1 | `gold_reconciliation_scorecard` for a customer | Refresh runs | One row per scored customer with `composite_health_score` and `risk_tier` ∈ {GREEN, AMBER, RED} |
| SCR-2 | Leakage exceptions across multiple check_types | Gold refresh completes | Scorecard aggregates all check_types per customer; one row per customer, no duplicates |
| SCR-3 | A customer with no exceptions | Refresh runs | They appear in the scorecard with `risk_tier='GREEN'` and `composite_health_score` near 100 |

### 1.4 ML anomaly + revenue forecast (`gold_anomaly_scores`, `gold_revenue_forecast_anomalies`)

| ID | Given | When | Then |
| :---- | :---- | :---- | :---- |
| ML-1 | Monthly GL revenue (account 4000) with seeded sharp deviations | `gold_revenue_forecast_anomalies` refreshes (uses `ai_forecast`) | Months outside the forecast interval get `anomaly_status` ∈ {ABOVE_EXPECTED, BELOW_EXPECTED}; normal months `NORMAL` |
| ML-2 | A stable revenue month | Refresh runs | `anomaly_status='NORMAL'`; `budget_variance_pct` computed vs `gl_budgets` |
| ML-3 | ML anomaly scoring | `gold_anomaly_scores` refreshes | Scores present and joinable to exceptions; higher scores concentrate on injected anomalies |
| ML-4 | Determinism | Re-run with same seed | Same set of anomaly flags produced |

**Caveat:** `cdm_tmforum` is statistically uniform/flat. To make the ML/forecast scene compelling, the source simulator injects a handful of sharp deviations. Narrate this honestly: "Real revenue would have more natural variance; we've seeded obvious anomalies to show `ai_forecast` detection in action."

### 1.5 RA Exceptions Console case workflow (Lakebase: `ra.cases` / `ra.case_notes`)

Case state is written by the AppKit app to Lakebase Postgres (project `ra-console-lakebase`, schema `ra`), keyed by the synthesized `exception_id` from the queue query. Reads of the exception itself come from `gold_leakage_summary` via the SQL warehouse.

| ID | Given | When | Then |
| :---- | :---- | :---- | :---- |
| APP-1 | An exception open in the queue (no case row yet) | Marcus clicks "Assign to me" | A `ra.cases` row is created lazily from the queue metadata; `assignee` set; `updated_at` advances |
| APP-2 | An assigned case in New | Marcus sets status → Investigating | Persisted in `ra.cases.status`; queue + drawer reflect it |
| APP-3 | Investigating case | Marcus → Recovering, then Recovered | Transitions allowed in order; dashboard/case-progress "Recovered" increases |
| APP-4 | Any status | Marcus tries an illegal transition (e.g. Investigating → Recovered) | Server guard rejects with **HTTP 409** and the allowed next states; UI only offers legal moves |
| APP-5 | WrittenOff | Marcus writes off without a note | Blocked ("Add a reason before writing off.") |
| APP-6 | Add note | Marcus adds a note | Row appended to `ra.case_notes` (author from `x-forwarded-email`); shown newest-first |
| APP-7 | Persistence | Case changed, page reloaded | Change reflected after refresh (round-trips through Lakebase); `/api/cases/stats` counts update |

---

## 2. Data-quality expectations

| ID | Table | Expectation | Action |
| :---- | :---- | :---- | :---- |
| DQ-1 | `*_source.*` | Row counts within tolerance of seed targets (e.g., ~10K customers, ~100K circuits) | warn |
| DQ-2 | `revenue_assurance.silver_contract_price_reconciliation` | `customer_id` resolvable; `leakage_flag` ∈ expected set | warn |
| DQ-3 | `revenue_assurance.silver_ar_aging_analysis` | `total_outstanding` ≥ 0; `collection_risk` ∈ {LOW, MEDIUM, HIGH} | drop invalid |
| DQ-4 | `revenue_assurance.gold_leakage_summary` | `check_type` ∈ the 7 known types; `severity` ∈ {HIGH, MEDIUM}; `amount_at_risk` ≥ 0 | fail |
| DQ-5 | `revenue_assurance.gold_reconciliation_scorecard` | one row per scored customer; `composite_health_score` ∈ [0,100]; `risk_tier` ∈ {GREEN, AMBER, RED} | fail |
| DQ-6 | `revenue_assurance.gold_revenue_forecast_anomalies` | `anomaly_status` ∈ {ABOVE_EXPECTED, BELOW_EXPECTED, NORMAL}; one row per month | warn |
| DQ-7 | `ra.cases` (Lakebase) | `exception_id` PK unique; `status` ∈ {New, Investigating, Recovering, Recovered, WrittenOff} | fail |
| DQ-8 | `ra.case_notes` (Lakebase) | `exception_id` FK exists in `ra.cases`; `body` non-empty | fail |
| DQ-9 | `ai_extract` outputs (`silver_doc_intelligence_*`) | Extracted fields non-null on parseable PDFs; unparseable docs flagged, not dropped silently | warn |

The gold materialized views (`CREATE OR REFRESH MATERIALIZED VIEW`) are the reproducibility guarantee — every leakage figure traces back through a named silver MV to a `*_source` / `tmf_*` table, which is the evidence shown in the Exception Detail drawer.

---

## 3. Security & governance checks

| ID | Given | When | Then |
| :---- | :---- | :---- | :---- |
| SEC-1 | The app service principal (or `ra_analysts` role, Marcus) | Reads `revenue_assurance.gold_*` | SELECT succeeds (SP granted `USE CATALOG` on `cdm_tmforum` + `USE SCHEMA`/`SELECT` on `cdm_tmforum.revenue_assurance`) |
| SEC-2 | `ra_analysts` role | Reads a customer name (PII) via the scorecard/`tmf_customer.customer.name` | Value is **masked** per UC tag `pii=true` |
| SEC-3 | `ra_engineers` role (Priya) | Reads the same PII column | Value is **unmasked** |
| SEC-4 | `ra_execs` role (Dana) | Attempts to write case state | Denied (read-only; only the app SP writes Lakebase) |
| SEC-5 | App service principal | Writes `ra.cases` / `ra.case_notes` in its own Lakebase schema | Allowed (SP owns schema `ra`); it cannot write `tmf_*` |
| SEC-6 | Any exception | Open Unity Catalog lineage | Traces `gold_leakage_summary` → the silver MV → `*_source` / `tmf_*` sources end-to-end |
| SEC-7 | PII columns | Inspect UC tags + mask function | Tagged `pii=true`; mask function bound |

---

## 4. Smoke tests (post-deploy health)

| ID | Check | Pass condition |
| :---- | :---- | :---- |
| SMK-1 | Bundle deploy | `databricks apps deploy --profile <name>` completes; validation (typegen/lint/typecheck/build) passes |
| SMK-2 | Warehouse | Serverless SQL warehouse reachable; `SELECT 1` returns |
| SMK-3 | Catalog & schema | `cdm_tmforum` exists; `revenue_assurance` + `*_source` schemas present; Lakebase project `ra-console-lakebase` reachable |
| SMK-4 | Source simulator | `simulate_source_systems` last run = SUCCESS; `*_source.*` tables non-empty and deterministic |
| SMK-5 | Silver/gold refresh | The `revenue_assurance` materialized views refresh; `gold_leakage_summary` non-empty (~48K rows); `gold_reconciliation_scorecard` one row per scored customer |
| SMK-6 | Register totals | `SUM(amount_at_risk)` over `gold_leakage_summary` ≈ $601M (±5%); all 7 `check_type`s present (see §5) |
| SMK-7 | Dashboard | AI/BI dashboard loads < 5s; tiles render non-null; KPI totals reconcile to `gold_leakage_summary` |
| SMK-8 | App | `ra-exceptions-console` status = RUNNING; `/api/whoami` returns the signed-in user; Queue loads rows; filters work |
| SMK-9 | Genie (planned) | Scripted question returns a governed answer; respects masking |
| SMK-10 | Case round-trip | Assign + status change via the App → `/api/cases/stats` reflects it; visible on dashboard/case-progress refresh |

---

## 5. Golden outputs (must reproduce)

The derived register `revenue_assurance.gold_leakage_summary` totals **~48,108 exceptions / ~$601.5M at risk** across **7 `check_type`s** (approximate, fixed-seed; assert presence + ±5% on the total, not exact per-row counts):

| `check_type` | Severity | Approx count | Approx $ at risk |
| :---- | :---- | :---- | :---- |
| `ar_collection_risk` | HIGH | ~6,244 | ~$500M |
| `rev_rec_timing_mismatch` | MEDIUM | ~72 | ~$85.7M |
| `unauthorized_discount` | HIGH | ~33,908 | ~$13.9M |
| `contract_price_mismatch` | HIGH+MEDIUM | ~3,363 | ~$1.6M |
| `expired_quote_active` | MEDIUM | ~4,521 | ~$0 |
| `doc_contract_mismatch` | HIGH | present | AI-extracted |
| `doc_invoice_mismatch` | HIGH | present | AI-extracted |
| **TOTAL (register)** | — | **~48,108** | **~$601.5M** |

**Real vs. pitch numbers:**
- **Derived register (what the app/dashboard query):** `gold_leakage_summary` ≈ 48K exceptions / ~$601M.
- **Native seed (context):** `tmf_enterprise.revenue_assurance_violation` ≈ 10K violations / ~$540M across 2018–2025.
- **Lumen business case (pitch framing):** $250M–$312M annually (2–2.5% leakage) — narrative, distinct from the demo dataset.

Assertions:

- `SELECT COUNT(*) FROM cdm_tmforum.revenue_assurance.gold_leakage_summary` ≈ 48,108 (±5% with fixed seed).
- `SELECT ROUND(SUM(amount_at_risk),0) FROM cdm_tmforum.revenue_assurance.gold_leakage_summary` ≈ $601.5M (±5%).
- All 7 `check_type`s appear; `GROUP BY check_type` matches the table above within tolerance.
- `gold_reconciliation_scorecard.risk_tier` yields a plausible GREEN/AMBER/RED distribution.
- Dashboard "Leakage at risk" tile equals the `SUM` (dashboard ↔ table reconcile).
- CHK-0: cleanly-reconciling customers produce no rows.
- **Narration callout:** "This register shows ~$601M in detected leakage across Lakelink Fiber's simulated stack; the actual Lumen case estimated $250M–$312M annually — proportional framing for a focused demo."

---

## 6. Definition of Done

The demo passes when, from a clean workspace, a coding agent can execute the following and have every item succeed:

1. `databricks apps deploy --profile <name>` → SMK-1..SMK-3 pass (app SP has the UC read grants).
2. Run the source simulator + refresh the `revenue_assurance` silver/gold materialized views → SMK-4, SMK-5, SMK-6 pass; ING-1..ING-4 and DQ-1..DQ-9 pass.
3. All reconciliation checks (CHK-1..CHK-7) produce their `gold_leakage_summary` rows / validation flags; CHK-0 produces none.
4. Identity-join scenarios IDR-1..IDR-4 hold; the scorecard resolves customers.
5. ML/forecast scenarios ML-1..ML-4 hold; anomaly flags are deterministic with seed.
6. Golden outputs in §5 reproduced within 5% tolerance; dashboard total reconciles to `gold_leakage_summary`; narration calls out the register vs. pitch distinction.
7. Security checks SEC-1..SEC-7 pass (masking, grants, lineage).
8. App workflow APP-1..APP-7 pass; a case assign + status change persists in Lakebase and appears on refresh (SMK-10), and the transition guard returns HTTP 409 on an illegal move.
9. Genie answers the scripted questions when enabled (SMK-9); governed by UC.

When these hold on a fresh deploy with the fixed seed from `cdm_tmforum`, the demo is **Done** and safe to present.
