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
| 11 | Metric Views & Semantic Layer | `11-metric-views.md` |
| 12 | Domains & Governed Tags | `12-domains-and-tags.md` |
| 13 | Glossary (UC Pages) | `13-glossary.md` |

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

- **`tmf_*` schemas are READ-ONLY** (per the catalog's own comment). The RA layer is built as a
  **single new schema `cdm_tmforum.revenue_assurance`** (owned by the demo user), reading from
  `tmf_*` and the `*_source` schemas. It holds **silver** materialized views (one per
  reconciliation check) and **gold** materialized views (serving surfaces):
  - **silver:** `silver_contract_price_reconciliation`, `silver_discount_authorization_check`,
    `silver_fx_rate_validation`, `silver_ar_aging_analysis`, `silver_revenue_recognition_check`,
    `silver_doc_intelligence_contracts`, `silver_doc_intelligence_invoices`.
  - **gold:** `gold_leakage_summary` (unified exception register — the queue/KPI source),
    `gold_reconciliation_scorecard` (per-customer health score + risk tier),
    `gold_anomaly_scores` (ML), `gold_revenue_forecast_anomalies` (`ai_forecast`).
- ❌ Earlier drafts proposed a two-schema `ra_silver`/`ra_gold` split with invented
  `reconciliation_exceptions` / `exception_case` / `leakage_kpis` / `revenue_forecast` tables and a
  materialized `service_instance` identity bridge (and, older still, a `lumen_ra` catalog). The real
  build uses the **single `revenue_assurance` schema** and the table names above; checks join the
  `*_source` systems to `tmf_*` directly rather than through a materialized bridge.
  **Canonical case-management state lives in Lakebase Postgres** (schema `ra`: `ra.cases`,
  `ra.case_notes`), owned by the RA Exceptions Console app. A retryable outbox projects current state
  to Delta `workflow_case_state`; warehouse consumers use `gold_exception_workflow`, never the
  projection as a write authority (see §4 and artifacts 06–07).

### 3. Source systems are simulated separately (already specced)
A generator notebook (`simulate_source_systems`) lands raw upstream systems, keyed to the
real golden customers, in these schemas — use these real provider names, not invented ones:
`salesforce_source` (Account, Contract, `SBQQ__Quote__c`, …), `oracle_erp_source`
(`RA_CUSTOMER_TRX_ALL`, `AR_PAYMENT_SCHEDULES_ALL`, `GL_JE_LINES`, ASC-606 rev-rec),
`refinitiv_fx_source` (`GL_DAILY_RATES`), `ironclad_clm_source` (contract PDFs),
`mdm_source` (`customer_crosswalk`).

### 4. The reconciliation checks map to real source data → `gold_leakage_summary`
Each check is a **silver materialized view** over the simulated `*_source` systems (joined to the
`tmf_*` golden data). Their flagged rows are unioned into **`gold_leakage_summary`** — the unified
exception register that backs the queue and KPIs (~48K rows, ~$601M at risk; columns `check_type`,
`severity`, `amount_at_risk`, `account_name`, `reference_id`, `source_table`, `detection_method`,
`known_leakage_flag`). Per-customer health rolls up into `gold_reconciliation_scorecard`.

| Silver check (materialized view) | Real evidence | `check_type` in `gold_leakage_summary` |
|---|---|---|
| `silver_contract_price_reconciliation` | `salesforce_source.contract_line_item.UnitPrice` vs `tmf_customer.bill` | `contract_price_mismatch` |
| `silver_discount_authorization_check` | `salesforce_source.sbqq__quoteline__c` vs `sbqq__quote__c.discount_approval__c` | `unauthorized_discount`, `expired_quote_active` |
| `silver_fx_rate_validation` | `oracle_erp_source.ra_customer_trx_all` vs Refinitiv mid-market rates (>1% dev) | (FX deviation; not unioned into the register) |
| `silver_ar_aging_analysis` | `oracle_erp_source.ar_payment_schedules_all` (DSO, 90+ days overdue) | `ar_collection_risk` |
| `silver_revenue_recognition_check` | ASC-606 `oracle_erp_source.revenue_recognition_schedule` vs `gl_je_lines` | `rev_rec_timing_mismatch` |
| `silver_doc_intelligence_contracts` | `ai_parse_document` + `ai_extract` on `ironclad_clm_source` contract PDFs vs system | `doc_contract_mismatch` |
| `silver_doc_intelligence_invoices` | `ai_parse_document` + `ai_extract` on invoice PDFs vs system | `doc_invoice_mismatch` |

- ❌ Earlier drafts listed a *different* six checks (active-circuit-unbilled, usage–billing variance,
  billing-start-lag, partner-settlement) and equated `gold.reconciliation_exceptions` ≈
  `revenue_assurance_violation` / `gold.exception_case` ≈ `ra_trouble_ticket`. The built model uses
  the **seven silver checks above → `gold_leakage_summary`**, leaning on document-intelligence (AI)
  plus AR-aging, FX, and rev-rec timing rather than the network-provisioning checks. The native
  `tmf_enterprise.revenue_assurance_violation` / `ra_trouble_ticket` tables remain available as
  context, but the app's **case state authority lives in Lakebase** (schema `ra`), not a writable
  Delta `exception_case`; Delta receives a read-only workflow projection for dashboard and Genie.

### 5. Numbers — use real, not invented
- ❌ Original: "~2,000 customers, ~25,000 circuits, ~2.25M usage rows, ~910 exceptions,
  **~$1.9M/month** leakage."
- ✅ Real: **~10,000 customers**, **~100,000 circuits** (`logical_resource`), ~100K CFS/RFS,
  ~100K product orders, **~10,000 RA violations** across 12 types totalling **~$540M
  estimated impact** (tunable by filtering type/date). Keep Lumen's **business case**
  ($250M–$312M / 2–2.5%) as the *pitch* framing, distinct from the demo dataset's seeded figure.
- The **derived** `revenue_assurance.gold_leakage_summary` register (what the app and dashboard
  actually query) totals **~48K exceptions / ~$601M at risk** across 7 `check_type`s — AR-collection
  risk dominates, followed by rev-rec timing and unauthorized discounts.

### 6. Cloud / deployment
- Deploy to the actual **`demo-workspace`** workspace via the `demo` profile. ❌ Do **not**
  assert "Azure-first" as fact — the original docs assumed Azure "mirroring Rogers." Keep the
  Rogers Communications lakehouse story as *narrative reference only*; state cloud as
  "the demo FEVM workspace (confirm cloud at deploy time)."
- IaC via **Databricks Asset Bundles** in the `revenue-assurance` repo is still correct; the
  **RA Exceptions Console** app is built on **AppKit** (React/TypeScript) — reads via a SQL warehouse
  over `gold_exception_workflow`, writes canonical case state to **Lakebase**, and projects it through
  a transactional outbox to Delta for dashboard/Genie consumers. Teardown drops only the **new**
  `revenue_assurance`/`*_source` schemas, the Lakebase project (`ra` schema), the app, and jobs —
  never `tmf_*`.

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

### 9. Semantic / governance layer (artifacts 11–13)
The demo's thesis is that Sales/Marketing/Ops/Finance use the **same words for different things**,
and RA reconciles across them. This is governed with **Unity Catalog Business Semantics**:
**Metric Views** (per-domain KPIs + `synonyms`), **Domains & Subdomains** (each backed by a
`domain` **governed tag**; assets tagged in), and **Pages** (the business glossary Genie cites).
See [`11-metric-views.md`](11-metric-views.md), [`12-domains-and-tags.md`](12-domains-and-tags.md),
and [`13-glossary.md`](13-glossary.md). Recovery-rate as a governed metric needs a Lakebase→Delta
sync first (case state lives in Lakebase, which metric views can't read).

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
