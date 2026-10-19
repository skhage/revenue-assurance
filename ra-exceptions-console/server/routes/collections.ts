// Collections Intelligence routes — reads gold_collections_optimization (built by
// @ai-engineer, RA-AI-COLLECTIONS-INTEL). Cross-references dunning with RA leakage
// to stop wrong-amount collections.

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

function arrayValue(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

// ── Request schemas ──────────────────────────────────────────────────────────

const QueueQuery = z.object({
  action: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// ── SQL templates ────────────────────────────────────────────────────────────

const SUMMARY_SQL = `
SELECT
  COUNT(*) AS total_customers,
  COALESCE(ROUND(SUM(estimated_recoverable_amount), 0), 0) AS total_recoverable,
  COALESCE(ROUND(SUM(ra_total_at_risk), 0), 0) AS total_at_risk,
  COALESCE(SUM(dunning_active_cases), 0) AS total_dunning_cases,
  COUNT(*) FILTER (WHERE has_legal_action) AS legal_action_count
FROM cdm_tmforum.revenue_assurance.gold_collections_optimization
`;

const ACTION_BREAKDOWN_SQL = `
SELECT
  recommended_action,
  COUNT(*) AS customer_count,
  COALESCE(ROUND(SUM(estimated_recoverable_amount), 0), 0) AS recoverable,
  COALESCE(ROUND(SUM(ra_total_at_risk), 0), 0) AS at_risk
FROM cdm_tmforum.revenue_assurance.gold_collections_optimization
GROUP BY recommended_action
ORDER BY recoverable DESC, at_risk DESC
`;

const QUEUE_ALL_SQL = `
SELECT *
FROM cdm_tmforum.revenue_assurance.gold_collections_optimization
ORDER BY collections_priority_score DESC
LIMIT :p_limit
`;

const QUEUE_FILTERED_SQL = `
SELECT *
FROM cdm_tmforum.revenue_assurance.gold_collections_optimization
WHERE recommended_action = :p_action
ORDER BY collections_priority_score DESC
LIMIT :p_limit
`;

// ── Route setup ──────────────────────────────────────────────────────────────

export function setupCollectionsRoutes(appkit: AppKitWithAnalytics) {
  appkit.server.extend((app) => {
    // Headline KPIs.
    // GET /api/collections/summary
    app.get('/api/collections/summary', async (_req, res) => {
      try {
        const warehouseResult = await appkit.analytics.query(SUMMARY_SQL);
        const rows = resultRows(warehouseResult);
        const row = rows[0] ?? [];
        res.json({
          total_customers: numberValue(row[0]),
          total_recoverable: numberValue(row[1]),
          total_at_risk: numberValue(row[2]),
          total_dunning_cases: numberValue(row[3]),
          legal_action_count: numberValue(row[4]),
        });
      } catch (err) {
        console.error('[collections] summary failed:', err);
        res.status(500).json({ error: 'Failed to load collections summary' });
      }
    });

    // Action breakdown — counts and amounts per recommended_action.
    // GET /api/collections/actions
    app.get('/api/collections/actions', async (_req, res) => {
      try {
        const warehouseResult = await appkit.analytics.query(ACTION_BREAKDOWN_SQL);
        const rows = resultRows(warehouseResult).map((r) => ({
          recommended_action: stringValue(r[0]),
          customer_count: numberValue(r[1]),
          recoverable: numberValue(r[2]),
          at_risk: numberValue(r[3]),
        }));
        res.json(rows);
      } catch (err) {
        console.error('[collections] action-breakdown failed:', err);
        res.status(500).json({ error: 'Failed to load action breakdown' });
      }
    });

    // Priority-ranked customer queue, optionally filtered by action.
    // GET /api/collections/queue?action=STOP_DUNNING&limit=50
    app.get('/api/collections/queue', async (req, res) => {
      const parsed = QueueQuery.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid collections queue parameters' });
        return;
      }
      try {
        const { action, limit } = parsed.data;
        const querySQL = action ? QUEUE_FILTERED_SQL : QUEUE_ALL_SQL;
        const params: Record<string, ReturnType<(typeof sql)['string']> | ReturnType<(typeof sql)['int']>> = {
          p_limit: sql.int(limit),
        };
        if (action) {
          params.p_action = sql.string(action);
        }
        const warehouseResult = await appkit.analytics.query(querySQL, params);
        const rows = resultRows(warehouseResult).map((r) => ({
          customer_id: numberValue(r[0]),
          account_name: stringValue(r[1]),
          customer_segment: stringValue(r[2]),
          recommended_action: stringValue(r[3]),
          collections_priority_score: numberValue(r[4]),
          ra_exception_count: numberValue(r[5]),
          ra_total_at_risk: numberValue(r[6]),
          ra_check_types: arrayValue(r[7]),
          dunning_active_cases: numberValue(r[8]),
          dunning_active_overdue: numberValue(r[9]),
          dunning_escalated_cases: numberValue(r[10]),
          dunning_written_off_amount: numberValue(r[11]),
          disputed_payment_count: numberValue(r[12]),
          estimated_recoverable_amount: numberValue(r[13]),
          has_legal_action: booleanValue(r[14]),
          ra_explains_pct_of_overdue: numberValue(r[15]),
          queue_position: numberValue(r[16]),
          investigation_guidance: stringValue(r[17]),
        }));
        res.json(rows);
      } catch (err) {
        console.error('[collections] queue failed:', err);
        res.status(500).json({ error: 'Failed to load collections queue' });
      }
    });
  });
}
