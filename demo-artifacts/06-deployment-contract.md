# RA Demo — Deployment Contract

> **Scrutiny summary**
> - **Cloud/workspace:** Original stated "Azure Databricks (mirrors Rogers Communications reference architecture)" as fact. **Corrected to:** deploy to the real `demo-workspace` workspace via the `demo` CLI profile; Rogers is narrative reference only, not deployment assumption. Confirm cloud at deploy time.
> - **Catalog creation:** Original created a new `lumen_ra` catalog. **Corrected to:** use existing `cdm_tmforum` catalog (already populated with 100K+ rows, 2018–2025 billing). Build only new schemas (`ra_silver`, `ra_gold`) within it.
> - **Data generation:** Original included a synthetic-data job. **Corrected to:** `cdm_tmforum` already has full golden data. Demo only needs `simulate_source_systems` to land upstream system data in `*_source` schemas (salesforce_source, oracle_erp_source, etc.).
> - **Compute:** Serverless SQL warehouse is referenced by id (assumed to exist in demo-workspace; not created by bundle). All jobs/pipelines run serverless.
> - **Teardown:** Corrected to drop only NEW `ra_*`/`*_source` schemas + app + jobs, never `tmf_*` (read-only golden data owned by Databricks).
> - **DAB commands verified:** `databricks bundle validate`, `deploy`, `run`, `destroy` are current (Databricks Asset Bundles 1.0+).

**Demo:** Revenue Assurance Lakehouse for Lakelink Fiber (pitched to Lumen Technologies)  
**Repo:** `revenue-assurance` | **IaC:** Databricks Asset Bundles (DABs)  
**Workspace:** `demo-workspace` (`demo` CLI profile) — confirm cloud at deploy time  
**Catalog:** `cdm_tmforum` (TM Forum SID Common Data Model, pre-populated)

This contract is the authority on *how the demo is provisioned, secured, deployed, and torn down*. A coding agent following it must be able to go from a clean workspace state to a running demo — and back to clean — with a fixed command sequence and no manual clicks.

---

## 1. Workspace & catalog assumptions

- **Workspace:** `demo-workspace` (accessed via `demo` CLI profile). Unity Catalog-enabled, serverless entitlement on, metastore attached.
- **Catalog:** `cdm_tmforum` — **pre-populated TM Forum SID Common Data Model**; owned by Databricks, read-only for RA use. Fully populated (1K–100K rows per table, 2018–2025 billing history).
- **New schemas:** DAB creates `ra_silver` and `ra_gold` within `cdm_tmforum` (idempotent).
- **Compute posture:** **serverless-first** — serverless SQL warehouse (referenced by id, assumed to exist) + serverless jobs and pipelines. **No classic clusters** created by the bundle.
- **Identity:** the deploying principal is a workspace admin (or has `CREATE SCHEMA` on `cdm_tmforum`, plus app/warehouse reference rights).
- **Region:** single region; no multi-region or DR in scope.

---

## 2. Schema creation

The bundle owns schema creation so the demo is self-contained within `cdm_tmforum`.

| Object | Name | Created by | Notes |
| :---- | :---- | :---- | :---- |
| Catalog | `cdm_tmforum` | **Pre-existing** (Databricks-owned) | Read-only inputs; do not modify tmf_* schemas |
| Schema | `ra_silver` | bundle (schema resource + init SQL) | Conformed + bridge tables (dims, facts, service_instance) |
| Schema | `ra_gold` | bundle (schema resource + init SQL) | Reconciliation exceptions, KPIs, forecast |
| Schemas | `salesforce_source`, `oracle_erp_source`, `refinitiv_fx_source`, `ironclad_clm_source`, `mdm_source` | bundle | Simulated upstream data (keyed to golden customers) |

Creation is idempotent — declared as bundle `schemas` resources and a guarded `CREATE SCHEMA IF NOT EXISTS` in the init task. Re-deploying never drops data; `destroy` removes only the new schemas (§8).

```sql
-- src/setup/00_schemas.sql (run by the init task)
CREATE SCHEMA IF NOT EXISTS cdm_tmforum.ra_silver;
CREATE SCHEMA IF NOT EXISTS cdm_tmforum.ra_gold;
CREATE SCHEMA IF NOT EXISTS cdm_tmforum.salesforce_source;
CREATE SCHEMA IF NOT EXISTS cdm_tmforum.oracle_erp_source;
CREATE SCHEMA IF NOT EXISTS cdm_tmforum.refinitiv_fx_source;
CREATE SCHEMA IF NOT EXISTS cdm_tmforum.ironclad_clm_source;
CREATE SCHEMA IF NOT EXISTS cdm_tmforum.mdm_source;
```

---

## 3. Unity Catalog permissions & grants model

Least-privilege, expressed as grants in `src/setup/01_grants.sql` (run post-create) so they are reproducible, not click-configured.

| Principal (group) | Grant | Scope |
| :---- | :---- | :---- |
| `ra_engineers` (Priya) | `ALL PRIVILEGES` | `cdm_tmforum.ra_silver`, `cdm_tmforum.ra_gold`, `*_source` |
| `ra_analysts` (Marcus) | `USE SCHEMA`, `SELECT` | `cdm_tmforum.ra_gold`, `cdm_tmforum.ra_silver` |
| `ra_execs` (Dana) | `USE SCHEMA`, `SELECT` | `cdm_tmforum.ra_gold` only |
| App service principal | `SELECT` on `cdm_tmforum.ra_gold.*`, `cdm_tmforum.ra_silver.*`; `MODIFY` on `cdm_tmforum.ra_gold.exception_case` | scoped to the app's needs |

**PII masking:** `cdm_tmforum.ra_silver.dim_customer.customer_name` carries the UC tag `pii` and a column mask that returns a masked value to principals outside `ra_engineers`. The demo shows a masked vs. unmasked query as the governance proof.

```sql
ALTER TABLE cdm_tmforum.ra_silver.dim_customer
  ALTER COLUMN customer_name SET MASK cdm_tmforum.ra_gold.mask_pii;
```

---

## 4. Secrets

- **Secret scope:** `revenue_assurance` (Databricks-backed).  
- No cloud keys, tokens, or workspace URLs in code — all sourced from the scope or bundle variables.

| Secret key | Purpose |
| :---- | :---- |
| `revenue_assurance/app_sql_warehouse_id` | warehouse the app queries |
| `revenue_assurance/genie_space_id` | Genie space bound to the app/dashboard |

```shell
databricks secrets create-scope revenue_assurance
databricks secrets put-secret revenue_assurance app_sql_warehouse_id --string-value "$WAREHOUSE_ID"
```

---

## 5. Compute / serverless policy

- **SQL:** one **serverless SQL warehouse** (`ra_serverless_wh`, size `Small`, auto-stop 10 min) serves the dashboard, Genie, reconciliation SQL, and the app. Referenced by id via the `warehouse_id` variable (assumed to exist in demo-workspace; not created by bundle).
- **Jobs & pipeline:** all run on **serverless** compute (`serverless: true` on tasks / `serverless` pipeline). No `job_clusters`, no `new_cluster`, no instance pools.
- **Rationale:** zero cluster warmup in a live demo, nothing left running to bill, reproducible across workspaces.

---

## 6. IaC — Databricks Asset Bundles

- **Bundle name:** `revenue_assurance`  
- **Targets:** `dev` (default, build/iterate) and `prod` (demo delivery).  
- **Resources deployed:** the medallion Lakeflow Declarative Pipeline, the reconciliation job, the ML/forecast job, the AI/BI dashboard, and the "RA Exceptions Console" app. **Not** a synthetic-data generation job (data exists in `cdm_tmforum`).

### Sample `databricks.yml` skeleton

```yaml
bundle:
  name: revenue_assurance

variables:
  warehouse_id:
    description: Serverless SQL warehouse id (must exist in demo-workspace)
  seed:
    default: "424242"

include:
  - resources/*.yml

targets:
  dev:
    mode: development
    default: true
    workspace:
      host: ${DATABRICKS_HOST}     # from profile/env, never hard-coded
    variables:
      warehouse_id: ${DATABRICKS_WAREHOUSE_ID}

  prod:
    mode: production
    workspace:
      host: ${DATABRICKS_HOST}
      root_path: /Workspace/Shared/revenue-assurance
    variables:
      warehouse_id: ${DATABRICKS_WAREHOUSE_ID}
```

```yaml
# resources/app.yml
resources:
  apps:
    ra_exceptions_console:
      name: ra-exceptions-console          # display: "RA Exceptions Console"
      source_code_path: ../app
      resources:
        - name: sql-warehouse
          sql_warehouse:
            id: ${var.warehouse_id}
            permission: CAN_USE
```

```yaml
# resources/pipeline_medallion.yml
resources:
  pipelines:
    ra_medallion_pipeline:
      name: ra_medallion_pipeline
      serverless: true
      catalog: cdm_tmforum
      schema: ra_silver
      libraries:
        - file: { path: ../src/pipelines/silver_dimensions.py }
        - file: { path: ../src/pipelines/silver_facts.py }
        - file: { path: ../src/pipelines/silver_service_instance.py }
```

---

## 7. Deploy sequence

```shell
# 0. Prereqs: authenticate the CLI to demo-workspace
databricks auth login --host https://<demo-workspace-host>

# 1. Validate the bundle (schema, refs, permissions)
databricks bundle validate -t dev

# 2. Deploy resources (schemas, jobs, pipeline, dashboard, app)
databricks bundle deploy -t dev

# 3. Seed upstream systems → run the medallion pipeline → run reconciliation + ML
databricks bundle run ra_simulate_source_systems -t dev
databricks bundle run ra_medallion_pipeline         -t dev
databricks bundle run ra_reconciliation            -t dev
databricks bundle run ra_ml_and_forecast           -t dev

# 4. (prod delivery) repeat validate/deploy/run with -t prod
databricks bundle validate -t prod
databricks bundle deploy -t prod
databricks bundle run ra_simulate_source_systems -t prod
databricks bundle run ra_medallion_pipeline         -t prod
databricks bundle run ra_reconciliation            -t prod
databricks bundle run ra_ml_and_forecast           -t prod
```

**Order matters:** schema creation first (in deploy), then simulate upstream → pipeline → reconciliation → ML, since each consumes the prior layer.

---

## 8. Teardown

```shell
databricks bundle destroy -t dev     # prompts for confirmation
```

`destroy` removes every bundle-managed resource:
- Jobs: `ra_simulate_source_systems`, `ra_reconciliation`, `ra_ml_and_forecast`
- Pipeline: `ra_medallion_pipeline`
- App: `ra-exceptions-console`
- **Schemas created by bundle:** `ra_silver`, `ra_gold`, `salesforce_source`, `oracle_erp_source`, `refinitiv_fx_source`, `ironclad_clm_source`, `mdm_source` (dropped from `cdm_tmforum`)
- **NOT touched:** `cdm_tmforum.tmf_*` schemas (read-only golden data, owned by Databricks)

Secrets in the `revenue_assurance` scope are removed separately if desired:

```shell
databricks secrets delete-scope revenue_assurance
```

---

## 9. Reproducibility guarantees

- **Deterministic data:** the source simulator uses a fixed `seed` (424242) variable → identical rows, identical golden exception counts/$ across environments.
- **No hard-coded workspace state:** host and warehouse id come from profile/variables — the same bundle deploys to any Databricks UC workspace (e.g., prod workspace or another dev workspace).
- **Idempotent deploys:** re-running `deploy` converges resources; re-running `run` re-seeds to the same golden state.
- **Environment parity:** `dev` and `prod` differ only in `mode` and `root_path`; schemas, table names, and logic are identical.
- **Real data:** seeded violations and billing history already exist in `cdm_tmforum` (no generation or fabrication).

---

## 10. Prerequisites

| Requirement | Minimum |
| :---- | :---- |
| Databricks CLI | v0.230+ (bundle-aware, serverless resources) |
| Workspace | `demo-workspace` (Unity Catalog-enabled, metastore attached) |
| Catalog | `cdm_tmforum` (pre-populated, read-only TM Forum SID model) |
| Compute | serverless SQL warehouse (must exist in workspace; id provided via `warehouse_id` variable) |
| Entitlements | serverless jobs/SQL, Databricks Apps enabled |
| Deploying principal | workspace admin (or schema-create + app/warehouse rights on `cdm_tmforum`) |
| Local | Python 3.10+ for local test runs; `git`; network to demo-workspace |

---

## 11. Notes on real data vs. narrative

- **Golden data in `cdm_tmforum`:** ~10,000 customers, ~100,000 circuits, ~10,000 RA violations (~$540M estimated impact). This is the **actual demo dataset**.
- **Lumen Technologies pitch:** $250M–$312M annual leakage is the **narrative business case** we show to Lumen to frame why they should invest in RA. Keep this separate in demo narration.
- **Lakelink Fiber:** the fictional operator whose data the demo shows (all unstructured docs, branding, persona narratives refer to Lakelink Fiber, not Lumen).
- **Cloud/platform:** Rogers Communications' reference architecture is mentioned as narrative context only. Deploy to `demo-workspace` (confirm cloud with workspace admin at deploy time).
