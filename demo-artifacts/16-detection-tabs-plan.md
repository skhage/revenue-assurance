# RA Console — "Reconciliation Rules" & "Anomaly Models" Tab Plan

> **Scrutiny summary**
> - ✅ **2026-09-03:** New artifact. Plans the two **Detection** nav tabs that are currently
>   disabled placeholders in the RA Exceptions Console (`client/src/App.tsx`, the `SearchCheck` /
>   `Zap` items). Turns the demo's detection layer from a black box into a transparent, auditable
>   surface — reinforcing the "transparent SQL controls" and "AI where it earns its place" chapters
>   of the **Why RA matters** tab. **Plan-only**; grounded in the deployed silver/gold views and
>   `mlops/`. Pairs with [`07-ui-specs.md`](07-ui-specs.md) (UI system) and
>   [`15-model-governance-unity-gateway.md`](15-model-governance-unity-gateway.md) (the governance
>   strip the Anomaly Models tab surfaces).

**Shared conventions.** Both pages read live via the existing `analytics` plugin (SQL warehouse)
exactly like Overview/Queue, reuse `KpiTile`/badges, and are theme-aware. Both link into the
Exception Queue pre-filtered by `check_type`. Neither writes data.

---

## 1. Reconciliation Rules — the governed rule-based controls

A gallery of the **seven silver checks** as expandable "control cards." The story: leakage
detection is not a black box — each control is versioned, declarative SQL that finance and audit
can read.

**Header KPIs:** `7 controls` · total exceptions · $ at risk · last pipeline refresh.

**The seven cards** (each: business question · source A ↔ source B · plain-language rule ·
`detection_method` · live count + $ at risk from `gold_leakage_summary` grouped by `check_type` ·
DQ-audit status · "View in queue" deep link):

| # | Check (silver MV) | Business question | Reconciles | Rule / threshold |
|---|---|---|---|---|
| 1 | `silver_contract_price_reconciliation` | Are we billing the contracted price? | SF contract line price ↔ `tmf_customer.bill` | contracted ≠ billed → price_mismatch / expired_discount |
| 2 | `silver_discount_authorization_check` | Was every discount approved? | quote-line discount ↔ `discount_approval__c` ceiling | over-ceiling, or expired quote still "Approved" |
| 3 | `silver_fx_rate_validation` | Did we use the right FX rate? | applied FX ↔ Refinitiv mid-market | deviation > 1% |
| 4 | `silver_ar_aging_analysis` | What collection risk is aging out? | `ar_payment_schedules_all` DSO | 90+ days overdue |
| 5 | `silver_revenue_recognition_check` | Is revenue recognized on policy? | ASC-606 schedule ↔ GL postings | RECOGNIZED/DEFERRED timing drift |
| 6 | `silver_doc_intelligence_contracts` | Does the signed PDF match the system? | contract PDF ↔ SF contract | SLA / term / auto-renew / status mismatch |
| 7 | `silver_doc_intelligence_invoices` | Does the invoice PDF match the ERP? | invoice PDF ↔ Oracle AR | amount variance > $0.01 |

**Detail affordance.** Expanding a card reveals the human-readable rule and a "how it's detected"
line — rule-based SQL for 1–5, **AI-extracted via Unity Gateway** for 6–7 (call out that the
document extraction runs through the governed `ra-llm-gateway` endpoint; ties to doc 15).

---

## 2. Anomaly Models — AI/ML detection beyond the rules

Two model panels plus a governance strip. The story: rules catch known leakage; AI catches the
leakage that mutates — and it stays governed.

**Panel A — Isolation Forest anomaly ranking**
- **Model card:** unsupervised sklearn IsolationForest (300 trees, contamination 0.05), the
  `FEATURE_COLUMNS`, training rows, UC model `…ra_anomaly_isolation_forest@champion`.
- **Live table:** top-N ranked anomalies from `gold_anomaly_scores`
  (`composite_anomaly_score = 0.75·zscore + 0.25·amount_zscore`, `anomaly_rank`,
  `review_priority`), each row linking into the queue.
- **Breakdown:** `review_priority` HIGH/MED/LOW counts; a score-distribution sparkline.

**Panel B — `ai_forecast` revenue anomalies**
- Monthly **actual vs. forecast** line chart with the ±2σ band, flagged months highlighted, plus
  budget variance vs `gl_budgets`, from `gold_revenue_forecast_anomalies`.

**Governance strip (the Unity Gateway surface).**
- Which models are UC-registered, their version/`@champion` alias and lineage.
- The **gateway matrix** from [doc 15](15-model-governance-unity-gateway.md): `ra-llm-gateway`
  (LLM extraction) and `ra-anomaly-gateway` (Isolation Forest) are routed + tracked;
  `ai_parse_document` / `ai_forecast` / Genie are governed-by-UC with the reason.
- Optional live read of per-endpoint usage (requests/latency) so the governance claim is *visible*
  in the console, not just asserted.

---

## 3. Build notes

- Nav: promote the two disabled `<div>`s in `App.tsx`'s **Detection** group to `NavItem`s at
  `/rules` and `/anomaly-models`; add routes + `TITLES` entries; new pages under `client/src/pages/`.
- Data: add typed query helpers in `client/src/lib/analytics.ts` (`check_type` rollups from
  `gold_leakage_summary`; top-N from `gold_anomaly_scores`; monthly series from
  `gold_revenue_forecast_anomalies`). Reuse the `KpiTile`/badge components.
- Keep both pages read-only; the only cross-tab interaction is the queue deep link (carry
  `check_type` as a query param the Queue already understands).
