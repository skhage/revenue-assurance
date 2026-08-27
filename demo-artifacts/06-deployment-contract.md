# RA Demo — Deployment Contract

> **Scrutiny summary**
> - ✅ **2026-08-27:** Added the Lakebase transactional outbox → Delta `workflow_case_state` projection, canonical `gold_exception_workflow` consumer view, required app-SP `CREATE TABLE` grant, and projection health/retry behavior for dashboard and Genie consistency.
> - ✅ **2026-08-26:** Aligned to the **built** system. Single new schema `cdm_tmforum.revenue_assurance` (not a `ra_silver`/`ra_gold` split); the reconciliation layer is **materialized views** defined in `reconciliation/transformations/*.sql`, not a dim/fact Lakeflow pipeline. The **RA Exceptions Console** is a **Databricks AppKit** app (React/TypeScript) with its own `databricks.yml`, deployed via `databricks apps deploy --profile <name>`; it reads analytics via a SQL warehouse and writes case state to **Lakebase Postgres** (project `ra-console-lakebase`, schema `ra`). Grants, teardown, and the deploy sequence updated accordingly.
> - **Cloud/workspace:** deploy to the real `demo-workspace` via the `demo` CLI profile; the workspace **host is never hardcoded** — it resolves from the profile (`--profile <name>`). Rogers is narrative reference only; confirm cloud at deploy time.
> - **Catalog:** use the existing, pre-populated `cdm_tmforum` catalog (100K+ rows, 2018–2025 billing). Build only new schemas within it; `tmf_*` are read-only. ❌ Original invented a `lumen_ra` catalog + `ra_silver`/`ra_gold` split.
> - **Data generation:** `cdm_tmforum` already holds full golden data. The demo only runs `simulate_source_systems` to land upstream data in the `*_source` schemas.
> - **Teardown:** drops only the NEW `revenue_assurance`/`*_source` schemas, the Lakebase project, the app, and jobs — never `tmf_*`.

**Demo:** Revenue Assurance Lakehouse for Lakelink Fiber (pitched to Lumen Technologies)
**Repo:** `revenue-assurance` | **IaC:** Databricks Asset Bundles (DABs) + `databricks apps`
**Workspace:** `demo-workspace` (`demo` CLI profile) — host resolves from the profile, confirm cloud at deploy time
**Catalog:** `cdm_tmforum` (TM Forum SID Common Data Model, pre-populated)

This contract is the authority on *how the demo is provisioned, secured, deployed, and torn down*. A coding agent following it must be able to go from a clean workspace to a running demo — and back to clean — with a fixed command sequence and no manual clicks.

---

## 1. Workspace & catalog assumptions

- **Workspace:** `demo-workspace` (accessed via the `demo` CLI profile). Unity Catalog-enabled, serverless entitlement on, Databricks Apps + Lakebase enabled, metastore attached.
- **Catalog:** `cdm_tmforum` — **pre-populated TM Forum SID Common Data Model**; owned by Databricks, read-only for RA use. Fully populated (1K–100K rows/table, 2018–2025 billing).
- **New schema:** the demo builds a **single** schema `cdm_tmforum.revenue_assurance` (silver + gold materialized views), plus the simulated `*_source` schemas.
- **Compute posture:** **serverless-first** — a serverless SQL warehouse (referenced by id) powers the reconciliation MVs, the AI/BI dashboard, Genie, and the app's analytics reads. **No classic clusters.**
- **Identity:** the deploying principal can `CREATE SCHEMA` on `cdm_tmforum` and manage apps + a Lakebase project. The **app runs as its own service principal** (created with the app) — it needs UC read grants (see §3).
- **Region:** single region; no multi-region/DR in scope.

---

## 2. Schema creation

One new schema holds the whole RA layer; the `*_source` schemas hold simulated upstream data.

| Object | Name | Created by | Notes |
| :---- | :---- | :---- | :---- |
| Catalog | `cdm_tmforum` | **Pre-existing** (Databricks-owned) | Read-only inputs; never modify `tmf_*` |
| Schema | `revenue_assurance` | demo build (owner = demo user) | 7 **silver** check MVs + 4 **gold** MVs (register/scorecard/anomaly/forecast) |
| Schemas | `salesforce_source`, `oracle_erp_source`, `refinitiv_fx_source`, `ironclad_clm_source`, `mdm_source` | `simulate_source_systems` | Simulated upstream data, keyed to golden customers |
| Lakebase schema | `ra` (in project `ra-console-lakebase`) | **app service principal** at first run | `ra.cases`, `ra.case_notes` — mutable case state (Postgres, not Delta) |

```sql
-- one schema for the whole RA layer
CREATE SCHEMA IF NOT EXISTS cdm_tmforum.revenue_assurance;
-- simulated upstream systems (created by the simulate_source_systems notebook)
CREATE SCHEMA IF NOT EXISTS cdm_tmforum.salesforce_source;
CREATE SCHEMA IF NOT EXISTS cdm_tmforum.oracle_erp_source;
CREATE SCHEMA IF NOT EXISTS cdm_tmforum.refinitiv_fx_source;
CREATE SCHEMA IF NOT EXISTS cdm_tmforum.ironclad_clm_source;
CREATE SCHEMA IF NOT EXISTS cdm_tmforum.mdm_source;
```

The reconciliation layer is a set of **materialized views** (`CREATE OR REFRESH MATERIALIZED VIEW`) defined in
`reconciliation/transformations/{silver_reconciliation.sql, silver_doc_intelligence.sql, gold_aggregation.sql}`:
- **silver:** `silver_contract_price_reconciliation`, `silver_discount_authorization_check`, `silver_fx_rate_validation`, `silver_ar_aging_analysis`, `silver_revenue_recognition_check`, `silver_doc_intelligence_contracts`, `silver_doc_intelligence_invoices`
- **gold:** `gold_leakage_summary` (unified register), `gold_reconciliation_scorecard`, `gold_anomaly_scores`, `gold_revenue_forecast_anomalies`

Re-applying is idempotent (`CREATE OR REFRESH`); a `REFRESH MATERIALIZED VIEW` re-computes against the latest source data.

---

## 3. Unity Catalog permissions & grants model

Least-privilege, reproducible as SQL grants (not click-configured).

| Principal (group) | Grant | Scope |
| :---- | :---- | :---- |
| `ra_engineers` (Priya) | `ALL PRIVILEGES` | `cdm_tmforum.revenue_assurance`, `*_source` |
| `ra_analysts` (Marcus) | `USE SCHEMA`, `SELECT` | `cdm_tmforum.revenue_assurance` |
| `ra_execs` (Dana) | `USE SCHEMA`, `SELECT` | `cdm_tmforum.revenue_assurance` (gold MVs) |
| **App service principal** | `USE CATALOG` on `cdm_tmforum`; `USE SCHEMA` + `SELECT` + `CREATE TABLE` on `cdm_tmforum.revenue_assurance` | required for app reads/typegen and for the Lakebase outbox projection table + canonical workflow view |

```sql
-- app SP grants (SP = the service_principal_client_id from `databricks apps get`)
GRANT USE CATALOG ON CATALOG cdm_tmforum                        TO `<app-sp-client-id>`;
GRANT USE SCHEMA  ON SCHEMA  cdm_tmforum.revenue_assurance       TO `<app-sp-client-id>`;
GRANT SELECT      ON SCHEMA  cdm_tmforum.revenue_assurance       TO `<app-sp-client-id>`;
GRANT CREATE TABLE ON SCHEMA cdm_tmforum.revenue_assurance       TO `<app-sp-client-id>`;
```

> Case-management writes commit to **Lakebase Postgres** first. The app SP then drains `ra.workflow_outbox` into Delta `workflow_case_state` and maintains `gold_exception_workflow` for dashboard/Genie reads. If projection fails, writes remain queued and `/api/workflow/health` returns 503 until retries succeed.

**PII masking (governance proof):** apply a UC column mask to a name column in the RA layer — e.g. `revenue_assurance.gold_reconciliation_scorecard.account_name` — so principals outside `ra_engineers` see a masked value. The demo shows a masked vs. unmasked query. (`tmf_*` stays untouched.)

---

## 4. Secrets

- **Secret scope:** `revenue_assurance` (Databricks-backed) — optional; the app resolves its warehouse + Lakebase resources through its `databricks.yml`/`app.yaml` resource bindings, not secrets.
- No cloud keys, tokens, or workspace URLs in code — all from the profile, bundle variables, or resource bindings.

| Secret key | Purpose |
| :---- | :---- |
| `revenue_assurance/genie_space_id` | Genie space bound to the dashboard/app (if used) |

---

## 5. Compute / serverless policy

- **SQL:** one **serverless SQL warehouse** (referenced by id via a variable) serves the reconciliation MVs, the AI/BI dashboard, Genie, and the app's analytics reads. Assumed to exist; not created by the bundle.
- **Lakebase:** one Autoscaling **Lakebase project** (`ra-console-lakebase`, 1 CU, scale-to-zero) holds case state.
- **Rationale:** zero warmup in a live demo, nothing left billing, reproducible across workspaces.

---

## 6. IaC — Databricks Asset Bundles + `databricks apps`

Two deployable units:

1. **Reconciliation layer** — the silver/gold MVs applied to `cdm_tmforum.revenue_assurance` by running `reconciliation/transformations/*.sql` on the serverless warehouse (as a Lakeflow Declarative Pipeline or a scheduled SQL task), plus `data-sim/simulate_source_systems.py` for the `*_source` data.
2. **RA Exceptions Console** — an **AppKit** project at `ra-exceptions-console/` with its own `databricks.yml`. It declares two resources — a **SQL warehouse** (`analytics` plugin) and a **Lakebase Postgres** project/branch/database (`lakebase` plugin) — and deploys with `databricks apps deploy`.

### App `databricks.yml` skeleton (real)

```yaml
bundle:
  name: ra-exceptions-console

# The repo-root Python .gitignore's `lib/` rule would exclude client/src/lib from
# the bundle sync; force-include it or the platform build fails.
sync:
  include:
    - client/src/lib/**

variables:
  sql_warehouse_id: { description: Serverless SQL warehouse id }
  postgres_project:  { description: Lakebase project resource name }
  postgres_branch:   { description: Lakebase branch resource name }
  postgres_database: { description: Lakebase database resource name }

resources:
  apps:
    app:
      name: ra-exceptions-console            # display: "RA Exceptions Console"
      source_code_path: ./
      resources:
        - name: sql-warehouse
          sql_warehouse: { id: ${var.sql_warehouse_id}, permission: CAN_USE }
        - name: postgres
          postgres:
            branch:   ${var.postgres_branch}
            database: ${var.postgres_database}
            permission: CAN_CONNECT_AND_CREATE

targets:
  default:
    default: true
    # Host resolves from the CLI profile — never hardcode the workspace hostname.
    variables:
      sql_warehouse_id: <warehouse-id>
      postgres_project:  projects/ra-console-lakebase
      postgres_branch:   projects/ra-console-lakebase/branches/production
      postgres_database: projects/ra-console-lakebase/branches/production/databases/databricks-postgres
```

---

## 7. Deploy sequence

```shell
# 0. Prereqs: authenticate the CLI (host comes from the profile)
databricks auth login --profile <name>

# 1. Simulate upstream source systems (lands *_source schemas)
#    run data-sim/simulate_source_systems.py on the workspace (+ config.yaml)

# 2. Build the reconciliation layer: apply the silver + gold materialized views
#    reconciliation/transformations/{silver_reconciliation,silver_doc_intelligence,gold_aggregation}.sql
#    on the serverless SQL warehouse (CREATE OR REFRESH MATERIALIZED VIEW ...)

# 3. Provision Lakebase (once) for case state
databricks postgres create-project ra-console-lakebase \
  --json '{"spec":{"display_name":"RA Console Lakebase"}}' --profile <name>

# 4. Deploy the AppKit app (builds → bundle deploy → runs). Do this BEFORE running it
#    locally so the app SP creates and owns the Lakebase `ra` schema.
cd ra-exceptions-console
databricks apps deploy --profile <name>

# 5. Grant the app SP UC read access (see §3), then redeploy if the first build
#    failed on INSUFFICIENT_PERMISSIONS during typegen.
databricks apps deploy --profile <name>
```

**Order matters:** sources → reconciliation MVs → Lakebase → app. The app's platform build re-runs typegen as the SP, so the §3 grants must be in place for a clean build.

---

## 8. Teardown

```shell
# App + its bundle resources
cd ra-exceptions-console && databricks bundle destroy --profile <name>

# Lakebase project (deletes all case data — confirm first)
databricks postgres delete-project ra-console-lakebase --profile <name>

# RA schema + simulated sources (drops MVs + source tables; never tmf_*)
databricks experimental aitools tools query --profile <name> \
  "DROP SCHEMA IF EXISTS cdm_tmforum.revenue_assurance CASCADE"
# repeat DROP SCHEMA for each *_source schema
```

- **Removed:** the `revenue_assurance` schema (all silver/gold MVs), the `*_source` schemas, the Lakebase project (`ra` schema/case data), and the app.
- **NOT touched:** `cdm_tmforum.tmf_*` (read-only golden data, Databricks-owned).

---

## 9. Reproducibility guarantees

- **Deterministic source data:** `simulate_source_systems` uses a fixed seed → identical rows and identical golden exception counts/$ across environments.
- **No hard-coded workspace state:** the workspace host comes from the profile; the warehouse id and Lakebase resource paths come from bundle variables — the same app deploys to any UC workspace.
- **Idempotent:** `CREATE OR REFRESH MATERIALIZED VIEW` converges the RA layer; `databricks apps deploy` converges the app.
- **Real data:** seeded violations and billing history already exist in `cdm_tmforum` (no fabrication).

---

## 10. Prerequisites

| Requirement | Minimum |
| :---- | :---- |
| Databricks CLI | v1.x (Apps + Lakebase/`postgres` subcommands, `apps deploy`) |
| Node.js | v22+ with `npm` (AppKit build) |
| Workspace | `demo-workspace` (UC-enabled, Apps + Lakebase entitled) |
| Catalog | `cdm_tmforum` (pre-populated, read-only TM Forum SID model) |
| Compute | serverless SQL warehouse (id via variable); a Lakebase project |
| Deploying principal | `CREATE SCHEMA` on `cdm_tmforum` + Apps/Lakebase management; ability to `GRANT` to the app SP |
| Local | `git`; network to `demo-workspace` |

---

## 11. Notes on real data vs. narrative

- **Golden data in `cdm_tmforum`:** ~10,000 customers, ~100,000 circuits, ~10,000 native RA violations (~$540M estimated impact). The **derived** `revenue_assurance.gold_leakage_summary` register — what the app and dashboard actually query — totals **~48K exceptions / ~$601M at risk** across 7 `check_type`s.
- **Lumen Technologies pitch:** $250M–$312M annual leakage is the **narrative business case** shown to Lumen; keep it separate from the demo dataset's figures.
- **Lakelink Fiber:** the fictional operator whose data the demo shows (all docs, branding, personas).
- **Cloud/platform:** Rogers Communications' architecture is narrative context only. Deploy to `demo-workspace` (confirm cloud at deploy time).
