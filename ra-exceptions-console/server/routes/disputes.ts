// Billing Dispute routes — queries gold_billing_dispute_leakage for fraud pattern
// drill-down, SLA breach exposure, stale dispute aging, and regulatory escalation.
//
// Data source: cdm_tmforum.revenue_assurance.gold_billing_dispute_leakage
// 7 check_types, ~291K rows, ~$9.85B total at risk.

import { z } from 'zod';
import type { Application } from 'express';
import { resultRows, type WarehouseResult } from '../warehouse-result';

interface AppKitWithAnalytics {
  analytics: {
    query(text: string, params?: Record<string, unknown>): Promise<WarehouseResult>;
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

const VALID_CHECK_TYPES = [
  'over_credit',
  'fraud_pattern',
  'sla_breach',
  'stale_dispute',
  'regulatory_escalation',
  'reopened_dispute',
  'unauthorized_waiver',
] as const;

const VALID_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;

const DetailQuery = z.object({
  check_type: z.enum(VALID_CHECK_TYPES).optional(),
  severity: z.enum(VALID_SEVERITIES).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

const CustomerQuery = z.object({
  top_n: z.coerce.number().int().min(1).max(100).default(50),
  check_type: z.enum(VALID_CHECK_TYPES).optional(),
});

// ── SQL ──────────────────────────────────────────────────────────────────────

const GOLD_TABLE = 'cdm_tmforum.revenue_assurance.gold_billing_dispute_leakage';

const SUMMARY_SQL = `
SELECT
  COUNT(*) AS total_exceptions,
  COALESCE(SUM(amount_at_risk), 0) AS total_at_risk,
  COUNT(DISTINCT customer_id) AS customers_affected,
  COUNT(*) FILTER (WHERE severity = 'critical') AS critical_count,
  COUNT(*) FILTER (WHERE check_type = 'stale_dispute') AS stale_dispute_count,
  COUNT(*) FILTER (WHERE check_type = 'fraud_pattern') AS fraud_pattern_count
FROM ${GOLD_TABLE}
`;

const CHECK_TYPE_BREAKDOWN_SQL = `
SELECT
  check_type,
  COUNT(*) AS exception_count,
  COALESCE(SUM(amount_at_risk), 0) AS total_at_risk,
  COUNT(DISTINCT customer_id) AS customer_count,
  MODE(severity) AS severity_mode
FROM ${GOLD_TABLE}
GROUP BY check_type
ORDER BY total_at_risk DESC
`;

function detailSql(opts: {
  check_type?: string;
  severity?: string;
  limit: number;
}): string {
  const where: string[] = [];
  if (opts.check_type) {
    where.push(`check_type = '${opts.check_type}'`);
  }
  if (opts.severity) {
    where.push(`severity = '${opts.severity}'`);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  return `
SELECT
  reference_id, customer_id, account_name,
  check_type, severity, amount_at_risk,
  source_table, detection_method, known_leakage_flag
FROM ${GOLD_TABLE}
${clause}
ORDER BY amount_at_risk DESC
LIMIT ${opts.limit}
`;
}

function customerSql(opts: { top_n: number; check_type?: string }): string {
  const where = opts.check_type
    ? `WHERE check_type = '${opts.check_type}'`
    : '';
  return `
SELECT
  customer_id,
  MAX(account_name) AS account_name,
  COUNT(*) AS exception_count,
  COALESCE(SUM(amount_at_risk), 0) AS total_at_risk,
  COLLECT_SET(check_type) AS check_types,
  MAX(severity) AS worst_severity,
  COUNT(*) FILTER (WHERE check_type = 'fraud_pattern') AS fraud_count,
  COUNT(*) FILTER (WHERE check_type = 'stale_dispute') AS stale_count,
  COUNT(*) FILTER (WHERE check_type = 'regulatory_escalation') AS regulatory_count
FROM ${GOLD_TABLE}
${where}
GROUP BY customer_id
ORDER BY total_at_risk DESC
LIMIT ${opts.top_n}
`;
}

// ── Route setup ──────────────────────────────────────────────────────────────

export function setupDisputeRoutes(appkit: AppKitWithAnalytics) {
  appkit.server.extend((app) => {
    // Dispute summary — headline KPIs.
    // GET /api/disputes/summary
    app.get('/api/disputes/summary', async (_req, res) => {
      try {
        const warehouseResult = await appkit.analytics.query(SUMMARY_SQL);
        const rows = resultRows(warehouseResult);
        const row = rows[0] ?? [];
        res.json({
          total_exceptions: numberValue(row[0]),
          total_at_risk: numberValue(row[1]),
          customers_affected: numberValue(row[2]),
          critical_count: numberValue(row[3]),
          stale_dispute_count: numberValue(row[4]),
          fraud_pattern_count: numberValue(row[5]),
        });
      } catch (err) {
        console.error('[disputes] summary failed:', err);
        res.status(500).json({ error: 'Failed to load dispute summary' });
      }
    });

    // Check-type breakdown — 7 rows, one per check_type.
    // GET /api/disputes/breakdown
    app.get('/api/disputes/breakdown', async (_req, res) => {
      try {
        const warehouseResult = await appkit.analytics.query(CHECK_TYPE_BREAKDOWN_SQL);
        const rows = resultRows(warehouseResult).map((r) => ({
          check_type: stringValue(r[0]),
          exception_count: numberValue(r[1]),
          total_at_risk: numberValue(r[2]),
          customer_count: numberValue(r[3]),
          severity_mode: stringValue(r[4]),
        }));
        res.json(rows);
      } catch (err) {
        console.error('[disputes] breakdown failed:', err);
        res.status(500).json({ error: 'Failed to load dispute breakdown' });
      }
    });

    // Dispute exception detail — filterable by check_type and severity.
    // GET /api/disputes/detail?check_type=fraud_pattern&severity=critical&limit=200
    app.get('/api/disputes/detail', async (req, res) => {
      const parsed = DetailQuery.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid dispute detail parameters' });
        return;
      }
      try {
        const { check_type, severity, limit } = parsed.data;
        const query = detailSql({ check_type, severity, limit });
        const warehouseResult = await appkit.analytics.query(query);
        const rows = resultRows(warehouseResult).map((r) => ({
          reference_id: stringValue(r[0]),
          customer_id: numberValue(r[1]),
          account_name: stringValue(r[2]),
          check_type: stringValue(r[3]),
          severity: stringValue(r[4]),
          amount_at_risk: numberValue(r[5]),
          source_table: stringValue(r[6]),
          detection_method: stringValue(r[7]),
          known_leakage_flag: boolValue(r[8]),
        }));
        res.json(rows);
      } catch (err) {
        console.error('[disputes] detail failed:', err);
        res.status(500).json({ error: 'Failed to load dispute detail' });
      }
    });

    // Customer drill-down — top customers by dispute exposure.
    // GET /api/disputes/customers?top_n=50&check_type=stale_dispute
    app.get('/api/disputes/customers', async (req, res) => {
      const parsed = CustomerQuery.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid customer query parameters' });
        return;
      }
      try {
        const { top_n, check_type } = parsed.data;
        const query = customerSql({ top_n, check_type });
        const warehouseResult = await appkit.analytics.query(query);
        const rows = resultRows(warehouseResult).map((r) => ({
          customer_id: numberValue(r[0]),
          account_name: stringValue(r[1]),
          exception_count: numberValue(r[2]),
          total_at_risk: numberValue(r[3]),
          check_types: Array.isArray(r[4]) ? r[4].map(String) : [],
          worst_severity: stringValue(r[5]),
          fraud_count: numberValue(r[6]),
          stale_count: numberValue(r[7]),
          regulatory_count: numberValue(r[8]),
        }));
        res.json(rows);
      } catch (err) {
        console.error('[disputes] customers failed:', err);
        res.status(500).json({ error: 'Failed to load customer drill-down' });
      }
    });
  });
}
