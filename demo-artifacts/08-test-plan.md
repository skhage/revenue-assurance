# RA Demo — Test Plan & Acceptance Criteria

> **Scrutiny summary**
> 
> - ❌ **Was:** Catalog `lumen_ra` with bronze/silver/gold layers; invented source tables like `bronze.usage_telemetry`, `bronze.billing_invoice_lines`. ✅ **Now:** All real data lives in `cdm_tmforum` (TM Forum SID model). Demo builds `ra_silver` (identity bridge) and `ra_gold` (reconciliation logic + serving tables) *within* `cdm_tmforum`, reading from existing `tmf_*` schemas. Source systems simulated in `*_source` schemas (e.g., `salesforce_source`, `oracle_erp_source`, `refinitiv_fx_source`, `ironclad_clm_source`, `mdm_source`).
> - ❌ **Was:** Golden outputs "~910 exceptions, ~$1.9M/month leakage" (~3–4% of ~25K circuits). ✅ **Now:** Real seed data: `tmf_enterprise.revenue_assurance_violation` contains ~10,000 pre-seeded violations across 12 types, totaling ~$540M estimated impact. For demo runs with a fixed seed, extract a reproducible subset (e.g., current month slice ≈ 600–900 open violations) matching the illustrative $1.9M/month demo target. **Caveat:** data is statistically flat (uniform distribution) — inject sharp anomalies for compelling ML demo.
> - ❌ **Was:** Golden table names `bronze.*`, invented source names. ✅ **Now:** Real source tables: `tmf_resource.resource_usage` (mediation_status), `tmf_customer.bill`, `tmf_customer.commitment` (price variance), `tmf_product.discount_prod_offer_price_alteration`, `tmf_product.order_item` (billing_start_date lag), `tmf_businesspartner.rev_share_reconciliation`, `logical_resource.lifecycle_status` (active circuits).
> - ✅ **Kept:** Scenario structure (Given/When/Then), 6 reconciliation checks, identity-resolution asserts, ML anomaly test, case workflow, data-quality expectations, security/governance, smoke tests. Updated assertion targets and data bindings to real tables.

**Demo:** Revenue Assurance Lakehouse for Lumen Technologies | **Catalog:** `cdm_tmforum` (reading `tmf_*` schemas; building `ra_silver`, `ra_gold`, simulated sources in `*_source`) | **Scope:** source ingestion → identity resolution → the 6 reconciliation checks → ML anomaly detection → RA Exceptions Console case workflow → governance & smoke tests → golden outputs.

All scenarios assume a deterministic seed on the fixed `cdm_tmforum` dataset, so counts and dollar totals are reproducible on every run.

---

## 1. Given/When/Then scenarios

### 1.1 Source ingestion (simulated into `*_source` schemas)

| ID | Given | When | Then |
| :---- | :---- | :---- | :---- |
| ING-1 | The 6 source-system generators (Salesforce, Oracle ERP, Refinitiv FX, IronClad CLM, MDM) exist | Ingestion job runs | All 6 `*_source.*` schemas populated and non-empty (e.g., `salesforce_source.Account`, `oracle_erp_source.RA_CUSTOMER_TRX_ALL`) |
| ING-2 | Streaming usage + batch billing sources | Lakeflow Connect / Auto Loader run | Source tables grow or refresh; ingestion metadata (`_ingest_ts`) present; deterministic with fixed seed |
| ING-3 | A re-run with the same seed | Ingestion runs again | Row counts identical (idempotent); matches prior run exactly |
| ING-4 | A malformed record (negative amount, bad date) | Ingestion runs | Row is captured in quarantine/error table, not silently dropped; flagged for DQ layer |

### 1.2 The 6 reconciliation checks (→ `ra_gold.reconciliation_exceptions`)

| ID | Check | Given | When | Then |
| :---- | :---- | :---- | :---- | :---- |
| CHK-1 | Active-circuit-unbilled | An active `logical_resource` (lifecycle_status='active') with no non-zero `bill` line via bridge | Reconciliation runs | An exception with `violation_type='billing_leakage'` or `provisioning_discrepancy`, non-zero `estimated_revenue_impact_amount` |
| CHK-2 | Contract-price mismatch | `commitment.amount` ≠ `commitment.actual_amount` or `offering_price.price_amount` diverges from billed | Reconciliation runs | Exception `violation_type='tariff_mismatch'` or `rating_error`; impact = contracted − billed (per period) |
| CHK-3 | Expired/unauthorized discount | `discount_prod_offer_price_alteration` applied past `discount_expiry` or without `approval_status='approved'` | Reconciliation runs | Exception `violation_type='revenue_recognition_error'` or `policy_violation`; impact = discount value |
| CHK-4 | Usage–billing variance (ML) | Usage series rose materially (2–4× step-up) while billing stayed flat; `mediation_status` ≠ PROCESSED | ML anomaly check runs | Exception `violation_type='usage_reconciliation_gap'` or `mediation_failure` flagged by model |
| CHK-5 | Billing-start-date lag | `order_item.billing_start_date > actual_completion_date` (native ~50% of rows) | Reconciliation runs | Exception `violation_type='provisioning_discrepancy'`; impact = un-billed days × daily rate |
| CHK-6 | Partner-settlement mismatch | `rev_share_reconciliation.variance_amount` non-zero, status `in_dispute` or `open` | Reconciliation runs | Exception `violation_type='partner_settlement_discrepancy'`; impact = variance amount |
| CHK-0 | No false positives | A cleanly-reconciling circuit (no seeded defect in any source) | Reconciliation runs | **No** exception produced for it |

### 1.3 Identity resolution (`ra_gold.service_instance`)

| ID | Given | When | Then |
| :---- | :---- | :---- | :---- |
| IDR-1 | Circuit, contract, billing, invoice keys that share a reference via the bridge | `ra_silver.service_instance` builds | One `service_instance_id` links all four keys; `match_confidence` ≥ 0.8 |
| IDR-2 | A billing line whose `circuit_ref` matches no circuit (orphan) | Pipeline runs | Orphan is quarantined, NOT counted as leakage; does not corrupt other joins |
| IDR-3 | Fuzzy-matched service (site-based) | Pipeline runs | Linked with `match_method='fuzzy_site'` and lower `match_confidence`; surfaced in Detail evidence banner |
| IDR-4 | An unbilled active circuit | Pipeline runs | `invoice_line_id` is NULL on its `service_instance` row (the signal CHK-1 consumes) |

### 1.4 ML anomaly detection (`ra_gold.ml_anomaly` / MLflow)

| ID | Given | When | Then |
| :---- | :---- | :---- | :---- |
| ML-1 | Usage series with seeded 2–4× step-up and flat billing (injected anomalies) | Model scores it | Circuit flagged as anomaly → CHK-4 exception |
| ML-2 | A stable usage/billing series (majority of data) | Model scores it | Not flagged (no exception) |
| ML-3 | Model training | `train_anomaly_model` job runs | Model logged to MLflow with metrics; accuracy/precision recorded; used by reconciliation job |
| ML-4 | Determinism | Re-run with same seed + model version | Same set of CHK-4 exceptions produced |

**Caveat:** source data is statistically uniform/flat (round counts, ~50/50 splits). To make the ML anomaly demo visually compelling, the seed generator injects a handful of sharp usage spikes and billing gaps. Call this out in demo narration: "Real billing data would have more natural variance; we've seeded some obvious anomalies to show detection in action."

### 1.5 RA Exceptions Console case workflow (`ra_gold.exception_case` ↔ `tmf_enterprise.ra_trouble_ticket`)

| ID | Given | When | Then |
| :---- | :---- | :---- | :---- |
| APP-1 | An open violation in New | Marcus clicks "Assign to me" | `ra_trouble_ticket.assigned_to` set; `updated_at` advances |
| APP-2 | An assigned case in New | Marcus sets status → Investigating | Persisted in `ra_trouble_ticket.investigation_status`; queue + detail reflect it |
| APP-3 | Investigating case | Marcus → Recovering, then Recovered (with amount) | Transitions allowed in order; `recovery_amount` captured; dashboard "Recovered" increases |
| APP-4 | Any status | Marcus tries an illegal transition (e.g. New → Recovered) | Blocked; only allowed next states offered |
| APP-5 | WrittenOff | Marcus writes off without a note | Blocked with "Add a reason before writing off." |
| APP-6 | Add note | Marcus adds a note | Appended to `ra_trouble_ticket.description`; visible newest-first |
| APP-7 | Persistence | Case changed, dashboard refreshed | Change reflected after refresh (round-trips through `ra_gold` ↔ `tmf_enterprise`) |

---

## 2. Data-quality expectations (Lakeflow Declarative Pipeline / expectations)

| ID | Table | Expectation | Action |
| :---- | :---- | :---- | :---- |
| DQ-1 | `*_source.*` | Expected row counts within tolerance of seed targets (e.g., ~10K customers, ~100K circuits, ~100K CFS, ~100K product orders) | warn |
| DQ-2 | `ra_silver.dim_circuit` | `circuit_id` NOT NULL and UNIQUE (PK) | drop/fail |
| DQ-3 | `ra_silver.fact_billing` | `invoice_line_id` NOT NULL and UNIQUE (PK); `amount_usd` ≥ 0 | drop |
| DQ-4 | `ra_silver.service_instance` | `service_instance_id` NOT NULL, UNIQUE | fail |
| DQ-5 | `ra_silver.service_instance` | Referential: every non-null `circuit_id` exists in `dim_circuit`; `contract_id` in `dim_contract`; `billing_account_id`/`invoice_line_id` resolve to `fact_billing` | fail on violation |
| DQ-6 | `tmf_resource.resource_usage` | `mediation_status` ∈ {PROCESSED, FAILED, DUPLICATE_DETECTED, SUPPRESSED, PENDING, REPROCESSED}; `usage_date` within expected window | warn/drop on invalid |
| DQ-7 | `ra_gold.reconciliation_exceptions` | `service_instance_id` FK exists in `ra_silver.service_instance`; `violation_type` ∈ seeded enum | fail |
| DQ-8 | `ra_gold.exception_case` (↔ `tmf_enterprise.ra_trouble_ticket`) | `exception_id` FK exists in `reconciliation_exceptions`; `investigation_status` ∈ {New, Investigating, Recovering, Recovered, WrittenOff} | fail |
| DQ-9 | Duplicates | `resource_usage` dedup leaves no duplicate `event_id` in silver; `mediation_status` transitioned cleanly | drop |

**Referential integrity across the `service_instance` bridge** (DQ-5) is the pipeline's most important guarantee — it is what makes every leakage figure traceable and is the join backing the Exception Detail evidence panel.

---

## 3. Security & governance checks

| ID | Given | When | Then |
| :---- | :---- | :---- | :---- |
| SEC-1 | `ra_analysts` role (Marcus) | Reads `ra_gold.*`, `tmf_enterprise.revenue_assurance_*` | SELECT succeeds |
| SEC-2 | `ra_analysts` role | Reads `ra_silver.dim_customer.customer_name` or `tmf_customer.customer.name` (PII) | Value is **masked** (mask function applies per UC tag `pii=true`) |
| SEC-3 | `ra_engineers` role (Priya) | Reads the same PII column | Value is **unmasked** |
| SEC-4 | `ra_execs` role (Dana) | Attempts write to `ra_gold.exception_case` or `tmf_enterprise.ra_trouble_ticket` | Denied (read-only) |
| SEC-5 | App service principal | Writes `ra_gold.exception_case` | Allowed; writes elsewhere in `ra_gold` denied |
| SEC-6 | Any exception | Open Unity Catalog lineage | Traces `ra_gold.reconciliation_exceptions` → `ra_silver.service_instance` → `tmf_*` sources end-to-end |
| SEC-7 | PII columns | Inspect UC tags + mask function | Tagged `pii=true`; mask function bound |

---

## 4. Smoke tests (post-deploy health)

| ID | Check | Pass condition |
| :---- | :---- | :---- |
| SMK-1 | Bundle deploy | `databricks bundle deploy -t prod` exits 0; all resources created |
| SMK-2 | Warehouse | Serverless SQL warehouse reachable; `SELECT 1` returns |
| SMK-3 | Catalog & schemas | `cdm_tmforum` exists; `ra_silver`, `ra_gold`, `*_source` schemas created |
| SMK-4 | Source generator | `simulate_source_systems` job last run = SUCCESS; `*_source.*` tables non-empty and deterministic |
| SMK-5 | Silver pipeline | `ra_medallion_pipeline` (or equivalent medallion DAG) last run = SUCCESS; `ra_silver.service_instance` ≥ 1K rows; expectations pass |
| SMK-6 | Reconciliation job | `ra_reconciliation` last run = SUCCESS; `ra_gold.reconciliation_exceptions` non-empty; golden counts within tolerance (see §5) |
| SMK-7 | Dashboard | AI/BI dashboard loads < 5s; tiles render non-null; KPI totals reconcile to `ra_gold` tables |
| SMK-8 | App | `ra-exceptions-console` status = RUNNING; Queue loads rows; filters work |
| SMK-9 | Genie | Scripted question returns a governed answer; respects masking |
| SMK-10 | Case round-trip | Change a case status via App → visible on dashboard refresh |

---

## 5. Golden outputs (must reproduce)

Seeded violations in `tmf_enterprise.revenue_assurance_violation` total **~10,000 across 12 types**. For a reproducible demo run (e.g., filtered to current month with a fixed seed), target **~600–900 open exceptions**:

| Violation type | Real seeded count (12-type totals) | Demo run target (1-month slice) | Target monthly impact $ |
| :---- | :---- | :---- | :---- |
| mediation_failure | 942 | ~80 | ~$46,000 |
| usage_reconciliation_gap | 941 | ~80 | ~$46,800 |
| revenue_recognition_error | 936 | ~80 | ~$47,100 |
| tariff_mismatch | 916 | ~77 | ~$47,300 |
| provisioning_discrepancy | 910 | ~77 | ~$46,300 |
| partner_settlement_discrepancy | 904 | ~77 | ~$44,500 |
| rating_error | 903 | ~76 | ~$44,800 |
| policy_violation | 903 | ~76 | ~$45,800 |
| fraud_indicator | 884 | ~75 | ~$43,700 |
| configuration_error | 867 | ~74 | ~$44,000 |
| billing_leakage | 453 | ~39 | ~$22,800 |
| data_quality_issue | 441 | ~37 | ~$22,900 |
| **TOTAL** | **~10,000** | **~900 (illustrative)** | **~$1.85M/mo (illustrative)** |

**Real vs. Demo numbers:**
- **Real catalog data:** `tmf_enterprise.revenue_assurance_violation` contains ~10K pre-seeded violations totaling ~$540M estimated impact across the full dataset (2018–2025).
- **Demo run (illustrative):** A 1-month slice with the fixed seed produces ~900 open violations totaling ~$1.85M — chosen as a scale appropriate for the Lumen pitch ($250M–$312M / 2–2.5% leakage).

Assertions:

- `SELECT COUNT(*) FROM cdm_tmforum.ra_gold.reconciliation_exceptions WHERE investigation_status IS NULL OR investigation_status='New'` ≈ 900 (±5% tolerance with fixed seed).  
- `SELECT SUM(estimated_revenue_impact_amount) FROM ra_gold.reconciliation_exceptions` ≈ $1.85M (for demo-slice date range).  
- Per-`violation_type` counts match the table above within 5% tolerance.  
- Dashboard "Total impact" tile equals that `SUM` (dashboard ↔ table reconcile).  
- CHK-0: circuits with no seeded defect produce zero exceptions.
- **Real scale callout in narration:** "This dataset shows ~$1.85M/month in detected leakage across Lakelink Fiber. The actual Lumen case study estimated $250M–$312M annually — we've seeded a proportional subset here for a focused demo."

---

## 6. Definition of Done

The demo passes when, from a clean workspace, a coding agent can execute the following and have every item succeed:

1. `databricks bundle deploy -t prod` → SMK-1..SMK-3 pass.  
2. Run source-gen + `ra_medallion_pipeline` + ML + reconciliation jobs → SMK-4, SMK-5, SMK-6 pass; ING-1..ING-4 and DQ-1..DQ-9 pass.  
3. All 6 reconciliation scenarios (CHK-1..CHK-6) produce their exceptions; CHK-0 produces none.  
4. Identity-resolution scenarios IDR-1..IDR-4 hold; referential integrity DQ-5 passes.  
5. ML scenarios ML-1..ML-4 hold; anomaly flags are deterministic with seed.  
6. Golden outputs in §5 reproduced within 5% tolerance; dashboard total reconciles to the table; narration calls out the real vs. demo-scale distinction.  
7. Security checks SEC-1..SEC-7 pass (masking, grants, lineage).  
8. App workflow APP-1..APP-7 pass; a case status change persists and appears on dashboard refresh (SMK-10).  
9. Genie answers the scripted questions (SMK-9); governed by UC.

When all nine hold on a fresh deploy with the fixed seed from `cdm_tmforum`, the demo is **Done** and safe to present.
