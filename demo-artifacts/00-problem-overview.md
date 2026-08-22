# Revenue Assurance Problem Overview & Research

> **Scrutiny summary**
>
> - **Lakelink Fiber vs. Lumen naming:** Fixed throughout — Lakelink Fiber is the *demo data operator* (fictional); Lumen Technologies is the *prospect being pitched to*. The narrative is "here's what a Lakelink Fiber lakehouse looks like; Lumen, this could be yours."
> - **Demo dataset scale:** Corrected from invented "~2,000 customers, ~25,000 circuits, ~910 exceptions" to real: ~10,000 customers (~10K), ~100,000 circuits (~100K), ~10,000 RA violations across 12 types, totaling ~$540M estimated impact (seeded in `cdm_tmforum.tmf_enterprise.revenue_assurance_violation`). Lumen's business-case framing ($250M–$312M / 2–2.5% annual leakage) is preserved as the *pitch context*.
> - **Data sourcing:** Clarified — no synthetic-data generation needed. Demo data lives in the `cdm_tmforum` TM Forum SID Common Data Model on the `demo-workspace` workspace. The build task is reconciliation logic on *existing tables*, not generation.
> - **Real tables cited:** Replaced invented table names with actual `cdm_tmforum` schemas and tables: `tmf_resource` (circuits), `tmf_service` (service usage), `tmf_customer` (billing), `tmf_enterprise` (native RA violation/control/case tables).
> - **Cloud / deployment:** Updated from "Azure-first" assertion to "demo FEVM workspace (cloud to be confirmed at deploy time)."
> - **ML data realism:** Added caveat that `cdm_tmforum` data is statistically flat/uniform — excellent for deterministic reconciliation, requires anomaly injection for ML scenes.

---

## What revenue assurance covers for a B2B broadband provider

Revenue assurance (RA) is the discipline of making sure every unit of service delivered over the network actually gets billed, invoiced, and collected — closing the gap between "revenue earned" and "revenue realized". For a B2B broadband provider specifically, this means reconciling data across the full chain: network provisioning and usage records, mediation systems, rating and tariff engines, billing, invoicing, partner/interconnect settlements, and cash collection. Core RA activities include:

- **Usage-to-billing reconciliation** — matching circuit/service usage records against what was actually rated and invoiced.
- **Provisioning and service catalog audits** — verifying that every activated or upgraded circuit (new fiber install, bandwidth upgrade, added site) is correctly reflected in billing.
- **Contract compliance checks** — confirming customers are billed per the negotiated SLA/contract terms, not stale or unauthorized pricing.
- **Partner and interconnect settlement checks** — for capacity leased from or resold to other carriers.
- **Fraud and credit/discount audits** — catching unauthorized discounts, expired promotional pricing still applied, or fraudulent account activity.

## What causes the 2–2.5% revenue loss

Industry benchmarks put typical telecom/broadband revenue leakage in a similar range: TM Forum cites roughly 1.5–1.9% average leakage, other studies (PwC, EY) show 1–5% or higher, and billing-specific errors alone average around 2.9% of revenue — so 2–2.5% sits squarely in the normal range for a B2B broadband operator. For Lumen Technologies (approximately $12.5 billion in revenue), this translates to a gross annual leakage estimate of **$250 million to $312.5 million**. The main root causes are:

| Cause | How it shows up in B2B broadband |
| ----- | ----- |
| Billing/mediation mismatches | Provisioned circuits or usage never make it from network/mediation systems into the billing run |
| Manual processes & spreadsheets | Order-to-cash handoffs between sales, provisioning, and billing rely on manual entry, causing missed or delayed charges |
| Pricing/discount errors | Expired promo pricing or unauthorized sales discounts persist uncorrected |
| Contract non-compliance / scope creep | Extra bandwidth, redundancy, or services delivered beyond the signed contract go unbilled |
| Legacy/siloed systems | CRM, ERP, and billing platforms don't sync in real time, so contract amendments or upgrades don't propagate to billing |
| Delayed reconciliation | CDR/usage discrepancies between network and billing systems aren't caught for months, by which time the revenue is unrecoverable |

## How providers fix it

Fixing this leakage is a data-and-process problem, not a single tool purchase. The standard playbook includes:

- **End-to-end process mapping** of the quote-to-cash flow to find where handoffs between sales, provisioning, billing, and collections break down.
- **Automated reconciliation** between network/usage records, mediation, rating, and billing systems instead of manual sampling.
- **Regular audits** comparing contracted terms, delivered service, invoiced amounts, and collected payments.
- **Replacing legacy billing/back-end systems** with configurable, standards-compliant platforms that reduce manual touchpoints.
- **Controls on discounting and contract changes** — approval workflows and audit logs for pricing exceptions.
- **Ongoing KPI monitoring** (leakage rate, unbilled usage, days-to-bill) rather than one-time cleanup.

## Where Databricks fits in

Databricks' role is to give revenue assurance teams a unified data platform that can ingest and correlate the disparate data sources (network logs, mediation, billing, CRM, partner settlement feeds) at scale, then apply analytics and machine learning to catch leakage faster and more systematically than manual audits.

Rogers Communications is a documented example directly in this space: it moved Revenue Assurance off a legacy, on-premises Hadoop/Oracle data warehouse — which couldn't scale, forced use of manual spreadsheet-heavy tools, and delayed insight — onto a Databricks lakehouse (its "Revenue Assurance Data Lake") on cloud infrastructure. Concretely this let Rogers:

- **Centralize and harmonize** data from provisioning, usage measurement, and billing systems into one governed repository, with an encryption framework for PII compliance.
- **Run ML-based forecasting** (e.g., predicting roaming revenue using traveler volume and seasonality data) to catch anomalies and improve financial forecasting accuracy versus manual reporting.
- **Move faster from insight to production** — putting new revenue-assurance use cases into production more frequently instead of being stuck mining and cleaning data.
- **Democratize access** via BI dashboards so business teams, not just data engineers, could see real-time leakage signals.

More broadly, case studies show the same pattern applied elsewhere in telecom RA: using anomaly-detection ML models across CDR, mediation, and billing API logs to flag leakage (e.g., unusual API response times signaling dropped records) faster than manual reconciliation, sometimes catching issues within days instead of months. For a B2B broadband provider, the equivalent Databricks-enabled approach would be building a lakehouse that ingests circuit-provisioning data, usage/bandwidth telemetry, CRM contract terms, and billing output, then running automated reconciliation jobs and anomaly-detection models to flag circuits that are active but unbilled, contracts where billed price no longer matches CRM terms, or usage spikes not reflected in invoices — attacking the exact root causes (manual handoffs, siloed systems, delayed reconciliation) that drive the 2–2.5% leakage.

## Dataset inventory for B2B broadband revenue assurance

Below is the realistic list of source systems, grouped by the organization that owns them. Names in parentheses are common vendors you'd actually encounter in a large broadband/cable operator's stack.

| Org Owner | Dataset / System | Vendor Examples | What it contributes |
| ----- | ----- | ----- | ----- |
| **Network Ops / Engineering** | Network provisioning & inventory records | Amdocs, Netcracker, Ericsson OSS, Nokia, ServiceNow | Ground truth on which circuits/services are actually active, upgraded, or decommissioned |
| **Network Ops** | Usage/traffic telemetry (CDRs, IPDRs, bandwidth utilization) | Ericsson, Nokia, Amdocs mediation | Confirms service is being consumed at the contracted tier; source for usage-based billing |
| **IT / Mediation** | Mediation platform output | Amdocs, Netcracker, Openet, MATRIXX | The bridge layer between raw network events and the rating/billing engine — a classic leakage point |
| **Finance / Billing** | Billing & rating engine records | CSG, Netcracker Digital BSS, Oracle BRM, Amdocs, Tridens, Optiva | Records what was actually rated, invoiced, and at what price |
| **Finance / Revenue Accounting** | Revenue recognition & GL data | Oracle ERP/NetSuite, SAP | Confirms billed revenue matches recognized revenue under ASC 606 |
| **Finance / Collections** | AR aging, dunning, payment records | Oracle, SAP, Tipalti, Stripe (less common at this scale) | Identifies collected vs. billed-but-uncollected revenue |
| **Sales / Account Management** | CRM contract & order data (pricing, term, discounts, SLAs) | Salesforce (Communications Cloud), Salesforce CPQ, Netcracker Order Management | The authoritative source of what a customer *should* be billed — most leakage shows up as a mismatch against this |
| **Sales / Deal Desk** | Quote-to-cash / CPQ approval logs | Salesforce CPQ, Netcracker | Flags unauthorized or expired discounts still being applied downstream |
| **Customer Ops / Provisioning** | Order management & fulfillment tickets | ServiceNow, Netcracker, Amdocs | Confirms the delivery date used to trigger billing start, common source of billing-start-date leakage |
| **Partner/Wholesale Ops** | Interconnect and wholesale settlement feeds | Custom EDI feeds, Netcracker Partner Management | Reconciles capacity leased to/from other carriers |
| **Compliance/Legal** | Contract repository (SLAs, MSAs, amendments) | Salesforce, Ironclad, DocuSign CLM | Ground truth for contract-compliance audits against billed amounts |
| **Data/IT** | Master customer/account hierarchy | MDM tools, CRM, ERP | Prevents leakage from account merges, site consolidations, or hierarchy mismatches |

## How it would actually work — the process

**Data engineering (foundation):**

- Ingest all the above sources into a lakehouse via CDC/batch pipelines — network telemetry and CDRs are high-volume/streaming, while CRM, billing, and contract data are batch/API-based.
- Build a canonical "service instance" entity that links a network circuit ID → CRM contract ID → billing account ID → invoice line item, since each source system uses different identifiers. This identity resolution is the single hardest engineering problem and the actual point of most leakage.
- Apply data quality rules and schema enforcement (Delta Lake style) so downstream reconciliation isn't corrupted by malformed CDRs or duplicate order records.

**Data science / analytics (detection):**

- Deterministic reconciliation jobs: for every active circuit in provisioning, does a corresponding non-zero invoice line exist? For every discount in billing, does it match an approved CPQ record and is it within its expiration window?
- Anomaly detection models on usage vs. billed amount time series to flag statistical outliers (e.g., bandwidth usage that jumped but billing didn't) — this is what case studies describe as catching leakage in days instead of months.
- Forecasting models to predict expected revenue by segment and flag actual-vs-expected variance as an early warning signal rather than waiting for a manual audit.
- Root-cause classification (ML or rules-based) tagging each detected exception by cause: billing-system gap, contract mismatch, provisioning lag, discount error, etc., so fixes can be prioritized.

**Analytics / governance (closing the loop):**

- Dashboards for RA analysts and finance showing leakage by product line, region, and root cause, with case management workflow to assign, investigate, and recover or write off each exception.
- Feedback loop: root causes discovered get converted into automated controls (e.g., a hard block preventing circuit activation without a matching billing record) so recurring leakage shrinks over time rather than just being caught after the fact.

## Realistic savings for a $12.5bn company (Lumen case study framing)

At 2–2.5% of Lumen's revenue, the gross leakage is roughly **$250 million to $312.5 million annually**. However, no RA program recovers 100% of identified leakage — some is structurally unrecoverable (revenue too old to back-bill under contract terms, disputed usage, customers who've churned, or leakage baked into systemic pricing errors that are cheaper to fix going forward than to claw back retroactively).

Industry benchmarks suggest standalone RA programs typically recover on the order of **3–5% of total revenue as an ongoing improvement**, while backward-looking recovery of already-leaked revenue tends to land in the **50–70% range of identified leakage**, with the remainder either uncollectible or requiring process fixes that only prevent *future* leakage rather than recovering past leakage. Applying that recovery range to the $250M–$312.5M gross leakage:

- **Recoverable/preventable revenue, realistic case:** roughly **$125M–$220M per year** (50–70% of the $250M–$312.5M leakage range), phased in over the first 12–24 months as reconciliation and controls mature.
- **Residual, likely-unrecoverable leakage:** roughly **$90M–$155M per year** even after a mature program is in place — driven by disputed/aged claims, one-off contract exceptions, and the inherent lag between when leakage occurs and when it's caught.
- Expect **most of the gain in year one to come from stopping ongoing leakage** (billing fixes, contract-compliance automation) rather than clawing back historical amounts, since back-billing older revenue is often contractually or practically limited.

So a defensible target to model against is **$125M–$220M in annual recovered/prevented revenue** for a $12.5bn B2B broadband provider — meaningful, but well short of eliminating the full $250M–$312.5M gap.

---

## Demo context: Lakelink Fiber Revenue Assurance Lakehouse

To ground this narrative in a concrete, working demo for Lumen, we've built a lakehouse scenario using **Lakelink Fiber Communications** as the fictional demo operator. Lakelink Fiber's datasets — circuit provisioning, mediation, billing, CRM contracts, and partner settlement records — are stored in the TM Forum SID Common Data Model (`cdm_tmforum` catalog on the `demo-workspace` workspace). The demo shows:

- **Real scale:** ~10,000 customers, ~100,000 active circuits, ~10,000 detected RA violations across 12 violation types, totaling ~$540M in estimated revenue impact.
- **Real data heritage:** All sources land in `cdm_tmforum`'s read-only `tmf_*` schemas (provisioning in `tmf_resource`, usage in `tmf_service`, billing in `tmf_customer`, native RA controls/violations in `tmf_enterprise`). Pre-seeded leakage across mediation failures, usage gaps, tariff mismatches, discount errors, and partner-settlement discrepancies.
- **Six deterministic checks + one ML anomaly detector** populate the exceptions queue, executable in a single serverless Databricks Workflow.
- **An RA Exceptions Console** (Databricks App) routes each exception through investigate → recover → close, with live KPI feedback to the leakage dashboard.

This gives Lumen a blueprint: "Here's how Lakelink Fiber tackled the 2–2.5% leakage problem using Databricks. Your data looks similar; your scale is similar. This is what your lakehouse could deliver."
