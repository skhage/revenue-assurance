---
name: ra-demo-build
description: Build and deploy the revenue-assurance demo on top of cdm_tmforum — the revenue_assurance reconciliation layer (seven silver checks + four gold views), the ML anomaly + ai_forecast component, the AI/BI dashboard, Genie, and the RA Exceptions Console AppKit app — packaged as a Databricks Asset Bundle. Use when scaffolding the repo, building the pipeline, wiring the dashboard/app, or deploying/tearing down the demo.
---

# RA Demo Build & Deploy

Implements the demo the artifacts specify. Authoritative sources — follow them rather than
improvising: [`demo-artifacts/05-repository-blueprint.md`](../../../demo-artifacts/05-repository-blueprint.md),
[`demo-artifacts/06-deployment-contract.md`](../../../demo-artifacts/06-deployment-contract.md),
[`demo-artifacts/10-decision-log.md`](../../../demo-artifacts/10-decision-log.md). Data
map + check SQL: use the `ra-data-explorer` skill. Ground truth:
[`demo-artifacts/README.md`](../../../demo-artifacts/README.md).

## What to build (and where)
- **Do not** create a `lumen_ra` catalog or a `bronze.*` layer — that's a stale early draft.
- Build **`cdm_tmforum.revenue_assurance`** schema with:
  - Seven **silver materialized views** (one per reconciliation check): `silver_contract_price_reconciliation`,
    `silver_discount_authorization_check`, `silver_fx_rate_validation`, `silver_ar_aging_analysis`,
    `silver_revenue_recognition_check`, `silver_doc_intelligence_contracts`, `silver_doc_intelligence_invoices`.
  - Four **gold materialized views**: `gold_leakage_summary` (unified exception register), `gold_reconciliation_scorecard`
    (per-customer health + risk tier), `gold_anomaly_scores` (ML), `gold_revenue_forecast_anomalies` (ai_forecast).
  - Reading from read-only `tmf_*` and the `*_source` schemas (see the `ra-source-simulation` skill).
- Reconciliation SQL in `reconciliation/transformations/` (see `ra-data-explorer`). ML anomaly (MLflow) + `ai_forecast` for the scenes.
- AI/BI dashboard (leakage KPIs, from `revenue_assurance` + `_metrics.*`), a Genie space over the RA
  tables, and the **RA Exceptions Console** Databricks **AppKit** app (React/TypeScript, reads via analytics plugin,
  writes case state to Lakebase `ra` schema).

## Product skills to load
`databricks-core` (first) → then as needed: `databricks-dabs` (bundle), `databricks-pipelines`
(Lakeflow Declarative Pipeline for revenue_assurance silver/gold), `databricks-ai-functions`
(`ai_forecast`), `databricks-aibi-dashboards`, `databricks-genie-agents`, `databricks-apps` (AppKit).

## Deploy / teardown (DABs)
Never auto-select a profile — pass `--profile <name>` (from `databricks auth profiles` or
ask the user). Target is the demo FEVM workspace (the committed docs redact its name to
`demo`; do not hardcode the real one).
```bash
databricks bundle validate                 --profile <name>
databricks bundle deploy   -t <target>     --profile <name>
databricks bundle run <resource> -t <target> --profile <name>
databricks bundle destroy  -t <target>     --profile <name>   # drops ONLY revenue_assurance, *_source, app, jobs — never tmf_*
```

## Guardrails
- Public repo: keep internal identifiers (workspace hostname, real profile, `@databricks.com`
  emails) out of committed files — use the `demo` / `demo-workspace` / `owner@example.com`
  placeholders (see README redaction rule).
- Keep the ten artifacts mutually consistent; if a build decision changes a fact, update the
  relevant artifact and the decision log.
