import { sql } from '@databricks/appkit';
import { z } from 'zod';
import type { Application } from 'express';
import { resultObjects, type WarehouseResult } from '../warehouse-result';

/**
 * Check-type-aware evidence (Gap 2 + document reconciliation, Gap 1).
 *
 * gold_leakage_summary only carries the generic register columns; the per-check
 * reconciled values (contracted vs billed, DSO/aging, applied vs market FX rate,
 * doc-vs-system fields, …) live in the silver views. This route re-derives the
 * evidence for one exception by joining the silver view that produced it, keyed
 * by the register's reference_id, and returns a normalized payload the drawer
 * renders as a two-column comparison (with mismatch highlighting) or a KV list.
 *
 * For the two document checks it also returns the source PDF's Catalog Explorer
 * link (built from DATABRICKS_HOST) so the analyst can open the contract/invoice
 * that was parsed.
 */

interface AppKitAnalytics {
  analytics: {
    query(
      text: string,
      params?: Record<string, ReturnType<(typeof sql)['string']>>
    ): Promise<WarehouseResult>;
  };
  server: { extend(fn: (app: Application) => void): void };
}

const EvidenceQuery = z.object({
  check_type: z.string().min(1),
  reference_id: z.string().default(''),
  customer_id: z.string().default(''),
});

type Fmt = 'usd' | 'pct' | 'int' | 'text' | 'bool';
interface EvidenceRow {
  label: string;
  left?: unknown;
  right?: unknown;
  value?: unknown;
  mismatch?: boolean;
  format?: Fmt;
}
interface EvidencePayload {
  kind: string;
  comparison?: { leftLabel: string; rightLabel: string };
  rows: EvidenceRow[];
  document?: { label: string; fileName: string; url: string | null };
  note?: string;
}

const S = 'cdm_tmforum.revenue_assurance';

function str(v: unknown): string {
  return v == null ? '' : String(v);
}

/** Build a Catalog Explorer link to a Volume file from its dbfs:/Volumes/… path. */
function volumeUrl(fileName: string): { fileName: string; url: string | null } {
  const clean = fileName.replace(/^dbfs:/, ''); // /Volumes/<catalog>/<schema>/<volume>/<subpath>
  const host = process.env.DATABRICKS_HOST?.replace(/\/+$/, '');
  if (!host || !clean.startsWith('/Volumes/')) return { fileName: clean, url: null };
  const rel = clean.slice('/Volumes/'.length); // <catalog>/<schema>/<volume>/<subpath>
  const wsId = process.env.DATABRICKS_WORKSPACE_ID;
  const base = `${host}/explore/data/volumes/${rel}`;
  return { fileName: clean, url: wsId ? `${base}?o=${wsId}` : base };
}

export function setupEvidenceRoutes(appkit: AppKitAnalytics) {
  appkit.server.extend((app) => {
    app.get('/api/analytics/evidence', async (req, res) => {
      const parsed = EvidenceQuery.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid evidence request' });
        return;
      }
      const { check_type, reference_id } = parsed.data;

      try {
        const payload = await buildEvidence(appkit, check_type, reference_id);
        res.json(payload);
      } catch (err) {
        console.error('[evidence] failed for', check_type, err);
        res.status(500).json({ error: 'Failed to load detection evidence' });
      }
    });
  });
}

// Returns the first row as a column-keyed object (keys lowercased). Callers read
// by column name so the parsing never depends on SELECT position.
async function one(
  appkit: AppKitAnalytics,
  text: string,
  params: Record<string, ReturnType<(typeof sql)['string']>>
): Promise<Record<string, unknown> | null> {
  const r = await appkit.analytics.query(text, params);
  return resultObjects(r)[0] ?? null;
}

async function buildEvidence(
  appkit: AppKitAnalytics,
  check: string,
  ref: string
): Promise<EvidencePayload> {
  // Only :ref is referenced by the per-check SQL below — do NOT bind extra
  // params (Databricks rejects a supplied-but-unused parameter marker).
  const p = { ref: sql.string(ref) };

  // ---- Contract price family -------------------------------------------------
  if (check === 'contract_price_mismatch' || check === 'contract_price_missing_erp') {
    const status = check === 'contract_price_mismatch' ? 'MISMATCH' : 'MISSING_ERP';
    const row = await one(
      appkit,
      `SELECT ProductCode, Service_Circuit_Id__c, contracted_price, billed_unit_price,
              contracted_total, billed_total, price_mismatch_pct, reconciliation_status
       FROM ${S}.silver_contract_price_reconciliation
       WHERE ContractNumber = :ref AND reconciliation_status = '${status}'
       ORDER BY estimated_amount_at_risk DESC LIMIT 1`,
      p
    );
    if (!row) return empty('contract_price');
    return {
      kind: 'contract_price',
      comparison: { leftLabel: 'Contracted', rightLabel: 'Billed' },
      rows: [
        { label: 'Unit price', left: row.contracted_price, right: row.billed_unit_price, format: 'usd', mismatch: true },
        { label: 'Line total', left: row.contracted_total, right: row.billed_total, format: 'usd', mismatch: true },
        { label: 'Product', value: str(row.productcode), format: 'text' },
        { label: 'Circuit', value: str(row.service_circuit_id__c), format: 'text' },
        { label: 'Price variance', value: row.price_mismatch_pct, format: 'pct' },
      ],
    };
  }
  if (check === 'contract_price_missing_salesforce') {
    const row = await one(
      appkit,
      `SELECT ProductCode, Service_Circuit_Id__c, billed_unit_price, billed_total, reconciliation_status
       FROM ${S}.silver_contract_price_reconciliation
       WHERE CAST(line_item_id AS STRING) = :ref LIMIT 1`,
      p
    );
    if (!row) return empty('contract_price');
    return {
      kind: 'contract_price',
      rows: [
        { label: 'Billed unit price', value: row.billed_unit_price, format: 'usd' },
        { label: 'Billed total', value: row.billed_total, format: 'usd' },
        { label: 'Product', value: str(row.productcode), format: 'text' },
        { label: 'Circuit', value: str(row.service_circuit_id__c), format: 'text' },
      ],
      note: 'Billed in ERP with no matching Salesforce contract line — revenue charged with no contract on file.',
    };
  }

  // ---- FX family -------------------------------------------------------------
  if (check.startsWith('fx_')) {
    const row = await one(
      appkit,
      `SELECT INVOICE_CURRENCY_CODE, INVOICE_AMOUNT, applied_rate, market_rate,
              rate_deviation_pct, fx_validation_status, TRX_DATE
       FROM ${S}.silver_fx_rate_validation
       WHERE TRX_NUMBER = :ref LIMIT 1`,
      p
    );
    if (!row) return empty('fx');
    const hasRates = row.applied_rate != null || row.market_rate != null;
    return {
      kind: 'fx',
      comparison: hasRates ? { leftLabel: 'Applied rate', rightLabel: 'Market (Refinitiv)' } : undefined,
      rows: [
        { label: 'Currency', value: str(row.invoice_currency_code), format: 'text' },
        { label: 'Invoice amount', value: row.invoice_amount, format: 'usd' },
        ...(hasRates
          ? [{ label: 'FX rate', left: row.applied_rate, right: row.market_rate, format: 'text' as Fmt, mismatch: true }]
          : []),
        { label: 'Rate deviation', value: row.rate_deviation_pct, format: 'pct' },
        { label: 'Status', value: str(row.fx_validation_status).replace(/_/g, ' ').toLowerCase(), format: 'text' },
        { label: 'Transaction date', value: str(row.trx_date), format: 'text' },
      ],
    };
  }

  // ---- Discount / expired quote ---------------------------------------------
  if (check === 'unauthorized_discount' || check === 'expired_quote_active') {
    const filter =
      check === 'unauthorized_discount' ? 'unauthorized_discount = TRUE' : 'expired_quote_still_active = TRUE';
    const row = await one(
      appkit,
      `SELECT applied_discount_pct, approved_discount_pct, discount_overrun_amount,
              quote_status, quote_expiration_date, product_id
       FROM ${S}.silver_discount_authorization_check
       WHERE quote_id = :ref AND ${filter} LIMIT 1`,
      p
    );
    if (!row) return empty('discount');
    if (check === 'unauthorized_discount') {
      return {
        kind: 'discount',
        comparison: { leftLabel: 'Applied', rightLabel: 'Approved ceiling' },
        rows: [
          { label: 'Discount %', left: row.applied_discount_pct, right: row.approved_discount_pct, format: 'pct', mismatch: true },
          { label: 'Overrun amount', value: row.discount_overrun_amount, format: 'usd' },
          { label: 'Quote status', value: str(row.quote_status), format: 'text' },
        ],
      };
    }
    return {
      kind: 'discount',
      rows: [
        { label: 'Quote status', value: str(row.quote_status), format: 'text' },
        { label: 'Expiration date', value: str(row.quote_expiration_date), format: 'text' },
        { label: 'Applied discount %', value: row.applied_discount_pct, format: 'pct' },
      ],
      note: 'Quote is past its expiration date but still marked active.',
    };
  }

  // ---- Revenue recognition ---------------------------------------------------
  if (check === 'rev_rec_timing_mismatch') {
    const row = await one(
      appkit,
      `SELECT scheduled_recognized, gl_revenue_posted, recognition_variance, PERIOD_NAME
       FROM ${S}.silver_revenue_recognition_check
       WHERE PERIOD_NAME = :ref LIMIT 1`,
      p
    );
    if (!row) return empty('rev_rec');
    return {
      kind: 'rev_rec',
      comparison: { leftLabel: 'Scheduled (ASC-606)', rightLabel: 'GL posted' },
      rows: [
        { label: 'Recognized revenue', left: row.scheduled_recognized, right: row.gl_revenue_posted, format: 'usd', mismatch: true },
        { label: 'Variance', value: row.recognition_variance, format: 'usd' },
        { label: 'Period', value: str(row.period_name), format: 'text' },
      ],
    };
  }

  // ---- AR collection risk ----------------------------------------------------
  if (check === 'ar_collection_risk') {
    const row = await one(
      appkit,
      `SELECT total_outstanding, total_billed, estimated_dso_days, AGING_BUCKET, invoice_count
       FROM ${S}.silver_ar_aging_analysis
       WHERE CAST(BILL_TO_CUSTOMER_ID AS STRING) = :ref AND collection_risk = 'HIGH'
       ORDER BY total_outstanding DESC LIMIT 1`,
      p
    );
    if (!row) return empty('ar');
    return {
      kind: 'ar',
      rows: [
        { label: 'Outstanding', value: row.total_outstanding, format: 'usd', mismatch: true },
        { label: 'Originally billed', value: row.total_billed, format: 'usd' },
        { label: 'Est. DSO (days)', value: row.estimated_dso_days, format: 'int' },
        { label: 'Aging bucket', value: str(row.aging_bucket), format: 'text' },
        { label: 'Open invoices', value: row.invoice_count, format: 'int' },
      ],
    };
  }

  // ---- Document: contract ----------------------------------------------------
  if (check === 'doc_contract_mismatch') {
    const row = await one(
      appkit,
      `SELECT doc_sla_tier, db_sla_tier, doc_term_months, db_term_months,
              doc_auto_renew, db_auto_renew, doc_status, db_status,
              sla_mismatch, term_mismatch, auto_renew_mismatch, status_mismatch, file_name
       FROM ${S}.silver_doc_intelligence_contracts
       WHERE doc_contract_number = :ref LIMIT 1`,
      p
    );
    if (!row) return empty('doc_contract');
    // Warehouse booleans arrive as strings, so derive the highlight by comparing
    // the PDF value against the system value directly (mismatch = they differ).
    const diff = (a: unknown, b: unknown) => str(a) !== str(b);
    return {
      kind: 'doc_contract',
      comparison: { leftLabel: 'Contract PDF', rightLabel: 'System (CRM)' },
      rows: [
        { label: 'SLA tier', left: str(row.doc_sla_tier), right: str(row.db_sla_tier), format: 'text', mismatch: diff(row.doc_sla_tier, row.db_sla_tier) },
        { label: 'Term (months)', left: row.doc_term_months, right: row.db_term_months, format: 'int', mismatch: diff(row.doc_term_months, row.db_term_months) },
        { label: 'Auto-renew', left: row.doc_auto_renew, right: row.db_auto_renew, format: 'bool', mismatch: diff(row.doc_auto_renew, row.db_auto_renew) },
        { label: 'Status', left: str(row.doc_status), right: str(row.db_status), format: 'text', mismatch: diff(row.doc_status, row.db_status) },
      ],
      document: { label: 'Open contract PDF', ...volumeUrl(str(row.file_name)) },
      note: 'AI-extracted terms from the signed MSA PDF vs the system of record. Highlighted rows diverge.',
    };
  }

  // ---- Document: invoice -----------------------------------------------------
  if (check === 'doc_invoice_mismatch') {
    const row = await one(
      appkit,
      `SELECT doc_total_amount, db_invoice_amount, doc_tax_amount, db_tax_amount, amount_variance, file_name
       FROM ${S}.silver_doc_intelligence_invoices
       WHERE doc_invoice_number = :ref LIMIT 1`,
      p
    );
    if (!row) return empty('doc_invoice');
    return {
      kind: 'doc_invoice',
      comparison: { leftLabel: 'Invoice PDF', rightLabel: 'System (ERP)' },
      rows: [
        { label: 'Total amount', left: row.doc_total_amount, right: row.db_invoice_amount, format: 'usd', mismatch: true },
        { label: 'Tax amount', left: row.doc_tax_amount, right: row.db_tax_amount, format: 'usd' },
        { label: 'Variance', value: row.amount_variance, format: 'usd' },
      ],
      document: { label: 'Open invoice PDF', ...volumeUrl(str(row.file_name)) },
      note: 'AI-extracted invoice totals from the PDF vs the ERP system of record.',
    };
  }

  return empty('none');
}

function empty(kind: string): EvidencePayload {
  return { kind, rows: [], note: 'No additional detection evidence is available for this exception.' };
}
