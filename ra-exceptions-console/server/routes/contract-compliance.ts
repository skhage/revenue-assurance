// Contract Compliance routes — proxies 4 Contract Compliance UC functions.
//
// UC functions (built by @ai-engineer, RA-AI-CONTRACT-COMPLIANCE-AGENT):
//   1. scan_contract_compliance — cross-reference contracts/PDFs/billing for violations
//   2. detect_expiring_contracts — contracts approaching renewal/expiry
//   3. detect_contract_lifecycle_risks — multi-dimensional risk scoring
//   4. generate_contract_risk_report — executive summary across all checks

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

function boolValue(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return Boolean(value);
}

// ── Request schemas ──────────────────────────────────────────────────────────

const ViolationsQuery = z.object({
  scan_scope: z
    .enum(['ALL', 'SLA_TIER_MISMATCH', 'PRICE_DEVIATION', 'SLA_BREACH_PENALTY', 'INVOICE_DISCREPANCY'])
    .default('ALL'),
  customer_id: z.coerce.number().int().optional(),
  min_amount: z.coerce.number().min(0).default(0),
});

const ExpiringQuery = z.object({
  days_ahead: z.coerce.number().int().min(1).max(730).default(180),
  include_expired: z.coerce.boolean().default(false),
  min_annual_revenue: z.coerce.number().min(0).default(0),
});

const LifecycleQuery = z.object({
  customer_id: z.coerce.number().int().optional(),
  risk_type: z.string().optional(),
  horizon_days: z.coerce.number().int().min(1).max(730).default(365),
});

// ── SQL templates ────────────────────────────────────────────────────────────

// RA-APP-RETEST-CREDIT-SUPERVISOR-1102: since #625 the UC fns treat only NULL/'null'/'' as
// "all". The route's -1 / 'NULL' sentinels returned 0 rows, so they are mapped to real NULLs here.
const VIOLATIONS_SQL = `
SELECT *
FROM cdm_tmforum.revenue_assurance.scan_contract_compliance(
  NULLIF(:p_customer_id, -1),
  :p_scan_scope,
  :p_min_amount
)
`;

const EXPIRING_SQL = `
SELECT *
FROM cdm_tmforum.revenue_assurance.detect_expiring_contracts(
  :p_days_ahead,
  :p_include_expired,
  :p_min_annual_revenue
)
`;

const LIFECYCLE_SQL = `
SELECT *
FROM cdm_tmforum.revenue_assurance.detect_contract_lifecycle_risks(
  NULLIF(:p_customer_id, -1),
  NULLIF(:p_risk_type, 'NULL'),
  :p_horizon_days
)
`;

const RISK_REPORT_SQL = `
SELECT *
FROM cdm_tmforum.revenue_assurance.generate_contract_risk_report()
ORDER BY section_order, metric_name
`;

const SUMMARY_SQL = `
WITH violations AS (
  SELECT COUNT(*) AS violation_count, COALESCE(SUM(amount_at_risk), 0) AS total_at_risk,
         COUNT(DISTINCT customer_id) AS customers_affected
  FROM cdm_tmforum.revenue_assurance.scan_contract_compliance(NULL, 'ALL', 0)
),
expiring AS (
  SELECT COUNT(*) AS expiring_count
  FROM cdm_tmforum.revenue_assurance.detect_expiring_contracts(180, FALSE, 0)
  WHERE urgency IN ('EXPIRING_SOON', 'CRITICAL')
),
risks AS (
  SELECT COUNT(*) AS risk_count
  FROM cdm_tmforum.revenue_assurance.detect_contract_lifecycle_risks(NULL, NULL, 365)
  WHERE risk_score >= 70
)
SELECT v.violation_count, v.total_at_risk, v.customers_affected,
       e.expiring_count, r.risk_count
FROM violations v, expiring e, risks r
`;

// ── Route setup ──────────────────────────────────────────────────────────────

export function setupContractComplianceRoutes(appkit: AppKitWithAnalytics) {
  appkit.server.extend((app) => {
    // Compliance violations — contract vs billing mismatches.
    // GET /api/contract-compliance/violations?scan_scope=ALL&customer_id=123&min_amount=0
    app.get('/api/contract-compliance/violations', async (req, res) => {
      const parsed = ViolationsQuery.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid violation query parameters' });
        return;
      }
      try {
        const { scan_scope, customer_id, min_amount } = parsed.data;
        const warehouseResult = await appkit.analytics.query(VIOLATIONS_SQL, {
          p_customer_id: sql.int(customer_id ?? -1),
          p_scan_scope: sql.string(scan_scope),
          p_min_amount: sql.int(Math.round(min_amount)),
        });
        const rows = resultRows(warehouseResult).map((r) => ({
          compliance_check: stringValue(r[0]),
          severity: stringValue(r[1]),
          customer_id: numberValue(r[2]),
          account_name: stringValue(r[3]),
          contract_number: stringValue(r[4]),
          finding: stringValue(r[5]),
          amount_at_risk: numberValue(r[6]),
          recommended_action: stringValue(r[7]),
          data_sources: stringValue(r[8]),
        }));
        res.json(rows);
      } catch (err) {
        console.error('[contract-compliance] violations failed:', err);
        res.status(500).json({ error: 'Failed to scan contract compliance' });
      }
    });

    // Expiring contracts — approaching renewal deadlines.
    // GET /api/contract-compliance/expiring?days_ahead=180&include_expired=false&min_annual_revenue=0
    app.get('/api/contract-compliance/expiring', async (req, res) => {
      const parsed = ExpiringQuery.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid expiring contracts parameters' });
        return;
      }
      try {
        const { days_ahead, include_expired, min_annual_revenue } = parsed.data;
        const warehouseResult = await appkit.analytics.query(EXPIRING_SQL, {
          p_days_ahead: sql.int(days_ahead),
          p_include_expired: sql.string(String(include_expired)),
          p_min_annual_revenue: sql.int(Math.round(min_annual_revenue)),
        });
        const rows = resultRows(warehouseResult).map((r) => ({
          urgency: stringValue(r[0]),
          customer_id: numberValue(r[1]),
          account_name: stringValue(r[2]),
          contract_number: stringValue(r[3]),
          sla_tier: stringValue(r[4]),
          contract_status: stringValue(r[5]),
          start_date: stringValue(r[6]),
          end_date: stringValue(r[7]),
          days_until_expiry: numberValue(r[8]),
          term_months: numberValue(r[9]),
          auto_renew: boolValue(r[10]),
          annual_revenue: numberValue(r[11]),
          risk_category: stringValue(r[12]),
          recommended_action: stringValue(r[13]),
        }));
        res.json(rows);
      } catch (err) {
        console.error('[contract-compliance] expiring failed:', err);
        res.status(500).json({ error: 'Failed to detect expiring contracts' });
      }
    });

    // Lifecycle risks — multi-dimensional risk scoring.
    // GET /api/contract-compliance/lifecycle?customer_id=123&risk_type=...&horizon_days=365
    app.get('/api/contract-compliance/lifecycle', async (req, res) => {
      const parsed = LifecycleQuery.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid lifecycle risk parameters' });
        return;
      }
      try {
        const { customer_id, risk_type, horizon_days } = parsed.data;
        const warehouseResult = await appkit.analytics.query(LIFECYCLE_SQL, {
          p_customer_id: sql.int(customer_id ?? -1),
          p_risk_type: sql.string(risk_type ?? 'NULL'),
          p_horizon_days: sql.int(horizon_days),
        });
        const rows = resultRows(warehouseResult).map((r) => ({
          contract_id: stringValue(r[0]),
          contract_number: stringValue(r[1]),
          customer_id: numberValue(r[2]),
          account_name: stringValue(r[3]),
          sla_tier: stringValue(r[4]),
          contract_status: stringValue(r[5]),
          contract_term_months: numberValue(r[6]),
          start_date: stringValue(r[7]),
          end_date: stringValue(r[8]),
          auto_renew: boolValue(r[9]),
          days_to_expiry: numberValue(r[10]),
          line_item_count: numberValue(r[11]),
          total_mrr: numberValue(r[12]),
          risk_type: stringValue(r[13]),
          risk_score: numberValue(r[14]),
          risk_detail: stringValue(r[15]),
          recommended_action: stringValue(r[16]),
          existing_exceptions: numberValue(r[17]),
          existing_leakage_amount: numberValue(r[18]),
        }));
        res.json(rows);
      } catch (err) {
        console.error('[contract-compliance] lifecycle failed:', err);
        res.status(500).json({ error: 'Failed to detect lifecycle risks' });
      }
    });

    // Executive risk report — summary metrics from all compliance checks.
    // GET /api/contract-compliance/report
    app.get('/api/contract-compliance/report', async (_req, res) => {
      try {
        const warehouseResult = await appkit.analytics.query(RISK_REPORT_SQL);
        const rows = resultRows(warehouseResult).map((r) => ({
          section: stringValue(r[0]),
          section_order: numberValue(r[1]),
          metric_name: stringValue(r[2]),
          metric_value: stringValue(r[3]),
          detail: stringValue(r[4]),
        }));
        res.json(rows);
      } catch (err) {
        console.error('[contract-compliance] report failed:', err);
        res.status(500).json({ error: 'Failed to generate contract risk report' });
      }
    });

    // Summary KPIs — headline numbers for the page.
    // GET /api/contract-compliance/summary
    app.get('/api/contract-compliance/summary', async (_req, res) => {
      try {
        const warehouseResult = await appkit.analytics.query(SUMMARY_SQL);
        const rows = resultRows(warehouseResult);
        const row = rows[0] ?? [];
        res.json({
          violation_count: numberValue(row[0]),
          total_at_risk: numberValue(row[1]),
          customers_affected: numberValue(row[2]),
          expiring_count: numberValue(row[3]),
          high_risk_count: numberValue(row[4]),
        });
      } catch (err) {
        console.error('[contract-compliance] summary failed:', err);
        res.status(500).json({ error: 'Failed to compute contract compliance summary' });
      }
    });
  });
}
