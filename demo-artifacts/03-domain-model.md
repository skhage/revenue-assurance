# RA Demo — Domain Model & Data Contract

> **Scrutiny summary**
> - ❌ **WRONG:** Invented `lumen_ra.bronze.*` tables + from-scratch Faker generation. **FIXED:** Data already exists in `cdm_tmforum.tmf_*` schemas (TM Forum SID Common Data Model, fully populated). No bronze layer to build.
> - ❌ **WRONG:** Scales were ~2K customers, ~25K circuits. **FIXED:** Real scales are ~10K customers, ~100K circuits, ~100K service orders, with 2018–2025 billing history per data-source-assessment.md.
> - ❌ **WRONG:** Invented source tables. **FIXED:** Reference real `tmf_resource.logical_resource` (circuits), `tmf_service.resource_facing_service` / `customer_facing_service` (identity bridge), `tmf_customer.bill`/`commitment`/`sales_quote`, `tmf_product.order_item`, `tmf_businesspartner.rev_share_reconciliation`, and pre-seeded `tmf_enterprise.revenue_assurance_violation` (10K rows, 12 violation types, ~$540M impact).
> - ❌ **WRONG:** Catalog is `lumen_ra` with read-write bronze/silver/gold. **FIXED:** Build only `ra_silver` and `ra_gold` schemas in `cdm_tmforum` (per README ground truth); `tmf_*` schemas are read-only. Source systems (salesforce_source, oracle_erp_source, etc.) are already specced separately.
> - ✅ **KEPT:** `service_instance` bridge is the correct canonical identity pattern — now built by materializing the native FK chain `logical_resource → RFS → CFS → customer/product/billing_account → bill`.
> - ✅ **KEPT:** All 6 reconciliation checks, personas (Dana Whitfield, Marcus Chen, Priya Nair), RA Exceptions Console app.

**Demo:** Revenue Assurance Lakehouse for Lakelink Fiber (Lumen pitch audience)  
**Catalog:** `cdm_tmforum` (TM Forum SID) + new `ra_silver` / `ra_gold` schemas  
**Workspace:** demo-workspace (`demo` CLI profile)  
**Purpose:** Define every entity, its schema, keys, PII classification, and the source→target flow so pipelines, reconciliation checks, ML, dashboards, and the app are all built against one coherent contract.

---

## 1. Entity-relationship overview

The whole demo hinges on **identity resolution**: each source system uses a different key, and leakage lives in the gaps between them. `ra_silver.service_instance` is the canonical bridge that stitches them into one auditable unit.

```
                     cdm_tmforum.tmf_* (read-only, pre-populated)
  logical_resource  resource_facing_service  customer_facing_service  bill
  commitment  sales_quote  order_item  revenue_assurance_violation  ra_trouble_ticket
                                     │  materialize + bridge
                                     ▼
                         ra_silver (conformed + identity-resolved)
   dim_customer ─┐        dim_circuit ─┐        dim_contract ─┐
                 │                     │                      │
                 └──────────────►  service_instance  ◄────────┘     
            (circuit_id ↔ contract_id ↔ billing_account_id ↔ invoice_line_id)
                                     │  reconcile (6 checks) + ML
                                     ▼
                         ra_gold (serving)
   reconciliation_exceptions   leakage_kpis   revenue_forecast   exception_case
```

**Grain summary**

| Entity | Grain (one row =) |
| :---- | :---- |
| `ra_silver.dim_customer` | one customer/account (SCD2 versioned) from `tmf_customer.customer` |
| `ra_silver.dim_contract` | one contracted service line from `tmf_customer.commitment` |
| `ra_silver.dim_circuit` | one provisioned circuit from `tmf_resource.logical_resource` |
| `ra_silver.fact_usage` | one circuit-day of usage from `tmf_resource.resource_usage` / `tmf_service.service_usage` |
| `ra_silver.fact_billing` | one invoice line from `tmf_customer.bill` / `applied_customer_billing_*` |
| `ra_silver.service_instance` | one resolved service (circuit↔contract↔billing↔invoice, native FK chain) |
| `ra_gold.reconciliation_exceptions` | one detected leakage exception (or pre-seeded row from `tmf_enterprise.revenue_assurance_violation`) |
| `ra_gold.exception_case` | one case (workflow state) from or linked to `tmf_enterprise.ra_trouble_ticket` |

---

## 2. Column-level schemas

All entities below materialize or conform existing `cdm_tmforum.tmf_*` columns. Cardinality from data-source-assessment.md.

### ra_silver.dim_customer *(source: `tmf_customer.customer` + `customer_billing_account`)*

| Column | Type | Description | PII |
| :---- | :---- | :---- | :---- |
| customer_id | STRING | Customer identifier (PK) | — |
| external_customer_code | STRING | External reference code | — |
| customer_name | STRING | Legal customer name | **PII** |
| tax_identifier | STRING | Tax ID / regulatory identifier | **PII** |
| segment_classification | STRING | `Enterprise`, `Mid-Market`, `Public Sector` (from cdm) | — |
| arpu_tier | STRING | Account value tier | — |
| credit_class | STRING | Credit risk classification | — |
| billing_account_id | STRING | FK → customer_billing_account | — |
| parent_account_id | STRING | Parent in hierarchy (MDM), nullable | — |
| region | STRING | Geographic region | — |
| industry | STRING | Customer vertical | — |
| effective_from | DATE | SCD2 version start | — |
| effective_to | DATE | SCD2 version end (NULL = current) | — |

### ra_silver.dim_circuit *(source: `tmf_resource.logical_resource` + `resource_facing_service`)*

| Column | Type | Description | Key |
| :---- | :---- | :---- | :---- |
| circuit_id | STRING | Network resource identifier (PK) | **PK** |
| resource_facing_service_id | STRING | FK to RFS entity | — |
| customer_id | STRING | Owning customer | FK → dim_customer |
| bandwidth_mbps | DECIMAL(12,2) | Provisioned bandwidth | — |
| service_type | STRING | `DIA`, `Ethernet`, `Wavelength`, `MPLS` | — |
| lifecycle_status | STRING | `active`, `pending`, `decommissioned` (from cdm) | — |
| activation_date | DATE | Circuit activation date | — |
| deactivation_date | DATE | Circuit deactivation date (nullable) | — |
| connection_point | STRING | Network endpoint reference | — |

### ra_silver.dim_contract *(source: `tmf_customer.commitment` + `tmf_product.offering_price`)*

| Column | Type | Description | Key |
| :---- | :---- | :---- | :---- |
| contract_id | STRING | Commitment identifier (PK) | **PK** |
| circuit_id | STRING | FK to contracted circuit | FK → dim_circuit |
| customer_id | STRING | FK to owning customer | FK → dim_customer |
| contract_amount | DECIMAL(12,2) | Contracted amount (from commitment.amount) | — |
| actual_amount | DECIMAL(12,2) | Actual amount vs contract (commitment.actual_amount) | — |
| variance_amount | DECIMAL(12,2) | Variance for exception detection | — |
| approved_discount_pct | DECIMAL(5,2) | Approved discount percentage | — |
| discount_expiry_date | DATE | Discount validity end (from offering_price validity) | — |
| sla_tier | STRING | `Gold`, `Silver`, `Bronze` | — |
| contract_start_date | DATE | Term start | — |
| contract_end_date | DATE | Term end (nullable for evergreen) | — |
| approval_status | STRING | `approved`, `pending`, `expired` | — |

### ra_silver.fact_usage *(source: `tmf_resource.resource_usage` + `tmf_service.service_usage`)*

| Column | Type | Description |
| :---- | :---- | :---- |
| usage_id | STRING (PK) | Usage record identifier |
| circuit_id | STRING (FK) | Circuit generating usage |
| usage_date | DATE | Day of measurement |
| avg_mbps | DECIMAL(12,2) | Average bandwidth utilized |
| peak_mbps | DECIMAL(12,2) | 95th-percentile peak |
| bytes_total | BIGINT | Total bytes for period |
| mediation_status | STRING | `PROCESSED`, `FAILED`, `DUPLICATE_DETECTED`, `SUPPRESSED`, `PENDING`, `REPROCESSED` (from cdm) |
| charging_type | STRING | Usage charge classification |

### ra_silver.fact_billing *(source: `tmf_customer.bill` + `applied_customer_billing_*`)*

| Column | Type | Description |
| :---- | :---- | :---- |
| invoice_line_id | STRING (PK) | Invoice line identifier |
| billing_account_id | STRING (FK) | Billing account |
| circuit_id | STRING | Circuit reference (may be NULL for unresolved lines) |
| bill_id | STRING (FK) | Parent bill identifier |
| bill_period_start_date | DATE | Billing period start |
| bill_period_end_date | DATE | Billing period end |
| usage_charges_amount | DECIMAL(12,2) | Usage component |
| recurring_charges_amount | DECIMAL(12,2) | Recurring component |
| one_time_charges_amount | DECIMAL(12,2) | One-time charges |
| discount_amount | DECIMAL(12,2) | Applied discount |
| write_off_amount | DECIMAL(12,2) | Write-offs (from bill entity) |
| outstanding_amount | DECIMAL(12,2) | Outstanding balance |
| invoice_date | DATE | Invoice generation date |

### ra_silver.service_instance — **the canonical identity bridge (most important table)**

| Column | Type | Description | Key |
| :---- | :---- | :---- | :---- |
| service_instance_id | STRING | Surrogate key for the resolved service | **PK** |
| circuit_id | STRING | From logical_resource | FK → dim_circuit |
| resource_facing_service_id | STRING | Native RFS entity ID | — |
| customer_facing_service_id | STRING | Native CFS entity ID | — |
| contract_id | STRING | From commitment | FK → dim_contract |
| billing_account_id | STRING | From customer_billing_account | — |
| invoice_line_id | STRING | Matched current invoice line (nullable when unbilled) | FK → fact_billing |
| customer_id | STRING | Owning customer | FK → dim_customer |
| match_confidence | DOUBLE | 0–1 resolution confidence | — |
| match_method | STRING | `exact`, `fuzzy`, `unmatched` | — |
| resolved_at | TIMESTAMP | Resolution run time | — |

> A NULL `invoice_line_id` on an active circuit with `lifecycle_status='active'` is exactly the *active-circuit-unbilled* leakage signal — the bridge makes it queryable in one join. Similarly, `actual_amount` vs `contract_amount` variance signals contract mismatch; `mediation_status` variance signals usage reconciliation gaps.

---

## 3. Gold-layer entities (serving)

### ra_gold.reconciliation_exceptions

Derived from or mapped to pre-seeded `tmf_enterprise.revenue_assurance_violation` (10K rows, 12 violation types).

| Column | Type | Description |
| :---- | :---- | :---- |
| exception_id | STRING (PK) | Deterministic hash of (service_instance_id, violation_type, period) |
| service_instance_id | STRING (FK) | Links to the bridge |
| violation_type | STRING | one of 12 types (see below) |
| severity | STRING | `high`/`medium`/`low` (driven by $ and confidence) |
| estimated_revenue_impact_amount | DECIMAL(12,2) | Estimated monthly leakage |
| actual_recovery_amount | DECIMAL(12,2) | Recovered amount |
| root_cause | STRING | Enum of 6 checks (see reconciliation logic) |
| remediation_status | STRING | `open`, `investigating`, `resolved`, `write_off` |
| detected_at | TIMESTAMP | Reconciliation run time |
| status | STRING | mirrors `exception_case.status`, default `New` |

**violation_type domain (12 native types from cdm_tmforum):**  
`mediation_failure`, `usage_reconciliation_gap`, `revenue_recognition_error`, `tariff_mismatch`, `provisioning_discrepancy`, `partner_settlement_discrepancy`, `rating_error`, `policy_violation`, `fraud_indicator`, `configuration_error`, `billing_leakage`, `data_quality_issue`.

### ra_gold.exception_case *(linked to or conformed from `tmf_enterprise.ra_trouble_ticket`)*

| Column | Type | Description |
| :---- | :---- | :---- |
| case_id | STRING (PK) | Case identifier |
| exception_id | STRING (FK) | Links to exception |
| service_id | STRING | Service reference (from ra_trouble_ticket) |
| related_service_now_incident_number | STRING | ServiceNow incident # (from ra_trouble_ticket) |
| assignee | STRING | RA analyst (e.g. Marcus Chen) | **PII** |
| investigation_status | STRING | `New` → `Investigating` → `Recovered` / `WrittenOff` |
| notes | STRING | Investigation notes |
| recovered_amount_usd | DECIMAL(12,2) | Realized recovery |
| actual_revenue_recovery_amount | DECIMAL(12,2) | Confirmed recovery (from ra_trouble_ticket) |
| updated_at | TIMESTAMP | Last update timestamp |

### ra_gold.leakage_kpis

Aggregated from `reconciliation_exceptions` and/or pre-built from `_metrics.enterprise_revenue_assurance_violation`:

| Column | Type | Description |
| :---- | :---- | :---- |
| period | DATE | Reporting period (month-start) |
| product_line | STRING | Service category (DIA, Ethernet, etc.) |
| region | STRING | Geographic region |
| violation_type | STRING | Exception type |
| exception_count | INT | Count of exceptions in period |
| leakage_rate_pct | DECIMAL(5,2) | Leakage as % of regional revenue |
| estimated_leakage_usd | DECIMAL(12,2) | Total estimated impact |
| recovered_usd | DECIMAL(12,2) | Actual recovery in period |
| avg_days_to_bill | INT | Average days from provisioning to first bill |

### ra_gold.revenue_forecast

ML-driven, integrating `ai_forecast` SQL function on historical billing + exception patterns:

| Column | Type | Description |
| :---- | :---- | :---- |
| forecast_id | STRING (PK) | Surrogate key |
| period | DATE | Forecasted period (month-start) |
| segment | STRING | Customer segment (`Enterprise`, `Mid-Market`, etc.) |
| product_category | STRING | Service line |
| expected_revenue_usd | DECIMAL(12,2) | Baseline forecast |
| anomaly_adjusted_revenue_usd | DECIMAL(12,2) | Forecast with leakage/exception risk |
| variance_usd | DECIMAL(12,2) | Difference vs actual (when actual available) |
| confidence_interval_low | DECIMAL(12,2) | 95% CI lower bound |
| confidence_interval_high | DECIMAL(12,2) | 95% CI upper bound |
| generated_at | TIMESTAMP | Model run time |

---

## 4. PII classification & governance

All PII handling via Unity Catalog column masks + tags (lineage auto-captured).

| Column | Table | Class | Control |
| :---- | :---- | :---- | :---- |
| customer_name | dim_customer | PII (Confidential) | UC tag `pii=true`; column mask returns `***` to non-`ra_admin` groups |
| tax_identifier | dim_customer | PII (Confidential) | Masked to `ra_admin` only |
| external_customer_code | dim_customer | Sensitive-linkable | UC tag `sensitive`; row access unaffected |
| assignee | exception_case | PII (Internal) | Visible to `ra_analyst` and `ra_admin` |

No raw PII leaves silver into gold except masked.

---

## 5. Real data volumes (not invented)

Per data-source-assessment.md assessment:

| Table | Real rows | Span |
| :---- | :---- | :---- |
| tmf_customer.customer | ~10,000 | MDM, ~10K unique accounts |
| tmf_resource.logical_resource | ~100,000 | Active + historical circuits |
| tmf_service.resource_facing_service | ~100,000 | Aligned with logical_resource |
| tmf_service.customer_facing_service | ~100,000 | Customer view of RFS |
| tmf_resource.resource_usage | 10K–100K | Daily/hourly CDR records |
| tmf_customer.bill | 10K+ | Invoices spanning 2018–2025 |
| tmf_customer.commitment | 10K–100K | Active + historical contracts |
| tmf_product.order_item | ~100,000 | Order fulfillment records |
| tmf_enterprise.revenue_assurance_violation | ~10,000 | **12 violation types, ~$540M est. impact** |
| tmf_enterprise.ra_trouble_ticket | ~10,000 | Case records |

---

## 6. Source-to-target mapping (lineage contract)

| tmf_* (read-only source) | → ra_silver | → ra_gold |
| :---- | :---- | :---- |
| tmf_customer.customer | dim_customer | leakage_kpis (segment, region aggregations) |
| tmf_resource.logical_resource | dim_circuit | (via service_instance) |
| tmf_service.resource_facing_service / customer_facing_service | service_instance bridge | exception drill-down |
| tmf_customer.commitment + tmf_product.offering_price | dim_contract | reconciliation_exceptions (price/variance) |
| tmf_resource.resource_usage / tmf_service.service_usage | fact_usage | usage_billing_variance exceptions, revenue_forecast |
| tmf_customer.bill + applied_customer_billing_* | fact_billing | reconciliation_exceptions, leakage_kpis |
| tmf_product.order_item | fact_usage (billing_start_date) | billing_start_lag exceptions |
| tmf_businesspartner.rev_share_reconciliation | (joined at reconcile) | partner_settlement_mismatch exceptions |
| all above via service_instance | **service_instance** | reconciliation_exceptions + exception_case |
| tmf_enterprise.revenue_assurance_violation | (reference / union) | leakage_kpis, reconciliation_exceptions (seeded baseline) |
| tmf_enterprise.ra_trouble_ticket | (reference) | exception_case enrichment |
| _metrics.* (71 pre-built views) | — | dashboards / KPIs |

---

## 7. The 6 reconciliation checks — mapped to native violations

Each check queries real data + correlates to pre-seeded violation types:

| Check | Evidence in data | Native violation_type |
| :---- | :---- | :---- |
| **1. Active-circuit-unbilled** | `logical_resource.lifecycle_status='active'` + NULL `invoice_line_id` via bridge | `provisioning_discrepancy` / `billing_leakage` |
| **2. Contract-price mismatch** | `commitment.amount` vs `actual_amount`/`variance_amount`; offering_price.price_amount | `tariff_mismatch` / `rating_error` |
| **3. Expired/unauthorized discount** | `offering_price.approval_status` + expiry date in past; applied_customer_billing_discount | `revenue_recognition_error` / `policy_violation` |
| **4. Usage–billing variance** | `resource_usage` / `service_usage` vs `bill.usage_charges_amount`; `mediation_status` in FAILED/DUPLICATE/SUPPRESSED | `usage_reconciliation_gap` / `mediation_failure` |
| **5. Billing-start-date lag** | `order_item.billing_start_date > actual_completion_date` (~50% of rows per assessment) | `provisioning_discrepancy` |
| **6. Partner-settlement mismatch** | `rev_share_reconciliation.variance_amount` with status `in_dispute` / `open` | `partner_settlement_discrepancy` |

Each seeded exception links back to the evidence row(s) for drill-down in the RA Exceptions Console app.

---

## 8. Notes on source systems (simulated separately)

Source systems (`salesforce_source`, `oracle_erp_source`, etc.) are specced separately and simulate upstream systems keyed to golden customers. They feed optional live ingestion & ML anomaly injection, but the **demo's core reconciliation logic runs on pre-populated `cdm_tmforum.tmf_*` data, not on simulated bronze.**
