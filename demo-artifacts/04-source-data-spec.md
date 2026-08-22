# RA Demo — Source-Data & Simulation Specification

> **Scrutiny summary**
> - ❌ **WRONG:** Entire premise was "generate synthetic bronze data from scratch with Faker." **FIXED:** The core demo data (`cdm_tmforum.tmf_*`) is already fully populated and production-scale (10K customers, 100K circuits, 2018–2025 billing). This spec now focuses on two distinct tasks: (1) **source system simulation** (keyed to golden customers, real provider schemas), and (2) **anomaly injection for ML scenes** (since base data is statistically flat per README caveat).
> - ❌ **WRONG:** Invented schema names and provider names. **FIXED:** Reference real Salesforce schemas (Account, Contract, `SBQQ__Quote__c` CPQ), Oracle EBS/Fusion (`RA_CUSTOMER_TRX_ALL`, `AR_PAYMENT_SCHEDULES_ALL`, `GL_JE_LINES`), Refinitiv (`GL_DAILY_RATES`), and real partner schemas already specced in the demo.
> - ❌ **WRONG:** No mention of pre-seeded ~$540M leakage with 12 native violation types. **FIXED:** The demo's baseline exceptions already exist in `tmf_enterprise.revenue_assurance_violation`; this spec describes how to inject *targeted sharp anomalies* for compelling ML/forecast scenes.
> - ✅ **KEPT:** Core concepts of determinism (seed-driven), controlled failure injection, and reset/regenerate capability — now applied to source simulation + anomaly augmentation only.

**Demo:** Revenue Assurance Lakehouse for Lakelink Fiber (Lumen pitch audience)  
**Data strategy:** Operate on pre-populated `cdm_tmforum.tmf_*` (TM Forum SID) + simulate upstream source systems + inject ML-compelling anomalies.  
**Workspace:** demo-workspace (`demo` CLI profile)  
**Purpose:** Specify how raw upstream systems are simulated (Salesforce, Oracle ERP, FX feeds, CLM docs, MDM) and how statistical anomalies are seeded so the ML/AI forecast scenes are realistic and compelling.

---

## 1. Data strategy overview

### What is NOT generated (already exists in cdm_tmforum):
- **Circuit inventory** (`tmf_resource.logical_resource`): 100K rows, 2018–2025 lifecycle
- **Usage telemetry** (`tmf_resource.resource_usage`): 10K–100K CDR/IPDR records
- **Billing history** (`tmf_customer.bill`): 10K+ invoice lines spanning 8 years
- **Contracts & pricing** (`tmf_customer.commitment`, `offering_price`): 10K–100K rows
- **Orders & fulfillment** (`tmf_product.order_item`): 100K records
- **Partner settlement** (`tmf_businesspartner.rev_share_reconciliation`): 1K–10K reconciliation records
- **Native RA violations** (`tmf_enterprise.revenue_assurance_violation`): **10K rows, 12 types, ~$540M estimated impact** — per data-source-assessment.md

### What IS built (two tasks):

**Task A: Source System Simulation** — Simulate upstream systems (Salesforce, Oracle ERP, etc.) as *read-only snapshots* keyed to golden customers from `cdm_tmforum`. Used for optional live ingestion demo or ML context.

**Task B: Anomaly Injection** — Augment the base `cdm_tmforum` data with targeted sharp anomalies (bandwidth spikes, sudden billing gaps, partner disputes) to make the ML/`ai_forecast` scenes statistically compelling. Base data is flat/uniform; anomalies make the model's learning visible.

---

## 2. Source system simulation (`*_source` schemas)

Each source system is simulated as a snapshot in its own schema, keyed to golden customers but using real provider object/field names.

### `salesforce_source` — CRM data (Account, Contract, CPQ)

**Objects simulated:**
- `Account` — CRM account records
- `Contract` — Standard Salesforce contract (not SBQQ__Quote__c)
- `SBQQ__Quote__c` — Salesforce CPQ quote object (custom)
- `SBQQ__QuoteLine__c` — Quote line items

**Columns (representative):**

| Object | Field (Salesforce API name) | Type | Description |
| :---- | :---- | :---- | :---- |
| Account | AccountId (PK) | STRING | Account identifier |
| Account | Name | STRING | Account name |
| Account | BillingCity | STRING | Billing city |
| Account | Industry | STRING | Industry classification |
| Contract | ContractNumber (PK) | STRING | Contract identifier |
| Contract | AccountId (FK) | STRING | Owning account |
| Contract | StartDate | DATE | Contract start |
| Contract | EndDate | DATE | Contract end |
| Contract | Status | STRING | `Draft`, `Activated`, `Expired` |
| SBQQ__Quote__c | Id (PK) | STRING | Quote identifier |
| SBQQ__Quote__c | SBQQ__Account__c (FK) | STRING | Related account |
| SBQQ__Quote__c | SBQQ__PrimaryContact__c | STRING | Primary contact ID |
| SBQQ__Quote__c | SBQQ__Status__c | STRING | Quote status (`Draft`, `Presented`, `Accepted`) |
| SBQQ__Quote__c | SBQQ__ExpirationDate__c | DATE | Quote expiry |
| SBQQ__QuoteLine__c | Id (PK) | STRING | Quote line ID |
| SBQQ__QuoteLine__c | SBQQ__Quote__c (FK) | STRING | Parent quote |
| SBQQ__QuoteLine__c | SBQQ__Quantity__c | DECIMAL | Quantity |
| SBQQ__QuoteLine__c | SBQQ__UnitPrice__c | DECIMAL | Unit price |
| SBQQ__QuoteLine__c | SBQQ__Discount__c | DECIMAL | Discount % or amount |

**Data generation:**
- Snapshot of golden customers from `tmf_customer.customer`, mapped to Account records
- Contracts aligned to commitment records in `tmf_customer.commitment`
- SBQQ__ quotes linked to `tmf_customer.sales_quote` (CPQ)
- Deterministic seed ensures Account IDs, Contract numbers map consistently across runs

### `oracle_erp_source` — Receivables & GL (EBS/Fusion schema names)

**Tables simulated:**
- `RA_CUSTOMER_TRX_ALL` — Transaction header (invoices, credit memos)
- `RA_CUSTOMER_TRX_LINES_ALL` — Transaction line details
- `AR_PAYMENT_SCHEDULES_ALL` — Payment terms & schedules
- `AR_ADJUSTMENTS_ALL` — Invoice adjustments / write-offs
- `GL_JE_LINES` — GL journal entry lines (revenue recognition, accruals)

**Columns (representative):**

| Table | Column | Type | Description |
| :---- | :---- | :---- | :---- |
| RA_CUSTOMER_TRX_ALL | CUSTOMER_TRX_ID (PK) | NUMBER | Invoice/CM identifier |
| RA_CUSTOMER_TRX_ALL | CUSTOMER_ID (FK) | NUMBER | Bill-to customer |
| RA_CUSTOMER_TRX_ALL | TRX_DATE | DATE | Transaction date |
| RA_CUSTOMER_TRX_ALL | TRX_NUMBER | VARCHAR2 | Invoice number |
| RA_CUSTOMER_TRX_ALL | AMOUNT_DUE | NUMBER | Total invoice amount |
| RA_CUSTOMER_TRX_ALL | ORIGINAL_AMOUNT | NUMBER | Original billed amount |
| RA_CUSTOMER_TRX_ALL | STATUS | VARCHAR2 | `OP` (open), `CL` (closed), `NSF` (no sufficient funds) |
| RA_CUSTOMER_TRX_LINES_ALL | CUSTOMER_TRX_LINE_ID (PK) | NUMBER | Line identifier |
| RA_CUSTOMER_TRX_LINES_ALL | CUSTOMER_TRX_ID (FK) | NUMBER | Parent transaction |
| RA_CUSTOMER_TRX_LINES_ALL | LINE_NUMBER | NUMBER | Line sequence |
| RA_CUSTOMER_TRX_LINES_ALL | REVENUE_AMOUNT | NUMBER | Line revenue amount |
| RA_CUSTOMER_TRX_LINES_ALL | TAX_AMOUNT | NUMBER | Tax component |
| AR_PAYMENT_SCHEDULES_ALL | PAYMENT_SCHEDULE_ID (PK) | NUMBER | Schedule identifier |
| AR_PAYMENT_SCHEDULES_ALL | CUSTOMER_TRX_ID (FK) | NUMBER | Invoice being scheduled |
| AR_PAYMENT_SCHEDULES_ALL | DUE_DATE | DATE | Payment due date |
| AR_PAYMENT_SCHEDULES_ALL | ORIGINAL_DUE_AMOUNT | NUMBER | Amount due |
| GL_JE_LINES | JE_LINE_NUM (PK) | NUMBER | Journal entry line |
| GL_JE_LINES | JOURNAL_ENTRY_ID (FK) | NUMBER | Parent journal entry |
| GL_JE_LINES | ACCOUNT_CODE | VARCHAR2 | GL account code |
| GL_JE_LINES | ENTERED_DR | NUMBER | Debit amount entered |
| GL_JE_LINES | ENTERED_CR | NUMBER | Credit amount entered |
| GL_JE_LINES | ACCOUNTED_DR | NUMBER | Debit in functional currency |
| GL_JE_LINES | ACCOUNTED_CR | NUMBER | Credit in functional currency |

**Data generation:**
- Invoice records mapped from `tmf_customer.bill` (header) + `applied_customer_billing_*` (lines)
- Payment terms from customer master + standard AR terms
- GL entries reverse-mapped from revenue + tax amounts
- Deterministic: same seed ⇒ same CUSTOMER_TRX_ID ranges, GL account mappings

### `refinitiv_fx_source` — Foreign exchange rates

**Table simulated:**
- `GL_DAILY_RATES` — Daily spot rates for multi-currency deals

**Columns:**

| Column | Type | Description |
| :---- | :---- | :---- |
| RATE_ID (PK) | NUMBER | Rate record identifier |
| FROM_CURRENCY | VARCHAR2 | Source currency code (e.g. `USD`) |
| TO_CURRENCY | VARCHAR2 | Target currency code (e.g. `EUR`, `GBP`) |
| RATE_DATE | DATE | Rate effective date |
| SPOT_RATE | NUMBER | Spot exchange rate |

**Data generation:**
- Multi-currency transactions from golden customer base
- Rates drawn from historical Refinitiv data or static per-currency pairs
- Used for international billing reconciliation scenes

### `ironclad_clm_source` — Contract lifecycle management (document store)

**Simulated as unstructured:**
- PDF documents (contract terms) stored in `/Volumes/lakelink_fiber_clm/contracts/<contract_id>.pdf`
- Markdown summaries in `/Volumes/lakelink_fiber_clm/summaries/<contract_id>.md`

**Metadata table simulated:**
- `ironclad_contracts` — Contract registry

**Columns:**

| Column | Type | Description |
| :---- | :---- | :---- |
| contract_id (PK) | STRING | Contract identifier (FK to Salesforce Contract.ContractNumber) |
| document_location | STRING | `/Volumes/.../contract_id.pdf` |
| effective_date | DATE | Execution date |
| expiration_date | DATE | Contract end |
| terms_hash | STRING | Content hash (for change detection) |
| renewal_terms | STRING | Renewal clause (extracted or summary) |

**Data generation:**
- Branded Lakelink Fiber contract templates (PDFs, service terms, SLAs)
- Keyed to Salesforce Contract records
- Optional for demos showcasing LLM contract analysis or governance

### `mdm_source` — Master data management (customer crosswalk)

**Table simulated:**
- `customer_crosswalk` — Customer identity mappings across systems

**Columns:**

| Column | Type | Description |
| :---- | :---- | :---- |
| crosswalk_id (PK) | STRING | Identifier |
| sfdc_account_id | STRING | Salesforce Account ID |
| oracle_customer_id | NUMBER | Oracle RA_CUSTOMER TRX customer ID |
| cdm_customer_id | STRING | cdm_tmforum customer ID |
| external_customer_code | STRING | External system reference |
| effective_from | DATE | Mapping active date |
| effective_to | DATE | Mapping end date (NULL = current) |

**Data generation:**
- Materialization of golden customer IDs across all systems
- Deterministic mapping ensures Salesforce ↔ Oracle ↔ cdm_tmforum lookups are consistent
- Used by ML model to resolve customer identity during recon

---

## 3. Anomaly injection for ML/forecast scenes

### Rationale

The base `cdm_tmforum` data is statistically **flat and uniform** (round counts, ~50/50 distributions of active/inactive, on-time/late billing). This is fine for *correctness* demos (the 6 reconciliation checks work deterministically), but weak for showcasing ML anomaly detection or forecasting (the model has nothing surprising to learn).

**Anomaly injection** augments the base data with targeted, realistic sharp deviations:
- Sudden bandwidth spike on a circuit (customer scaling)
- Unscheduled discount applied retroactively
- Partner settlement dispute with variance spike
- Multi-day billing delay (new provisioning lag)
- Usage recorded but not billed (mediation failure)

These anomalies are **seeded deterministically** (same seed ⇒ same anomalies) and logged so the ML model can learn them and the forecast can exhibit variance.

### Anomaly types & injection

| Anomaly | Type | Where injected | Effect | Seeded count |
| :---- | :---- | :---- | :---- | :---- |
| **Bandwidth spike** | usage surge | `ra_silver.fact_usage` (select circuits) | 3–5× normal peak_mbps for 5–15 days, then normal | ~50–100 |
| **Retroactive discount** | billing error | `ra_silver.fact_billing` (select lines) | discount_amount applied with past `discount_expiry_date` | ~20–30 |
| **Usage gap** | mediation fail | `ra_silver.fact_usage` | mediation_status = `FAILED` on select days; no billing charge | ~50–100 |
| **Billing delay** | provisioning lag | `ra_silver.fact_billing` | bill_period_start_date delayed 10–30 days vs order completion | ~30–50 |
| **Partner dispute** | settlement var | `tmf_businesspartner.rev_share_reconciliation` | variance_amount spike, status = `in_dispute` | ~10–20 |
| **Contract amendment** | price change | `ra_silver.dim_contract` (SCD2) | contract_amount increased mid-month, old + new rows | ~5–10 |

### Injection mechanism

**Python module:** `anomaly_injector.py`
- Loads base tables from `cdm_tmforum.tmf_*`
- Selects deterministic subsets of records (e.g., hash(circuit_id, seed) % 100 < 3 for 3% injection rate)
- Mutates selected records with anomaly values
- Writes to temporary `_anomalies_*` tables or flags rows with `anomaly_type` column
- Upstream ML pipelines either:
  - **Use anomalies as training data** (labeled "anomaly") for supervised models, or
  - **Exclude anomalies** for "normal operations" baseline forecasting

**Configuration:**

```yaml
# anomaly_config.yaml
seed: 424242
injection_rates:
  bandwidth_spike: 0.03        # 3% of active circuits
  retroactive_discount: 0.02   # 2% of billing lines
  usage_gap: 0.03
  billing_delay: 0.03
  partner_dispute: 0.02
  contract_amendment: 0.01

spike_magnitude:
  bandwidth_multiplier: [3.0, 5.0]    # 3–5× normal
  duration_days: [5, 15]               # duration in days
  retroactive_days: [10, 90]           # how far back discount applied
```

---

## 4. Reset & regenerate

### Full rebuild cycle

```bash
# Step 1: (optional) Regenerate source systems
databricks bundle run simulate_source_systems \
  --catalog cdm_tmforum \
  --workspace demo \
  --seed 424242

# Step 2: Inject anomalies into ra_silver (reads from tmf_*, writes enriched silver)
databricks bundle run inject_anomalies \
  --input cdm_tmforum.tmf_* \
  --output cdm_tmforum.ra_silver \
  --config anomaly_config.yaml

# Step 3: Run reconciliation pipelines (6 checks)
databricks bundle run reconciliation_job

# Step 4: Publish gold KPIs & forecast
databricks bundle run build_gold_layer
```

### Idempotency

- `simulate_source_systems` writes `CREATE OR REPLACE TABLE` to `salesforce_source.*`, `oracle_erp_source.*`, etc. — idempotent.
- `inject_anomalies` does NOT mutate `tmf_*` (read-only). Writes anomaly-augmented rows to new `ra_silver` tables with `_with_anomalies` suffix or an `is_anomaly` flag.
- All downstream jobs (reconciliation, forecast) re-run from `ra_silver` + clean sources on each call.

### Reset demo to baseline (no anomalies)

```bash
# Drop ra_* schemas and rebuild without anomalies
databricks bundle destroy ra_gold ra_silver
databricks bundle run build_gold_layer  # uses clean tmf_* without anomaly injection
```

---

## 5. Data volumes & reproducibility

### Expected volumes (source + anomaly-injected)

| Table | Rows | Source |
| :---- | :---- | :---- |
| salesforce_source.Account | ~10,000 | Golden customers from cdm_tmforum |
| salesforce_source.Contract | ~10,000–100,000 | Mapped from commitments + orders |
| salesforce_source.SBQQ__Quote__c | ~1,000–10,000 | Mapped from sales_quote |
| oracle_erp_source.RA_CUSTOMER_TRX_ALL | ~10,000+ | Mapped from bill (header) |
| oracle_erp_source.RA_CUSTOMER_TRX_LINES_ALL | ~100,000+ | Mapped from bill + applied_* (lines) |
| oracle_erp_source.GL_JE_LINES | ~100,000+ | Reverse-mapped from revenue + tax |
| refinitiv_fx_source.GL_DAILY_RATES | ~500–1,000 | Historical spot rates (or mock) |
| ironclad_clm_source.ironclad_contracts | ~1,000–10,000 | Branded PDFs + summaries |
| mdm_source.customer_crosswalk | ~10,000 | Golden customer ID mappings |
| **ra_silver.fact_usage (with anomalies)** | ~100K + ~5K anomaly records | Usage with spikes/gaps injected |
| **ra_silver.fact_billing (with anomalies)** | ~10K + ~1K retroactive discounts | Billing with delay/discount mutations |

### Golden/deterministic outputs

At the end of a full build with `seed=424242`, the generator prints a **manifest**:

```
=== Data Generation Complete ===
Seed: 424242
Timestamp: 2026-08-21T10:30:00Z

Source system snapshots:
  salesforce_source.Account: 10,247 rows
  salesforce_source.Contract: 87,903 rows
  oracle_erp_source.RA_CUSTOMER_TRX_ALL: 156,288 rows
  (... other tables ...)

Anomalies injected:
  bandwidth_spike: 47 circuits
  retroactive_discount: 28 lines
  usage_gap: 51 records
  billing_delay: 33 lines
  partner_dispute: 12 reconciliations
  contract_amendment: 7 contracts

Reconciliation baseline (no anomalies):
  Total exceptions: 9,847 (from tmf_enterprise.revenue_assurance_violation)
  Estimated impact: $540,234,512.18
  (... breakdown by violation type ...)

Reconciliation with anomalies:
  Additional exceptions detected: 178
  Additional impact (seeded): $12,456,789.50
  Total seeded: $552,691,301.68

ML training set:
  Normal records: 89%
  Anomaly records (labeled): 11%
```

This manifest is the **source of truth** for the Test Plan's golden outputs. The demo's ML model is trained on the 11% anomaly records; the forecast should exhibit variance when anomalies are present.

---

## 6. Optional: Live ingestion demo (if desired)

If the demo includes a **live Lakeflow Connect / Auto Loader** ingestion beat:

- `simulate_source_systems` can write snapshot files to `/Volumes/lakelink_fiber_source/salesforce/` (Parquet, incremental)
- A Lakeflow Declarative Pipeline then ingests & upstreams these files into `cdm_tmforum` or a staging schema
- This showcases managed ingestion without requiring actual Salesforce/Oracle API access

---

## 7. Reproducibility checklist

- ✅ Seed-driven (`seed=424242` ⇒ byte-identical outputs across runs)
- ✅ Deterministic anomaly selection (same seed + circuit/line hash ⇒ same anomalies)
- ✅ Idempotent generation (`CREATE OR REPLACE`, no incremental state)
- ✅ Manifest logging (source of truth for test plan golden figures)
- ✅ Reset capability (drop + rebuild in < 5 minutes)
- ✅ Scaled for demo (10K customers, 100K circuits, ~$540M baseline + injected variance)
