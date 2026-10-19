// Commission Leakage routes — queries the silver_commission_leakage_reconciliation
// view for agent fraud drill-down, clawback tracking, and cap violation analysis.
//
// Data source: cdm_tmforum.revenue_assurance.silver_commission_leakage_reconciliation
// 6 sub_check_types, ~157K rows, ~$6.08B total at risk.

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

const VALID_SUB_CHECKS = [
  'clawback_failure',
  'commission_cap_violation',
  'cancelled_order_commission',
  'unauthorized_override',
  'spec_max_exceeded',
  'duplicate_commission',
] as const;

const VALID_SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM'] as const;

const DetailQuery = z.object({
  sub_check_type: z.enum(VALID_SUB_CHECKS).optional(),
  severity: z.enum(VALID_SEVERITIES).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

const AgentQuery = z.object({
  top_n: z.coerce.number().int().min(1).max(100).default(50),
  sub_check_type: z.enum(VALID_SUB_CHECKS).optional(),
});

// ── SQL ──────────────────────────────────────────────────────────────────────

const SILVER_TABLE = 'cdm_tmforum.revenue_assurance.silver_commission_leakage_reconciliation';

const SUMMARY_SQL = `
SELECT
  COUNT(*) AS total_exceptions,
  COALESCE(SUM(amount_at_risk), 0) AS total_at_risk,
  COUNT(DISTINCT sales_agent_id) AS agents_involved,
  COUNT(*) FILTER (WHERE sub_check_type = 'clawback_failure') AS clawback_failures,
  COUNT(*) FILTER (WHERE severity = 'CRITICAL') AS critical_count
FROM ${SILVER_TABLE}
`;

const SUBTYPE_BREAKDOWN_SQL = `
SELECT
  sub_check_type,
  COUNT(*) AS exception_count,
  COALESCE(SUM(amount_at_risk), 0) AS total_at_risk,
  COUNT(DISTINCT sales_agent_id) AS agent_count,
  MODE(severity) AS severity_mode
FROM ${SILVER_TABLE}
GROUP BY sub_check_type
ORDER BY total_at_risk DESC
`;

function detailSql(opts: {
  sub_check_type?: string;
  severity?: string;
  limit: number;
}): string {
  const where: string[] = [];
  if (opts.sub_check_type) {
    where.push(`sub_check_type = '${opts.sub_check_type}'`);
  }
  if (opts.severity) {
    where.push(`severity = '${opts.severity}'`);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  return `
SELECT
  commission_id, customer_id, sales_agent_id, product_order_id,
  sub_check_type, amount_at_risk, commission_paid, rule_maximum, spec_maximum,
  commission_status, commission_type, clawback_flag, override_flag,
  split_commission_flag, customer_segment, product_category, service_type,
  earned_date, paid_date, severity, description
FROM ${SILVER_TABLE}
${clause}
ORDER BY amount_at_risk DESC
LIMIT ${opts.limit}
`;
}

function agentSql(opts: { top_n: number; sub_check_type?: string }): string {
  const where = opts.sub_check_type
    ? `WHERE sub_check_type = '${opts.sub_check_type}'`
    : '';
  return `
SELECT
  sales_agent_id,
  COUNT(*) AS exception_count,
  COALESCE(SUM(amount_at_risk), 0) AS total_at_risk,
  COLLECT_SET(sub_check_type) AS sub_check_types,
  MAX(severity) AS worst_severity,
  COUNT(*) FILTER (WHERE clawback_flag = TRUE) AS clawback_count,
  COUNT(*) FILTER (WHERE override_flag = TRUE) AS override_count
FROM ${SILVER_TABLE}
${where}
GROUP BY sales_agent_id
ORDER BY total_at_risk DESC
LIMIT ${opts.top_n}
`;
}

// ── Route setup ──────────────────────────────────────────────────────────────

export function setupCommissionRoutes(appkit: AppKitWithAnalytics) {
  appkit.server.extend((app) => {
    // Commission summary — headline KPIs.
    // GET /api/commission/summary
    app.get('/api/commission/summary', async (_req, res) => {
      try {
        const warehouseResult = await appkit.analytics.query(SUMMARY_SQL);
        const rows = resultRows(warehouseResult);
        const row = rows[0] ?? [];
        res.json({
          total_exceptions: numberValue(row[0]),
          total_at_risk: numberValue(row[1]),
          agents_involved: numberValue(row[2]),
          clawback_failures: numberValue(row[3]),
          critical_count: numberValue(row[4]),
        });
      } catch (err) {
        console.error('[commission] summary failed:', err);
        res.status(500).json({ error: 'Failed to load commission summary' });
      }
    });

    // Commission sub-type breakdown — 6 rows, one per sub_check_type.
    // GET /api/commission/breakdown
    app.get('/api/commission/breakdown', async (_req, res) => {
      try {
        const warehouseResult = await appkit.analytics.query(SUBTYPE_BREAKDOWN_SQL);
        const rows = resultRows(warehouseResult).map((r) => ({
          sub_check_type: stringValue(r[0]),
          exception_count: numberValue(r[1]),
          total_at_risk: numberValue(r[2]),
          agent_count: numberValue(r[3]),
          severity_mode: stringValue(r[4]),
        }));
        res.json(rows);
      } catch (err) {
        console.error('[commission] breakdown failed:', err);
        res.status(500).json({ error: 'Failed to load commission breakdown' });
      }
    });

    // Commission exception detail — filterable by sub_check_type and severity.
    // GET /api/commission/detail?sub_check_type=clawback_failure&severity=CRITICAL&limit=200
    app.get('/api/commission/detail', async (req, res) => {
      const parsed = DetailQuery.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid commission detail parameters' });
        return;
      }
      try {
        const { sub_check_type, severity, limit } = parsed.data;
        const query = detailSql({ sub_check_type, severity, limit });
        const warehouseResult = await appkit.analytics.query(query);
        const rows = resultRows(warehouseResult).map((r) => ({
          commission_id: numberValue(r[0]),
          customer_id: numberValue(r[1]),
          sales_agent_id: numberValue(r[2]),
          product_order_id: numberValue(r[3]),
          sub_check_type: stringValue(r[4]),
          amount_at_risk: numberValue(r[5]),
          commission_paid: numberValue(r[6]),
          rule_maximum: r[7] != null ? numberValue(r[7]) : null,
          spec_maximum: r[8] != null ? numberValue(r[8]) : null,
          commission_status: stringValue(r[9]),
          commission_type: stringValue(r[10]),
          clawback_flag: boolValue(r[11]),
          override_flag: boolValue(r[12]),
          split_commission_flag: boolValue(r[13]),
          customer_segment: stringValue(r[14]),
          product_category: stringValue(r[15]),
          service_type: stringValue(r[16]),
          earned_date: stringValue(r[17]),
          paid_date: stringValue(r[18]),
          severity: stringValue(r[19]),
          description: stringValue(r[20]),
        }));
        res.json(rows);
      } catch (err) {
        console.error('[commission] detail failed:', err);
        res.status(500).json({ error: 'Failed to load commission detail' });
      }
    });

    // Agent fraud drill-down — top agents by exposure.
    // GET /api/commission/agents?top_n=50&sub_check_type=unauthorized_override
    app.get('/api/commission/agents', async (req, res) => {
      const parsed = AgentQuery.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid agent query parameters' });
        return;
      }
      try {
        const { top_n, sub_check_type } = parsed.data;
        const query = agentSql({ top_n, sub_check_type });
        const warehouseResult = await appkit.analytics.query(query);
        const rows = resultRows(warehouseResult).map((r) => ({
          sales_agent_id: numberValue(r[0]),
          exception_count: numberValue(r[1]),
          total_at_risk: numberValue(r[2]),
          sub_check_types: Array.isArray(r[3]) ? (r[3] as string[]) : [],
          worst_severity: stringValue(r[4]),
          clawback_count: numberValue(r[5]),
          override_count: numberValue(r[6]),
        }));
        res.json(rows);
      } catch (err) {
        console.error('[commission] agents failed:', err);
        res.status(500).json({ error: 'Failed to load agent drill-down' });
      }
    });
  });
}
