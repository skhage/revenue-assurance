# ra-exceptions-console

A Databricks App powered by [AppKit](https://developers.databricks.com/docs/appkit/v0/), featuring React, TypeScript, and Tailwind CSS.

**Enabled plugins:**

- **Analytics** -- SQL query execution against Databricks SQL Warehouses
- **Lakebase** -- Fully managed Postgres database for transactional (OLTP) workloads on Databricks
- **Server** -- Express HTTP server with static file serving and Vite dev mode

## Screens

- **Overview** -- KPI tiles and root-cause breakdown from `gold_leakage_summary`.
- **Exception queue** -- filterable, paginated register of detected leakage.
- **My cases** -- cases you (or anyone) have started working, with the full lifecycle.
- **Agent Workbench** -- four deterministic, rule-based panels over the same data (see below).
- **Architecture** -- how the demo maps onto the Databricks Data + AI Platform.

## Agent Workbench

A single tab with four sub-tabs, each showcasing one narrow, deterministic capability over data
this app already reads. **None of these use an LLM or a Model Serving endpoint** — every
agent-computed value in the UI carries a "Deterministic · rule-based" or "Demo data" badge so
that's never ambiguous. See `demo-artifacts/07-ui-specs.md` §5.5 and `demo-artifacts/10-decision-log.md`
ADR-015 for the full design rationale.

| Tab                      | What it shows                                                                           | Computed how                                                                                                                                                                            |
| :----------------------- | :-------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Pipeline reliability** | Freshness/quality of the reconciliation pipeline (`dq_audit`)                           | Reads `cdm_tmforum.revenue_assurance.dq_audit`; summarized server-side into `ok`/`stale`/`red`/`unavailable` (`server/routes/dqAudit.ts`, `summarizePipelineHealth`)                    |
| **Investigate**          | A cited root-cause hypothesis + confidence for a selected exception                     | `client/src/lib/agents/hypothesis.ts` — cites literal evidence fields from `exception_detail`                                                                                           |
| **Prioritize & route**   | A ranked queue with a recommended analyst/queue; carries the selected exception forward | `client/src/lib/agents/scoring.ts` (amount 35 + severity 25 + age 20 + evidence 20) + a small **demo** analyst roster (`roster.ts`) — not a live capacity feed                          |
| **Recovery playbook**    | A check-type-specific recovery action, expected recovery $, owner, deadline             | `client/src/lib/agents/playbook.ts` — a fixed 7-entry template table, one row per reconciliation check_type; recovery %/owner/deadline are labeled **demo data**, not measured outcomes |

**Safety controls, all enforced in code, not just documented:**

- **Pipeline gate.** If `dq_audit` reports `red`, is unreachable, **or is `stale`** (freshest
  observation older than 72h), the Investigate/Prioritize/Recovery tabs render only a blocking
  alert — no recommendation is computed, no "Apply" button renders. Stale evidence is a hard block,
  not a soft warning: `isBlocked()` in `client/src/lib/agents/types.ts` is the single source of
  truth every panel calls, so this can't drift per-panel. The DQ route itself also fails closed —
  any row with a null/unrecognized/inconsistent status is treated as failing, never GREEN.
- **Human approval before any mutation.** Every recommendation is inert until a user clicks "Apply."
  There is no auto-apply, no background write, no polling loop.
- **Existing API is the only mutation gateway.** "Apply" buttons call the same
  `POST /api/cases/:id/assign|status|notes` routes the Queue and Cases pages already use — no new
  mutation route was added for this feature.
- **Audit-before-mutation, not audit-after.** Every "Apply" writes its structured
  `[Agent: <name>] run_at=… · inputs={…} · output={…}` note **before** attempting any case-lifecycle
  mutation. If the note write fails, no mutation is attempted at all. If a later mutation step fails,
  the note has already landed, so a human reviewing the case sees exactly what was approved even if
  the transition didn't finish; retrying resumes at the mutation step without re-writing the note.
- **Shared selection across the loop.** Investigate, Prioritize & route, and Recovery playbook share
  one "selected exception" — pick it in Investigate, or "Carry forward" a ranked row in Prioritize &
  route, and Recovery playbook opens already showing it.

### Demo script (~3 minutes)

1. Open **Agent Workbench → Pipeline reliability**. Point out the green/fresh status and the
   `dq_audit` snapshot — this is the gate the other three tabs respect (and note that `stale`, not
   just `red`/unreachable, blocks them too).
2. Switch to **Investigate**, search for an account, select an exception. Read the hypothesis aloud
   and point at the literal `check_type=…`, `source_table=…`, `risk_tier=…` values it cites, and the
   "Deterministic · rule-based" badge.
3. Switch to **Prioritize & route** — the same exception is highlighted in the ranked table. Show the
   recommended analyst/queue column; call out the "Demo data" badge on the roster — this is
   illustrative routing, not live capacity.
4. Switch to **Recovery playbook** — it opens already showing that exception's plan. Show the
   templated action, expected recovery $, owner, and deadline (all under a "Demo data" caveat); click
   **Apply** and narrate that this is the exact same status-change call a human would make from the
   Cases page — then open the case's notes timeline to show the `[Agent: Recovery Playbook]` audit
   note, written before the status change, that was just recorded.

## Prerequisites

- Node.js v22+ and npm
- Databricks CLI (for deployment)
- Access to a Databricks workspace

## Databricks Authentication

### Local Development

For local development, configure your environment variables by creating a `.env` file:

```bash
cp .env.example .env
```

Edit `.env` and set the environment variables you need:

```env
DATABRICKS_HOST=https://your-workspace.cloud.databricks.com
DATABRICKS_APP_PORT=8000
# ... other environment variables, depending on the plugins you use
```

#### Lakebase Configuration

The Lakebase plugin requires additional environment variables for PostgreSQL connectivity. To learn how to configure the Lakebase plugin, see the [Lakebase plugin documentation](https://developers.databricks.com/docs/appkit/v0/plugins/lakebase).

### CLI Authentication

The Databricks CLI requires authentication to deploy and manage apps. Configure authentication using one of these methods:

#### OAuth U2M

Interactive browser-based authentication with short-lived tokens:

```bash
databricks auth login --host https://your-workspace.cloud.databricks.com
```

This will open your browser to complete authentication. The CLI saves credentials to `~/.databrickscfg`.

#### Configuration Profiles

Use multiple profiles for different workspaces:

```ini
[DEFAULT]
host = https://dev-workspace.cloud.databricks.com

[production]
host = https://prod-workspace.cloud.databricks.com
client_id = prod-client-id
client_secret = prod-client-secret
```

Deploy using a specific profile:

```bash
databricks bundle deploy --profile production
```

**Note:** Personal Access Tokens (PATs) are legacy authentication. OAuth is strongly recommended for better security.

## Getting Started

### Install Dependencies

```bash
npm install
```

### Development

Run the app in development mode with hot reload:

```bash
npm run dev
```

The app will be available at the URL shown in the console output.

### Build

Build both client and server for production:

```bash
npm run build
```

This creates:

- `dist/server.js` - Compiled server bundle
- `client/dist/` - Bundled client assets

### Production

Run the production build:

```bash
npm start
```

## Code Quality

There are a few commands to help you with code quality:

```bash
# Type checking
npm run typecheck

# Linting
npm run lint
npm run lint:fix

# Formatting
npm run format
npm run format:fix
```

## Deployment with Databricks Asset Bundles

### 1. Configure Bundle

Update `databricks.yml` with your workspace settings:

```yaml
targets:
  default:
    workspace:
      host: https://your-workspace.cloud.databricks.com
```

Make sure to replace all placeholder values in `databricks.yml` with your actual resource IDs.

### 2. Deploy

Deploy and start the app with a single command:

```bash
databricks apps deploy
```

`databricks apps deploy` validates the project, deploys it, starts the app, and prints its URL.

### Deploy to Production

1. Configure the production target in `databricks.yml`
2. Deploy to production:

```bash
databricks apps deploy -t prod
```

> **Restarting a stopped app:** apps stop after a period of inactivity. To start one again without redeploying, run `databricks apps start <APP_NAME>`.

## Project Structure

```
* client/          # React frontend
  * src/           # Source code
  * public/        # Static assets
* server/          # Express backend
  * server.ts      # Server entry point
  * routes/        # Routes
* shared/          # Shared types
* config/          # Configuration
  * queries/       # SQL query files
* databricks.yml   # Bundle configuration
* app.yaml         # App configuration
* .env.example     # Environment variables example
```

## Tech Stack

- **Backend**: Node.js, Express
- **Frontend**: React.js, TypeScript, Vite, Tailwind CSS, React Router
- **UI Components**: Radix UI, shadcn/ui
- **Databricks**: AppKit SDK
