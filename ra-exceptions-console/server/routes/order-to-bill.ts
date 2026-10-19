// Order-to-Bill routes — reads from gold_order_to_bill_leakage view via SQL warehouse.
//
// Check type #13: Order-to-bill reconciliation — detects misalignment between
// order, provisioning, and billing states. 4 leakage vectors:
//   phantom_billing, service_order_misalignment, stale_in_progress, stuck_provisioned

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
  return value === true || value === 'true' || value === 1 || value === '1';
}

// ── Request schemas ──────────────────────────────────────────────────────────

const ListQuery = z.object({
  leakage_vector: z.string().optional(),
  severity: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

// ── SQL ──────────────────────────────────────────────────────────────────────

const SUMMARY_SQL = `
SELECT
  COUNT(*) AS total_exceptions,
  COALESCE(SUM(amount_at_risk), 0) AS total_at_risk,
  COUNT(DISTINCT leakage_vector) AS vector_count,
  COUNT(*) FILTER (WHERE is_sla_breached = TRUE) AS sla_breached_count
FROM cdm_tmforum.revenue_assurance.gold_order_to_bill_leakage
`;

const VECTOR_BREAKDOWN_SQL = `
SELECT
  leakage_vector,
  severity,
  COUNT(*) AS exception_count,
  COALESCE(SUM(amount_at_risk), 0) AS total_at_risk,
  COUNT(*) FILTER (WHERE is_sla_breached = TRUE) AS sla_breached,
  ROUND(AVG(days_since_order), 0) AS avg_days_since_order
FROM cdm_tmforum.revenue_assurance.gold_order_to_bill_leakage
GROUP BY leakage_vector, severity
ORDER BY total_at_risk DESC
`;

function listSql(opts: { leakage_vector?: string; severity?: string; limit: number }): string {
  const clauses: string[] = [];
  if (opts.leakage_vector) clauses.push(`leakage_vector = '${opts.leakage_vector}'`);
  if (opts.severity) clauses.push(`severity = '${opts.severity}'`);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  return `
SELECT
  exception_id, customer_id, order_id, order_status, provisioning_status,
  service_state, service_type, leakage_vector, severity, amount_at_risk,
  recommended_action, is_sla_breached, days_since_order, recovery_urgency,
  annualized_impact
FROM cdm_tmforum.revenue_assurance.gold_order_to_bill_leakage
${where}
ORDER BY amount_at_risk DESC
LIMIT ${opts.limit}
`;
}

// ── Route setup ──────────────────────────────────────────────────────────────

export function setupOrderToBillRoutes(appkit: AppKitWithAnalytics) {
  appkit.server.extend((app) => {
    // GET /api/order-to-bill/summary
    app.get('/api/order-to-bill/summary', async (_req, res) => {
      try {
        const warehouseResult = await appkit.analytics.query(SUMMARY_SQL);
        const rows = resultRows(warehouseResult);
        const row = rows[0] ?? [];
        res.json({
          total_exceptions: numberValue(row[0]),
          total_at_risk: numberValue(row[1]),
          vector_count: numberValue(row[2]),
          sla_breached_count: numberValue(row[3]),
        });
      } catch (err) {
        console.error('[order-to-bill] summary failed:', err);
        res.status(500).json({ error: 'Failed to load order-to-bill summary' });
      }
    });

    // GET /api/order-to-bill/vectors
    app.get('/api/order-to-bill/vectors', async (_req, res) => {
      try {
        const warehouseResult = await appkit.analytics.query(VECTOR_BREAKDOWN_SQL);
        const rows = resultRows(warehouseResult).map((r) => ({
          leakage_vector: stringValue(r[0]),
          severity: stringValue(r[1]),
          exception_count: numberValue(r[2]),
          total_at_risk: numberValue(r[3]),
          sla_breached: numberValue(r[4]),
          avg_days_since_order: numberValue(r[5]),
        }));
        res.json(rows);
      } catch (err) {
        console.error('[order-to-bill] vectors failed:', err);
        res.status(500).json({ error: 'Failed to load leakage vector breakdown' });
      }
    });

    // GET /api/order-to-bill/list?leakage_vector=phantom_billing&severity=HIGH&limit=200
    app.get('/api/order-to-bill/list', async (req, res) => {
      const parsed = ListQuery.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid order-to-bill parameters' });
        return;
      }
      try {
        const query = listSql(parsed.data);
        const warehouseResult = await appkit.analytics.query(query);
        const rows = resultRows(warehouseResult).map((r) => ({
          exception_id: numberValue(r[0]),
          customer_id: numberValue(r[1]),
          order_id: numberValue(r[2]),
          order_status: stringValue(r[3]),
          provisioning_status: stringValue(r[4]),
          service_state: stringValue(r[5]),
          service_type: stringValue(r[6]),
          leakage_vector: stringValue(r[7]),
          severity: stringValue(r[8]),
          amount_at_risk: numberValue(r[9]),
          recommended_action: stringValue(r[10]),
          is_sla_breached: boolValue(r[11]),
          days_since_order: numberValue(r[12]),
          recovery_urgency: stringValue(r[13]),
          annualized_impact: numberValue(r[14]),
        }));
        res.json(rows);
      } catch (err) {
        console.error('[order-to-bill] list failed:', err);
        res.status(500).json({ error: 'Failed to load order-to-bill exceptions' });
      }
    });
  });
}
