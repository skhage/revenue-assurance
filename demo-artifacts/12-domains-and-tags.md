# RA Demo — Domains & Governed Tags

> **Scrutiny summary**
> - ✅ **2026-08-26:** New artifact. Defines the **business-domain taxonomy** for the demo and how
>   to realize it with Unity Catalog **Domains** (each backed by a **governed tag**), so resources
>   can be tagged and browsed by business meaning. Pairs with
>   [`11-metric-views.md`](11-metric-views.md) (per-domain metrics) and
>   [`13-glossary.md`](13-glossary.md) (Pages live inside domains). Grounded in the real
>   `cdm_tmforum` schemas and the built `revenue_assurance` layer.

**Purpose.** Give every stakeholder a browse path aligned to *how the business is organized*, not
how storage is laid out — and give the disambiguation in [`11`](11-metric-views.md) a home: a term
resolves within the **domain** that owns it.

---

## 1. What a Unity Catalog Domain is

- A **Domain** is a discovery/organizational overlay, **backed by a governed tag**: a "Finance"
  domain corresponds to a `Finance` governed-tag value, and any asset carrying that tag appears in
  the domain. It is **independent of the catalog/schema hierarchy** — assets from many schemas can
  live in one domain.
- **Subdomains** add one nesting level, named `Parent/Child` (e.g. `Finance/Collections`). The
  parent and subdomain tags are **independent** — tagging `Finance/Collections` does *not* auto-add
  `Finance`; apply both if you want the asset in each. Assets in a subdomain still surface in the
  parent domain's results.
- **Assignable assets:** catalogs, schemas, tables, **metric views**, dashboards, and Genie agents.
  (Governed tags do **not** apply to compute like SQL warehouses/jobs.)
- **Permission:** managing a domain / its Pages requires **`MANAGE DISCOVERY`** (granted by account
  admins at account, domain, or subdomain scope). Assigning a governed tag requires **`ASSIGN`** on
  that tag.

---

## 2. Governed-tag scheme

Model domains with **one governed tag key** and a curated value list. Governed tags enforce that
only the allowed values are used and only by authorized principals — the consistency the demo's
governance story needs.

- **Tag key:** `domain`
- **Allowed values (top-level):** `Revenue Assurance`, `Finance`, `Sales`, `Operations`,
  `Marketing`, `Shared`
- **Subdomain values** (`Parent/Child`, applied alongside the parent where dual membership is
  wanted): `Finance/Collections`, `Finance/RevenueRecognition`, `Finance/FPA`, `Finance/Treasury`,
  `Sales/Contracts`, `Sales/DealDesk`, `Operations/Provisioning`, `Operations/ServiceAssurance`,
  `Marketing/Segmentation`, `Marketing/Retention`, `RevenueAssurance/Detection`,
  `RevenueAssurance/CaseManagement`, `RevenueAssurance/Reporting`.

> Governed tags have a CLI/API surface for create/assign; **Domains and Pages are authored in the
> Discover UI** (or generated via Genie Code). Create the tag first, then the Domain that points at
> it, then tag assets. Disallowed value characters: `* . / < > % & ? \ =` — the `Parent/Child`
> subdomain form is the one place `/` is used and is handled by the subdomain feature, not a raw
> tag value.

**Dual-tagging convention (important for RA).** Each **silver check** reconciles a specific source
domain's data *and* is part of the RA layer. Tag it with **both**: its source domain (e.g.
`Sales/DealDesk` for the discount check) **and** `RevenueAssurance/Detection`. This is what makes
RA legibly *cross-cutting* in Discover.

---

## 3. Domain taxonomy

| Domain | Subdomains | What it owns / represents |
| :-- | :-- | :-- |
| **Revenue Assurance** (cross-cutting) | Detection · Case Management · Reporting | The `revenue_assurance` schema, `gold_leakage_summary`, `gold_anomaly_scores`, the RA Exceptions Console app, the Command Center dashboard, the Genie space, and the Leakage / Health / Anomaly metric views. Reconciles signals from every other domain. |
| **Finance** | Collections/AR · Revenue Recognition · FP&A · Treasury | `oracle_erp_source`; the AR-aging, rev-rec, and FX silver checks; `gold_revenue_forecast_anomalies`; `tmf_businesspartner` (partner settlement); Collections / Revenue-Forecast / Rev-Rec / FX metric views. |
| **Sales** | Contracts · Deal Desk (CPQ) | `salesforce_source` (`contract_line_item`, `sbqq__*`); the contract-price and discount silver checks; `tmf_product` catalog; Contract-Pricing / Discount metric views. |
| **Operations / Network** | Provisioning · Service Assurance | `tmf_resource`, `tmf_service` (circuits, service instances, provisioning, usage); contributes to Customer Reconciliation Health. |
| **Marketing / Customer** | Segmentation · Retention (Churn) | `tmf_marketsales`; `tmf_customer.customer` (segment, ARPU tier, churn); Customer-base & churn metric view. |
| **Shared / MDM** | — | `mdm_source` (customer crosswalk) and `tmf_customer` as master reference; the identity backbone every domain joins to. |

Document-intelligence sits across Sales/Finance + RA: `silver_doc_intelligence_contracts` →
`Sales/Contracts` + `RevenueAssurance/Detection`; `silver_doc_intelligence_invoices` →
`Finance/Collections` + `RevenueAssurance/Detection`; both read `ironclad_clm_source`.

---

## 4. Resource → domain assignment matrix

The actionable list. Apply the `domain` tag(s) to each; RA-layer assets that reconcile a source
domain carry **both** tags.

| Resource | Type | `domain` tag(s) | Suggested owner |
| :-- | :-- | :-- | :-- |
| `cdm_tmforum.revenue_assurance` | schema | `Revenue Assurance` | RA lead (Priya) |
| `gold_leakage_summary` | metric-view source / table | `RevenueAssurance/Reporting` | RA |
| `gold_reconciliation_scorecard` | table | `RevenueAssurance/Reporting`, `Operations` | RA / Ops |
| `gold_anomaly_scores` | table | `RevenueAssurance/Detection` | RA / DS |
| `gold_revenue_forecast_anomalies` | table | `Finance/FPA`, `RevenueAssurance/Reporting` | Finance |
| `silver_contract_price_reconciliation` | table | `Sales/Contracts`, `RevenueAssurance/Detection` | Sales / RA |
| `silver_discount_authorization_check` | table | `Sales/DealDesk`, `RevenueAssurance/Detection` | Sales / RA |
| `silver_ar_aging_analysis` | table | `Finance/Collections`, `RevenueAssurance/Detection` | Finance / RA |
| `silver_revenue_recognition_check` | table | `Finance/RevenueRecognition`, `RevenueAssurance/Detection` | Finance / RA |
| `silver_fx_rate_validation` | table | `Finance/Treasury`, `RevenueAssurance/Detection` | Finance / RA |
| `silver_doc_intelligence_contracts` | table | `Sales/Contracts`, `RevenueAssurance/Detection` | Sales / RA |
| `silver_doc_intelligence_invoices` | table | `Finance/Collections`, `RevenueAssurance/Detection` | Finance / RA |
| `salesforce_source` | schema | `Sales` | Sales Ops |
| `oracle_erp_source` | schema | `Finance` | Finance systems |
| `refinitiv_fx_source` | schema | `Finance/Treasury` | Treasury |
| `ironclad_clm_source` | schema | `Sales/Contracts` | Legal / Sales |
| `mdm_source` | schema | `Shared` | Data governance |
| `tmf_customer` | schema | `Marketing`, `Shared` | Customer / MDM |
| `tmf_resource`, `tmf_service` | schema | `Operations` | Network Ops |
| `tmf_marketsales` | schema | `Marketing` | Marketing |
| `tmf_product` | schema | `Sales` | Product |
| `tmf_businesspartner` | schema | `Finance` | Partner finance |
| `tmf_enterprise` | schema | `Revenue Assurance` | RA |
| RA Exceptions Console (app) | Databricks app | `RevenueAssurance/CaseManagement` | RA |
| Command Center (`*.lvdash.json`) | dashboard | `RevenueAssurance/Reporting` | RA / Exec (Dana) |
| RA Genie space | Genie agent | `Revenue Assurance` | RA |
| Metric views (from `11`) | metric view | domain of the view (see `11` §3) | domain owner |

> `tmf_*` schemas are **read-only**; tagging them for discovery is fine (tags are metadata) and does
> not grant write access.

---

## 5. Revenue Assurance is the cross-cutting domain

RA is deliberately the overlay that touches every other domain: it consumes Sales pricing/discount
signals, Finance AR/rev-rec/FX/forecast signals, Ops provisioning/service signals, and Marketing/
Customer churn signals, and unifies them in `gold_leakage_summary`. In Discover this shows as RA
assets carrying a source-domain tag **and** an `RevenueAssurance/*` tag — the visual proof of
"RA reconciles across the business," which is the demo's thesis.

---

## 6. Create steps (order matters)

1. **Create the governed tag** `domain` with the allowed values in §2 (account/metastore admin);
   grant `ASSIGN` to the domain owners.
2. **Create each Domain** in the Discover UI → *Create domain* → select the matching governed-tag
   value → add subtitle, description, business + technical owners → **Publish**. Add subdomains.
3. **Tag resources** per the §4 matrix (UI, or the governed-tag API for bulk). RA-layer silver
   checks get **both** tags.
4. **Grant `MANAGE DISCOVERY`** to domain curators so they can maintain the domain and its Pages.
5. Author the **Pages** ([`13-glossary.md`](13-glossary.md)) inside the relevant domains.

Redaction: keep `demo-workspace` / `demo` / `owner@example.com` placeholders — never real
hostnames, the real CLI profile, or `@databricks.com` addresses in committed docs.
