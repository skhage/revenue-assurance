# RA Demo — UI Interaction Specs

> **Scrutiny summary**
> 
> - ❌ **Was:** `lumen_ra` catalog with invented `gold.reconciliation_exceptions` and `gold.exception_case` tables. ✅ **Now:** Data binds to real `cdm_tmforum.tmf_enterprise.revenue_assurance_violation` (10K rows, 12 violation types, native leakage), `tmf_enterprise.ra_trouble_ticket` (case management), and `_metrics.*` KPI views (71 pre-built). Demo builds `ra_gold` layer in `cdm_tmforum` (not a separate catalog) for derived reconciliation exceptions and serving surfaces.
> - ❌ **Was:** Invented columns like `leakage_amount_usd`, `gold.leakage_kpis`, `root_cause`. ✅ **Now:** Real columns: `revenue_assurance_violation.estimated_revenue_impact_amount`/`recovery_amount`, `violation_type` (enum: mediation_failure, usage_reconciliation_gap, tariff_mismatch, provisioning_discrepancy, etc.), `ra_trouble_ticket.investigation_status`, `service_id`. KPIs sourced from `_metrics.enterprise_revenue_assurance_*` views.
> - ❌ **Was:** ~610 open exceptions, $1.42M/mo. ✅ **Now:** Real scale: ~10K total violations in `cdm_tmforum`, estimated ~$540M impact (tunable by filtering violation_type/date). Demo shows a subset seeded for reproducible demo runs.
> - ✅ **Kept:** Personas (Dana, Marcus), UI structure (Exceptions Queue, Exception Detail, Case management), Genie natural-language surface, and the New→Investigating→Recovering workflow.

**Demo:** Revenue Assurance Lakehouse for Lumen Technologies | **Surfaces covered:** the **RA Exceptions Console** Databricks App (analyst — Marcus Chen) and the **AI/BI leakage dashboard** (exec — Dana Whitfield), plus the Genie natural-language Q&A surface. | **Data source:** Unity Catalog catalog `cdm_tmforum`, schemas `tmf_enterprise`, `tmf_*`, `_metrics`; build layer `ra_gold` (reconciliation logic + serving tables). All reads via a serverless SQL warehouse; case updates go to `ra_gold.exception_case` (writing to `tmf_enterprise.ra_trouble_ticket` upstream).

---

## 1. Component inventory

| Component | Used on | Bound data | Notes |
| :---- | :---- | :---- | :---- |
| Global header (persona badge, catalog indicator, refresh) | App (all screens) | — | Shows signed-in identity (e.g. `marcus.chen`); catalog = `cdm_tmforum` |
| Exceptions data grid | Exceptions Queue | `ra_gold.reconciliation_exceptions` (derived from `tmf_enterprise.revenue_assurance_violation`) ⋈ `ra_gold.exception_case` (via `exception_id` ↔ `ra_trouble_ticket.id`) | Sortable, paginated, virtualized |
| Filter bar (chips + selects) | Exceptions Queue | `violation_type`, `severity`, `investigation_status`, region (via service identity bridge) | Multi-select; values from native `revenue_assurance_violation` enum |
| Severity badge | Queue, Detail | `revenue_assurance_violation.severity` OR derived risk tier | High=red, Medium=amber, Low=grey |
| Leakage $ pill | Queue, Detail, Dashboard | `revenue_assurance_violation.estimated_revenue_impact_amount` or `actual_revenue_impact_amount` | Right-aligned, currency-formatted |
| Status chip | Queue, Detail, Case | `ra_trouble_ticket.investigation_status` mapped to UI states (New, Investigating, Recovering, Recovered, WrittenOff) | 5 states (see §4) |
| Evidence panel | Exception Detail | `ra_gold.service_instance` (bridge: `logical_resource` → `resource_facing_service` → `customer_facing_service` → `customer` / `billing_account` / `bill`) + linked `silver.*` derived views | Shows the identity-resolution join; links to the offending circuit, contract, invoice |
| Case action bar (Assign, Change Status, Add Note) | Exception Detail / Case | writes to `ra_gold.exception_case` (materialized from `tmf_enterprise.ra_trouble_ticket`) |  |
| Notes timeline | Exception Detail / Case | `exception_case.notes`, `updated_at` | Append-only display; sourced from `ra_trouble_ticket.description` / comments |
| KPI tile | Dashboard | `_metrics.enterprise_revenue_assurance_violation` and related metric views | Total leakage (SUM of `estimated_revenue_impact_amount`), recovery rate, open count |
| Root-cause donut | Dashboard | `revenue_assurance_violation.violation_type` grouped (mediation_failure, usage_reconciliation_gap, tariff_mismatch, etc.) | Click = cross-filter |
| Leakage-by-region bar | Dashboard | `_metrics.*` or derived `ra_gold.leakage_kpis` by region (via service instance bridge) |  |
| Forecast variance line | Dashboard | `ra_gold.revenue_forecast` (expected vs actual, if built; caveat: source data is statistically flat) |  |
| Exceptions detail table (dashboard) | Dashboard | `revenue_assurance_violation` | Drill target; join to `ra_trouble_ticket` for case context |
| Genie Q&A input | Genie surface | `cdm_tmforum.ra_gold.*`, `tmf_enterprise.*`, `_metrics.*` | Governed by Unity Catalog; PII masking applied to customer names |

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
│ Filters: [Type ▾][Severity ▾][Status ▾][Region ▾]  [Clear]     │
│ Open exceptions: ~612   |   Open impact: $1.42M/mo (demo subset)│
├───────────────────────────────────────────────────────────────┤
│ SEV  TYPE                     IMPACT$  REGION   STATUS   ASGN  │
│ ●Hi  Billing leakage          $8,420   West     New       —    │
│ ●Hi  Mediation failure        $6,900   NE       Investi.  MC   │
│ ●Md  Tariff mismatch          $2,150   MW       New       —    │
│ ●Md  Revenue recognition err. $1,780   SE       New       —    │
│ ●Lo  Provisioning discrep.    $  540   SW       Recover.  MC   │
│ … (virtualized, 25/page) …                                     │
├───────────────────────────────────────────────────────────────┤
│                                       ‹ 1 2 3 … 25 ›            │
└───────────────────────────────────────────────────────────────┘
```

### Data binding

| Element | Table.column |
| :---- | :---- |
| Row set | `ra_gold.reconciliation_exceptions` (sourced from `tmf_enterprise.revenue_assurance_violation`) LEFT JOIN `ra_gold.exception_case` (↔ `ra_trouble_ticket`) ON `exception_id` |
| SEV | `revenue_assurance_violation.severity` or derived risk tier from `estimated_revenue_impact_amount` |
| TYPE | `revenue_assurance_violation.violation_type` (enum: mediation_failure, usage_reconciliation_gap, tariff_mismatch, revenue_recognition_error, provisioning_discrepancy, partner_settlement_discrepancy, rating_error, policy_violation, fraud_indicator, configuration_error, billing_leakage, data_quality_issue) |
| IMPACT$ | `revenue_assurance_violation.estimated_revenue_impact_amount` |
| REGION | via `ra_gold.service_instance.region` (derived from identity bridge through `customer.address_region`) |
| STATUS | `ra_trouble_ticket.investigation_status` mapped (null ⇒ "New") |
| ASGN | `ra_trouble_ticket.assigned_to` or `ra_gold.exception_case.assignee` |
| Header counts | `COUNT(*)`, `SUM(estimated_revenue_impact_amount)` over the filtered set |

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
┌ ‹ Back to queue ─────────────────── violation_id: VIO-004821 ┐
│ ●High  Billing leakage                Impact: $8,420/mo      │
│ Detected 2025-08-19  ·  Type: billing_leakage  ·  Recoverable │
├── Evidence (service SI-0099821) ─────────────────────────────┤
│  circuit_id     CKT-0099821   status: active   500 Mbps        │
│  contract_id    C-1000042     MRR: $3,200  term to 2026-05-31  │
│  billing_acct   B-000317                                       │
│  invoice_line   (none for 2025-08)   ◄── missing = unbilled    │
│  match_confidence 0.98  (method: exact_ref)                    │
├── Case (ra_trouble_ticket) ───────────────────────────────────┤
│  Status: [ New ▾ ]   Assignee: [ Assign to me ]                │
│  [ + Add note ]                                                │
│  Notes:                                                        │
│   — (none yet)                                                 │
└───────────────────────────────────────────────────────────────┘
```

### Data binding

| Element | Source |
| :---- | :---- |
| Header ($, type, severity, detected_at, recoverable) | `tmf_enterprise.revenue_assurance_violation` |
| Evidence identity row | `ra_gold.service_instance` (circuit_id, contract_id, billing_account_id, invoice_line_id, match_confidence, match_method) |
| Circuit facts | `tmf_resource.logical_resource` joined through `resource_facing_service` |
| Contract facts | `tmf_customer.commitment` (amount, actual_amount, variance_amount) |
| Missing/mismatched invoice | `tmf_customer.bill` / `applied_customer_billing_*` (absence or divergence per violation type) |
| Case block | `tmf_enterprise.ra_trouble_ticket` (investigation_status, assigned_to, related_service_now_incident_number, description/notes) |

Evidence panel is **violation-type aware** — e.g. Contract-price mismatch shows committed amount vs billed amount side by side; Usage–billing variance shows usage series vs flat billing.

### States & copy

- **Loading:** "Loading violation VIO-… and linked records…"  
- **Empty evidence (unresolved identity):** "Identity could not be fully resolved (match_confidence < 0.8). Some links are missing — review before actioning." (amber banner)  
- **Error:** "Couldn't load this violation. It may have been reprocessed. [Back to queue]"

---

## 5. Case management — status transitions & interactions (Marcus)

Status lifecycle (stored in `ra_trouble_ticket.investigation_status`):

```
        assign / begin        proceed to recovery
  New ───────────────► Investigating ───────────────► Recovering
   │                        │                              │
   │ (invalid / not real)   │ (invalid)                    ├──► Recovered
   └────────────────────────┴──────────────────────────────┤
                                                            └──► WrittenOff
```

Allowed transitions:

| From | To (allowed) | Guard / UI copy |
| :---- | :---- | :---- |
| New | Investigating | requires an assignee — "Assign the case before investigating." |
| Investigating | Recovering, WrittenOff | Recovering: "Move to recovery — back-billing / dispute initiated." |
| Recovering | Recovered, WrittenOff | Recovered: "Confirm recovered amount." (prompts recovered_usd) |
| Recovered | (terminal) | read-only chip |
| WrittenOff | (terminal) | requires a note — "Add a reason before writing off." |

### Interactions & writes

- **Assign to me:** sets `assigned_to = <current user>`, `updated_at = now()`; if status ≠ New, enables Investigating.  
- **Change status:** dropdown offers only allowed next states; on select, upserts `ra_trouble_ticket` and mirrors `revenue_assurance_violation.status` (if mirrored).  
- **Add note:** appends timestamped entry to `ra_trouble_ticket.description`; shown newest-first in the timeline.  
- **Optimistic UI:** chip updates immediately; on write failure, reverts + toast.

### States & copy

- **Save success:** toast "Violation VIO-004821 → Recovering. Saved."  
- **Save error:** toast "Couldn't save — no write permission on `tmf_enterprise.ra_trouble_ticket` or warehouse unavailable. Change reverted."  
- **Concurrent edit:** "This case was updated by someone else. Reloaded to latest." (re-fetch)  
- **Terminal status:** action bar disabled with "This case is closed (Recovered/WrittenOff)."

---

## 6. Screen — AI/BI Leakage Dashboard (Dana)

Executive quantification surface (Databricks SQL / AI-BI). Read-only.

### Wireframe

```
┌ Revenue Assurance — Leakage Overview ────── period: 2025-08 ▾ ─┐
│ ┌ Total impact  ┐ ┌ Impact rate ┐ ┌ Recovered ┐ ┌ Days-to-bill ┐│
│ │ $1.85M / mo   │ │    2.1%      │ │  $210K    │ │   14.6 avg   ││
│ └───────────────┘ └──────────────┘ └───────────┘ └──────────────┘│
│ ┌ Leakage by violation type ┐   ┌ Leakage by region ─────────┐  │
│ │   ◐ billing_leakage 18%    │   │ West   ▇▇▇▇▇▇▇             │  │
│ │   ◔ mediation_failure 14%  │   │ NE     ▇▇▇▇▇              │  │
│ │   ◔ usage_reconcil_gap 12% │   │ MW     ▇▇▇▇               │  │
│ │   … (click to filter)      │   │ SE/SW  ▇▇                 │  │
│ └────────────────────────────┘   └────────────────────────────┘  │
│ ┌ Expected vs actual revenue (forecast) ─────────────────────┐ │
│ │  expected ─── / actual ─ · ─   variance shaded              │ │
│ │  (Note: source data is statistically uniform; injected       │ │
│ │   anomalies for compelling ML demo)                         │ │
│ └────────────────────────────────────────────────────────────┘ │
│ ┌ Top violations ────────────────────────── [Open in App ↗] ─┐ │
│ │ VIO-004821  Billing leakage         $8,420  West  New      │ │
│ └────────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────┘
```

### Data binding

| Element | Source |
| :---- | :---- |
| Total impact / impact rate / days-to-bill / recovered | `_metrics.enterprise_revenue_assurance_violation` and related metric views (71 pre-built) |
| Violation-type donut | `tmf_enterprise.revenue_assurance_violation` grouped by `violation_type` |
| Impact by region | `_metrics.*` by region or `ra_gold.leakage_kpis` (derived) |
| Forecast line | `ra_gold.revenue_forecast` (expected_usd, actual_usd, variance_usd) — built on top of historical billing |
| Top violations | `revenue_assurance_violation` ORDER BY `estimated_revenue_impact_amount` DESC |

### Interactions (drill)

- **KPI/segment click → cross-filter** the dashboard.  
- **"Open in App ↗"** and row click → deep-link to RA Exceptions Console Queue pre-filtered by the clicked dimension, enabling Dana→Marcus handoff.

### States & copy

- **Loading:** tile shimmer.  
- **Empty (reconciliation not run):** "No leakage detected for this period. Confirm the reconciliation job has run."  
- **Error:** "Dashboard query failed against `cdm_tmforum.tmf_enterprise`. Check the SQL warehouse."

---

## 7. Genie Q&A surface (Marcus)

Natural-language questions over `cdm_tmforum` governed by Unity Catalog. Rendered as a side panel in the App and as a standalone Genie space.

### Wireframe

```
┌ Ask Genie ────────────────────────────────────────────────┐
│ > Which regions have the most unbilled active circuits      │
│   this month?                                               │
├─────────────────────────────────────────────────────────────┤
│ Region   Unbilled circuits   Impact $/mo                     │
│ West           92             $412,000                       │
│ Northeast      64             $268,000                       │
│ …                                                            │
│ [ View generated SQL ]   [ Open matching violations in App ]│
└─────────────────────────────────────────────────────────────┘
```

- **Binding:** Genie space scoped to `cdm_tmforum.ra_gold.*`, `tmf_enterprise.*`, `_metrics.*`; answers respect UC grants + PII masking.  
- **Trust:** every answer exposes the generated SQL and the tables used.  
- **Handoff:** "Open matching violations in App" deep-links results into the Queue.

### States & copy

- **Loading:** "Genie is thinking…"  
- **Low confidence / ambiguous:** "I'm not sure which table you mean. Did you mean unbilled *active circuits* (violation type: Billing leakage)?"  
- **Error / no answer:** "I couldn't answer that from the RA data. Try rephrasing, or ask about leakage, violations, or circuits."

---

## 8. Persona workflow tie-in

- **Dana (exec):** lands on the AI/BI dashboard, reads total impact $ and violation-type mix, spots the West-region spike, and hands off by drilling into the App — proving leakage is now a monitored KPI, not an annual audit. Dashboard is backed by `tmf_enterprise` native violations + `_metrics` pre-built views.
- **Marcus (analyst):** receives the filtered queue (sourced from `revenue_assurance_violation` + `ra_trouble_ticket`), opens the top Billing-leakage violation, reads the identity-resolution evidence (service_instance bridge), assigns it to himself, moves New → Investigating → Recovering, adds a note, then asks Genie a follow-up — closing the loop from detection to recovery inside one governed console, all writes flowing back to `tmf_enterprise` tables.
