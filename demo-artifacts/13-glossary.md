# RA Demo — Glossary (Unity Catalog Pages)

> **Scrutiny summary**
> - ✅ **2026-08-26:** New artifact. The authoritative **business glossary** for the demo. Each
>   entry is written to map onto a Unity Catalog **Page** — Owner · Synonyms · Description ·
>   Domain · Related assets · Sources — so it can be authored in Discover (manually, via Genie
>   Code, or bulk-imported) and cited by Genie. Pairs with [`11-metric-views.md`](11-metric-views.md)
>   (metrics) and [`12-domains-and-tags.md`](12-domains-and-tags.md) (domains). Grounded in the
>   real `cdm_tmforum` objects.

**How to use.** Section **A** (contested terms) is the priority — those are the Pages that resolve
cross-functional ambiguity and that Genie should cite. Author each entry as a Page in its owning
domain; set **Synonyms** so colloquial phrasing resolves; link **Related assets** to the metric
view(s)/table(s) named. Redaction: personas/owners use placeholders, never real `@databricks.com`.

---

## A. Contested terms (author these first)

Each is one Page whose body records the canonical meaning **and** each team's local meaning + the
authoritative source, so Genie returns the right number with its definition.

### Revenue
*Domain:* Shared (linked from Finance, Sales, RA) · *Synonyms:* sales, turnover, top line
| Team | Means | Authoritative source |
| :-- | :-- | :-- |
| Finance | Recognized revenue (ASC-606), GL acct 4000 | `gold_revenue_forecast_anomalies.actual_revenue`, `oracle_erp_source.gl_je_lines.ENTERED_CR` |
| Sales | Bookings / contracted value | `salesforce_source.contract_line_item.TotalPrice` |
| Operations | Provisioned (active-service) revenue | `tmf_service` / `tmf_resource` active services |
| Revenue Assurance | Billed vs expected — the **gap** | `gold_leakage_summary.amount_at_risk` |

### Customer
*Domain:* Shared / MDM · *Synonyms:* account, client, subscriber
| Team | Means | Authoritative source |
| :-- | :-- | :-- |
| Sales | CRM Account | `salesforce_source.account` |
| Finance | Bill-to / billing account | `ar_payment_schedules_all.BILL_TO_CUSTOMER_ID` |
| Operations | Service owner / circuit holder | `tmf_service` customer-facing service |
| MDM (canonical) | Master customer | `tmf_customer.customer.customer_id` |

### Leakage / Amount at risk
*Domain:* Revenue Assurance · *Synonyms:* revenue leakage, at-risk revenue, exceptions
Detected revenue that is billed incorrectly, late, or not at all. Canonical measure:
`gold_leakage_summary.amount_at_risk`. Finance's related concept is uncollected/written-off AR
(`silver_ar_aging_analysis.total_outstanding`); Sales' is margin erosion from discounts
(`silver_discount_authorization_check.discount_overrun_amount`).

### Discount
*Domain:* Sales › Deal Desk · *Synonyms:* price reduction, concession
Sales: the quoted discount on a deal (`sbqq__quoteline__c.SBQQ__Discount__c`). RA: a discount
**beyond the approved ceiling** (`silver_discount_authorization_check.unauthorized_discount = true`,
`discount_overrun_amount`). Distinguish *quoted* from *unauthorized*.

### ARPU
*Domain:* Marketing / Finance · *Synonyms:* average revenue per user/account
In the golden data ARPU is a **tier label** (`tmf_customer.customer.arpu_tier`), used for risk
weighting — **not** a computed dollar figure. Finance's "$ ARPU = billed revenue ÷ active accounts"
is a *derived* measure not yet built. Do not present the tier as the dollar value.

### Recovery / Recovery rate
*Domain:* Revenue Assurance (+ Finance) · *Synonyms:* recovered leakage, clawback, collections recovery
RA: recovered ÷ detected leakage, where "recovered" is a case reaching `status='Recovered'` in
**Lakebase** `ra.cases`. Finance: collections recovery on AR
(`ar_payment_schedules_all.AMOUNT_DUE_REMAINING`). RA recovery is **not yet a metric view** — it
needs a Lakebase→Delta sync first (see [`11`](11-metric-views.md) §4).

### Churn
*Domain:* Marketing › Retention · *Synonyms:* attrition, disconnection, retention loss
Marketing: retention loss / churn risk (`tmf_customer.customer.churn_risk_score`, `churn_date`,
`churn_reason`). Sales: lost logos. Finance: revenue churn. Ops: service disconnection.

---

## B. Business terms & metrics
| Term | Definition | Domain | Related asset |
| :-- | :-- | :-- | :-- |
| Reconciliation | Comparing a source-of-record value against an independent system to find mismatches | RA | the 7 silver checks |
| Exception | One detected reconciliation mismatch (a row in the register) | RA | `gold_leakage_summary` |
| Case | The workflow wrapping an exception (assign → investigate → recover) | RA › Case Mgmt | Lakebase `ra.cases` |
| DSO (Days Sales Outstanding) | Avg days to collect receivables | Finance › Collections | `silver_ar_aging_analysis.estimated_dso_days` |
| Composite health score | 0–100 weighted reconciliation health per customer | RA / Ops | `gold_reconciliation_scorecard.composite_health_score` |
| Risk tier | GREEN/AMBER/RED bucket of the health score | RA / Ops | `gold_reconciliation_scorecard.risk_tier` |
| Budget variance | Actual − budget, as % | Finance › FP&A | `gold_revenue_forecast_anomalies.budget_variance_pct` |
| Recognition variance | Scheduled vs GL-posted revenue gap | Finance › Rev Rec | `silver_revenue_recognition_check.recognition_variance` |
| FX deviation | Applied vs market rate beyond tolerance (>1%) | Finance › Treasury | `silver_fx_rate_validation.rate_deviation_flag` |
| Document intelligence | AI extraction from contract/invoice PDFs vs system of record | RA + Sales/Finance | `silver_doc_intelligence_*` (`ai_parse_document`/`ai_extract`) |
| Anomaly score | ML outlier score (isolation forest + z-score) on exceptions | RA / DS | `gold_anomaly_scores.composite_anomaly_score` |
| Known-leakage flag | Ground-truth marker that a row is seeded/confirmed leakage | RA | `gold_leakage_summary.known_leakage_flag` |

---

## C. The seven reconciliation checks (`check_type`)
| `check_type` | Definition | Domain | Source | Severity logic |
| :-- | :-- | :-- | :-- | :-- |
| `contract_price_mismatch` | Contracted price ≠ billed price | Sales › Contracts | `silver_contract_price_reconciliation` (SF `contract_line_item` vs `tmf_customer.bill`) | HIGH if `price_mismatch`, else MEDIUM |
| `unauthorized_discount` | Applied discount exceeds approved ceiling | Sales › Deal Desk | `silver_discount_authorization_check` | HIGH |
| `expired_quote_active` | Expired quote still marked Approved | Sales › Deal Desk | `silver_discount_authorization_check` | MEDIUM |
| `ar_collection_risk` | 90+ day overdue AR / high DSO | Finance › Collections | `silver_ar_aging_analysis` | HIGH |
| `rev_rec_timing_mismatch` | ASC-606 schedule ≠ GL postings | Finance › Rev Rec | `silver_revenue_recognition_check` | MEDIUM |
| `doc_contract_mismatch` | Contract PDF ≠ system of record | Sales/RA | `silver_doc_intelligence_contracts` | HIGH |
| `doc_invoice_mismatch` | Invoice PDF amount ≠ system | Finance/RA | `silver_doc_intelligence_invoices` | HIGH |
> `silver_fx_rate_validation` produces FX deviations tracked separately (not unioned into the leakage register).

---

## D. Entities
| Entity | Definition | Canonical source |
| :-- | :-- | :-- |
| Customer | Master customer/party | `tmf_customer.customer` |
| Account | CRM account (sales view of a customer) | `salesforce_source.account` (`TMF_Customer_Id__c` ↔ customer) |
| Billing account | The bill-to entity | `tmf_customer` billing account / `ar_payment_schedules_all.BILL_TO_CUSTOMER_ID` |
| Service instance / Circuit | A provisioned network service | `tmf_service` (CFS/RFS) / `tmf_resource.logical_resource` |
| Contract | A signed agreement + its line items | `salesforce_source.contract_line_item`, `ironclad_clm_source` PDFs |
| Quote | A CPQ quote + lines | `salesforce_source.sbqq__quote__c` / `sbqq__quoteline__c` |
| Invoice / Bill | A billed document | `tmf_customer.bill`, `oracle_erp_source.ra_customer_trx_all`, invoice PDFs |
| Violation | Native seeded RA violation (context) | `tmf_enterprise.revenue_assurance_violation` |
| Trouble ticket | Native case entity (context) | `tmf_enterprise.ra_trouble_ticket` |

---

## E. Datasets
| Object | Purpose | Domain | Grain |
| :-- | :-- | :-- | :-- |
| `gold_leakage_summary` | Unified exception register (queue/KPI source) | RA | one detected exception |
| `gold_reconciliation_scorecard` | Per-customer reconciliation health + risk tier | RA/Ops | one customer |
| `gold_anomaly_scores` | ML anomaly scores over exceptions | RA/DS | one scored item |
| `gold_revenue_forecast_anomalies` | Actual vs `ai_forecast` vs budget, monthly | Finance | one revenue month |
| `silver_contract_price_reconciliation` | Contract vs billed price | Sales | one contract line |
| `silver_discount_authorization_check` | Discount vs approval ceiling | Sales | one quote line |
| `silver_ar_aging_analysis` | AR aging / DSO / collection risk | Finance | one customer × aging bucket |
| `silver_revenue_recognition_check` | ASC-606 vs GL timing | Finance | one period |
| `silver_fx_rate_validation` | Applied vs market FX rate | Finance | one invoice transaction |
| `silver_doc_intelligence_contracts` | AI contract-PDF vs system | Sales/RA | one contract doc |
| `silver_doc_intelligence_invoices` | AI invoice-PDF vs system | Finance/RA | one invoice doc |
| `*_source` schemas | Simulated upstream systems (SF, Oracle ERP, Refinitiv, Ironclad, MDM) | per domain | source-native |
| `tmf_*` schemas | Golden TM Forum SID model (read-only inputs) | per domain | source-native |
| `ra.cases` / `ra.case_notes` (Lakebase) | Mutable case state | RA › Case Mgmt | one case / one note |

---

## F. Acronyms
| Acronym | Expansion |
| :-- | :-- |
| RA | Revenue Assurance |
| DSO | Days Sales Outstanding |
| ARPU | Average Revenue Per User/Account |
| ASC-606 | Accounting standard for revenue recognition |
| CLM | Contract Lifecycle Management (Ironclad) |
| MDM | Master Data Management |
| ERP | Enterprise Resource Planning (Oracle) |
| CPQ | Configure-Price-Quote (Salesforce SBQQ) |
| CDR | Call Detail Record |
| FX | Foreign Exchange |
| MRR | Monthly Recurring Revenue |
| TMF SID | TM Forum Shared Information/Data model |
| UC | Unity Catalog |
| MV | Materialized View / Metric View (per context) |
| DABs | Databricks Asset Bundles |
| KPI | Key Performance Indicator |

---

## G. Personas
| Persona | Role | Domain | Primary surface |
| :-- | :-- | :-- | :-- |
| **Dana Whitfield** | VP Revenue Assurance (exec) | Revenue Assurance › Reporting | Command Center dashboard |
| **Marcus Chen** | Sr. RA Analyst | Revenue Assurance › Case Mgmt | RA Exceptions Console + Genie |
| **Priya Nair** | Lead Data Engineer | Revenue Assurance / Platform | Reconciliation layer, pipelines, governance |
