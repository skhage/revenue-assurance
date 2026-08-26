# RA Demo — Metric Views & the Semantic Layer

> **Scrutiny summary**
> - ✅ **2026-08-26:** New artifact. Specifies the **governed metric layer** for the demo using
>   **Unity Catalog Business Semantics** (Metric Views + `synonyms`/`display_name`), and the
>   design that resolves the demo's central tension: Sales, Marketing, Ops, and Finance use the
>   **same words for different things**. **Design-only** — conceptual specs grounded in real
>   columns of `cdm_tmforum.revenue_assurance`; no YAML is deployed here (authoring/deploy is a
>   follow-up). Pairs with [`12-domains-and-tags.md`](12-domains-and-tags.md) (ownership context)
>   and [`13-glossary.md`](13-glossary.md) (authoritative term definitions / UC Pages).

**Purpose.** A metric view is a governed KPI definition — measures and dimensions in YAML, secured
as a Unity Catalog object, queried with `MEASURE()`, and consumable identically from dashboards,
Genie, SQL, and external BI. It is the layer where "revenue" stops being a word people argue about
and becomes a **named, owned, reusable definition**. Requires DBR **17.3+** / YAML **v1.1** for the
semantic metadata (`synonyms`, `display_name`, `format`) this design relies on.

---

## 1. The cross-functional problem

The same term denotes different measures depending on who says it. This is not a data-quality bug —
each definition is correct **within its domain**. The semantic layer's job is to make the domain
explicit, not to force one winner.

| Term | Sales | Marketing | Operations / Network | Finance | Revenue Assurance | Authoritative column(s) per meaning |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| **Revenue** | Bookings / contracted value | Influenced / attributed revenue | Provisioned (active-service) revenue | Recognized revenue (ASC-606) | Billed vs expected (the gap) | Sales `contract_line_item.TotalPrice` · Finance `gl_je_lines.ENTERED_CR` (acct 4000) / `gold_revenue_forecast_anomalies.actual_revenue` · RA `gold_leakage_summary.amount_at_risk` |
| **Customer** | Account (CRM) | Segment / persona | Service owner / circuit holder | Bill-to / billing account | Reconciled entity across all four | Sales `salesforce_source.account` · Finance `ar_payment_schedules_all.BILL_TO_CUSTOMER_ID` · MDM `tmf_customer.customer.customer_id` |
| **Leakage / at risk** | Margin erosion from discounts | — | Unbilled active service | Uncollected / written-off AR | Detected reconciliation exceptions | `silver_discount_authorization_check.discount_overrun_amount` · `silver_ar_aging_analysis.total_outstanding` · `gold_leakage_summary.amount_at_risk` |
| **Discount** | Quoted discount % (deal) | Promo | — | Realized price reduction | Discount **beyond approval** | Sales `sbqq__quoteline__c.SBQQ__Discount__c` · RA `silver_discount_authorization_check.unauthorized_discount` |
| **ARPU** | — | Revenue per segment | — | Billed $ / active accounts | Tier used for risk weighting | `tmf_customer.customer.arpu_tier` — **a tier label, not a computed $** (see §4) |
| **Recovery** | — | — | — | Collections recovery (AR) | Recovered leakage ÷ detected | Finance `ar_payment_schedules_all.AMOUNT_DUE_REMAINING` · RA case status in **Lakebase** `ra.cases.status='Recovered'` (see §4) |
| **Churn** | Logo churn (lost accounts) | Retention / churn risk | Service disconnection | Revenue churn | Churn-linked leakage | `tmf_customer.customer.churn_date` / `churn_risk_score` / `churn_reason` |

---

## 2. How Unity Catalog Business Semantics resolves it

1. **Domains give ownership context.** "Revenue" asked inside the Finance domain resolves to
   recognized revenue; inside Sales, to bookings. Domains are the disambiguating scope
   ([`12-domains-and-tags.md`](12-domains-and-tags.md)).
2. **One governed metric view per domain meaning.** Each meaning becomes a distinct, owned measure
   with a clear `display_name` (e.g. *Recognized Revenue* vs *Bookings*) — never a bare "revenue".
3. **`synonyms` route colloquial language.** A Finance metric view tags *recognized revenue* with
   synonyms like "revenue", "GL revenue", "recognized sales"; Genie maps the user's word to the
   right measure instead of guessing.
4. **Pages carry the authoritative definition.** The shared concept ("Revenue") is defined once as
   a UC **Page** that spells out each team's meaning and links to each domain's metric view; Genie
   prioritizes and cites the Page ([`13-glossary.md`](13-glossary.md)).

Net: the analyst still says "revenue"; governance decides which one, shows the definition, and
returns a number with provenance.

---

## 3. Applicable metric views (conceptual)

Grounded in real columns of `cdm_tmforum.revenue_assurance` (and `tmf_customer` for the customer
view). Each row: **owning domain · source · measures · dimensions · synonyms / governed term**.

| Metric view | Domain | Source | Measures | Dimensions | Synonyms / governs |
| :-- | :-- | :-- | :-- | :-- | :-- |
| **Leakage register** | Revenue Assurance | `gold_leakage_summary` | Total at risk `SUM(amount_at_risk)`, Exception count, High-severity count, Known-leakage $, Distinct accounts | `check_type`, `severity`, `detection_method`, `known_leakage_flag` | leakage, revenue at risk, exceptions |
| **Customer reconciliation health** | RA / Operations | `gold_reconciliation_scorecard` | Avg composite health, avg price/discount/collection/doc scores, Total at risk, Total exceptions | `risk_tier`, `arpu_tier`, `billing_currency`, `account_status` | health score, risk tier, reconciliation score |
| **Collections & AR aging** | Finance › Collections/AR | `silver_ar_aging_analysis` | Total outstanding, Total billed, Avg & Max **DSO** (`estimated_dso_days`), Invoice count | `AGING_BUCKET`, `collection_risk` | DSO, collections, receivables aging |
| **Revenue vs forecast vs budget** | Finance › FP&A | `gold_revenue_forecast_anomalies` | Actual revenue, Forecast revenue, Budget amount, **Budget variance %**, Anomaly count | `revenue_month`, `anomaly_status` | recognized revenue, revenue forecast, budget variance |
| **Revenue recognition timing** | Finance › Rev Rec | `silver_revenue_recognition_check` | Scheduled recognized, Scheduled deferred, GL posted, **Recognition variance** | `PERIOD_NAME`, `material_timing_mismatch` | rev rec, ASC-606 timing, deferred revenue |
| **FX rate validation** | Finance › Treasury | `silver_fx_rate_validation` | Invoice amount, Market rate, Deviation count | `INVOICE_CURRENCY_CODE`, `rate_source`, `rate_deviation_flag` | FX, currency conversion, exchange-rate variance |
| **Contract pricing integrity** | Sales › Contracts | `silver_contract_price_reconciliation` | Contracted price, Estimated at risk, Exception count | `ProductCode`, `leakage_flag`, `reconciliation_status` | price mismatch, contract price, tariff |
| **Discount authorization** | Sales › Deal Desk | `silver_discount_authorization_check` | Applied vs approved discount %, **Discount overrun $**, Unauthorized count, Expired-quote count | `quote_status`, `unauthorized_discount`, `expired_quote_still_active` | discount, discount overrun, unauthorized discount |
| **Anomaly scores** | RA / Data Science | `gold_anomaly_scores` | Composite anomaly score, Isolation-forest score, Z-score, Amount at risk | `check_type`, `review_priority` | anomaly, outlier, ML score |
| **Customer base & churn** | Marketing / Customer | `tmf_customer.customer` | Customer count, Avg `churn_risk_score`, Churned count (`churn_date`) | `arpu_tier`, `segment_classification`, `credit_class`, `account_status`, `churn_reason`, `sales_channel` | churn, retention, ARPU tier, segment |

> Ratio/derived measures (e.g. budget variance %, applied-vs-approved discount, recovery rate) are
> exactly what metric views do well: the ratio is re-aggregated safely at query time rather than
> pre-computed at a fixed grain.

---

## 4. Caveats & follow-ups

- **Recovery rate is not yet a metric view.** Recovered ÷ detected leakage needs case state, which
  lives in **Lakebase Postgres** (`ra.cases.status`), and a metric view can only read UC/Delta.
  To govern recovery rate, first **sync `ra.cases` → a Delta table** (a scheduled job / Lakebase
  lakehouse-sync), then define the view over it. Until then, recovery is reported in-app only.
- **ARPU is a tier, not a dollar.** The golden data carries `customer.arpu_tier` (a label), not a
  computed average revenue per user. Finance's "$ ARPU = billed revenue ÷ active accounts" would be
  a *new* measure over billing — call this out rather than implying the tier is the dollar figure.
- **`gold_anomaly_scores.customer_id` is a `double`** (others are `bigint`) — cast on join.
- **Synonyms need DBR 17.3+/YAML v1.1**; on older runtimes the views still work without the
  semantic metadata, but lose the disambiguation routing.

See [`12-domains-and-tags.md`](12-domains-and-tags.md) for which domain owns each view and
[`13-glossary.md`](13-glossary.md) for the authoritative definitions these views point back to.
