# Data Source Assessment — `cdm_tmforum` vs. Revenue Assurance Demo Requirements

**Demo:** Revenue Assurance Lakehouse for Lumen Technologies
**Workspace:** demo-workspace (`demo` CLI profile)
**Catalog evaluated:** `cdm_tmforum` — TM Forum SID Common Data Model
**Assessed:** 2026-08-21

---

## Verdict

**~90% of the demo's data already exists in `cdm_tmforum`.** Every mapped table is
populated (1K–100K rows) and billing history spans **2018–2025**. This is a fully-built
TM Forum SID model that natively covers the revenue-assurance domain — *including
pre-seeded leakage, a native exceptions table, a case-management entity, an RA control
framework, and 71 pre-built metric views.*

The work shifts from **"generate synthetic data"** to **"build reconciliation logic +
serving surfaces on top of real data."** The previously planned Synthetic-Data
Specification is now largely redundant.

### Catalog structure

| Schema | Role | Relevance |
|---|---|---|
| `tmf_resource` | Network assets: circuits, usage records, alarms, anomalies | Provisioning + usage/CDR + mediation |
| `tmf_service` | CFS/RFS service instances, service orders, usage, SLAs | **Identity-resolution bridge** |
| `tmf_product` | Catalog, offerings, pricing, rating logic, orders, usage | Pricing / rating / orders |
| `tmf_customer` | Customer identity, billing accounts, bills, discounts, quotes, dunning, disputes | Billing + CRM + CPQ + AR |
| `tmf_businesspartner` | Partner settlement, revenue sharing, reconciliation | Partner/interconnect settlement |
| `tmf_enterprise` | **Revenue Assurance ABEs** (controls, KPIs, violations, trouble tickets), orders | Native RA gold layer |
| `tmf_marketsales` | Leads, opportunities, campaigns, commissions, policy framework | Sales pipeline (peripheral) |
| `tmf_shared` | Cross-domain shared entities | Supporting |
| `_metrics` | 71 pre-built metric views (gold KPI layer) | Dashboards / KPIs |
| `ccd_intelligence` | OTEL traces/logs/metrics (separate "Task A") | Not RA-relevant |

> **Ownership note:** most `tmf_*` schemas are owned by owner@example.com. The
> `ccd_intelligence` schema comment states *"Source tmf_* schemas are read-only."* Build
> our layer in a **separate `lumen_ra` catalog** that reads from `cdm_tmforum.tmf_*`; do
> not write back.

---

## Requirement → available data → verdict

Verdicts: ✅ **Use** (data exists, use directly) · 🔧 **Build** (logic/surface to build on
existing data — not simulation) · 💉 **Simulate/Inject** (net-new data required).

| Demo requirement | TM Forum table(s) | Rows | Verdict |
|---|---|---|---|
| **Network provisioning / circuit inventory** | `tmf_resource.logical_resource` (`bandwidth_mbps`, `activation_date`, `deactivation_date`, `lifecycle_status`), `equipment`, `connection_point`, `resource_configuration`; `tmf_service.resource_facing_service` | 100K / ~11K active | ✅ Use |
| **Usage telemetry (CDR/IPDR/bandwidth)** | `tmf_resource.resource_usage`, `tmf_service.service_usage`, `tmf_product.product_usage` | 10K–100K | ✅ Use |
| **Mediation layer** | `tmf_resource.resource_usage.mediation_status` (FAILED / DUPLICATE_DETECTED / SUPPRESSED / PENDING / REPROCESSED / PROCESSED), `charging_type` | — | ✅ Use (mediation failures explicitly modeled) |
| **Billing & rating / invoice lines** | `tmf_customer.bill` (usage/recurring/one-time/outstanding/write-off amounts, periods, dates), `applied_customer_billing_charge` / `_discount` / `_product_usage_rate` | 10K + | ✅ Use |
| **CRM contracts & pricing** | `tmf_customer.commitment` (`amount` vs `actual_amount`, `variance_amount`, `breach_date`, `fulfillment_status`), `service_level_agreement`, `customer`; `tmf_product.offering_price` (`valid_from`/`valid_to`, `approval_status`) | 10K–100K | ✅ Use |
| **CPQ quotes & discount approvals** | `tmf_customer.sales_quote`, `customer_quote`; `tmf_product.discount_prod_offer_price_alteration` (validity + approval); `applied_customer_billing_discount` | 1K–10K | ✅ Use |
| **Order management & fulfillment** | `tmf_product.order_item` (`billing_start_date`, `actual_completion_date`, `contract_start/end_date`, `provisioning_status`, price/discount amounts), `tmf_service.service_order_item` / `fulfillment` | 100K | ✅ Use |
| **AR aging / collections** | `tmf_customer.payment`, `dunning_case`, `dunning_write_off`, `billing_account_balance`, `billing_dispute` | 1K–100K | ✅ Use |
| **Partner / interconnect settlement** | `tmf_businesspartner.rev_share_reconciliation` (`operator_billed_amount` vs `partner_reported_amount`, `variance_amount`, `status`), `party_settlement`, `rev_share_recon_discrepancy` | 1K–10K | ✅ Use |
| **Customer / account hierarchy (MDM)** | `tmf_customer.customer`, `customer_billing_account`; `tmf_enterprise.billing_account` | 10K | ✅ Use |
| **Canonical `service_instance` bridge** ("the hard problem") | Native FK chain: `logical_resource → resource_facing_service → customer_facing_service → customer / product / billing_account / service / bill` | — | 🔧 Build (materialize the join — keys exist, no simulation) |
| **`reconciliation_exceptions` (leakage)** | `tmf_enterprise.revenue_assurance_violation` — 12 seeded `violation_type`s, `estimated`/`actual_revenue_impact_amount`, `recovery_amount`, `write_off_amount`, `remediation_status` | 10K | ✅ Use + 🔧 build live detection |
| **`exception_case` (case management)** | `tmf_enterprise.ra_trouble_ticket` (`service_id`, `estimated_revenue_impact_amount`, `actual_revenue_recovery_amount`, `investigation_status`, `related_service_now_incident_number`) | 10K | ✅ Use |
| **`leakage_kpis`** | `_metrics.*` — incl. `enterprise_revenue_assurance_violation` / `_control` / `_assessment`, `customer_customer_billing_revenue`, `businesspartner_rev_share_reconciliation` | 71 views | ✅ Use |
| **RA control framework** | `tmf_enterprise.revenue_assurance_control` (detective / preventive / corrective) | 1K | ✅ Use |

---

## The 6 reconciliation checks — all supported

Each check has **both** supporting transactional data **and** a matching pre-seeded
outcome in `revenue_assurance_violation`.

| Check | Evidence in data | Pre-seeded violation type |
|---|---|---|
| 1. Active-circuit-unbilled | `logical_resource.lifecycle_status='active'` (~11K) joined through RFS→CFS→`bill` | `provisioning_discrepancy` / `billing_leakage` |
| 2. Contract-price mismatch | `commitment.amount` vs `actual_amount`/`variance_amount`; `offering_price.price_amount` | `tariff_mismatch` / `rating_error` |
| 3. Expired/unauthorized discount | `discount_prod_offer_price_alteration` validity + `offering_price.approval_status`; `applied_customer_billing_discount` | `revenue_recognition_error` / `policy_violation` |
| 4. Usage–billing variance | `resource_usage` / `service_usage` vs `bill.usage_charges_amount`; `mediation_status` | `usage_reconciliation_gap` / `mediation_failure` |
| 5. Billing-start-date lag | `order_item`: ~50% have `billing_start_date > actual_completion_date` | `provisioning_discrepancy` |
| 6. Partner-settlement mismatch | `rev_share_reconciliation.variance_amount` with `in_dispute`/`open` status | `partner_settlement_discrepancy` |

### Seeded leakage taxonomy (`revenue_assurance_violation`, 10K rows)

| violation_type | count | est. impact | recovered |
|---|---|---|---|
| mediation_failure | 942 | $46.0M | $47.9M |
| usage_reconciliation_gap | 941 | $46.8M | $46.8M |
| revenue_recognition_error | 936 | $47.1M | $46.1M |
| tariff_mismatch | 916 | $47.3M | $45.0M |
| provisioning_discrepancy | 910 | $46.3M | $45.7M |
| partner_settlement_discrepancy | 904 | $44.5M | $45.7M |
| rating_error | 903 | $44.8M | $45.4M |
| policy_violation | 903 | $45.8M | $47.1M |
| fraud_indicator | 884 | $43.7M | $44.3M |
| configuration_error | 867 | $44.0M | $43.4M |
| billing_leakage | 453 | $22.8M | $22.8M |
| data_quality_issue | 441 | $22.9M | $22.4M |

Total estimated impact ≈ **$540M** — in the ballpark of the $250M–$312M Lumen leakage
story, and tunable by filtering violation types / date range.

---

## What actually needs to be built or simulated (~10%)

| Item | Why | Type |
|---|---|---|
| **Reconciliation logic** — the 6 checks as SQL / Lakeflow Declarative Pipelines | Data + pre-seeded violations exist, but *showing* detection means building the queries that derive exceptions from the raw tables | 🔧 Build (not simulate) |
| **ML anomaly detection + `ai_forecast`** | Training data + 8yr billing history exist. **Caveat:** data is statistically uniform/flat (round counts, ~50/50 splits) — inject a handful of sharp anomalies so the ML scene is compelling | 🔧 Build + 💉 small inject |
| **Raw landing files / stream** for a live Lakeflow Connect / Auto Loader ingestion beat | Data is already *landed* in UC; a live ingestion demo needs source files or a stream | 💉 Simulate (only if a live ingestion beat is wanted) |
| **Violation → evidence drill-down enrichment** | `revenue_assurance_violation` links via `ra_trouble_ticket.service_id`, not directly to the exact invoice/circuit row — verify/build the path for "click exception → see offending circuit + invoice" | 🔧 Build (light) |
| **Serving surfaces** — Genie space, AI/BI dashboard, RA Exceptions Console app | Standard build on top of the above | 🔧 Build |

---

## Caveats & follow-ups

1. **Data realism.** The data is generated and statistically flat — excellent for
   correctness/reconciliation demos, weaker for showcasing subtle ML anomaly detection.
   Inject a few dramatic anomalies for the ML scene.
2. **Referential integrity.** Join keys are present across the bridge chain; spot-check
   that `logical_resource → RFS → CFS → bill` resolves end-to-end before committing the
   build plan.
3. **Read-only source.** Build gold/silver in a separate `lumen_ra` catalog; treat
   `cdm_tmforum.tmf_*` as read-only inputs.
4. **Artifact impact.** The **Synthetic-Data Specification** is now largely redundant
   (reduces to anomaly injection + optional ingestion source). The **Domain Model & Data
   Contract** should be repointed at real `cdm_tmforum` tables instead of
   tables-to-be-generated.

---

## Appendix — how this was assessed (`demo` profile)

- `databricks schemas list cdm_tmforum` — enumerated 10 schemas
- `databricks tables list cdm_tmforum <schema>` — enumerated tables per schema
- Row counts via `experimental aitools tools query` (UNION ALL COUNT across ~57 tables)
- `information_schema.columns` — inspected join keys / amount / date columns on bridge + RA tables
- Probe queries: `revenue_assurance_violation` type distribution + impact; `revenue_assurance_control` types; `rev_share_reconciliation` status/variance; `resource_usage.mediation_status`; `order_item` billing-start-lag; `logical_resource.lifecycle_status`; `bill` period span (2018–2025)
