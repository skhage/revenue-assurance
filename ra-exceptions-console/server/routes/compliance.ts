// Compliance routes — proxies the 2 UC contract compliance functions via the SQL warehouse.
//
// UC functions (built by @ai-engineer, RA-AI-COMPLIANCE-BUILD):
//   1. scan_contract_compliance — full compliance profile per contract (20 columns)
//   2. detect_rate_drift         — drift type, detail, and recommended action per contract

import { sql } from '@databricks/appkit';
import { z } from 'zod';
import type { Application } from 'express';
import { resultRows, type WarehouseResult } from '../warehouse-result';

interface AppKitWithAnalytics {
  analytics: {
    query(
      text: string,
      params?: Record<string, ReturnType<(typeof sql)['string']> | ReturnType<(typeof sql)['int']>>
    ): Promise<WarehouseResult>;
  };
  server: {
    extend(fn: (app: Application) => void): void;
  };
}

function stringValue(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : '';
}

function numberValue(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function booleanValue(value: unknown): boolean {
  return value === true || value === 'true' || value === 1;
}

// ── Request schemas ──────────────────────────────────────────────────────────

const ComplianceQuery = z.object({
  contract_number: z.string().optional(),
  mismatch_only: z.coerce.boolean().default(false),
});

const RateDriftQuery = z.object({
  customer_id: z.coerce.number().int().optional(),
  min_variance_pct: z.coerce.number().min(0).default(5.0),
});

// ── SQL templates ────────────────────────────────────────────────────────────

const COMPLIANCE_SQL = `
SELECT *
FROM cdm_tmforum.revenue_assurance.scan_contract_compliance(
  :p_contract_number,
  :p_mismatch_only
)
`;

const RATE_DRIFT_SQL = `
SELECT *
FROM cdm_tmforum.revenue_assurance.detect_rate_drift(
  :p_customer_id,
  :p_min_variance_pct
)
`;

// Compliance summary — status distribution for the dashboard badge.
const COMPLIANCE_SUMMARY_SQL = `
SELECT
  compliance_status,
  COUNT(*) AS contract_count
FROM cdm_tmforum.revenue_assurance.scan_contract_compliance(NULL, FALSE)
GROUP BY compliance_status
ORDER BY compliance_status
`;

// ── Route setup ──────────────────────────────────────────────────────────────

export function setupComplianceRoutes(appkit: AppKitWithAnalytics) {
  appkit.server.extend((app) => {
    // Contract compliance scan — full compliance profile per contract.
    // GET /api/compliance/scan?contract_number=CN-00095725&mismatch_only=true
    app.get('/api/compliance/scan', async (req, res) => {
      const parsed = ComplianceQuery.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid compliance scan parameters' });
        return;
      }
      try {
        const { contract_number, mismatch_only } = parsed.data;
        const warehouseResult = await appkit.analytics.query(COMPLIANCE_SQL, {
          p_contract_number: sql.string(contract_number ?? ''),
          p_mismatch_only: sql.string(mismatch_only ? 'TRUE' : 'FALSE'),
        });
        const rows = resultRows(warehouseResult).map((r) => ({
          contract_number: stringValue(r[0]),
          file_name: stringValue(r[1]),
          customer_id: numberValue(r[2]),
          account_name: stringValue(r[3]),
          doc_sla_tier: stringValue(r[4]),
          db_sla_tier: stringValue(r[5]),
          doc_term_months: numberValue(r[6]),
          db_term_months: numberValue(r[7]),
          doc_auto_renew: booleanValue(r[8]),
          doc_status: stringValue(r[9]),
          sla_mismatch: booleanValue(r[10]),
          term_mismatch: booleanValue(r[11]),
          auto_renew_mismatch: booleanValue(r[12]),
          status_mismatch: booleanValue(r[13]),
          total_mismatches: numberValue(r[14]),
          matched_to_billing: booleanValue(r[15]),
          billing_line_items: numberValue(r[16]),
          billing_amount_at_risk: numberValue(r[17]),
          compliance_status: stringValue(r[18]),
          compliance_detail: stringValue(r[19]),
        }));
        res.json(rows);
      } catch (err) {
        console.error('[compliance] scan failed:', err);
        res.status(500).json({ error: 'Failed to scan contract compliance' });
      }
    });

    // Rate drift detection — drift types with recommended actions.
    // GET /api/compliance/rate-drift?customer_id=10016&min_variance_pct=5
    app.get('/api/compliance/rate-drift', async (req, res) => {
      const parsed = RateDriftQuery.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid rate drift parameters' });
        return;
      }
      try {
        const { customer_id, min_variance_pct } = parsed.data;
        const warehouseResult = await appkit.analytics.query(RATE_DRIFT_SQL, {
          p_customer_id: sql.int(customer_id ?? 0),
          p_min_variance_pct: sql.int(Math.round(min_variance_pct * 100)),
        });
        const raw = warehouseResult?.data ?? [];
        res.json(Array.isArray(raw) ? raw : []);
      } catch (err) {
        console.error('[compliance] rate drift failed:', err);
        res.status(500).json({ error: 'Failed to detect rate drift' });
      }
    });

    // Compliance summary — status distribution for the dashboard badge.
    // GET /api/compliance/summary
    app.get('/api/compliance/summary', async (_req, res) => {
      try {
        const warehouseResult = await appkit.analytics.query(COMPLIANCE_SUMMARY_SQL);
        const rows = resultRows(warehouseResult).map((r) => ({
          compliance_status: stringValue(r[0]),
          contract_count: numberValue(r[1]),
        }));
        res.json(rows);
      } catch (err) {
        console.error('[compliance] summary failed:', err);
        res.status(500).json({ error: 'Failed to load compliance summary' });
      }
    });
  });
}
