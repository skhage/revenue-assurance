# Databricks notebook source
# /// script
# [tool.databricks.environment]
# environment_version = "5"
# ///
# MAGIC %md
# MAGIC # Simulate Source Systems — Lakelink Fiber
# MAGIC ### ERP · CRM/CPQ · CLM · Market-data source layer for the Revenue Assurance demo
# MAGIC
# MAGIC This notebook **generates** the upstream *source-system* data that feeds the
# MAGIC `cdm_tmforum` MDM/SID model. The TM Forum model is the **conformed golden layer**;
# MAGIC these new schemas are the **raw source systems** (Salesforce, Oracle ERP, Ironclad
# MAGIC CLM, Refinitiv FX) that a real operator would land *before* MDM survivorship.
# MAGIC
# MAGIC > ⚠️ **This notebook is generation code only.** It is written to be reviewed and run
# MAGIC > deliberately. Nothing here has been executed. Review the `CONFIG` cell (catalog,
# MAGIC > scale, leakage rate) before running.
# MAGIC
# MAGIC ## Design principles
# MAGIC 1. **MDM-consistent.** Every source record is anchored to a real golden record in
# MAGIC    `cdm_tmforum.tmf_customer.customer` and carries the MDM crosswalk keys
# MAGIC    (`external_customer_code`, master `customer_id`). We generate an explicit
# MAGIC    `mdm_source.customer_crosswalk` so survivorship lineage is visible — this mirrors
# MAGIC    how the `tmf_*` data was itself simulated (SSOT + source cross-references).
# MAGIC 2. **Real provider schemas.** Tables and columns use the *actual* API/table names
# MAGIC    practitioners recognise: Salesforce `Account`/`Contract`/`SBQQ__Quote__c`, Oracle
# MAGIC    `RA_CUSTOMER_TRX_ALL`/`GL_JE_LINES`/`AR_PAYMENT_SCHEDULES_ALL`, Refinitiv/LSEG
# MAGIC    `GL_DAILY_RATES`, Ironclad `contract_record`. Each is a *representative subset* of
# MAGIC    the real (very wide) provider schema, fully commented.
# MAGIC 3. **Natural distributions.** No flat/uniform data. B2B power-law account sizing
# MAGIC    (a few strategic accounts drive most revenue), log-normal contract value, DSO by
# MAGIC    credit class, Q4 seasonality, 80/20 skews — so the RA reconciliation has real
# MAGIC    signal to find.
# MAGIC 4. **Consistency with billed data.** ERP AR invoices are derived from the existing
# MAGIC    `tmf_customer.bill` rows and Salesforce contract prices from `tmf` commitments /
# MAGIC    offering prices, so "source-of-truth vs billed" reconciles to the same universe.
# MAGIC 5. **Controlled leakage seeding.** A configurable `LEAKAGE_RATE` injects the 6 demo
# MAGIC    exception types (price mismatch, expired discount, unbilled circuit, billing-start
# MAGIC    lag, partner-settlement variance, missing-contract) so checks against these source
# MAGIC    tables surface leakage. Clearly flagged; set to 0 for clean data.
# MAGIC
# MAGIC ## Recommended schema names (all in the `cdm_tmforum` catalog)
# MAGIC | Schema | Origin system | Contents |
# MAGIC |---|---|---|
# MAGIC | `salesforce_source` | Salesforce (CRM + CPQ + PRM) | Accounts, Contracts, Orders, Opportunities, CPQ quotes/discounts, approvals, partners |
# MAGIC | `oracle_erp_source` | Oracle ERP Cloud / EBS | AR invoices, payment schedules (aging), receipts, GL, ASC-606 rev-rec, budgets |
# MAGIC | `ironclad_clm_source` | Ironclad CLM | Contract records + branded MSA/amendment PDFs (unstructured) |
# MAGIC | `refinitiv_fx_source` | Refinitiv / LSEG | Daily FX conversion rates |
# MAGIC | `mdm_source` | MDM hub | Source→golden customer crosswalk (survivorship lineage) |
# MAGIC
# MAGIC The `_source` suffix makes provenance obvious next to the conformed `tmf_*` schemas.

# COMMAND ----------

# DBTITLE 1,Review Notes
# MAGIC %md
# MAGIC ## ⚠️ SUPERSEDED — See SDP Pipeline + config.yaml
# MAGIC
# MAGIC This notebook has been restructured into:
# MAGIC - **`config.yaml`** — all shared variables (catalog, schemas, seed, scale, leakage rate, brand, products, FX pairs) in one YAML file reusable across notebooks and pipeline steps.
# MAGIC - **Lakelink Revenue Assurance Source Sim** pipeline — Spark Declarative Pipeline that declares each output table as a materialized view with explicit dependency graph.
# MAGIC
# MAGIC The original notebook is retained as reference for the generation logic.
# MAGIC
# MAGIC ---
# MAGIC
# MAGIC ## ⚠️ Code Review — Issues Fixed (Aug 2026)
# MAGIC
# MAGIC **Critical fixes applied:**
# MAGIC 1. **Customer `name` / `trading_name` / `registration_number` / `regulatory_jurisdiction` are all gibberish codes** (e.g. "EW0IA6X51FE0") in the golden table. The original code mapped these directly to Salesforce `Account.Name`, `BillingStreet`, and `BillingCountry` — producing nonsensical demo data. **Fix:** Added a Faker-generated lookup (`fake_name`, `fake_street`, `fake_country`) broadcast-joined to the anchor in cell 9.
# MAGIC 2. **Dead `addr` variable** — `geographic_address` was read but never joined. Removed (its `locality`/`state_or_province` are also gibberish; only `address_line_1` had Faker data).
# MAGIC 3. **Dead `w = Window.partitionBy(...)` variable** in the Salesforce cell — defined but never referenced. Removed.
# MAGIC 4. **Unused columns** (`billing_account_id`, `write_off_amount`) selected from `bill` but never used downstream in ERP section. Removed to avoid confusion.
# MAGIC 5. **`.__int__()` call** on `circuits.count()` was redundant (Spark Connect returns Python int). Removed.
# MAGIC
# MAGIC **Additional observations (not blocking but worth noting):**
# MAGIC - `CONTACTS_PER_ACCOUNT=3` and `LINES_PER_CONTRACT=4` are used as fixed constants (no variance). The docstring says "avg" but every account gets exactly the same count. Consider adding `+ (hash % 2)` for natural spread.
# MAGIC - `bill.date` / `due_date` / `paid_date` are STRING type. The `F.to_date("col_name")` calls work but rely on implicit ISO parsing — add explicit format `"yyyy-MM-dd"` for robustness.
# MAGIC - 10K bills × 12-month ratable = 120K rev-rec rows — fine for demo scale but grows fast if bill count increases.

# COMMAND ----------

# MAGIC %md
# MAGIC ## 0 · Dependencies (unstructured document rendering)
# MAGIC WeasyPrint renders the branded HTML letterheads to PDF. If system libs are missing on
# MAGIC serverless, the unstructured section falls back to writing the styled HTML to the
# MAGIC volume (still ingestible by `ai_parse_document`).

# COMMAND ----------

# DBTITLE 1,Dependencies
# MAGIC %pip install faker xhtml2pdf --quiet
# MAGIC dbutils.library.restartPython()

# COMMAND ----------

# MAGIC %md
# MAGIC ## 1 · CONFIG — review before running

# COMMAND ----------

# ---------------------------------------------------------------------------
# Target catalog: co-located with the MDM golden data so joins are single-catalog.
CATALOG = "cdm_tmforum"

# Source-system schemas (see recommendations above)
SCHEMA_SFDC   = "salesforce_source"
SCHEMA_ERP    = "oracle_erp_source"
SCHEMA_CLM    = "ironclad_clm_source"
SCHEMA_FX     = "refinitiv_fx_source"
SCHEMA_MDM    = "mdm_source"

# Reproducibility + PK offset (mirrors the tmf_ generator convention to avoid clashes)
SEED = 42
PK_START_OFFSET = 900000

# Scale. Account count is derived from the real golden customer set at runtime; these
# multipliers size the child tables. Keep modest for a first run, raise for scale demos.
CONTACTS_PER_ACCOUNT   = 3
CONTRACTS_PER_ACCOUNT  = 1.4      # avg; some accounts have renewals/amendments
LINES_PER_CONTRACT     = 4        # avg circuits / services per contract
OPPS_PER_ACCOUNT       = 1.8
FX_DAYS                = 365 * 8  # match tmf bill history 2018-2025

# Controlled leakage injection — drives the 6 RA checks. Set to 0.0 for pristine data.
LEAKAGE_RATE = 0.06               # ~6% of contract lines carry a seeded exception

# Branding for unstructured documents
BRAND = {
    "company": "Lakelink Fiber",
    "legal_name": "Lakelink Fiber Communications, Inc.",
    "tagline": "Enterprise Fiber & Wavelength Services",
    "primary": "#0B3D5C",     # deep fiber blue
    "accent":  "#FF6A3D",     # signal orange
    "ink":     "#1c1c1c",
    "muted":   "#6b7280",
    "domain":  "lakelinkfiber.com",
    "address": "410 Optical Way, Suite 900, Denver, CO 80202",
    "support": "1-800-LAKELINK",
}
# Databricks logo used as the Lakelink Fiber letterhead mark (per demo direction).
DATABRICKS_LOGO_URL = "https://upload.wikimedia.org/wikipedia/commons/6/63/Databricks_Logo.png"

print(f"Target: {CATALOG}  |  schemas: {SCHEMA_SFDC}, {SCHEMA_ERP}, {SCHEMA_CLM}, {SCHEMA_FX}, {SCHEMA_MDM}")
print(f"Seed={SEED}  PK offset={PK_START_OFFSET}  Leakage rate={LEAKAGE_RATE:.0%}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 2 · Imports, Spark session, helpers

# COMMAND ----------

from pyspark.sql import functions as F, Window
from pyspark.sql.types import *
import random

random.seed(SEED)

# In a Databricks notebook `spark` is pre-provisioned (serverless recommended).
spark.conf.set("spark.sql.session.timeZone", "UTC")

# --- helper: create schema with a description comment ------------------------
def make_schema(schema, comment):
    spark.sql(f"CREATE SCHEMA IF NOT EXISTS {CATALOG}.{schema} COMMENT '{comment}'")

# --- helper: write a Delta table then apply table + column comments ----------
def write_table(df, schema, table, table_comment, col_comments, mode="overwrite"):
    """Persist df as a managed Delta table and attach UC documentation."""
    fqn = f"{CATALOG}.{schema}.{table}"
    (df.write.format("delta").mode(mode)
        .option("overwriteSchema", "true").saveAsTable(fqn))
    spark.sql(f"COMMENT ON TABLE {fqn} IS '{table_comment.replace(chr(39), chr(8217))}'")
    have = set(c.name for c in df.schema.fields)
    for col, cmt in col_comments.items():
        if col in have:
            safe = cmt.replace("'", "’")
            spark.sql(f"ALTER TABLE {fqn} ALTER COLUMN {col} COMMENT '{safe}'")
    print(f"  ✓ {fqn}  ({df.count():,} rows, {len(df.columns)} cols)")
    return fqn

# --- helper: Salesforce-style 18-char record id (prefix + base62) ------------
from pyspark.sql.types import StringType
@F.pandas_udf(StringType())
def sfid(prefix_and_seq):
    import pandas as pd
    B62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
    out = []
    for v in prefix_and_seq:
        prefix, seq = v.split("|")
        n = int(seq); body = ""
        for _ in range(15 - len(prefix)):
            body = B62[n % 62] + body; n //= 62
        out.append((prefix + body + "AAA")[:18])
    return pd.Series(out)

def sf_id(prefix, seq_col):
    """Build a deterministic SFDC-shaped id from a 3-char keyPrefix and a sequence col."""
    return sfid(F.concat(F.lit(prefix + "|"), seq_col.cast("string")))

# --- helper: log-normal money in Spark (natural long-tailed amounts) ---------
def lognormal(mu, sigma, seed_col):
    # Box-Muller from two hashed uniforms -> lognormal; deterministic per row
    u1 = (F.abs(F.hash(seed_col, F.lit(1))) % 100000 + 1) / 100000.0
    u2 = (F.abs(F.hash(seed_col, F.lit(2))) % 100000 + 1) / 100000.0
    z = F.sqrt(-2.0 * F.log(u1)) * F.cos(F.lit(2 * 3.141592653589793) * u2)
    return F.exp(F.lit(mu) + F.lit(sigma) * z)

def rand_of(col):  # stable 0..1 per row+salt
    return lambda salt: (F.abs(F.hash(col, F.lit(salt))) % 100000) / 100000.0

print("helpers ready")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 3 · Anchor to the MDM golden records
# MAGIC Read the real customer master (and its address) so every source Account maps 1:1 to
# MAGIC an existing `tmf_customer.customer`. We also assign each account a **B2B size tier**
# MAGIC (power-law) that drives contract value, circuit counts and usage downstream.

# COMMAND ----------

# DBTITLE 1,Cell 9
cust = spark.table(f"{CATALOG}.tmf_customer.customer")

# NOTE: customer.name, trading_name, registration_number, regulatory_jurisdiction
# are all opaque alphanumeric codes in the golden data — NOT realistic company names
# or addresses. We use Faker to generate realistic B2B identifiers for the source layer.
from faker import Faker
fake = Faker()
Faker.seed(SEED)

# Pre-generate realistic company names, addresses, and countries for all customers.
# We broadcast a lookup so Spark can join it deterministically.
cust_count = cust.count()
fake_data = [(i, fake.company(), fake.street_address(), fake.country_code(representation='alpha-2'))
             for i in range(cust_count)]
fake_df = spark.createDataFrame(fake_data, ["_idx", "fake_name", "fake_street", "fake_country"])

# Assign size tier with a power-law weighting (strategic accounts are rare but dominant).
r = rand_of(F.col("customer_id"))
anchor = (cust
    .withColumn("_idx", (F.col("customer_id") - F.lit(10001)).cast("int"))  # 0-based index matching fake_data
    .join(F.broadcast(fake_df), "_idx", "left")
    .withColumn("_t", r("tier"))
    .withColumn("size_tier",
        F.when(F.col("_t") < 0.03, "Strategic")       # 3%
         .when(F.col("_t") < 0.15, "Enterprise")      # 12%
         .when(F.col("_t") < 0.50, "Mid-Market")      # 35%
         .otherwise("SMB"))                            # 50%
    .withColumn("annual_revenue_usd",
        F.round(F.when(F.col("size_tier") == "Strategic", lognormal(18.4, 0.5, F.col("customer_id")))
                 .when(F.col("size_tier") == "Enterprise", lognormal(17.2, 0.5, F.col("customer_id")))
                 .when(F.col("size_tier") == "Mid-Market", lognormal(15.8, 0.5, F.col("customer_id")))
                 .otherwise(lognormal(14.2, 0.6, F.col("customer_id"))), 0))
    .withColumn("employees",
        F.greatest(F.lit(5), F.round(F.col("annual_revenue_usd") / F.lit(280000)).cast("int")))
    .drop("_t", "_idx"))

# Persist the anchor so all children read a stable, FK-valid parent (no .cache on serverless)
make_schema(SCHEMA_MDM, "MDM hub: source-to-golden crosswalk and survivorship lineage feeding the tmf_* SSOT.")
(anchor.write.format("delta").mode("overwrite").option("overwriteSchema","true")
    .saveAsTable(f"{CATALOG}.{SCHEMA_MDM}._anchor_accounts"))
anchor = spark.table(f"{CATALOG}.{SCHEMA_MDM}._anchor_accounts")
print(f"Anchored {anchor.count():,} golden customers")
anchor.groupBy("size_tier").count().show()

# COMMAND ----------

# MAGIC %md
# MAGIC ## 4 · Salesforce source  (`salesforce_source`)
# MAGIC Real Salesforce object + field API names, including the CPQ managed-package
# MAGIC (`SBQQ__…`) objects. `Account` is the CRM view of the golden customer; the CPQ quote
# MAGIC + discount + approval chain is what the "expired / unauthorised discount" check runs
# MAGIC against, and `Contract` line prices are the "should-be-billed" source of truth.

# COMMAND ----------

# DBTITLE 1,Cell 11
make_schema(SCHEMA_SFDC, "Salesforce source system: CRM (Account, Contact, Contract, Order, Opportunity), CPQ (SBQQ__ managed package) and PRM. Raw pre-MDM extract; Account maps 1:1 to tmf_customer.customer via TMF_Customer_Id__c.")

# ---- Account -----------------------------------------------------------------
tier_seg = {"Strategic":"Strategic Enterprise","Enterprise":"Enterprise","Mid-Market":"Commercial","SMB":"Small Business"}
seg_expr = F.create_map(*sum([[F.lit(k), F.lit(v)] for k,v in tier_seg.items()], []))

account = (anchor
    .withColumn("Id", sf_id("001", F.col("customer_id")))
    .withColumn("Name", F.col("fake_name"))
    .withColumn("AccountNumber", F.concat(F.lit("LLF-"), F.lpad(F.col("customer_id").cast("string"), 8, "0")))
    .withColumn("Type", F.lit("Customer"))
    .withColumn("Industry", F.lit("Telecommunications"))
    .withColumn("AnnualRevenue", F.col("annual_revenue_usd"))
    .withColumn("NumberOfEmployees", F.col("employees"))
    .withColumn("BillingStreet", F.coalesce(F.col("fake_street"), F.lit("410 Optical Way")))
    .withColumn("BillingCountry", F.coalesce(F.col("fake_country"), F.lit("US")))
    .withColumn("CurrencyIsoCode", F.coalesce(F.col("billing_currency"), F.lit("USD")))
    .withColumn("Rating",
        F.when(F.col("size_tier").isin("Strategic","Enterprise"), "Hot").otherwise("Warm"))
    .withColumn("Segment__c", seg_expr[F.col("size_tier")])
    .withColumn("ARPU_Tier__c", F.col("arpu_tier"))
    .withColumn("Credit_Class__c", F.col("credit_class"))
    .withColumn("Account_Status__c", F.col("account_status"))
    # ---- MDM crosswalk keys -------------------------------------------------
    .withColumn("TMF_Customer_Id__c", F.col("customer_id"))
    .withColumn("External_Customer_Code__c", F.col("external_customer_code"))
    .withColumn("CreatedDate", F.col("since_date").cast("timestamp"))
    .withColumn("LastModifiedDate", F.col("last_modified_timestamp"))
    .select("Id","Name","AccountNumber","Type","Industry","AnnualRevenue","NumberOfEmployees",
            "BillingStreet","BillingCountry","CurrencyIsoCode","Rating","Segment__c","ARPU_Tier__c",
            "Credit_Class__c","Account_Status__c","TMF_Customer_Id__c","External_Customer_Code__c",
            "CreatedDate","LastModifiedDate"))

write_table(account, SCHEMA_SFDC, "account",
    "Salesforce Account object (standard). CRM view of the enterprise customer; one row per golden customer in tmf_customer.customer.",
    {"Id":"Salesforce 18-char record Id (keyPrefix 001).",
     "Name":"Account name; sourced from the golden customer name.",
     "AnnualRevenue":"Firmographic annual revenue (USD); log-normal by account size tier.",
     "Segment__c":"Custom field: Lakelink commercial segment.",
     "TMF_Customer_Id__c":"MDM crosswalk: golden customer_id in cdm_tmforum.tmf_customer.customer.",
     "External_Customer_Code__c":"MDM crosswalk: shared external customer code used for survivorship.",
     "CurrencyIsoCode":"Salesforce multi-currency ISO code; matches customer.billing_currency."})

acct_lkp = spark.table(f"{CATALOG}.{SCHEMA_SFDC}.account").select(
    F.col("Id").alias("AccountId"), "TMF_Customer_Id__c", "CurrencyIsoCode", "Segment__c")

# ---- Contact (natural fan-out per account) ----------------------------------
contact = (acct_lkp
    .withColumn("n", F.explode(F.sequence(F.lit(1), F.lit(CONTACTS_PER_ACCOUNT))))
    .withColumn("seq", F.monotonically_increasing_id())
    .withColumn("Id", sf_id("003", F.col("seq")))
    .withColumn("Title",
        F.element_at(F.array(F.lit("VP Network"),F.lit("Procurement Lead"),F.lit("Finance Director"),
                             F.lit("IT Manager"),F.lit("CTO")), (F.col("n") % 5 + 1)))
    .withColumn("Email", F.concat(F.lit("contact"), F.col("seq").cast("string"),
                                  F.lit(f"@customer.example")))
    .select("Id","AccountId","Title","Email"))
write_table(contact, SCHEMA_SFDC, "contact",
    "Salesforce Contact object (standard). Buying-centre contacts per Account.",
    {"Id":"Salesforce Contact Id (keyPrefix 003).","AccountId":"FK to salesforce_source.account.Id."})

# ---- Product2 + Pricebook (catalog of fiber offerings) ----------------------
products = [("FIBER-DIA-1G","1 Gbps Dedicated Internet Access","Dedicated Internet",1200.0),
            ("FIBER-DIA-10G","10 Gbps Dedicated Internet Access","Dedicated Internet",4800.0),
            ("WAVE-10G","10G Wavelength (point-to-point)","Wavelength",5200.0),
            ("WAVE-100G","100G Wavelength (point-to-point)","Wavelength",18500.0),
            ("ELINE-1G","E-Line EVPL 1G","Ethernet",900.0),
            ("ELAN-MPLS","MPLS IP-VPN site","IP-VPN",650.0),
            ("SDWAN-EDGE","Managed SD-WAN edge","Managed",450.0),
            ("COLO-RACK","Colocation rack + cross-connect","Colocation",1500.0)]
prod_df = spark.createDataFrame(products, ["ProductCode","Name","Family","list_mrr"]) \
    .withColumn("seq", F.monotonically_increasing_id()) \
    .withColumn("Id", sf_id("01t", F.col("seq"))) \
    .withColumn("IsActive", F.lit(True))
write_table(prod_df.select("Id","Name","ProductCode","Family","IsActive","list_mrr"),
    SCHEMA_SFDC, "product2",
    "Salesforce Product2 object (standard). Lakelink Fiber service catalogue (access, wavelength, Ethernet, IP-VPN, managed).",
    {"Id":"Product2 Id (keyPrefix 01t).","ProductCode":"SKU code.","Family":"Product family.",
     "list_mrr":"Catalogue list monthly recurring charge (USD)."})

# ---- Contract (should-be-billed source of truth) ----------------------------
contract = (acct_lkp
    .withColumn("cnt", F.floor(F.lit(CONTRACTS_PER_ACCOUNT) + rand_of(F.col("AccountId"))("c") ))
    .withColumn("cnt", F.greatest(F.lit(1), F.col("cnt").cast("int")))
    .withColumn("k", F.explode(F.sequence(F.lit(1), F.col("cnt"))))
    .withColumn("cseq", F.monotonically_increasing_id())
    .withColumn("Id", sf_id("800", F.col("cseq")))
    .withColumn("ContractNumber", F.concat(F.lit("CN-"), F.lpad(F.col("cseq").cast("string"),8,"0")))
    .withColumn("_start_off", (F.abs(F.hash(F.col("cseq"))) % 2555))   # within ~7yrs
    .withColumn("StartDate", F.date_add(F.lit("2018-01-01"), F.col("_start_off")))
    .withColumn("ContractTerm", F.element_at(F.array(F.lit(12),F.lit(24),F.lit(36),F.lit(36),F.lit(60)),
                                              (F.abs(F.hash(F.col("cseq"),F.lit(9))) % 5 + 1)))
    .withColumn("EndDate", F.add_months(F.col("StartDate"), F.col("ContractTerm")))
    .withColumn("Status", F.when(F.col("EndDate") < F.current_date(), "Expired").otherwise("Activated"))
    .withColumn("SLA_Tier__c", F.element_at(F.array(F.lit("Platinum"),F.lit("Gold"),F.lit("Silver")),
                                            (F.abs(F.hash(F.col("cseq"),F.lit(4))) % 3 + 1)))
    .withColumn("Auto_Renew__c", (F.abs(F.hash(F.col("cseq"),F.lit(5))) % 100) < 70)
    .withColumn("CurrencyIsoCode", F.col("CurrencyIsoCode")))

contract_out = contract.select("Id","AccountId","ContractNumber","Status","StartDate","EndDate",
    "ContractTerm","SLA_Tier__c","Auto_Renew__c","CurrencyIsoCode","TMF_Customer_Id__c")
write_table(contract_out, SCHEMA_SFDC, "contract",
    "Salesforce Contract object (standard). Signed customer contracts — the authoritative 'should-be-billed' terms reconciled against tmf billing.",
    {"Id":"Contract Id (keyPrefix 800).","AccountId":"FK to account.Id.","ContractTerm":"Term length in months.",
     "Status":"Contract lifecycle status (Draft/Activated/Expired).","SLA_Tier__c":"Custom SLA tier.",
     "TMF_Customer_Id__c":"MDM crosswalk to golden customer_id."})

# ---- Contract line items — link to real circuits + contracted price ---------
# Pull real circuits (logical_resource) and offering prices to anchor the source-of-truth price.
circuits = (spark.table(f"{CATALOG}.tmf_resource.logical_resource")
    .select(F.col("logical_resource_id").alias("Service_Circuit_Id__c"),
            "bandwidth_mbps","lifecycle_status")
    .withColumn("rn", F.row_number().over(Window.orderBy("Service_Circuit_Id__c"))))
contract_lkp = spark.table(f"{CATALOG}.{SCHEMA_SFDC}.contract").select(
    F.col("Id").alias("Contract__c"), "AccountId")

cli = (contract_lkp
    .withColumn("k", F.explode(F.sequence(F.lit(1), F.lit(LINES_PER_CONTRACT))))
    .withColumn("lseq", F.monotonically_increasing_id())
    .withColumn("rn", (F.abs(F.hash(F.col("lseq"))) % circuits.count() + 1))
    .join(circuits, on="rn", how="left")
    .join(prod_df.select(F.col("Id").alias("Product2Id"),"ProductCode","list_mrr","seq"),
          (F.abs(F.hash(F.col("lseq"),F.lit(3))) % 8) == F.col("seq"), "left")
    .withColumn("Id", sf_id("a0L", F.col("lseq")))
    .withColumn("Quantity", F.lit(1))
    # contracted price = list * negotiated factor (natural discounting, tier-driven)
    .withColumn("_disc", F.round(rand_of(F.col("lseq"))("d") * 0.35, 3))   # 0-35% discount
    .withColumn("Discount__c", F.col("_disc") * 100)
    .withColumn("UnitPrice", F.round(F.col("list_mrr") * (1 - F.col("_disc")), 2))
    .withColumn("TotalPrice", F.col("UnitPrice") * F.col("Quantity"))
    .withColumn("Billing_Frequency__c", F.lit("Monthly")))

# --- LEAKAGE INJECTION (flagged) : seed price mismatch + expired discount -----
cli = (cli
    .withColumn("_leak", rand_of(F.col("lseq"))("leak") < LEAKAGE_RATE)
    .withColumn("leakage_flag",
        F.when(F.col("_leak") & ((F.abs(F.hash(F.col("lseq"),F.lit(7))) % 2)==0), F.lit("price_mismatch"))
         .when(F.col("_leak"), F.lit("expired_discount"))
         .otherwise(F.lit(None)))
    # price_mismatch: contracted price silently differs from what billing will hold
    .withColumn("UnitPrice",
        F.when(F.col("leakage_flag")=="price_mismatch", F.round(F.col("UnitPrice")*1.18,2))
         .otherwise(F.col("UnitPrice")))
    .withColumn("TotalPrice", F.col("UnitPrice")*F.col("Quantity")))

cli_out = cli.select("Id","Contract__c","AccountId","Product2Id","ProductCode","Service_Circuit_Id__c",
    "Quantity","UnitPrice","TotalPrice","Discount__c","Billing_Frequency__c","bandwidth_mbps","leakage_flag")
write_table(cli_out, SCHEMA_SFDC, "contract_line_item",
    "Salesforce custom object Contract_Line_Item__c. One row per contracted circuit/service; UnitPrice is the negotiated source-of-truth MRR reconciled against tmf billing. `leakage_flag` marks seeded exceptions.",
    {"Id":"Contract line Id (keyPrefix a0L).","Contract__c":"FK to contract.Id.",
     "Service_Circuit_Id__c":"MDM crosswalk to tmf_resource.logical_resource.logical_resource_id (the circuit).",
     "UnitPrice":"Negotiated monthly price (source of truth for contract-price reconciliation).",
     "Discount__c":"Negotiated discount percent off list.",
     "leakage_flag":"DEMO ONLY: seeded exception type (price_mismatch / expired_discount) or null."})

# ---- Opportunity (pipeline; Q4-seasonal close dates) ------------------------
opp = (acct_lkp
    .withColumn("k", F.explode(F.sequence(F.lit(1), F.lit(int(OPPS_PER_ACCOUNT*10)))))
    .filter(rand_of(F.concat(F.col("AccountId"),F.col("k").cast("string")))("o") < (OPPS_PER_ACCOUNT/ (OPPS_PER_ACCOUNT*10)))
    .withColumn("oseq", F.monotonically_increasing_id())
    .withColumn("Id", sf_id("006", F.col("oseq")))
    .withColumn("Name", F.concat(F.lit("Fiber expansion "), F.col("oseq").cast("string")))
    .withColumn("_m", (F.abs(F.hash(F.col("oseq"),F.lit(11))) % 100))
    # Q4 seasonality: bias close dates into Oct-Dec
    .withColumn("_month", F.when(F.col("_m")<45, F.element_at(F.array(F.lit(10),F.lit(11),F.lit(12)),(F.col("_m")%3+1)))
                            .otherwise((F.col("_m")%9+1)))
    .withColumn("CloseDate", F.to_date(F.concat(F.lit("2025-"),F.lpad(F.col("_month").cast("string"),2,"0"),F.lit("-15"))))
    .withColumn("Amount", F.round(lognormal(10.5,0.7,F.col("oseq")),2))
    .withColumn("StageName", F.element_at(F.array(F.lit("Closed Won"),F.lit("Negotiation"),
                    F.lit("Proposal"),F.lit("Qualification"),F.lit("Closed Lost")),
                    (F.abs(F.hash(F.col("oseq"),F.lit(13)))%5+1)))
    .withColumn("Probability", F.when(F.col("StageName")=="Closed Won",100)
                    .when(F.col("StageName")=="Closed Lost",0).otherwise((F.abs(F.hash(F.col("oseq")))%80+10)))
    .select("Id","AccountId","Name","StageName","Amount","CloseDate","Probability","CurrencyIsoCode"))
write_table(opp, SCHEMA_SFDC, "opportunity",
    "Salesforce Opportunity object (standard). Sales pipeline with Q4-seasonal close dates and log-normal deal size.",
    {"Id":"Opportunity Id (keyPrefix 006).","StageName":"Sales stage.","Amount":"Total contract value (USD).",
     "CloseDate":"Expected/actual close date (Q4 seasonal bias)."})

# ---- CPQ: SBQQ__Quote__c + SBQQ__QuoteLine__c + discount + approval ----------
opp_lkp = spark.table(f"{CATALOG}.{SCHEMA_SFDC}.opportunity").select(
    F.col("Id").alias("SBQQ__Opportunity2__c"),"AccountId","CurrencyIsoCode")
quote = (opp_lkp
    .withColumn("qseq", F.monotonically_increasing_id())
    .withColumn("Id", sf_id("a0Q", F.col("qseq")))
    .withColumnRenamed("AccountId","SBQQ__Account__c")
    .withColumn("SBQQ__Status__c", F.element_at(F.array(F.lit("Approved"),F.lit("Draft"),
                    F.lit("Pending Approval"),F.lit("Accepted")),(F.abs(F.hash(F.col("qseq")))%4+1)))
    .withColumn("SBQQ__NetAmount__c", F.round(lognormal(10.4,0.7,F.col("qseq")),2))
    .withColumn("SBQQ__ExpirationDate__c", F.date_add(F.current_date(), (F.abs(F.hash(F.col("qseq"),F.lit(2)))%120)-40))
    .withColumn("ApprovalStatus__c", F.col("SBQQ__Status__c")))
write_table(quote.select("Id","SBQQ__Account__c","SBQQ__Opportunity2__c","SBQQ__Status__c",
        "SBQQ__NetAmount__c","SBQQ__ExpirationDate__c","ApprovalStatus__c","CurrencyIsoCode"),
    SCHEMA_SFDC, "sbqq__quote__c",
    "Salesforce CPQ (Salesforce CPQ / Steelbrick) SBQQ__Quote__c object. Configured quotes; expiration + approval status feed the expired/unauthorised-discount reconciliation.",
    {"Id":"CPQ Quote Id (keyPrefix a0Q).","SBQQ__Account__c":"FK to account.Id.",
     "SBQQ__NetAmount__c":"Net quoted amount after discounting.",
     "SBQQ__ExpirationDate__c":"Quote/discount expiration date.",
     "ApprovalStatus__c":"Discount approval status."})

quote_lkp = spark.table(f"{CATALOG}.{SCHEMA_SFDC}.sbqq__quote__c").select(
    F.col("Id").alias("SBQQ__Quote__c"))
qline = (quote_lkp
    .withColumn("k", F.explode(F.sequence(F.lit(1), F.lit(3))))
    .withColumn("qlseq", F.monotonically_increasing_id())
    .withColumn("Id", sf_id("a0R", F.col("qlseq")))
    .join(prod_df.select(F.col("Id").alias("SBQQ__Product__c"),"list_mrr","seq"),
          (F.abs(F.hash(F.col("qlseq"))) % 8) == F.col("seq"), "left")
    .withColumn("SBQQ__Quantity__c", F.lit(1))
    .withColumn("SBQQ__ListPrice__c", F.col("list_mrr"))
    .withColumn("SBQQ__Discount__c", F.round(rand_of(F.col("qlseq"))("qd")*40,1))
    .withColumn("SBQQ__CustomerPrice__c", F.round(F.col("list_mrr")*(1 - F.col("SBQQ__Discount__c")/100),2)))
write_table(qline.select("Id","SBQQ__Quote__c","SBQQ__Product__c","SBQQ__Quantity__c",
        "SBQQ__ListPrice__c","SBQQ__Discount__c","SBQQ__CustomerPrice__c"),
    SCHEMA_SFDC, "sbqq__quoteline__c",
    "Salesforce CPQ SBQQ__QuoteLine__c object. Per-line list vs customer price and discount percentage.",
    {"Id":"CPQ Quote Line Id (keyPrefix a0R).","SBQQ__Quote__c":"FK to sbqq__quote__c.Id.",
     "SBQQ__ListPrice__c":"Catalogue list price.","SBQQ__Discount__c":"Line discount percent.",
     "SBQQ__CustomerPrice__c":"Final customer price after discount."})

# ---- Discount approval audit trail (drives 'unauthorised discount' check) ----
approval = (quote.select("Id","SBQQ__Status__c")
    .withColumnRenamed("Id","Quote__c")
    .withColumn("aseq", F.monotonically_increasing_id())
    .withColumn("Id", sf_id("a0A", F.col("aseq")))
    .withColumn("Approved_Discount_Pct__c", F.round(rand_of(F.col("aseq"))("a")*30,1))
    .withColumn("Status", F.when(F.col("SBQQ__Status__c")=="Approved","Approved")
                            .when(F.col("SBQQ__Status__c")=="Pending Approval","Pending").otherwise("Not Submitted"))
    .withColumn("Approver__c", F.concat(F.lit("Deal Desk "), (F.abs(F.hash(F.col("aseq")))%8+1).cast("string")))
    .withColumn("ApprovalDate", F.when(F.col("Status")=="Approved",
                    F.date_add(F.current_date(), -(F.abs(F.hash(F.col("aseq"),F.lit(6)))%400))).otherwise(F.lit(None))))
write_table(approval.select("Id","Quote__c","Status","Approved_Discount_Pct__c","Approver__c","ApprovalDate"),
    SCHEMA_SFDC, "discount_approval__c",
    "Salesforce custom object Discount_Approval__c. Deal-desk approval audit for CPQ discounts; the max approved percentage is the control reconciled against applied discounts.",
    {"Id":"Approval record Id.","Quote__c":"FK to sbqq__quote__c.Id.",
     "Approved_Discount_Pct__c":"Maximum discount percentage approved by deal desk.",
     "Status":"Approval status.","ApprovalDate":"Date approved (null if not approved)."})

# ---- PRM: partner accounts + program agreements ------------------------------
partner = (spark.range(0, 60)
    .withColumn("Id", sf_id("001", F.col("id")+F.lit(500000)))
    .withColumn("Name", F.concat(F.lit("Partner Carrier "), F.col("id").cast("string")))
    .withColumn("IsPartner", F.lit(True))
    .withColumn("Partner_Type__c", F.element_at(F.array(F.lit("Wholesale Carrier"),F.lit("Reseller"),
                    F.lit("Agent"),F.lit("Interconnect")),(F.col("id")%4+1)))
    .withColumn("Rev_Share_Pct__c", F.round(15 + rand_of(F.col("id"))("p")*25,1)))
write_table(partner.select("Id","Name","IsPartner","Partner_Type__c","Rev_Share_Pct__c"),
    SCHEMA_SFDC, "partner_account",
    "Salesforce PRM partner Account (IsPartner=true). Wholesale/reseller/interconnect partners; Rev_Share_Pct__c reconciled against tmf partner settlement.",
    {"Id":"Partner Account Id.","Partner_Type__c":"Partner relationship type.",
     "Rev_Share_Pct__c":"Agreed revenue-share percentage."})

# COMMAND ----------

# MAGIC %md
# MAGIC ## 5 · Oracle ERP source  (`oracle_erp_source`)
# MAGIC Oracle Receivables / General Ledger table + column names (EBS / Fusion conventions).
# MAGIC **AR invoices are derived from the existing `tmf_customer.bill`** so the finance
# MAGIC system and the billing system reconcile to the same invoices — the ERP is the
# MAGIC "recognised & collected" truth; GL and ASC-606 rev-rec close the loop.

# COMMAND ----------

# DBTITLE 1,Cell 13
make_schema(SCHEMA_ERP, "Oracle ERP Cloud / E-Business Suite source: Receivables (RA_/AR_) invoices, aging and receipts derived from tmf billing; General Ledger (GL_) journals and chart of accounts; ASC-606 revenue recognition; budgets. Party master crosswalks to tmf_customer.customer.")

bill = spark.table(f"{CATALOG}.tmf_customer.bill")

# ---- HZ party / customer account master (TCA) --------------------------------
hz = (account.select(F.col("TMF_Customer_Id__c").alias("_cid"),

                     F.col("Name").alias("PARTY_NAME"),
                     F.col("AccountNumber").alias("ACCOUNT_NUMBER"),
                     F.col("External_Customer_Code__c").alias("ORIG_SYSTEM_REFERENCE"),
                     F.col("CurrencyIsoCode"))
    .withColumn("PARTY_ID", F.col("_cid") + F.lit(PK_START_OFFSET))
    .withColumn("CUST_ACCOUNT_ID", F.col("_cid") + F.lit(PK_START_OFFSET))
    .withColumn("PARTY_TYPE", F.lit("ORGANIZATION"))
    .withColumn("STATUS", F.lit("A")))
write_table(hz.select("PARTY_ID","CUST_ACCOUNT_ID","PARTY_NAME","PARTY_TYPE","ACCOUNT_NUMBER",
        "ORIG_SYSTEM_REFERENCE","STATUS", F.col("_cid").alias("TMF_CUSTOMER_ID")),
    SCHEMA_ERP, "hz_cust_accounts",
    "Oracle TCA HZ_CUST_ACCOUNTS (Trading Community Architecture). Customer account master as held in ERP; ORIG_SYSTEM_REFERENCE and TMF_CUSTOMER_ID crosswalk to the golden customer.",
    {"PARTY_ID":"TCA party identifier.","CUST_ACCOUNT_ID":"Customer account id used across Receivables.",
     "ORIG_SYSTEM_REFERENCE":"Source cross-reference = external_customer_code (MDM survivorship key).",
     "TMF_CUSTOMER_ID":"MDM crosswalk to golden customer_id.","STATUS":"Account status (A=active)."})

# ---- RA_CUSTOMER_TRX_ALL : AR invoice headers (from tmf bill) ----------------
trx = (bill.select("bill_id","customer_id","total_amount","tax_amount",
                   "billing_period_start_date","billing_period_end_date","date","due_date",
                   "outstanding_amount","paid_amount","paid_date")
    .withColumn("CUSTOMER_TRX_ID", F.col("bill_id") + F.lit(PK_START_OFFSET))
    .withColumn("TRX_NUMBER", F.concat(F.lit("INV-"), F.lpad(F.col("bill_id").cast("string"),10,"0")))
    .withColumn("TRX_DATE", F.to_date("date"))
    .withColumn("BILL_TO_CUSTOMER_ID", F.col("customer_id") + F.lit(PK_START_OFFSET))
    .withColumn("INVOICE_CURRENCY_CODE", F.lit("USD"))
    .withColumn("CUST_TRX_TYPE", F.lit("INV"))
    .withColumn("COMPLETE_FLAG", F.lit("Y")))
write_table(trx.select("CUSTOMER_TRX_ID","TRX_NUMBER","TRX_DATE","BILL_TO_CUSTOMER_ID",
        "INVOICE_CURRENCY_CODE","CUST_TRX_TYPE","COMPLETE_FLAG",
        F.col("total_amount").alias("INVOICE_AMOUNT"), F.col("tax_amount").alias("TAX_AMOUNT"),
        F.col("bill_id").alias("TMF_BILL_ID")),
    SCHEMA_ERP, "ra_customer_trx_all",
    "Oracle Receivables RA_CUSTOMER_TRX_ALL: AR invoice headers. Derived 1:1 from tmf_customer.bill so ERP finance and billing reconcile to the same invoices.",
    {"CUSTOMER_TRX_ID":"Receivables transaction id (PK).","TRX_NUMBER":"Human-readable invoice number.",
     "TRX_DATE":"Invoice date.","BILL_TO_CUSTOMER_ID":"FK to hz_cust_accounts.CUST_ACCOUNT_ID.",
     "INVOICE_AMOUNT":"Invoice total (matches tmf bill.total_amount).","TMF_BILL_ID":"Crosswalk to tmf_customer.bill.bill_id."})

# ---- RA_CUSTOMER_TRX_LINES_ALL : invoice lines -------------------------------
trx_lines = (trx.select("CUSTOMER_TRX_ID", F.col("total_amount"), F.col("tax_amount"))
    .withColumn("k", F.explode(F.sequence(F.lit(1), F.lit(3))))
    .withColumn("CUSTOMER_TRX_LINE_ID", F.monotonically_increasing_id()+F.lit(PK_START_OFFSET))
    .withColumn("LINE_NUMBER", F.col("k"))
    .withColumn("LINE_TYPE", F.element_at(F.array(F.lit("LINE"),F.lit("LINE"),F.lit("TAX")), F.col("k")))
    .withColumn("QUANTITY_INVOICED", F.lit(1))
    .withColumn("UNIT_SELLING_PRICE", F.round(F.col("total_amount")/F.lit(3),2))
    .withColumn("EXTENDED_AMOUNT", F.col("UNIT_SELLING_PRICE")))
write_table(trx_lines.select("CUSTOMER_TRX_LINE_ID","CUSTOMER_TRX_ID","LINE_NUMBER","LINE_TYPE",
        "QUANTITY_INVOICED","UNIT_SELLING_PRICE","EXTENDED_AMOUNT"),
    SCHEMA_ERP, "ra_customer_trx_lines_all",
    "Oracle Receivables RA_CUSTOMER_TRX_LINES_ALL: invoice line detail (LINE/TAX/FREIGHT).",
    {"CUSTOMER_TRX_LINE_ID":"Invoice line id (PK).","CUSTOMER_TRX_ID":"FK to ra_customer_trx_all.",
     "LINE_TYPE":"Line classification.","UNIT_SELLING_PRICE":"Unit selling price.","EXTENDED_AMOUNT":"Extended line amount."})

# ---- AR_PAYMENT_SCHEDULES_ALL : open items / aging ---------------------------
sched = (trx.select("CUSTOMER_TRX_ID","BILL_TO_CUSTOMER_ID","TRX_DATE","due_date",
                    "total_amount","outstanding_amount","paid_amount")
    .withColumn("PAYMENT_SCHEDULE_ID", F.col("CUSTOMER_TRX_ID"))
    .withColumn("DUE_DATE", F.to_date("due_date"))
    .withColumn("AMOUNT_DUE_ORIGINAL", F.col("total_amount"))
    .withColumn("AMOUNT_DUE_REMAINING", F.coalesce(F.col("outstanding_amount"), F.lit(0.0)))
    .withColumn("STATUS", F.when(F.col("AMOUNT_DUE_REMAINING") <= 0, "CL").otherwise("OP"))
    .withColumn("_days_overdue", F.datediff(F.current_date(), F.col("DUE_DATE")))
    .withColumn("AGING_BUCKET",
        F.when(F.col("STATUS")=="CL","Paid")
         .when(F.col("_days_overdue")<=0,"Current")
         .when(F.col("_days_overdue")<=30,"1-30")
         .when(F.col("_days_overdue")<=60,"31-60")
         .when(F.col("_days_overdue")<=90,"61-90").otherwise("90+"))
    .withColumn("CLASS", F.lit("INV")))
write_table(sched.select("PAYMENT_SCHEDULE_ID","CUSTOMER_TRX_ID","BILL_TO_CUSTOMER_ID","DUE_DATE",
        "AMOUNT_DUE_ORIGINAL","AMOUNT_DUE_REMAINING","STATUS","AGING_BUCKET","CLASS"),
    SCHEMA_ERP, "ar_payment_schedules_all",
    "Oracle Receivables AR_PAYMENT_SCHEDULES_ALL: open receivables and aging. AMOUNT_DUE_REMAINING + AGING_BUCKET expose billed-but-uncollected leakage.",
    {"PAYMENT_SCHEDULE_ID":"Payment schedule id (PK).","CUSTOMER_TRX_ID":"FK to ra_customer_trx_all.",
     "AMOUNT_DUE_REMAINING":"Open balance still owed.","STATUS":"OP=open, CL=closed.",
     "AGING_BUCKET":"Derived aging bucket (Current/1-30/31-60/61-90/90+/Paid)."})

# ---- AR_CASH_RECEIPTS_ALL : receipts / cash application ----------------------
receipts = (trx.filter(F.col("paid_amount").isNotNull() & (F.col("paid_amount")>0))
    .select("CUSTOMER_TRX_ID","BILL_TO_CUSTOMER_ID","paid_amount","paid_date")
    .withColumn("CASH_RECEIPT_ID", F.col("CUSTOMER_TRX_ID")+F.lit(1))
    .withColumn("AMOUNT", F.col("paid_amount"))
    .withColumn("RECEIPT_DATE", F.to_date("paid_date"))
    .withColumn("STATUS", F.lit("APP"))
    .withColumn("RECEIPT_METHOD", F.element_at(F.array(F.lit("WIRE"),F.lit("ACH"),F.lit("CHECK")),
                    (F.abs(F.hash(F.col("CASH_RECEIPT_ID")))%3+1))))
write_table(receipts.select("CASH_RECEIPT_ID","CUSTOMER_TRX_ID","BILL_TO_CUSTOMER_ID","AMOUNT",
        "RECEIPT_DATE","STATUS","RECEIPT_METHOD"),
    SCHEMA_ERP, "ar_cash_receipts_all",
    "Oracle Receivables AR_CASH_RECEIPTS_ALL: customer cash receipts applied to invoices.",
    {"CASH_RECEIPT_ID":"Cash receipt id (PK).","AMOUNT":"Receipt amount.","STATUS":"APP=applied.",
     "RECEIPT_METHOD":"Payment instrument."})

# ---- GL chart of accounts + journals -----------------------------------------
coa = spark.createDataFrame(
    [("4000","Recurring Service Revenue"),("4010","Usage Revenue"),("4020","Installation Revenue"),
     ("1200","Accounts Receivable"),("2400","Deferred Revenue"),("5000","Network Cost of Sales"),
     ("6100","Partner Settlement Expense")], ["ACCOUNT","ACCOUNT_DESC"]) \
    .withColumn("CODE_COMBINATION_ID", F.monotonically_increasing_id()+F.lit(PK_START_OFFSET)) \
    .withColumn("SEGMENT1_COMPANY", F.lit("01")) \
    .withColumn("SEGMENT2_COST_CENTER", F.lit("400")) \
    .withColumn("SEGMENT3_ACCOUNT", F.col("ACCOUNT"))
write_table(coa.select("CODE_COMBINATION_ID","SEGMENT1_COMPANY","SEGMENT2_COST_CENTER",
        "SEGMENT3_ACCOUNT","ACCOUNT","ACCOUNT_DESC"),
    SCHEMA_ERP, "gl_code_combinations",
    "Oracle GL_CODE_COMBINATIONS: chart-of-accounts code combinations (company.cost-centre.account).",
    {"CODE_COMBINATION_ID":"Code combination id (PK).","SEGMENT3_ACCOUNT":"Natural account segment.",
     "ACCOUNT_DESC":"Account description."})

je_head = (trx.select("CUSTOMER_TRX_ID","TRX_DATE","total_amount")
    .withColumn("JE_HEADER_ID", F.col("CUSTOMER_TRX_ID")+F.lit(2))
    .withColumn("JE_BATCH_NAME", F.concat(F.lit("AR-INV "), F.date_format("TRX_DATE","yyyy-MM")))
    .withColumn("PERIOD_NAME", F.date_format("TRX_DATE","MMM-yy"))
    .withColumn("CURRENCY_CODE", F.lit("USD"))
    .withColumn("STATUS", F.lit("P"))
    .withColumn("JE_SOURCE", F.lit("Receivables"))
    .withColumn("JE_CATEGORY", F.lit("Sales Invoices")))
write_table(je_head.select("JE_HEADER_ID","JE_BATCH_NAME","PERIOD_NAME","CURRENCY_CODE",
        "STATUS","JE_SOURCE","JE_CATEGORY","TRX_DATE","CUSTOMER_TRX_ID"),
    SCHEMA_ERP, "gl_je_headers",
    "Oracle GL_JE_HEADERS: journal entry headers posted from Receivables.",
    {"JE_HEADER_ID":"Journal header id (PK).","PERIOD_NAME":"GL period (MON-YY).",
     "STATUS":"P=posted.","JE_SOURCE":"Feeder subledger.","CUSTOMER_TRX_ID":"Source AR invoice."})

# JE lines: DR AR / CR Revenue (+ deferred split) — natural double-entry
rev_cc = coa.filter(F.col("ACCOUNT")=="4000").select("CODE_COMBINATION_ID").first()[0]
ar_cc  = coa.filter(F.col("ACCOUNT")=="1200").select("CODE_COMBINATION_ID").first()[0]
je_lines = (je_head.select("JE_HEADER_ID","total_amount")
    .withColumn("k", F.explode(F.array(F.lit("DR"),F.lit("CR"))))
    .withColumn("JE_LINE_NUM", F.when(F.col("k")=="DR",1).otherwise(2))
    .withColumn("CODE_COMBINATION_ID", F.when(F.col("k")=="DR", F.lit(ar_cc)).otherwise(F.lit(rev_cc)))
    .withColumn("ENTERED_DR", F.when(F.col("k")=="DR", F.col("total_amount")).otherwise(F.lit(0.0)))
    .withColumn("ENTERED_CR", F.when(F.col("k")=="CR", F.col("total_amount")).otherwise(F.lit(0.0))))
write_table(je_lines.select("JE_HEADER_ID","JE_LINE_NUM","CODE_COMBINATION_ID","ENTERED_DR","ENTERED_CR"),
    SCHEMA_ERP, "gl_je_lines",
    "Oracle GL_JE_LINES: journal lines (balanced double-entry — DR Receivables / CR Revenue) for each posted invoice.",
    {"JE_HEADER_ID":"FK to gl_je_headers.","CODE_COMBINATION_ID":"FK to gl_code_combinations.",
     "ENTERED_DR":"Debit amount.","ENTERED_CR":"Credit amount."})

# ---- ASC-606 revenue recognition schedule ------------------------------------
revrec = (trx.select("CUSTOMER_TRX_ID","TRX_DATE","total_amount")
    .withColumn("k", F.explode(F.sequence(F.lit(0), F.lit(11))))          # 12-month ratable
    .withColumn("REV_REC_ID", F.monotonically_increasing_id()+F.lit(PK_START_OFFSET))
    .withColumn("PERFORMANCE_OBLIGATION", F.lit("Recurring fiber service (over time)"))
    .withColumn("RECOGNITION_DATE", F.add_months(F.col("TRX_DATE"), F.col("k")))
    .withColumn("PERIOD_NAME", F.date_format("RECOGNITION_DATE","MMM-yy"))
    .withColumn("RECOGNIZED_AMOUNT", F.round(F.col("total_amount")/F.lit(12),2))
    .withColumn("STATUS", F.when(F.col("RECOGNITION_DATE")<=F.current_date(),"RECOGNIZED").otherwise("DEFERRED")))
write_table(revrec.select("REV_REC_ID","CUSTOMER_TRX_ID","PERFORMANCE_OBLIGATION","PERIOD_NAME",
        "RECOGNITION_DATE","RECOGNIZED_AMOUNT","STATUS"),
    SCHEMA_ERP, "revenue_recognition_schedule",
    "Oracle Revenue Management (ASC 606) recognition schedule: ratable 12-month recognition per invoice. Recognised vs deferred split detects revenue-recognition-error leakage.",
    {"REV_REC_ID":"Recognition line id (PK).","CUSTOMER_TRX_ID":"FK to ra_customer_trx_all.",
     "PERFORMANCE_OBLIGATION":"ASC-606 performance obligation.","RECOGNIZED_AMOUNT":"Amount recognised in period.",
     "STATUS":"RECOGNIZED or DEFERRED."})

# ---- GL_BUDGETS (forecast baseline) ------------------------------------------
budget = (spark.range(0, 96)   # 8 years x 12 months
    .withColumn("BUDGET_ID", F.col("id")+F.lit(PK_START_OFFSET))
    .withColumn("PERIOD_NAME", F.date_format(F.add_months(F.lit("2018-01-01"), F.col("id").cast("int")),"MMM-yy"))
    .withColumn("ACCOUNT", F.lit("4000"))
    .withColumn("BUDGET_AMOUNT", F.round(lognormal(16.6,0.15,F.col("id")),0)))
write_table(budget.select("BUDGET_ID","PERIOD_NAME","ACCOUNT","BUDGET_AMOUNT"),
    SCHEMA_ERP, "gl_budgets",
    "Oracle GL budget balances by period — revenue plan/forecast baseline for actual-vs-expected variance analysis.",
    {"BUDGET_ID":"Budget row id.","PERIOD_NAME":"GL period.","BUDGET_AMOUNT":"Planned revenue for the period."})

# COMMAND ----------

# MAGIC %md
# MAGIC ## 6 · Refinitiv / LSEG FX source  (`refinitiv_fx_source`)
# MAGIC Daily conversion rates for multi-currency partner settlement (Oracle `GL_DAILY_RATES`
# MAGIC shape, sourced from a market-data provider). Natural random-walk around a base rate.

# COMMAND ----------

make_schema(SCHEMA_FX, "Refinitiv / LSEG market-data source: daily FX conversion rates used for multi-currency partner settlement and GL translation (Oracle GL_DAILY_RATES shape).")

pairs = [("EUR","USD",1.08),("GBP","USD",1.27),("USD","USD",1.0),("CAD","USD",0.74),
         ("AUD","USD",0.66),("JPY","USD",0.0067),("SGD","USD",0.74),("AED","USD",0.27)]
pair_df = spark.createDataFrame(pairs, ["FROM_CURRENCY","TO_CURRENCY","base_rate"])
fx = (pair_df.crossJoin(spark.range(0, FX_DAYS).withColumnRenamed("id","d"))
    .withColumn("CONVERSION_DATE", F.date_add(F.lit("2018-01-01"), F.col("d").cast("int")))
    # deterministic random-walk-ish daily drift (±1.5%)
    .withColumn("_drift", (F.abs(F.hash(F.col("FROM_CURRENCY"),F.col("d"))) % 300 - 150)/10000.0)
    .withColumn("CONVERSION_RATE", F.round(F.col("base_rate") * (1 + F.col("_drift")),6))
    .withColumn("CONVERSION_TYPE", F.lit("Corporate"))
    .withColumn("SOURCE", F.lit("Refinitiv")))
write_table(fx.select("FROM_CURRENCY","TO_CURRENCY","CONVERSION_DATE","CONVERSION_RATE","CONVERSION_TYPE","SOURCE"),
    SCHEMA_FX, "gl_daily_rates",
    "Refinitiv-sourced daily FX rates (Oracle GL_DAILY_RATES shape). One row per currency pair per day, 2018-2025, with realistic daily drift.",
    {"FROM_CURRENCY":"Source ISO currency.","TO_CURRENCY":"Target ISO currency (USD functional).",
     "CONVERSION_DATE":"Rate date.","CONVERSION_RATE":"FX conversion rate.","CONVERSION_TYPE":"Corporate/Spot.",
     "SOURCE":"Market-data provider."})

# COMMAND ----------

# MAGIC %md
# MAGIC ## 7 · MDM crosswalk  (`mdm_source.customer_crosswalk`)
# MAGIC The survivorship lineage tying each source-system party back to the golden customer —
# MAGIC exactly the mapping the `tmf_*` MDM build relies on. Match confidence is skewed high
# MAGIC with a realistic tail of fuzzy matches (the hard identity-resolution cases).

# COMMAND ----------

xw_sf  = account.select(F.lit("SALESFORCE").alias("SOURCE_SYSTEM"),
                        F.col("Id").alias("SOURCE_PARTY_ID"),
                        F.col("External_Customer_Code__c").alias("SOURCE_PARTY_CODE"),
                        F.col("TMF_Customer_Id__c").alias("MASTER_CUSTOMER_ID"))
xw_erp = spark.table(f"{CATALOG}.{SCHEMA_ERP}.hz_cust_accounts").select(
                        F.lit("ORACLE_ERP").alias("SOURCE_SYSTEM"),
                        F.col("CUST_ACCOUNT_ID").cast("string").alias("SOURCE_PARTY_ID"),
                        F.col("ORIG_SYSTEM_REFERENCE").alias("SOURCE_PARTY_CODE"),
                        F.col("TMF_CUSTOMER_ID").alias("MASTER_CUSTOMER_ID"))
crosswalk = (xw_sf.unionByName(xw_erp)
    .withColumn("_r", (F.abs(F.hash(F.col("SOURCE_PARTY_ID"))) % 1000)/1000.0)
    .withColumn("MATCH_CONFIDENCE",
        F.when(F.col("_r")<0.85, F.round(0.97 + F.col("_r")*0.03,3))   # high-confidence exact
         .otherwise(F.round(0.70 + F.col("_r")*0.20,3)))               # fuzzy tail
    .withColumn("MATCH_RULE",
        F.when(F.col("MATCH_CONFIDENCE")>=0.97,"exact_external_code")
         .otherwise("probabilistic_name_address"))
    .withColumn("SURVIVORSHIP_ROLE",
        F.when(F.col("SOURCE_SYSTEM")=="SALESFORCE","contributor_pricing")
         .otherwise("contributor_financial")))
write_table(crosswalk.select("SOURCE_SYSTEM","SOURCE_PARTY_ID","SOURCE_PARTY_CODE","MASTER_CUSTOMER_ID",
        "MATCH_CONFIDENCE","MATCH_RULE","SURVIVORSHIP_ROLE"),
    SCHEMA_MDM, "customer_crosswalk",
    "MDM survivorship crosswalk: maps each source-system party (Salesforce, Oracle ERP) to the golden customer_id in tmf_customer.customer, with match confidence and rule. This is the lineage the SID/MDM golden layer is built from.",
    {"SOURCE_SYSTEM":"Originating source system.","SOURCE_PARTY_ID":"Native party id in the source system.",
     "SOURCE_PARTY_CODE":"Shared external code used for deterministic matching.",
     "MASTER_CUSTOMER_ID":"Golden customer_id in cdm_tmforum.tmf_customer.customer.",
     "MATCH_CONFIDENCE":"Survivorship match confidence (0-1); skewed high with a fuzzy tail.",
     "MATCH_RULE":"exact_external_code vs probabilistic_name_address."})

# COMMAND ----------

# MAGIC %md
# MAGIC ## 8 · Unstructured documents — Lakelink Fiber branded
# MAGIC Generates branded **MSA contracts (CLM)**, **invoices**, and **dunning letters** as
# MAGIC HTML → PDF and lands them in UC volumes for `ai_parse_document` / Knowledge Assistant.
# MAGIC Branding is consistent (letterhead, palette, footer) and uses the Databricks logo as
# MAGIC the Lakelink Fiber mark. Metadata rows are written to `ironclad_clm_source`.

# COMMAND ----------

# DBTITLE 1,Cell 20
# Bootstrap minimal prerequisites so this cell can run independently.
from pyspark.sql import functions as F

if "CATALOG" not in globals():
    CATALOG = "cdm_tmforum"
if "SCHEMA_SFDC" not in globals():
    SCHEMA_SFDC = "salesforce_source"
if "SCHEMA_CLM" not in globals():
    SCHEMA_CLM = "ironclad_clm_source"
if "BRAND" not in globals():
    BRAND = {
        "company": "Lakelink Fiber",
        "legal_name": "Lakelink Fiber Communications, Inc.",
        "tagline": "Enterprise Fiber & Wavelength Services",
        "primary": "#0B3D5C",
        "accent": "#FF6A3D",
        "ink": "#1c1c1c",
        "muted": "#6b7280",
        "domain": "lakelinkfiber.com",
        "address": "410 Optical Way, Suite 900, Denver, CO 80202",
        "support": "1-800-LAKELINK",
    }
if "DATABRICKS_LOGO_URL" not in globals():
    DATABRICKS_LOGO_URL = "https://upload.wikimedia.org/wikipedia/commons/6/63/Databricks_Logo.png"
if "make_schema" not in globals():
    def make_schema(schema, comment):
        spark.sql(f"CREATE SCHEMA IF NOT EXISTS {CATALOG}.{schema} COMMENT '{comment}'")
if "write_table" not in globals():
    def write_table(df, schema, table, table_comment, col_comments, mode="overwrite"):
        fqn = f"{CATALOG}.{schema}.{table}"
        (df.write.format("delta").mode(mode)
            .option("overwriteSchema", "true").saveAsTable(fqn))
        spark.sql(f"COMMENT ON TABLE {fqn} IS '{table_comment.replace(chr(39), chr(8217))}'")
        have = set(c.name for c in df.schema.fields)
        for col, cmt in col_comments.items():
            if col in have:
                safe = cmt.replace("'", "’")
                spark.sql(f"ALTER TABLE {fqn} ALTER COLUMN {col} COMMENT '{safe}'")
        print(f"  ✓ {fqn}  ({df.count():,} rows, {len(df.columns)} cols)")
        return fqn

account = spark.table(f"{CATALOG}.{SCHEMA_SFDC}.account")
bill = spark.table(f"{CATALOG}.tmf_customer.bill")

make_schema(SCHEMA_CLM, "Ironclad CLM source: contract records (MSA, Order Form, Amendment) and their branded PDF attachments. The document repository behind contract-compliance checks.")

# Volumes for the rendered documents
for vol in ["contract_pdfs", "invoice_pdfs", "dunning_pdfs"]:
    spark.sql(f"CREATE VOLUME IF NOT EXISTS {CATALOG}.{SCHEMA_CLM}.{vol}")
CLM_VOL = f"/Volumes/{CATALOG}/{SCHEMA_CLM}"

import os, base64, urllib.request

# Fetch the Databricks logo once (fallback to a simple inline wordmark if offline).
def get_logo_data_uri():
    try:
        req = urllib.request.Request(DATABRICKS_LOGO_URL, headers={"User-Agent":"Mozilla/5.0"})
        raw = urllib.request.urlopen(req, timeout=15).read()
        return "data:image/png;base64," + base64.b64encode(raw).decode()
    except Exception as e:
        print(f"  (logo fetch failed: {e}; using text mark)")
        return None
LOGO = get_logo_data_uri()

def letterhead_css():
    b = BRAND
    return f"""
    <style>
      @page {{ size: Letter; margin: 54px 56px; }}
      * {{ font-family: 'Helvetica Neue', Arial, sans-serif; color: {b['ink']}; }}
      .bar {{ height: 6px; background: {b['primary']}; }}
      .accent {{ color: {b['accent']}; }}
      header {{ display:flex; justify-content:space-between; align-items:center;
                border-bottom:2px solid {b['primary']}; padding-bottom:12px; margin-bottom:22px; }}
      .brand {{ font-size:22px; font-weight:800; color:{b['primary']}; letter-spacing:.5px; }}
      .brand small {{ display:block; font-size:10px; font-weight:500; color:{b['muted']}; letter-spacing:2px; }}
      .logo {{ height:34px; }}
      h1 {{ color:{b['primary']}; font-size:19px; margin:6px 0 2px; }}
      table {{ width:100%; border-collapse:collapse; margin:14px 0; font-size:12px; }}
      th {{ background:{b['primary']}; color:#fff; text-align:left; padding:7px 9px; }}
      td {{ border-bottom:1px solid #e5e7eb; padding:7px 9px; }}
      .tot {{ font-weight:700; color:{b['primary']}; }}
      footer {{ position:fixed; bottom:-30px; left:0; right:0; font-size:9px; color:{b['muted']};
                border-top:1px solid #e5e7eb; padding-top:6px; text-align:center; }}
      .muted {{ color:{b['muted']}; font-size:11px; }}
    </style>"""

def brand_header(doc_kind):
    b = BRAND
    logo_html = (f'<img class="logo" src="{LOGO}"/>' if LOGO
                 else f'<div class="brand accent">◆</div>')
    return f"""
    <div class="bar"></div>
    <header>
      <div><div class="brand">{b['company']}<small>{b['tagline'].upper()}</small></div></div>
      <div style="text-align:right">{logo_html}<div class="muted">{doc_kind}</div></div>
    </header>"""

def brand_footer():
    b = BRAND
    return f"""<footer>{b['legal_name']} · {b['address']} · {b['support']} · {b['domain']}
      &nbsp;|&nbsp; Confidential — generated for demonstration</footer>"""

def render_pdf(html, out_path):
    """HTML -> PDF via xhtml2pdf (pure Python, no system deps); falls back to .html."""
    try:
        from xhtml2pdf import pisa
        with open(out_path, "wb") as f:
            status = pisa.CreatePDF(html, dest=f)
        if status.err:
            raise RuntimeError(f"xhtml2pdf reported {status.err} errors")
        return out_path
    except Exception as e:
        alt = out_path.rsplit(".",1)[0] + ".html"
        with open(alt, "w") as f: f.write(html)
        print(f"  (PDF render fallback -> {os.path.basename(alt)}: {e})")
        return alt

# ---- Build a small, high-value document set from real contracts --------------
# We take a sample of contracts (esp. leakage-flagged) so the docs correspond to
# records an RA analyst would actually pull up.
sample_contracts = (spark.table(f"{CATALOG}.{SCHEMA_SFDC}.contract")
    .join(account.select(F.col("Id").alias("AccountId"),"Name","BillingCountry","CurrencyIsoCode"), "AccountId")
    .limit(25).collect())

clm_rows = []
for c in sample_contracts:
    fname = f"MSA_{c['ContractNumber']}.pdf"
    html = f"""<html><head>{letterhead_css()}</head><body>
      {brand_header("MASTER SERVICE AGREEMENT")}
      <h1>Master Service Agreement</h1>
      <div class="muted">Contract {c['ContractNumber']} · Effective {c['StartDate']} – {c['EndDate']}</div>
      <p>This Master Service Agreement ("Agreement") is entered into between
         <b>{BRAND['legal_name']}</b> ("Provider") and <b>{c['Name']}</b> ("Customer"),
         for the provision of enterprise fiber and wavelength services.</p>
      <table>
        <tr><th>Term</th><th>Value</th></tr>
        <tr><td>Contract Number</td><td>{c['ContractNumber']}</td></tr>
        <tr><td>SLA Tier</td><td>{c['SLA_Tier__c']}</td></tr>
        <tr><td>Term (months)</td><td>{c['ContractTerm']}</td></tr>
        <tr><td>Auto-Renew</td><td>{'Yes' if c['Auto_Renew__c'] else 'No'}</td></tr>
        <tr><td>Currency</td><td>{c['CurrencyIsoCode']}</td></tr>
        <tr><td class="tot">Status</td><td class="tot">{c['Status']}</td></tr>
      </table>
      <p class="muted">1. Service Levels. Provider shall meet the availability commitments of the
         {c['SLA_Tier__c']} tier as set out in Schedule A. 2. Charges. Customer shall pay the monthly
         recurring charges per the applicable Order Forms. 3. Term & Renewal. This Agreement remains in
         effect through {c['EndDate']}{' and renews automatically' if c['Auto_Renew__c'] else ''}.</p>
      {brand_footer()}</body></html>"""
    out = render_pdf(html, f"{CLM_VOL}/contract_pdfs/{fname}")
    clm_rows.append((c['ContractNumber'], c['AccountId'], "Master Service Agreement",
                     str(c['StartDate']), str(c['EndDate']), c['Status'],
                     f"{CLM_VOL}/contract_pdfs/{os.path.basename(out)}"))

clm_meta = spark.createDataFrame(clm_rows,
    ["contract_number","account_id","record_type","effective_date","expiration_date","status","attachment_path"])
write_table(clm_meta, SCHEMA_CLM, "contract_record",
    "Ironclad CLM contract records: one row per executed agreement with a pointer to the branded PDF in the contract_pdfs volume. Feeds contract-compliance / ai_parse_document.",
    {"contract_number":"CLM contract number (matches Salesforce ContractNumber).",
     "account_id":"FK to salesforce_source.account.Id.","record_type":"MSA / Order Form / Amendment.",
     "attachment_path":"UC Volume path to the rendered PDF."})

# ---- A few branded invoices + dunning letters from real bills ----------------
sample_bills = (bill.join(account.select(F.col("TMF_Customer_Id__c").alias("customer_id"),"Name"), "customer_id")
    .select("bill_id","Name","total_amount","tax_amount","billing_period_start_date",
            "billing_period_end_date","due_date","outstanding_amount")
    .limit(20).collect())
inv_rows, dun_rows = [], []
for bnav in sample_bills:
    inv_no = f"INV-{int(bnav['bill_id']):010d}"
    inv_html = f"""<html><head>{letterhead_css()}</head><body>
      {brand_header("INVOICE")}
      <h1>Invoice {inv_no}</h1>
      <div class="muted">Bill to: {bnav['Name']} · Period {bnav['billing_period_start_date']} – {bnav['billing_period_end_date']} · Due {bnav['due_date']}</div>
      <table>
        <tr><th>Description</th><th>Amount</th></tr>
        <tr><td>Recurring fiber services</td><td>${(bnav['total_amount'] or 0):,.2f}</td></tr>
        <tr><td>Tax</td><td>${(bnav['tax_amount'] or 0):,.2f}</td></tr>
        <tr><td class="tot">Total Due</td><td class="tot">${(bnav['total_amount'] or 0):,.2f}</td></tr>
      </table>
      {brand_footer()}</body></html>"""
    out = render_pdf(inv_html, f"{CLM_VOL}/invoice_pdfs/{inv_no}.pdf")
    inv_rows.append((inv_no, bnav['Name'], float(bnav['total_amount'] or 0),
                     f"{CLM_VOL}/invoice_pdfs/{os.path.basename(out)}"))
    if (bnav['outstanding_amount'] or 0) > 0:
        dun_html = f"""<html><head>{letterhead_css()}</head><body>
          {brand_header("PAYMENT REMINDER")}
          <h1 class="accent">Overdue Balance Notice</h1>
          <p>Dear {bnav['Name']}, our records show an outstanding balance of
             <b>${(bnav['outstanding_amount'] or 0):,.2f}</b> on invoice {inv_no}, due {bnav['due_date']}.
             Please remit payment to avoid service interruption.</p>
          {brand_footer()}</body></html>"""
        do = render_pdf(dun_html, f"{CLM_VOL}/dunning_pdfs/DUN-{int(bnav['bill_id'])}.pdf")
        dun_rows.append((f"DUN-{int(bnav['bill_id'])}", bnav['Name'], float(bnav['outstanding_amount'] or 0),
                         f"{CLM_VOL}/dunning_pdfs/{os.path.basename(do)}"))

write_table(spark.createDataFrame(inv_rows, ["invoice_number","customer_name","total_amount","pdf_path"]),
    SCHEMA_CLM, "invoice_document",
    "Branded Lakelink Fiber invoice PDFs (rendered from tmf billing) with pointers to the invoice_pdfs volume.",
    {"invoice_number":"Invoice number.","total_amount":"Invoice total.","pdf_path":"UC Volume path to PDF."})
if dun_rows:
    write_table(spark.createDataFrame(dun_rows, ["dunning_ref","customer_name","outstanding_amount","pdf_path"]),
        SCHEMA_CLM, "dunning_letter",
        "Branded Lakelink Fiber dunning / overdue-notice PDFs for accounts with an open balance.",
        {"dunning_ref":"Dunning reference.","outstanding_amount":"Open balance demanded.","pdf_path":"UC Volume path to PDF."})

print("Unstructured document generation complete.")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 9 · Validation (run after generation)
# MAGIC Row counts, distribution sanity, and referential integrity back to the MDM golden set.

# COMMAND ----------

print("== Row counts ==")
for s in [SCHEMA_SFDC, SCHEMA_ERP, SCHEMA_FX, SCHEMA_MDM, SCHEMA_CLM]:
    for t in spark.sql(f"SHOW TABLES IN {CATALOG}.{s}").collect():
        if t.tableName.startswith("_"): continue
        n = spark.table(f"{CATALOG}.{s}.{t.tableName}").count()
        print(f"  {s}.{t.tableName:<28} {n:>10,}")

print("\n== Natural distribution: account size tiers ==")
spark.table(f"{CATALOG}.{SCHEMA_SFDC}.account").groupBy("Segment__c").count().orderBy("count").show()

print("== Referential integrity: crosswalk -> golden customer ==")
orphans = spark.sql(f"""
  SELECT COUNT(*) FROM {CATALOG}.{SCHEMA_MDM}.customer_crosswalk x
  LEFT ANTI JOIN {CATALOG}.tmf_customer.customer c ON x.MASTER_CUSTOMER_ID = c.customer_id
""").first()[0]
print(f"  crosswalk rows with no matching golden customer: {orphans} (expect 0)")

print("== Seeded leakage on contract lines ==")
spark.table(f"{CATALOG}.{SCHEMA_SFDC}.contract_line_item").groupBy("leakage_flag").count().show()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Summary
# MAGIC Generated raw source-system schemas that feed the `cdm_tmforum` MDM golden layer:
# MAGIC - **`salesforce_source`** — Account, Contact, Product2, Contract, Contract_Line_Item, Opportunity, CPQ (SBQQ__Quote__c / SBQQ__QuoteLine__c), Discount_Approval__c, partner_account
# MAGIC - **`oracle_erp_source`** — hz_cust_accounts, ra_customer_trx_all/_lines_all, ar_payment_schedules_all, ar_cash_receipts_all, gl_code_combinations, gl_je_headers/_lines, revenue_recognition_schedule, gl_budgets
# MAGIC - **`refinitiv_fx_source`** — gl_daily_rates
# MAGIC - **`mdm_source`** — customer_crosswalk (survivorship lineage)
# MAGIC - **`ironclad_clm_source`** — contract_record, invoice_document, dunning_letter + branded PDFs in UC volumes
# MAGIC
# MAGIC All anchored to real golden customers, using real provider schema/field names, natural
# MAGIC distributions, table/column comments, and consistent Lakelink Fiber branding.