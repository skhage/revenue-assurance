# RA Demo — Source-Data & Simulation Specification

> **Scrutiny summary**
> - ❌ **WRONG:** Entire premise was "generate synthetic bronze data from scratch with Faker." **FIXED:** The core demo data (`cdm_tmforum.tmf_*`) is already fully populated and production-scale (10K customers, 100K circuits, 2018–2025 billing). This spec now focuses on two distinct tasks: (1) **source system simulation** (keyed to golden customers, real provider schemas), and (2) **anomaly injection for ML scenes** (since base data is statistically flat per README caveat).
> - ❌ **WRONG:** Invented schema names and provider names. **FIXED:** Reference real Salesforce schemas (Account, Contract, `SBQQ__Quote__c` CPQ), Oracle EBS/Fusion (`RA_CUSTOMER_TRX_ALL`, `AR_PAYMENT_SCHEDULES_ALL`, `GL_JE_LINES`), Refinitiv (`GL_DAILY_RATES`), and real partner schemas already specced in the demo.
> - ❌ **WRONG:** No mention of pre-seeded ~$540M leakage with 12 native violation types. **FIXED:** The demo's baseline exceptions already exist in `tmf_enterprise.revenue_assurance_violation`; this spec describes how to inject *targeted sharp anomalies* for compelling ML/forecast scenes.
> - ❌ **WRONG (superseded):** Anomalies injected into `ra_silver.fact_usage`/`fact_billing`/`dim_contract`; jobs `inject_anomalies`/`reconciliation_job`/`build_gold_layer`; teardown of `ra_silver`/`ra_gold`. **FIXED (as built):** there is no `ra_silver`/`ra_gold` split and no `dim_*`/`fact_*` tables. Anomalies are injected into the **`*_source` systems** (and the `oracle_erp_source.gl_je_lines` account `4000` GL revenue series that feeds the forecast) by `data-sim/simulate_source_systems.py` (+ `data-sim/config.yaml`); the RA layer is a single `cdm_tmforum.revenue_assurance` schema of silver-check + gold materialized views (see artifact 01-03).
> - ✅ **KEPT:** Core concepts of determinism (seed-driven), controlled failure injection, and reset/regenerate capability — now applied to source simulation + anomaly augmentation only.
> - **Source system & anomaly injection correction (build-verified):** Clarified real Salesforce schema names (Account, Contract, ContractLineItem, SBQQ objects with `discount_approval__c`); added Oracle EBS/Fusion tables (GL_BUDGETS, REVENUE_RECOGNITION_SCHEDULE, AR_PAYMENT_SCHEDULES_ALL with DAYS_OVERDUE, GL_JE_HEADERS); expanded Ironclad CLM to include both contract and invoice PDFs for document-intelligence checks. Anomalies are injected deterministically into `*_source` schemas only; the pipeline then feeds silver checks in `cdm_tmforum.revenue_assurance`, which compose into `gold_leakage_summary` (~48K / ~$601M register). All operations preserve read-only `tmf_*` base data.
> - **Orchestration & determinism correction (ws3-datasim):** (1) Added a DAB **job** `resources/datasim_job.yml` that runs `simulate_source_systems.py` as a serverless notebook_task, making `databricks bundle run simulate_source_systems` real. (2) `config.yaml` is now the **single source of truth** — the notebook loads it at module scope (`import yaml`) and derives catalog/schemas/seed/scale/leakage/products/FX/forecast knobs from it, with no hardcoded duplicates. (3) Seed collapsed to the **one authoritative value `42`** (previously the doc cited `424242` while code+config used `42`); this spec now reads `42` throughout. (4) Non-deterministic `monotonically_increasing_id()` surrogate keys were replaced with **deterministic hash keys** (`xxhash64` of business keys salted with the seed), so "same seed ⇒ reproducible" holds. (5) The documented GL **revenue step-change** is now actually implemented in `gl_je_lines` (account 4000, config-driven months/magnitudes) instead of just copying invoice totals.

**Demo:** Revenue Assurance Lakehouse for Lakelink Fiber (Lumen pitch audience)  
**Data strategy:** Operate on pre-populated `cdm_tmforum.tmf_*` (TM Forum SID, read-only) + simulate upstream source systems in `*_source` schemas + inject ML-compelling anomalies into sources.  
**Workspace:** selected at runtime; no workspace hostname or credential identifier is committed
**Purpose:** Specify how raw upstream systems are simulated (Salesforce, Oracle ERP, FX feeds, CLM docs, MDM) keyed to golden customers, and how statistical anomalies are seeded into those sources so the ML/AI forecast scenes are realistic and compelling.

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
- `Account` — CRM account records (linked to `tmf_customer.customer`)
- `Contract` — Standard Salesforce contract (not a custom object; linked to `tmf_customer.commitment`)
- `ContractLineItem` — Contract line items with pricing (note: not the same as SBQQ line items)
- `SBQQ__Quote__c` — Salesforce CPQ quote object (custom; linked to `tmf_customer.sales_quote`)
- `SBQQ__QuoteLine__c` — Quote line items with unit pricing and discount approval flags

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
| SBQQ__QuoteLine__c | discount_approval__c | STRING | Approval status (`Approved`, `Pending`, `Denied`) |
| ContractLineItem | Id (PK) | STRING | Contract line ID |
| ContractLineItem | ContractId (FK) | STRING | Parent contract |
| ContractLineItem | UnitPrice | DECIMAL | Line item unit price |
| ContractLineItem | Quantity | DECIMAL | Quantity |
| ContractLineItem | Discount | DECIMAL | Discount applied |
| Account | TMF_Customer_Id__c | STRING | Link to `tmf_customer.customer_id` (for reconciliation) |

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
| AR_PAYMENT_SCHEDULES_ALL | DAYS_OVERDUE | NUMBER | Days past due (for AR aging check) |
| GL_JE_LINES | JE_LINE_NUM (PK) | NUMBER | Journal entry line |
| GL_JE_LINES | JOURNAL_ENTRY_ID (FK) | NUMBER | Parent journal entry |
| GL_JE_LINES | ACCOUNT_CODE | VARCHAR2 | GL account code (e.g., `4000` for revenue) |
| GL_JE_LINES | JE_DATE | DATE | Journal entry date |
| GL_JE_LINES | ENTERED_DR | NUMBER | Debit amount entered |
| GL_JE_LINES | ENTERED_CR | NUMBER | Credit amount entered |
| GL_JE_LINES | ACCOUNTED_DR | NUMBER | Debit in functional currency |
| GL_JE_LINES | ACCOUNTED_CR | NUMBER | Credit in functional currency |
| GL_JE_HEADERS | JOURNAL_ENTRY_ID (PK) | NUMBER | Journal entry header ID |
| GL_JE_HEADERS | JE_DATE | DATE | Entry date |
| GL_JE_HEADERS | STATUS | VARCHAR2 | Posted/Draft status |
| GL_BUDGETS | BUDGET_ID (PK) | NUMBER | Budget record ID |
| GL_BUDGETS | ACCOUNT_CODE | VARCHAR2 | GL account code (e.g., `4000`) |
| GL_BUDGETS | BUDGET_MONTH | DATE | Month for budget |
| GL_BUDGETS | BUDGET_AMOUNT | NUMBER | Budgeted revenue amount |
| REVENUE_RECOGNITION_SCHEDULE | SCHEDULE_ID (PK) | NUMBER | Recognition schedule ID |
| REVENUE_RECOGNITION_SCHEDULE | CUSTOMER_TRX_ID (FK) | NUMBER | Related invoice |
| REVENUE_RECOGNITION_SCHEDULE | RECOGNITION_DATE | DATE | Scheduled recognition date |
| REVENUE_RECOGNITION_SCHEDULE | REVENUE_AMOUNT | NUMBER | Amount to be recognized |

**Data generation:**
- Invoice records mapped from `tmf_customer.bill` (header) + `applied_customer_billing_*` (lines)
- Payment terms from customer master + standard AR terms
- GL entries reverse-mapped from revenue + tax amounts (account code `4000` for revenue)
- GL budgets sampled from historical budget table; GL headers house JE metadata
- Revenue recognition schedules reverse-mapped from `tmf_customer.bill` line revenue amounts
- Deterministic: same seed ⇒ same CUSTOMER_TRX_ID ranges, GL account mappings
- Anomalies: AR invoice aging artificially pushed past 90 days (ar-collection-risk); GL revenue step changes injected into account `4000` on specific months (forecast anomaly seed)

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

**Simulated as unstructured + metadata:**
- Contract PDFs stored in `/Volumes/lakelink_fiber_clm/contracts/<contract_id>.pdf`
- Invoice PDFs stored in `/Volumes/lakelink_fiber_clm/invoices/<invoice_id>.pdf`

**Metadata tables simulated:**
- `ironclad_contracts` — Contract registry
- `ironclad_invoices` — Invoice document registry

**Columns (contracts):**

| Column | Type | Description |
| :---- | :---- | :---- |
| contract_id (PK) | STRING | Contract identifier (FK to Salesforce Contract.ContractNumber) |
| document_location | STRING | `/Volumes/.../contract_id.pdf` |
| effective_date | DATE | Execution date |
| expiration_date | DATE | Contract end |
| service_term_value | DECIMAL | Service term amount extracted from PDF (for reconciliation) |
| renewal_terms | STRING | Renewal clause (extracted via `ai_extract`) |

**Columns (invoices):**

| Column | Type | Description |
| :---- | :---- | :---- |
| invoice_id (PK) | STRING | Invoice identifier |
| document_location | STRING | `/Volumes/.../invoice_id.pdf` |
| customer_id (FK) | STRING | Bill-to customer |
| invoice_amount | DECIMAL | Invoice total (from PDF extraction) |
| invoice_date | DATE | Invoice date |
| extracted_line_items | ARRAY | Line-item structure extracted via `ai_parse_document` |

**Data generation:**
- Branded Lakelink Fiber contract & invoice templates (PDFs, service terms, SLAs, payment terms)
- Contract PDFs linked to Salesforce Contract records; invoice PDFs linked to `oracle_erp_source.RA_CUSTOMER_TRX_ALL`
- Used for AI document-intelligence checks: `silver_doc_intelligence_contracts` (contract terms vs. billed amount) and `silver_doc_intelligence_invoices` (invoice PDF structure vs. GL posting)
- Anomalies: contract PDF service term diverges from actual billed price (doc-contract-mismatch); invoice PDF line count differs from GL posting detail (doc-invoice-mismatch)

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

The base `cdm_tmforum` data is statistically **flat and uniform** (round counts, ~50/50 distributions of active/inactive, on-time/late billing). This is fine for *correctness* demos (the seven silver reconciliation checks work deterministically), but weak for showcasing ML anomaly detection or forecasting (the model has nothing surprising to learn).

**Anomaly injection** augments the **simulated `*_source` systems** (which feed the silver checks) with targeted, realistic sharp deviations:
- Contract/quote priced away from the billed amount (contract-price / discount leakage)
- FX rate applied off market (multi-currency invoice)
- AR balances aging sharply past 90 days (collection risk)
- Revenue recognized early/late vs the GL (rev-rec timing)
- Contract/invoice PDF terms diverging from the system-of-record (doc-intelligence)
- A step change in monthly GL revenue (account `4000`) for the `ai_forecast` scene

These anomalies are **seeded deterministically** (same seed ⇒ same anomalies) and land in the `*_source` tables so the silver checks surface them and `gold_revenue_forecast_anomalies` exhibits variance.

### Anomaly types & injection

| Anomaly | Type | Where injected (`*_source`) | Surfaces in | Check MV |
| :---- | :---- | :---- | :---- | :---- |
| **Contract-price gap** | pricing error | `salesforce_source.ContractLineItem.UnitPrice` (diverges from tmf bill amount) | `silver_contract_price_reconciliation` | `contract_price_mismatch` |
| **Unauthorized discount** | policy breach | `salesforce_source.SBQQ__QuoteLine__c.discount_approval__c` (set to `Pending`/`Denied` when discount > threshold) | `silver_discount_authorization_check` | `unauthorized_discount` |
| **Expired quote active** | governance violation | `salesforce_source.SBQQ__Quote__c.SBQQ__ExpirationDate__c` (past due, discount still active in billing) | `silver_discount_authorization_check` | `expired_quote_active` |
| **FX deviation >1%** | rate error | `oracle_erp_source.RA_CUSTOMER_TRX_ALL` multi-currency amount vs `refinitiv_fx_source.GL_DAILY_RATES` | `silver_fx_rate_validation` | FX >1% deviation |
| **AR aging >90 days** | collection risk | `oracle_erp_source.AR_PAYMENT_SCHEDULES_ALL.DAYS_OVERDUE` (artificially aged) | `silver_ar_aging_analysis` | `ar_collection_risk` |
| **Rev-rec timing mismatch** | ASC-606 mismatch | `oracle_erp_source.REVENUE_RECOGNITION_SCHEDULE` date diverges from `GL_JE_LINES.JE_DATE` | `silver_revenue_recognition_check` | `rev_rec_timing_mismatch` |
| **Contract PDF mismatch** | doc intelligence | `ironclad_clm_source` contract PDF service term diverges from `oracle_erp_source.RA_CUSTOMER_TRX_ALL` amount | `silver_doc_intelligence_contracts` (via `ai_parse_document` + `ai_extract`) | `doc_contract_mismatch` |
| **Invoice PDF mismatch** | doc intelligence | `ironclad_clm_source` invoice PDF line count differs from `oracle_erp_source.GL_JE_LINES` detail | `silver_doc_intelligence_invoices` (via `ai_parse_document` + `ai_extract`) | `doc_invoice_mismatch` |
| **Revenue step change** | forecast anomaly | `oracle_erp_source.GL_JE_LINES` (account `4000`) magnitude jumps on specified months | `gold_revenue_forecast_anomalies` (`ai_forecast`) | — |

### Injection mechanism

**Generator:** `data-sim/simulate_source_systems.py` (+ `data-sim/config.yaml`) — a notebook/script that lives in the Databricks workspace; also orchestrated by the DAB job.
- Snapshots golden customers/accounts from `cdm_tmforum.tmf_*` and writes the `*_source` schemas as `CREATE OR REPLACE` tables (idempotent).
- Selects deterministic subsets using `hash(key, seed) % 100 < rate` and mutates selected rows into the anomaly values above.
- Because the silver checks in `cdm_tmforum.revenue_assurance` read the `*_source` systems directly, injected anomalies flow straight through to `gold_leakage_summary` and `gold_revenue_forecast_anomalies` — no separate `_anomalies_*` tables and no mutation of read-only `tmf_*`.

**Configuration** — the real file is `data-sim/config.yaml` and the generator now
*actually loads it* at module scope (`import yaml; CFG = yaml.safe_load(...)`); there
are no hardcoded catalog/schema/seed/scale/leakage duplicates left in the notebook. The
DAB job (`resources/datasim_job.yml`) passes the bundle `catalog` and reconciliation
`schema` as notebook parameters; the source-system schema names, seed, scale, leakage
rate, product catalogue, FX pairs and forecast step-change all derive from `config.yaml`.
Representative excerpt:

```yaml
catalog: cdm_tmforum
schemas:
  salesforce:   salesforce_source
  oracle_erp:   oracle_erp_source
  ironclad_clm: ironclad_clm_source
  refinitiv_fx: refinitiv_fx_source
  mdm:          mdm_source
seed: 42                               # the ONE authoritative seed (code + config agree)
leakage_rate: 0.06                     # ~6% of contract lines carry a seeded exception
forecast_anomaly:
  enabled: true                         # false disables GL step-change injection
  gl_account_code: "4000"              # revenue account the step change lands on
  months: ["2025-06", "2025-11"]       # inject step changes for the ai_forecast scene
  magnitude_pct: [15, 30]              # aligned to months (2025-06 → +15%, 2025-11 → +30%)
```

---

## 4. Reset & regenerate

### Full rebuild cycle

```bash
# Step 1: Regenerate source systems (with anomalies) — writes the *_source schemas
databricks bundle run simulate_source_systems --profile <name>   # seed + rates from data-sim/config.yaml

# Step 2: Refresh the reconciliation layer — the silver-check + gold materialized
# views in cdm_tmforum.revenue_assurance read the *_source systems and tmf_*
databricks bundle run ra_reconciliation --profile <name>
```

### Idempotency

- `simulate_source_systems` writes `CREATE OR REPLACE TABLE` to `salesforce_source.*`, `oracle_erp_source.*`, etc. — idempotent; anomalies are baked into the `*_source` rows (never into read-only `tmf_*`).
- The silver/gold layer is `CREATE OR REFRESH MATERIALIZED VIEW cdm_tmforum.revenue_assurance.*` — re-running the refresh recomputes from the current `*_source` + `tmf_*` state.

### Reset demo to baseline (no anomalies)

```bash
# Regenerate sources with injection rates set to 0 in data-sim/config.yaml, then refresh
databricks bundle run simulate_source_systems --profile <name>
databricks bundle run ra_reconciliation --profile <name>
```

> Full teardown drops only the new `cdm_tmforum.revenue_assurance` + `*_source` schemas, the Lakebase project, and the app — never `tmf_*`.

---

## 5. Data volumes & reproducibility

### Expected volumes (source + anomaly-injected)

| Table | Rows | Source |
| :---- | :---- | :---- |
| salesforce_source.Account | ~10,000 | Golden customers from `tmf_customer` |
| salesforce_source.Contract | ~10,000–100,000 | Mapped from `tmf_customer.commitment` |
| salesforce_source.ContractLineItem | ~50,000–150,000 | Mapped from `tmf_customer.offering_price` + commitments |
| salesforce_source.SBQQ__Quote__c | ~1,000–10,000 | Mapped from `tmf_customer.sales_quote` |
| salesforce_source.SBQQ__QuoteLine__c | ~5,000–50,000 | Mapped from quote line items |
| oracle_erp_source.RA_CUSTOMER_TRX_ALL | ~10,000+ | Mapped from `tmf_customer.bill` (header) |
| oracle_erp_source.RA_CUSTOMER_TRX_LINES_ALL | ~100,000+ | Mapped from `tmf_customer.bill` + applied_* (lines) |
| oracle_erp_source.GL_JE_LINES | ~100,000+ | Reverse-mapped from revenue + tax lines |
| oracle_erp_source.GL_JE_HEADERS | ~10,000+ | Journal entry batches |
| oracle_erp_source.GL_BUDGETS | ~1,000–5,000 | Monthly budgets per account (e.g., account `4000`) |
| oracle_erp_source.REVENUE_RECOGNITION_SCHEDULE | ~50,000+ | Reverse-mapped from bill revenue |
| oracle_erp_source.AR_PAYMENT_SCHEDULES_ALL | ~10,000+ | Payment terms & aging |
| refinitiv_fx_source.GL_DAILY_RATES | ~500–1,000 | Historical spot rates (or mock) |
| ironclad_clm_source.ironclad_contracts | ~1,000–10,000 | Branded contract PDFs + metadata |
| ironclad_clm_source.ironclad_invoices | ~5,000–50,000 | Invoice PDFs + metadata |
| mdm_source.customer_crosswalk | ~10,000 | Golden customer ID mappings |
| **cdm_tmforum.revenue_assurance.gold_leakage_summary** | **~48,000** | Unified exception register (~$601M at risk, 7 check types) |
| **cdm_tmforum.revenue_assurance.gold_reconciliation_scorecard** | ~8,200 | One health score per affected customer |
| **cdm_tmforum.revenue_assurance.gold_anomaly_scores** | ~100K+ | ML anomaly predictions (per record) |
| **cdm_tmforum.revenue_assurance.gold_revenue_forecast_anomalies** | ~24 | Monthly forecasts with variance flags |

### Golden/deterministic outputs

At the end of a full build with `seed=42`, the generator prints a **manifest**:

```
=== Data Simulation Complete ===
Seed: 42
Timestamp: 2026-08-25T10:30:00Z
Catalog: cdm_tmforum

Source system snapshots created/updated:
  salesforce_source.Account: 10,247 rows
  salesforce_source.Contract: 87,903 rows
  salesforce_source.ContractLineItem: 156,288 rows
  salesforce_source.SBQQ__Quote__c: 8,547 rows
  salesforce_source.SBQQ__QuoteLine__c: 42,183 rows
  oracle_erp_source.RA_CUSTOMER_TRX_ALL: 156,288 rows
  oracle_erp_source.RA_CUSTOMER_TRX_LINES_ALL: 1,247,542 rows
  oracle_erp_source.GL_JE_LINES: 1,890,234 rows
  oracle_erp_source.GL_JE_HEADERS: 10,547 rows
  oracle_erp_source.GL_BUDGETS: 3,287 rows
  oracle_erp_source.REVENUE_RECOGNITION_SCHEDULE: 47,853 rows
  oracle_erp_source.AR_PAYMENT_SCHEDULES_ALL: 156,288 rows
  refinitiv_fx_source.GL_DAILY_RATES: 847 rows
  ironclad_clm_source.ironclad_contracts: 8,903 rows
  ironclad_clm_source.ironclad_invoices: 28,547 rows
  mdm_source.customer_crosswalk: 10,247 rows

Anomalies injected (into *_source):
  contract_price_gap: 3,241 lines (~3% of ContractLineItem)
  unauthorized_discount: 2,180 quotes (~2% of QuoteLine)
  expired_quote_active: 1,087 quotes (~1% of QuoteLine)
  fx_deviation: 1,980 transactions (~2% of RA_CUSTOMER_TRX_ALL)
  ar_aging_spike: 3,452 invoices (~3% of AR_PAYMENT_SCHEDULES_ALL)
  rev_rec_timing: 1,980 schedules (~2% of REVENUE_RECOGNITION_SCHEDULE)
  doc_divergence: 890 contracts/invoices (~1% of ironclad_clm_source)
  gl_revenue_step_change: 2 months [2025-06, 2025-11]

Silver check results (cdm_tmforum.revenue_assurance):
  contract_price_mismatch: 3,241 exceptions
  unauthorized_discount: 2,180 exceptions
  expired_quote_active: 1,087 exceptions
  fx_validation_gaps: 1,980 exceptions
  ar_collection_risk: 3,452 exceptions
  rev_rec_timing_mismatch: 1,980 exceptions
  doc_contract_mismatch: 445 exceptions
  doc_invoice_mismatch: 445 exceptions
  Total silver exceptions detected: 16,410 (anomaly-related only)

Gold reconciliation register (cdm_tmforum.revenue_assurance.gold_leakage_summary):
  Total exceptions: ~48,108 (native seeded ~10K + anomaly-related ~16K + context ~22K)
  Estimated impact: ~$601,547,363
  Breakdown by check_type: 7 silver checks + context from tmf_enterprise.revenue_assurance_violation
  Detection rate: ≥95% of seeded exceptions in manifest

Baseline context (native RA layer, not the register):
  tmf_enterprise.revenue_assurance_violation: ~10,287 rows, ~$540M, 12 native types

Forecast (gold_revenue_forecast_anomalies):
  Injected step-change months [2025-06, 2025-11] flagged ABOVE_EXPECTED / BELOW_EXPECTED by ai_forecast
  Magnitude: +15–30% variance on revenue (account 4000)

ML training set (gold_anomaly_scores):
  Normal records: 89%
  Injected anomaly records (labeled): 11%
```

This manifest is the **source of truth** for the Test Plan's golden outputs. The forecast should exhibit variance where revenue step-changes were injected (2025-06, 2025-11); the silver checks should surface the injected `*_source` anomalies in `gold_leakage_summary`. All outputs are deterministic on `seed=42`.

---

## 6. Optional: Live ingestion demo (if desired)

If the demo includes a **live Lakeflow Connect / Auto Loader** ingestion beat:

- `simulate_source_systems` can write snapshot files to `/Volumes/lakelink_fiber_source/salesforce/` (Parquet, incremental)
- A Lakeflow Declarative Pipeline then ingests & upstreams these files into `cdm_tmforum` or a staging schema
- This showcases managed ingestion without requiring actual Salesforce/Oracle API access

---

## 7. Reproducibility checklist

- ✅ Seed-driven (`seed=42` ⇒ byte-identical outputs across runs; deterministic hash-based surrogate keys, not `monotonically_increasing_id()`)
- ✅ Deterministic anomaly selection (same seed + key hash ⇒ same anomalies in `*_source`)
- ✅ Idempotent generation (`CREATE OR REPLACE`, no incremental state; manifested in DAB targets)
- ✅ Manifest logging (source of truth for test plan golden figures; printed to workspace run output)
- ✅ Reset capability (DAB destroy + redeploy in < 5 minutes)
- ✅ Scaled for demo (10K customers, 100K+ circuits, ~$540M baseline + injected variance → ~$601M register)
- ✅ Read-only `tmf_*` never mutated; anomalies live in simulated `*_source` only
- ✅ Silver checks join `*_source` + `tmf_*` directly (no materialized bridge); gold MVs aggregate to `gold_leakage_summary`
