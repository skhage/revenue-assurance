# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

A **planning / specification repository** for a Databricks **revenue-assurance demo**. It
contains design artifacts plus the implementation code: reconciliation SQL, a Lakeflow data-sim
notebook, and a deployed Databricks AppKit app. The `.gitignore` is a stock Python one.

Two things you must read before doing substantive work — they carry context spread across
many files and prevent recurring mistakes:

1. **`demo-artifacts/README.md`** — the **GROUND TRUTH**. Defines the real data landscape,
   naming, the reconciliation checks, and the correction rules every artifact obeys. Treat
   it as authoritative; if you change a fact, change it here first.
2. **`data-source-assessment.md`** — analysis of which data already exists vs. what must be
   simulated.

## Big-picture facts that are easy to get wrong

- **Lakelink Fiber ≠ Lumen.** "Lakelink Fiber" is the *fictional operator whose data the
  demo shows*. "Lumen Technologies" is the *prospect the demo is pitched to*. Lumen data is
  never used. Older drafts conflated them — don't reintroduce that.
- **The data already exists — do not build a bronze layer or generate it from scratch.**
  The demo runs on the pre-populated **`cdm_tmforum`** catalog (a full TM Forum SID Common
  Data Model: `tmf_resource`, `tmf_service`, `tmf_product`, `tmf_customer`,
  `tmf_businesspartner`, `tmf_enterprise`, plus `_metrics` views). It even has a native RA
  layer (`tmf_enterprise.revenue_assurance_violation` / `revenue_assurance_control` /
  `ra_trouble_ticket`). The work is to **build reconciliation logic on top**, not to invent
  tables. Any reference to a `lumen_ra` catalog or a hand-generated `bronze.*` layer is a
  stale artifact of an early draft — see the README's correction table.
- **`tmf_*` schemas are read-only.** Build new work into the single new schema `revenue_assurance`
  in `cdm_tmforum`, reading from `tmf_*` and the simulated `*_source` schemas
  (`salesforce_source`, `oracle_erp_source`, `refinitiv_fx_source`, `ironclad_clm_source`,
  `mdm_source`). Source-system data is simulated by a separate `simulate_source_systems`
  notebook that lives in the Databricks workspace, not in this repo.
- The 10 numbered artifacts cross-reference each other and share personas (Dana Whitfield /
  Marcus Chen / Priya Nair) and the "RA Exceptions Console". Keep them mutually consistent —
  a change to the domain model, checks, or scale ripples across several docs.

## Public-repo redaction rule (important)

The GitHub remote (`skhage/revenue-assurance`) is **public**. Committed docs are deliberately
**scrubbed of internal identifiers**: the real workspace hostname and CLI profile appear as
`demo-workspace` / `demo`, and internal emails as `owner@example.com`. **Do not commit real
internal identifiers** (workspace hostnames, the actual CLI profile name, `@databricks.com`
addresses, catalog ownership) into any tracked file — replace them with those placeholders.

Because of this, the actual Databricks profile/workspace are intentionally **not recorded
here**. Get the profile from `databricks auth profiles` or ask the user; never hardcode it.

## Working conventions

- **Databricks work routes through the skills** (`databricks-core` first, then the matching
  product skill). Never auto-select a CLI profile — pass `--profile <name>` and let the user
  choose. `tmf_*` is read-only; write only to `revenue_assurance` / `*_source` schemas.
- **Editing artifacts:** each doc in `demo-artifacts/` opens with a `> **Scrutiny summary**`
  blockquote recording what changed and why; preserve that pattern and the `NN-name.md`
  numbering when adding or revising docs.
- **Git/GitHub:** commits author as `skhage` (personal noreply email). Databricks
  pre-commit/pre-push git hooks run **secret scanning** on every commit — expect that. The
  repo is public, so heed the redaction rule above before pushing.

## The built-out architecture (code now exists)

Per `demo-artifacts/05-repository-blueprint.md` and `06-deployment-contract.md`, the
`revenue-assurance` project is deployed via **Databricks Asset Bundles (DABs)** with:

- **Reconciliation layer:** seven silver materialized views (one per check) and four gold
  materialized views (leakage_summary, reconciliation_scorecard, anomaly_scores, revenue_forecast_anomalies)
  in the `cdm_tmforum.revenue_assurance` schema, plus ML anomaly detection and `ai_forecast`.
- **RA Exceptions Console:** a Databricks **AppKit** app (React/TypeScript, deployed via
  `databricks apps deploy --profile <name>`). Reads analytics via SQL warehouse plugin, writes
  case state to Lakebase Postgres (`ra` schema, tables `ra.cases` / `ra.case_notes`).
- **Reconciliation SQL:** `reconciliation/pipelines/{silver_reconciliation.sql,
  silver_doc_intelligence.sql, gold_aggregation.sql, dq_audit.sql}` (+ `reconciliation/warehouse/`
  for the `ai_forecast` gold view).
- **Data simulation:** `data-sim/simulate_source_systems.py` + `config.yaml` in workspace.
- **Serving surfaces:** AI/BI dashboard (JSON), Genie space, and the AppKit app (all reading
  `revenue_assurance.gold_*`/`silver_*`).
- **Semantic / governance layer (design):** artifacts 11–13 spec the **UC Business Semantics**
  layer — **Metric Views** (per-domain KPIs + `synonyms`), **Domains** (a `domain` governed tag +
  the resource→domain matrix), and **Pages** (the business glossary). The demo's premise is that
  Sales/Marketing/Ops/Finance use the same terms differently and RA reconciles across them; these
  are design docs, not yet-deployed workspace objects.

For non-code changes, follow `10-decision-log.md` for decision rationale.
