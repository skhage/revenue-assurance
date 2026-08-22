# Revenue Assurance Demo — Artifacts (scrutinized)

Markdown recreations of the 10 planning artifacts originally drafted in Google Docs with
GPT models. Each has been **scrutinized against the real data landscape** (the
`cdm_tmforum` catalog we profiled on the `demo` workspace, plus the simulated source
systems) and against public documentation via web research, then corrected. Every doc
opens with a **Scrutiny summary** callout listing what changed and why.

Companion analysis: [`../data-source-assessment.md`](../data-source-assessment.md).

## Index
| # | Artifact | File |
|---|---|---|
| 00 | Problem Overview / Research | `00-problem-overview.md` |
| 01 | Product Requirements & Build Contract | `01-product-requirements.md` |
| 02 | Capability-to-Scene Matrix | `02-capability-matrix.md` |
| 03 | Domain Model & Data Contract | `03-domain-model.md` |
| 04 | Source-Data & Simulation Spec | `04-source-data-spec.md` |
| 05 | Repository Blueprint | `05-repository-blueprint.md` |
| 06 | Deployment Contract | `06-deployment-contract.md` |
| 07 | UI Interaction Specs | `07-ui-specs.md` |
| 08 | Test Plan & Acceptance Criteria | `08-test-plan.md` |
| 09 | Demo Operations Runbook | `09-runbook.md` |
| 10 | Decision Log | `10-decision-log.md` |

---

## GROUND TRUTH — the facts every artifact must reflect

The original docs predate our data discovery. The corrections below apply across **all**
artifacts and are the single source of truth for the rewrite.

### 1. Who is who (naming)
- **Lumen Technologies** = the **prospect / audience** the demo is *pitched to* (a ~$12.5bn
  B2B broadband & enterprise-networking operator). Lumen data is **not** used.
- **Lakelink Fiber** (Lakelink Fiber Communications, Inc.) = the **fictional operator whose
  data the demo shows**. All demo data, branding, and unstructured documents are Lakelink
  Fiber. (The Databricks logo is used as the Lakelink mark per demo direction.)
- ❌ The original docs conflate the two — they call the *data company* "Lumen" and invent a
  `lumen_ra` catalog. Fix: the story is "we built a Lakelink Fiber revenue-assurance
  lakehouse to show Lumen what theirs could look like."

### 2. The data already exists — do not generate a bronze layer
- Real data lives in the **`cdm_tmforum`** catalog (a fully-populated **TM Forum SID Common
  Data Model**) on the **`demo-workspace`** workspace (CLI profile `demo`).
- Every relevant table is populated (1K–100K rows); **billing history spans 2018–2025**.
- ❌ The original Domain Model / Synthetic-Data docs invent a `lumen_ra.bronze.*` layer
  (`network_provisioning`, `usage_telemetry`, `crm_contracts`, …) and a from-scratch Faker
  generator. **That layer does not need to be built** — the equivalent data is already in
  `cdm_tmforum`. The demo *builds reconciliation logic on top*, it does not generate raw data.

#### Real `cdm_tmforum` schemas and the tables that matter
| Requirement | Real table(s) | Approx rows |
|---|---|---|
| Network provisioning / circuits | `tmf_resource.logical_resource` (`bandwidth_mbps`, `activation_date`, `lifecycle_status`), `tmf_service.resource_facing_service` | 100K |
| Usage / CDR + **mediation status** | `tmf_resource.resource_usage` (`mediation_status`=FAILED/DUPLICATE_DETECTED/SUPPRESSED…), `tmf_service.service_usage` | 10K–100K |
| Billing / invoice lines | `tmf_customer.bill` (usage/recurring/one-time/write-off amounts), `applied_customer_billing_*` | 10K+ |
| CRM contracts & pricing | `tmf_customer.commitment` (`amount` vs `actual_amount`, `variance_amount`), `service_level_agreement`, `tmf_product.offering_price` | 10K–100K |
| CPQ quotes / discounts | `tmf_customer.sales_quote`, `tmf_product.discount_prod_offer_price_alteration` | 1K–10K |
| Orders / fulfillment | `tmf_product.order_item` (`billing_start_date`, `actual_completion_date`, `provisioning_status`), `tmf_service.service_order_item`/`fulfillment` | 100K |
| AR / collections | `tmf_customer.payment`, `dunning_case`, `dunning_write_off`, `billing_account_balance` | 1K–100K |
| Partner settlement | `tmf_businesspartner.rev_share_reconciliation` (`operator_billed_amount` vs `partner_reported_amount`, `variance_amount`), `party_settlement` | 1K–10K |
| Customer / account master (MDM) | `tmf_customer.customer` (~10K; rich: `segment_classification`, `arpu_tier`, `credit_class`, `external_customer_code`), `customer_billing_account` | 10K |
| **Identity bridge (native!)** | `logical_resource → resource_facing_service → customer_facing_service → customer/product/billing_account → bill` | — |
| **Native RA layer** | `tmf_enterprise.revenue_assurance_violation` (10K, **12 seeded violation types**, `estimated_revenue_impact_amount`/`recovery_amount`), `revenue_assurance_control` (1K), `ra_trouble_ticket` (10K, case entity w/ `service_id`, ServiceNow #), `revenue_assurance_assessment` | 1K–10K |
| Pre-built KPIs | `_metrics.*` — 71 metric views incl. `enterprise_revenue_assurance_violation/control/assessment` | 71 views |

- **`tmf_*` schemas are READ-ONLY** (per the catalog's own comment). Build the RA layer in
  **new schemas** in `cdm_tmforum` — recommended `ra_silver` (conformed + `service_instance`
  bridge) and `ra_gold` (reconciliation exceptions, KPIs, forecast, cases) — reading from
  `tmf_*` and the `*_source` schemas. **Do not** use the invented `lumen_ra` catalog.

### 3. Source systems are simulated separately (already specced)
A generator notebook (`simulate_source_systems`) lands raw upstream systems, keyed to the
real golden customers, in these schemas — use these real provider names, not invented ones:
`salesforce_source` (Account, Contract, `SBQQ__Quote__c`, …), `oracle_erp_source`
(`RA_CUSTOMER_TRX_ALL`, `AR_PAYMENT_SCHEDULES_ALL`, `GL_JE_LINES`, ASC-606 rev-rec),
`refinitiv_fx_source` (`GL_DAILY_RATES`), `ironclad_clm_source` (contract PDFs),
`mdm_source` (`customer_crosswalk`).

### 4. The 6 reconciliation checks map to real data + native violations
Each deterministic check has supporting columns **and** a pre-seeded `revenue_assurance_violation`
type. `gold.reconciliation_exceptions` ≈ `tmf_enterprise.revenue_assurance_violation`;
`gold.exception_case` ≈ `tmf_enterprise.ra_trouble_ticket`.

| Check | Real evidence | Native violation_type |
|---|---|---|
| Active-circuit-unbilled | `logical_resource.lifecycle_status='active'` w/ no `bill` via bridge | `provisioning_discrepancy` / `billing_leakage` |
| Contract-price mismatch | `commitment.amount` vs `actual_amount`/`variance_amount`; source: `salesforce_source.contract_line_item.UnitPrice` | `tariff_mismatch` / `rating_error` |
| Expired/unauthorised discount | `discount_prod_offer_price_alteration`; source: CPQ `SBQQ__` + `discount_approval__c` | `revenue_recognition_error` / `policy_violation` |
| Usage–billing variance | `resource_usage`/`service_usage` vs `bill.usage_charges_amount`; `mediation_status` | `usage_reconciliation_gap` / `mediation_failure` |
| Billing-start-date lag | `order_item.billing_start_date` > `actual_completion_date` (~50% of rows) | `provisioning_discrepancy` |
| Partner-settlement mismatch | `rev_share_reconciliation.variance_amount`, status `in_dispute`/`open` | `partner_settlement_discrepancy` |

### 5. Numbers — use real, not invented
- ❌ Original: "~2,000 customers, ~25,000 circuits, ~2.25M usage rows, ~910 exceptions,
  **~$1.9M/month** leakage."
- ✅ Real: **~10,000 customers**, **~100,000 circuits** (`logical_resource`), ~100K CFS/RFS,
  ~100K product orders, **~10,000 RA violations** across 12 types totalling **~$540M
  estimated impact** (tunable by filtering type/date). Keep Lumen's **business case**
  ($250M–$312M / 2–2.5%) as the *pitch* framing, distinct from the demo dataset's seeded figure.

### 6. Cloud / deployment
- Deploy to the actual **`demo-workspace`** workspace via the `demo` profile. ❌ Do **not**
  assert "Azure-first" as fact — the original docs assumed Azure "mirroring Rogers." Keep the
  Rogers Communications lakehouse story as *narrative reference only*; state cloud as
  "the demo FEVM workspace (confirm cloud at deploy time)."
- IaC via **Databricks Asset Bundles** in the `revenue-assurance` repo is still correct;
  teardown drops only the **new** `ra_*`/`*_source` schemas + app + jobs, never `tmf_*`.

### 7. Data realism caveat (affects ML/forecast scenes)
The `cdm_tmforum` data is statistically **flat/uniform** (round counts, ~50/50 splits) —
fine for deterministic reconciliation, weak for a compelling ML anomaly demo. The demo
should **inject a handful of sharp anomalies** (via the source generator) for the ML/
`ai_forecast` scenes. Call this out honestly wherever ML is described.

### 8. Databricks capabilities — verify current names via web research
The capability set is broadly right; confirm current product naming when rewriting:
Lakeflow Connect (managed ingestion), **Lakeflow Declarative Pipelines** (formerly DLT),
Delta Lake, Unity Catalog (governance/lineage/masking), Databricks Workflows/Jobs
(serverless), Databricks SQL + **AI/BI dashboards & Genie**, MLflow, the `ai_forecast` SQL
function, and **Databricks Apps**. Flag anything that has been renamed or is not GA.

---

## Rewrite rules
1. Keep each artifact's original purpose and useful structure; correct the facts per the
   ground truth above.
2. Open every doc with a `> **Scrutiny summary**` blockquote: 3–8 bullets of what was
   wrong → what's now correct, citing web sources inline where a claim was web-verified.
3. Reference **real** `cdm_tmforum` / `*_source` tables and columns, never invented ones.
4. Preserve personas (Dana Whitfield, Marcus Chen, Priya Nair) and the RA Exceptions Console.
5. Where the original asserts a fabricated number, replace with the real figure or clearly
   label it an illustrative target.
