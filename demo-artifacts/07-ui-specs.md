# RA Demo — UI Interaction Specs

> **Scrutiny summary**
>
> - ❌ **Was:** `lumen_ra` catalog with invented `gold.reconciliation_exceptions` and `gold.exception_case` tables. ✅ **Now:** Data binds to `cdm_tmforum.revenue_assurance.gold_leakage_summary` (~48K rows, 7 check_types, ~$601M at-risk register), case state in **Lakebase Postgres** (`ra.cases`/`ra.case_notes`, not Delta), and `_metrics.*` KPI views (71 pre-built). Single unified `cdm_tmforum.revenue_assurance` schema (no `ra_silver`/`ra_gold` split).
> - ❌ **Was:** Invented columns like `leakage_amount_usd`, `gold.leakage_kpis`, `root_cause`, `service_instance` materialized bridge. ✅ **Now:** Real columns in `gold_leakage_summary`: `check_type`, `severity`, `amount_at_risk`, `source_table`, `detection_method`, `known_leakage_flag`, `reference_id`; identity resolved inline per check (no bridge); KPIs from `_metrics.enterprise_revenue_assurance_*` views; `exception_id` synthesized at read-time as md5(check_type|reference_id|customer_id|amount_at_risk).
> - ❌ **Was:** ~610 open exceptions, $1.42M/mo. ✅ **Now:** Real scale: ~48K exceptions in `gold_leakage_summary`, estimated ~$601M impact, 7 check-types (contract_price_mismatch, unauthorized_discount, expired_quote_active, ar_collection_risk, rev_rec_timing_mismatch, doc_contract_mismatch, doc_invoice_mismatch). Native `tmf_enterprise.revenue_assurance_violation` (~10K rows, ~$540M) is context only.
> - ✅ **Kept:** Personas (Dana, Marcus, Priya), UI structure (Overview/Queue/My Cases, Exception Detail, Case management), Genie natural-language surface, and the New→Investigating→Recovering workflow.
> - ✅ **2026-08 correction applied:** AppKit (React/TypeScript) Databricks App architecture; READ path via analytics plugin over SQL warehouse → `gold_leakage_summary` + `gold_reconciliation_scorecard`; WRITE path via lakebase plugin → `ra.cases`/`ra.case_notes`; exception_id synthesis at SQL read time; dashboard exists as `Lakelink Fiber — Revenue Assurance Command Center.lvdash.json`; Genie side-panel marked future/planned.
> - ✅ **2026-08-31 addition:** Agent Workbench tab (§5.5) — four deterministic, rule-based panels (Pipeline Reliability, Exception Investigation, Smart Prioritization & Routing, Recovery Playbook) added to the Console. No LLM/model-serving endpoint is used; every agent-computed value is labeled "Deterministic · rule-based" or "Demo data" in the UI. All mutations still go through the existing `ra.cases`/`ra.case_notes` API — see ADR-015.

**Demo:** Revenue Assurance Lakehouse for Lumen Technologies | **Surfaces covered:** the **RA Exceptions Console** Databricks AppKit (analyst — Marcus Chen) and the **AI/BI leakage dashboard** (exec — Dana Whitfield), plus Genie natural-language Q&A (future: side panel). | **Data source:** Unity Catalog `cdm_tmforum`, schema `cdm_tmforum.revenue_assurance` (7 silver MVs + 4 gold MVs); simulated `*_source` schemas; case state in **Lakebase Postgres** project `ra-console-lakebase`, schema `ra`. All reads via SQL warehouse → analytics plugin; case writes via lakebase plugin → `ra.cases`/`ra.case_notes`.

---

## 1. Component inventory

| Component                                                 | Used on                                             | Bound data                                                                                                                                                                                                              | Notes                                                                                                                                                                                      |
| :-------------------------------------------------------- | :-------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Global header (persona badge, catalog indicator, refresh) | App (all screens)                                   | —                                                                                                                                                                                                                       | Shows signed-in identity (e.g. `marcus.chen`); catalog = `cdm_tmforum`; workspace = `demo-workspace`                                                                                       |
| Exceptions data grid                                      | Exceptions Queue                                    | `cdm_tmforum.revenue_assurance.gold_leakage_summary` (7 check_types, ~48K rows); case state from Lakebase `ra.cases` (LEFT JOIN on synthesized `exception_id`)                                                          | Sortable, paginated, virtualized; `exception_id = md5(check_type\|reference_id\|customer_id\|amount_at_risk)` synthesized at read time                                                     |
| Filter bar (chips + selects)                              | Exceptions Queue                                    | `check_type` (7 enum values), `severity` (HIGH/MEDIUM), case `status` from Lakebase                                                                                                                                     | Multi-select; `check_type`: contract_price_mismatch, unauthorized_discount, expired_quote_active, ar_collection_risk, rev_rec_timing_mismatch, doc_contract_mismatch, doc_invoice_mismatch |
| Severity badge                                            | Queue, Detail                                       | `gold_leakage_summary.severity` (HIGH / MEDIUM)                                                                                                                                                                         | High=red, Medium=amber                                                                                                                                                                     |
| Leakage $ pill                                            | Queue, Detail, Dashboard                            | `gold_leakage_summary.amount_at_risk`                                                                                                                                                                                   | Right-aligned, currency-formatted                                                                                                                                                          |
| Status chip                                               | Queue, Detail, Case                                 | `ra.cases.status` (Lakebase Postgres): New → Investigating → Recovering → Recovered / WrittenOff                                                                                                                        | 5 states with transition guards (see §4); terminal states read-only                                                                                                                        |
| Evidence panel                                            | Exception Detail                                    | `gold_leakage_summary` row detail + linked source evidence (e.g. `salesforce_source.contract_line_item` + `tmf_customer.bill` for contract-price checks); `source_table` + `reference_id` point to originating evidence | Identity resolved inline per check; shows detection method (rule_based or ai_extracted); `known_leakage_flag` indicates ground-truth seeded leakage                                        |
| Case action bar (Assign, Change Status, Add Note)         | Exception Detail / Case                             | Writes to Lakebase: `ra.cases` (assignee, status, updated_at) + `ra.case_notes` append                                                                                                                                  | Async to SQL warehouse; optimistic UI updates; reverts on write failure                                                                                                                    |
| Notes timeline                                            | Exception Detail / Case                             | `ra.case_notes` (append-only: id, exception_id FK, author, body, created_at)                                                                                                                                            | Newest-first; author resolved from `/api/whoami` (x-forwarded-email header)                                                                                                                |
| KPI tile                                                  | Dashboard (Dana)                                    | `gold_leakage_summary`: SUM(`amount_at_risk`), COUNT(\*) by severity, distinct check_types                                                                                                                              | Total at-risk ($601M), open count (~48K), high-severity count                                                                                                                              |
| Root-cause bar chart                                      | Dashboard (Dana)                                    | `gold_leakage_summary.check_type` grouped; SUM(`amount_at_risk`) or COUNT(\*) per type                                                                                                                                  | Click = filter Console Queue to that check_type; shows $ or count                                                                                                                          |
| Account health scorecard                                  | Dashboard (Dana)                                    | `gold_reconciliation_scorecard`: `composite_health_score`, `risk_tier` (GREEN/AMBER/RED), component scores                                                                                                              | Per-customer scores; detail Drawer shows price_accuracy, discount_compliance, collection_efficiency, doc_consistency                                                                       |
| Forecast variance line                                    | Dashboard (Dana)                                    | `gold_revenue_forecast_anomalies`: actual_revenue vs forecast_revenue vs budget_amount; `anomaly_status`                                                                                                                | Monthly GL revenue (acct 4000) via `ai_forecast`; shaded variance band                                                                                                                     |
| Top exceptions table (dashboard)                          | Dashboard (Dana)                                    | `gold_leakage_summary` ORDER BY amount_at_risk DESC; join `ra.cases` for status                                                                                                                                         | Drill → RA Exceptions Console Queue filtered by check_type/customer_id                                                                                                                     |
| Genie Q&A input                                           | Genie surface                                       | Scoped to `cdm_tmforum.revenue_assurance.*`, `tmf_enterprise.*`, `_metrics.*`                                                                                                                                           | Future/planned side-panel in Console; standalone Genie space available; PII masking applied to account_name                                                                                |
| Agent Workbench tabs                                      | Agent Workbench                                     | Pipeline: `dq_audit` (new `/api/dq/audit` route). Investigation: `exception_detail`. Prioritization: `gold_leakage_summary` + `ra.cases`. Recovery: same exception row, no new data.                                    | 4 sub-tabs (Pipeline reliability, Investigate, Prioritize & route, Recovery playbook); every computed value carries a "Deterministic · rule-based" or "Demo data" badge                    |
| Pipeline health gate                                      | Agent Workbench (all 4 tabs)                        | `dq_audit.status`, `observed_at` freshness vs. 72h threshold                                                                                                                                                            | Blocks Investigation/Prioritization/Recovery with a destructive alert when RED or unavailable; soft warning banner when stale but green                                                    |
| Apply-recommendation buttons                              | Agent Workbench (Investigate, Prioritize, Recovery) | N/A (writes via existing case API)                                                                                                                                                                                      | Every "Apply" requires an explicit click after review; calls the same `POST /api/cases/:id/assign\|status\|notes` routes the Queue/Cases pages use — no new mutation surface               |

---

## 2. Navigation map

```
                       ┌─────────────────────────────┐
   Dana (exec) ──────► │  AI/BI Leakage Dashboard     │
                       │  (Databricks SQL / AI-BI)    │
                       └──────────┬──────────────────┘
                                  │ drill from KPI / donut / bar
                                  ▼
                       ┌─────────────────────────────┐
   Marcus (analyst) ─► │  RA Exceptions Console (App) │
                       │                              │
                       │  Exceptions Queue  ◄─────┐   │
                       │        │ open row       │   │
                       │        ▼                │   │
                       │  Exception Detail ──────┘   │  (back to queue)
                       │        │ manage case         │
                       │        ▼                     │
                       │  Case (status/assign/notes)  │
                       │                              │
                       │  Agent Workbench             │
                       │   ├ Pipeline reliability      │
                       │   ├ Investigate               │
                       │   ├ Prioritize & route        │
                       │   └ Recovery playbook         │
                       │                              │
                       │  Genie Q&A (side panel)      │
                       └─────────────────────────────┘
```

Deep-link contract: dashboard drill passes `?violation_type=…&severity=…&region=…` into the App's Queue filter; a row's `exception_id` deep-links to Exception Detail.

---

## 3. Screen — Exceptions Queue (Marcus)

Primary triage surface. Lists open violations ranked by estimated revenue impact.

### Wireframe

```
┌─ RA Exceptions Console ───────────────────  marcus.chen ▾  ⟳ ─┐
│ Filters: [Check type ▾][Severity ▾][Status ▾]  [Clear]        │
│ Open exceptions: ~48,200   |   Open impact: $601M at risk       │
├───────────────────────────────────────────────────────────────┤
│ SEV  CHECK TYPE                  ACCOUNT          IMPACT$  STAT│
│ ●Hi  ar_collection_risk          Acme Corp       $425,000  New  │
│ ●Hi  rev_rec_timing_mismatch     GlobeTel Inc    $185,200  Inv  │
│ ●Md  unauthorized_discount       NetConnect Ltd  $42,500   New  │
│ ●Md  contract_price_mismatch     DataFlow SA     $31,750   Rec  │
│ ●Md  doc_invoice_mismatch        Apex Networks   $18,900   New  │
│ … (virtualized, 25/page) …                                     │
├───────────────────────────────────────────────────────────────┤
│                                       ‹ 1 2 3 … 1928 ›          │
└───────────────────────────────────────────────────────────────┘
```

### Data binding

| Element           | Table.column                                                                                                                                                                                               |
| :---------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Row set           | `cdm_tmforum.revenue_assurance.gold_leakage_summary` LEFT JOIN Lakebase `ra.cases` ON `exception_id`                                                                                                       |
| SEV               | `gold_leakage_summary.severity` (HIGH / MEDIUM)                                                                                                                                                            |
| TYPE (Check type) | `gold_leakage_summary.check_type` (7 enum: contract_price_mismatch, unauthorized_discount, expired_quote_active, ar_collection_risk, rev_rec_timing_mismatch, doc_contract_mismatch, doc_invoice_mismatch) |
| IMPACT$           | `gold_leakage_summary.amount_at_risk`                                                                                                                                                                      |
| REFERENCE         | `gold_leakage_summary.reference_id` (contract #, quote id, invoice #, or business key)                                                                                                                     |
| ACCOUNT           | `gold_leakage_summary.account_name` (masked by UC column policy)                                                                                                                                           |
| STATUS            | `ra.cases.status` (New / Investigating / Recovering / Recovered / WrittenOff); null or absent → "New"                                                                                                      |
| ASGN              | `ra.cases.assignee` (e.g. "Marcus Chen" or internal email); null → "—"                                                                                                                                     |
| Header counts     | `COUNT(*)` rows, `SUM(amount_at_risk)` over filtered set                                                                                                                                                   |

### Interactions

- **Filter:** each chip/select adds a WHERE predicate; header counts recompute.
- **Sort:** default `estimated_revenue_impact_amount DESC`; column headers toggle sort.
- **Open row:** navigates to Exception Detail (`exception_id`).

### States & copy

- **Loading:** skeleton rows; "Loading violations…"
- **Empty (no matches):** "No violations match these filters. Try clearing them." + [Clear filters]
- **Empty (nothing open):** "🎉 No open violations. All detected leakage has been worked."
- **Error:** "Couldn't load violations from `cdm_tmforum.tmf_enterprise`. Retry?" + [Retry] (logs warehouse/query error).

---

## 4. Screen — Exception Detail & Investigation (Marcus)

Shows one violation, the identity-resolution evidence, and the case action bar.

### Wireframe

```
┌ ‹ Back to queue ─────────────────── exception_id (synthesized) ┐
│ ●High  ar_collection_risk                Impact: $425,000     │
│ Check: ar_collection_risk  ·  Severity: HIGH  ·  Known: false   │
├── Detection Evidence ───────────────────────────────────────────┤
│  Customer: Acme Corp                    customer_id: 4821        │
│  Check Type: ar_collection_risk                                 │
│  Reference: DSO=127 days                (ar_payment_schedules_all)
│  Amount at Risk: $425,000               (outstanding AR)        │
│  Detection Method: rule_based                                   │
│  Source Table: oracle_erp_source.ar_payment_schedules_all       │
├── Case (Lakebase ra.cases) ───────────────────────────────────┤
│  Status: [ New ▾ ]   Assignee: [ Assign to me ]                │
│  [ + Add note ]                                                │
│  Notes:                                                        │
│   — (none yet)                                                 │
└───────────────────────────────────────────────────────────────┘
```

### Data binding

| Element                                       | Source                                                                                                                                                                                                                                                                                                                                                              |
| :-------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Header ($, check_type, severity, detected_at) | `gold_leakage_summary` row; `check_type` + `reference_id` identify the violation                                                                                                                                                                                                                                                                                    |
| Detection evidence                            | Per-check detail from source: e.g. for `contract_price_mismatch`: `salesforce_source.contract_line_item.UnitPrice` vs `tmf_customer.bill` actual charged; for `ar_collection_risk`: `oracle_erp_source.ar_payment_schedules_all` DSO/aging; for `doc_invoice_mismatch`: `ai_parse_document` parsed vs system-of-record from `oracle_erp_source.ra_customer_trx_all` |
| Customer / Account context                    | `tmf_customer.customer` + `salesforce_source.account` (joined via `TMF_Customer_Id__c`); `account_name` masked by UC column policy                                                                                                                                                                                                                                  |
| Reference business object                     | `gold_leakage_summary.reference_id` (contract #, quote id, invoice #, DSO period, GL period, or PDF doc reference) + `source_table` pointer                                                                                                                                                                                                                         |
| Known leakage indicator                       | `gold_leakage_summary.known_leakage_flag` (TRUE for seeded/ground-truth exceptions)                                                                                                                                                                                                                                                                                 |
| Case block                                    | Lakebase `ra.cases` row (status, assignee, created_at, updated_at); `ra.case_notes` append-only notes timeline                                                                                                                                                                                                                                                      |

Evidence panel is **violation-type aware** — e.g. Contract-price mismatch shows committed amount vs billed amount side by side; Usage–billing variance shows usage series vs flat billing.

### States & copy

- **Loading:** "Loading violation VIO-… and linked records…"
- **Empty evidence (unresolved identity):** "Identity could not be fully resolved (match_confidence < 0.8). Some links are missing — review before actioning." (amber banner)
- **Error:** "Couldn't load this violation. It may have been reprocessed. [Back to queue]"

---

## 5. Case management — status transitions & interactions (Marcus)

Status lifecycle (stored in Lakebase `ra.cases.status`):

```
        assign / begin        proceed to recovery
  New ───────────────► Investigating ───────────────► Recovering
   │                        │                              │
   │ (invalid / not real)   │ (invalid)                    ├──► Recovered
   └────────────────────────┴──────────────────────────────┤
                                                            └──► WrittenOff
```

Allowed transitions:

| From          | To (allowed)           | Guard / UI copy                                                    |
| :------------ | :--------------------- | :----------------------------------------------------------------- |
| New           | Investigating          | requires an assignee — "Assign the case before investigating."     |
| Investigating | Recovering, WrittenOff | Recovering: "Move to recovery — back-billing / dispute initiated." |
| Recovering    | Recovered, WrittenOff  | Recovered: "Confirm recovered amount." (prompts recovered_usd)     |
| Recovered     | (terminal)             | read-only chip                                                     |
| WrittenOff    | (terminal)             | requires a note — "Add a reason before writing off."               |

### Interactions & writes

- **Assign to me:** upserts/updates `ra.cases` row: sets `assignee = <current user>` (from `/api/whoami` x-forwarded-email), `updated_at = now()`; if status = New, enables Investigating transition.
- **Change status:** dropdown offers only allowed next states (per transition table); on select, upserts `ra.cases.status`; respects guard conditions (e.g. Investigating requires assignee ≠ null).
- **Add note:** creates new row in `ra.case_notes` (exception_id FK, author, body, created_at); shown newest-first in the timeline.
- **Optimistic UI:** chip updates immediately; on Lakebase write failure, reverts + toast with permission/connection details.

### States & copy

- **Save success:** toast "Case status → Recovering. Saved."
- **Save error:** toast "Couldn't save to Lakebase (ra.cases) — check write permission or connection. Change reverted."
- **Concurrent edit:** "This case was updated by someone else. Reloaded to latest." (re-fetch from Lakebase)
- **Terminal status:** action bar disabled with "This case is closed (Recovered/WrittenOff)."

---

## 5.5. Screen — Agent Workbench (Marcus)

Single tab in the Console, four sub-tabs, one shared "selected exception" so switching between Investigate and Recovery playbook keeps context. Every agent here is deterministic TypeScript over data the app already reads — **there is no LLM or model-serving endpoint behind any of these panels.** See ADR-015.

### Wireframe

```
┌ Agent Workbench ──────────────────────────────────────────────────┐
│ [Pipeline reliability] [Investigate] [Prioritize & route] [Recovery]│
│                                                                     │
│ Pipeline reliability tab:                                          │
│  ┌ Pipeline evidence is fresh and green ────────────────────────┐  │
│  │ Pipeline DQ checks are green and fresh.                       │  │
│  └────────────────────────────────────────────────────────────────┘│
│  ┌ DQ audit snapshot ─────────────────────────────────────────────┐│
│  │  14 green   0 red   Freshest: 2026-08-31 08:03                 ││
│  └──────────────────────────────────────────────────────────────────┘│
│                                                                     │
│ Investigate tab:                                                   │
│  ┌ Search box + ranked results ┐  ┌ Root-cause hypothesis ──────┐  │
│  │  Acme Fiber  contract_price │  │ check_type=…, risk_tier=RED,│  │
│  │  ...                         │  │ price_accuracy_score=42.3   │  │
│  └──────────────────────────────┘  │ Confidence: 92/100           │  │
│                                     │ [Deterministic · rule-based]│  │
│                                     │ [Add hypothesis as note]    │  │
│                                     └──────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────┘
```

### Data binding

| Tab                  | Source                                                                                                          | Notes                                                                                                                                                                                                      |
| :------------------- | :-------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pipeline reliability | `cdm_tmforum.revenue_assurance.dq_audit` via new `GET /api/dq/audit` (inline SQL, no named query — see ADR-015) | Summarized client-side into `unavailable`/`red`/`stale`/`ok`; freshness threshold 72h                                                                                                                      |
| Investigate          | `exception_detail` named query (existing)                                                                       | Deterministic hypothesis: cites `check_type`, `source_table`, `risk_tier`, and the check-type-mapped scorecard field; confidence = detection-method base + known-leakage/risk-tier bonuses, capped [0,100] |
| Prioritize & route   | `exceptions_list`-equivalent (`analyticsApi.exceptions`) + `ra.cases` (via `casesApi.list`)                     | Score = amount (35) + severity (25) + case age (20) + evidence quality (20); routing uses a fixed 3-analyst demo roster, not live capacity                                                                 |
| Recovery playbook    | Same exception row already fetched                                                                              | 7-entry check-type-keyed template (action, recovery %, owner role, deadline); no new data source                                                                                                           |

### Interactions & writes

- **Pipeline gate:** if `dq_audit` is `RED` or unreachable, the Investigate/Prioritize/Recovery tabs render only a destructive "Blocked by Pipeline Reliability agent" alert — no recommendation is computed, no Apply button renders. If `stale` (freshest observation > 72h old), a warning banner shows but recommendations still render (a human is still approving).
- **Apply as note (Investigate):** `POST /api/cases/:id/notes` with a body prefixed `[Agent: Exception Investigation] run_at=… · inputs={…} · output={…}` — the existing append-only `ra.case_notes` table doubles as the agent-run audit trail (see ADR-015). Requires an explicit click; nothing is written on page load.
- **Apply: assign (Prioritize & route):** `POST /api/cases/:id/assign` to the recommended analyst, followed by the same structured `[Agent: …]` note.
- **Apply: move to Recovering (Recovery playbook):** walks the existing `New → Investigating → Recovering` transition guard (assigning first if needed) via `POST /api/cases/:id/assign` then `POST /api/cases/:id/status`, attaching the structured note on the final transition. No new mutation route is introduced anywhere in this tab.

### States & copy

- **Loading:** `LoadingRegion` + skeletons, matching Queue/Cases.
- **Blocked:** `Alert variant="destructive"` — "Blocked by Pipeline Reliability agent" + the specific DQ failure reason.
- **Stale (soft warn):** `Alert variant="default"` — "Pipeline evidence may be stale" + hours since freshest observation.
- **Empty (no exception selected):** "Select an exception to see a cited root-cause hypothesis." / "…to draft a recovery plan."
- **Apply error:** inline `ErrorRegion` with retry, same pattern as the case-action bar in §5.

---

## 6. Screen — AI/BI Leakage Dashboard (Dana)

Executive quantification surface (Databricks SQL / AI-BI). Read-only.

### Wireframe

```
┌ Lakelink Fiber — Revenue Assurance Command Center ─ Dana ◀ ─┐
│ ┌ At-risk leakage ┐ ┌ Exception count ┐ ┌ High-severity ┐ ┌ Accts │
│ │   $601.2M       │ │    ~48.2K       │ │    $127.5M     │ │ 8.2K  ││
│ └─────────────────┘ └─────────────────┘ └────────────────┘ └───────┘│
│ ┌ Leakage by check type ($ at risk) ─────────────────────┐         │
│ │   ar_collection_risk        ▇▇▇▇▇▇▇▇ ($500M)            │  ◄─ cli│
│ │   rev_rec_timing_mismatch   ▇▇ ($62M)                   │     ck │
│ │   unauthorized_discount     ▇ ($18M)                    │     to │
│ │   doc_invoice_mismatch      ▇ ($12M)                    │    filtr│
│ │   … (7 total)                                           │    the  │
│ └─────────────────────────────────────────────────────────┘    queue│
│ ┌ Expected vs actual revenue forecast ────────────────────┐         │
│ │  forecast ─── / actual ─ · ─   variance shaded          │         │
│ │  GL account 4000 (monthly)                              │         │
│ └─────────────────────────────────────────────────────────┘         │
│ ┌ Top exceptions ──────────────────── [Open in App ↗] ────┐         │
│ │ ar_collection_risk Acme Corp     $425K  HIGH  New       │  ◄──┐  │
│ │ rev_rec_timing… GlobeTel Inc     $185K  HIGH  Invest.   │     │  │
│ │ unauthorized…  NetConnect Ltd     $43K  MED   New       │     │  │
│ └──────────────────────────────────────────────────────────┘  drill │
└─────────────────────────────────────────────────────────────────────┘
```

### Data binding

| Element                                                                       | Source                                                                                                                                                                               |
| :---------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| KPI tiles (leakage, exceptions count, high-severity count, accounts affected) | `gold_leakage_summary`: `SUM(amount_at_risk)`, `COUNT(*)`, `COUNT(*) WHERE severity='HIGH'`, `COUNT(DISTINCT customer_id)`                                                           |
| Check-type root-cause bar ($ / count)                                         | `gold_leakage_summary` grouped by `check_type` (7 types); SUM(amount_at_risk) or COUNT(\*) per bar                                                                                   |
| Account health scorecard                                                      | `gold_reconciliation_scorecard`: composite_health_score, risk_tier (GREEN/AMBER/RED), component scores (price_accuracy, discount_compliance, collection_efficiency, doc_consistency) |
| Forecast variance line                                                        | `gold_revenue_forecast_anomalies` (monthly actual_revenue vs forecast_revenue vs budget_amount; shaded variance band) — GL revenue account 4000 via `ai_forecast`                    |
| Exception drill table                                                         | `gold_leakage_summary` ORDER BY amount_at_risk DESC (top 10–20); columns: check_type, account, reference_id, severity, amount_at_risk                                                |

### Interactions (drill)

- **Check-type bar click → cross-filter** the dashboard and drill table.
- **"Open in App ↗"** and exception row click → deep-link to RA Exceptions Console Queue pre-filtered by `check_type` and/or `customer_id`, enabling Dana (exec) → Marcus (analyst) handoff.

### States & copy

- **Loading:** tile shimmer.
- **Empty (reconciliation not run):** "No leakage detected for this period. Confirm the reconciliation job has run."
- **Error:** "Dashboard query failed against `cdm_tmforum.tmf_enterprise`. Check the SQL warehouse."

---

## 7. Genie Q&A surface (Marcus) — FUTURE / PLANNED

Natural-language questions over `cdm_tmforum` governed by Unity Catalog. Currently: standalone Genie space in the workspace. Planned: side panel in the AppKit Console.

### Wireframe (standalone space — current)

```
┌ RA Data Assistant (Genie) ─────────────────────────────────┐
│ > Which customers have the highest ar_collection_risk      │
│   this quarter?                                             │
├─────────────────────────────────────────────────────────────┤
│ Customer               Amount at Risk    Exceptions         │
│ Acme Corp              $425,000           2 (DSO>120d)      │
│ GlobeTel Inc           $315,200           1 (AR aging)      │
│ DataFlow SA            $128,750           3 (AR+disc)       │
│ …                                                           │
│ [ View generated SQL ]   [ Show in Exception Queue ]       │
└─────────────────────────────────────────────────────────────┘
```

- **Binding:** Scoped to `cdm_tmforum.revenue_assurance.*`, `tmf_enterprise.*`, `_metrics.*`; answers respect UC grants + PII masking on account_name.
- **Trust:** every answer exposes the generated SQL and the source tables used.
- **Handoff:** "Show in Exception Queue" deep-links filtered results into the App Queue.

### States & copy

- **Loading:** "Analyzing RA data…"
- **Low confidence / ambiguous:** "I'm not sure which check type you mean. Did you mean exceptions with `ar_collection_risk` (AR aging/DSO high)?"
- **Error / no answer:** "I couldn't answer that from the RA data. Try asking about check types, customers, severity, or amounts at risk (e.g. 'Which customers have the highest contract_price_mismatch exposure?')."
- **Future (side panel):** Will be integrated into the Console as a right-side panel for ad-hoc analysis during case investigation.

---

## 8. Persona workflow tie-in

- **Dana (exec):** lands on `Lakelink Fiber — Revenue Assurance Command Center.lvdash.json` (AI/BI dashboard via Databricks SQL), reads 4 KPI tiles ($601M at-risk, ~48.2K exceptions, $127.5M high-severity, 8.2K affected accounts), spots the `ar_collection_risk` dominance in the check-type bar chart, clicks it to filter the dashboard, sees top exceptions, and hands off by clicking "Open in App" — proving leakage is now a monitored KPI, not an annual audit. Dashboard backed by `gold_leakage_summary` + `gold_reconciliation_scorecard` + `gold_revenue_forecast_anomalies`.
- **Marcus (analyst):** receives the filtered RA Exceptions Console Queue (sourced from `gold_leakage_summary` LEFT JOIN Lakebase `ra.cases`), opens the top `ar_collection_risk` exception for Acme Corp, reads the Detection Evidence (DSO=127 days from `oracle_erp_source.ar_payment_schedules_all`), assigns it to himself (writes to `ra.cases`), moves status New → Investigating → Recovering (Lakebase state), adds an investigation note (appends to `ra.case_notes`), then optionally asks Genie a follow-up question (standalone space or planned side panel) — closing the loop from detection to recovery inside one governed AppKit console, all writes persisted to Lakebase Postgres.
