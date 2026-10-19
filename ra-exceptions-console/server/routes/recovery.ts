// Recovery routes — proxies the 2 UC recovery functions via the SQL warehouse.
//
// UC functions (built by @ai-engineer, RA-AI-RECOVERY-ORCHESTRATOR):
//   1. generate_recovery_action_plan — ranked recovery opportunities with action plans
//   2. resolve_unattributed_exceptions — traces unattributed rev-rec exceptions via ERP lineage

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

const ActionPlanQuery = z.object({
  customer_id: z.coerce.number().int().optional(),
  max_results: z.coerce.number().int().min(1).max(100).default(25),
  min_recovery_estimate: z.coerce.number().min(0).default(1000),
});

// ── SQL templates ────────────────────────────────────────────────────────────

const ACTION_PLAN_SQL = `
SELECT *
FROM cdm_tmforum.revenue_assurance.generate_recovery_action_plan(
  :p_customer_id,
  :p_max_results,
  :p_min_recovery_estimate
)
`;

const UNATTRIBUTED_SQL = `
SELECT *
FROM cdm_tmforum.revenue_assurance.resolve_unattributed_exceptions()
`;

// Recovery headline — total recoverable amount and top opportunity count.
const RECOVERY_SUMMARY_SQL = `
SELECT
  COUNT(*) AS opportunity_count,
  COALESCE(SUM(estimated_recoverable), 0) AS total_recoverable,
  COALESCE(SUM(total_amount_at_risk), 0) AS total_at_risk
FROM cdm_tmforum.revenue_assurance.generate_recovery_action_plan(NULL, 100, 1000)
`;

// ── Route setup ──────────────────────────────────────────────────────────────

export function setupRecoveryRoutes(appkit: AppKitWithAnalytics) {
  appkit.server.extend((app) => {
    // Recovery action plan — ranked customer recovery opportunities.
    // GET /api/recovery/action-plan?customer_id=123&max_results=25&min_recovery_estimate=1000
    app.get('/api/recovery/action-plan', async (req, res) => {
      const parsed = ActionPlanQuery.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid recovery plan parameters' });
        return;
      }
      try {
        const { customer_id, max_results, min_recovery_estimate } = parsed.data;
        const warehouseResult = await appkit.analytics.query(ACTION_PLAN_SQL, {
          p_customer_id: sql.int(customer_id ?? 0),
          p_max_results: sql.int(max_results),
          p_min_recovery_estimate: sql.int(Math.round(min_recovery_estimate)),
        });
        const rows = resultRows(warehouseResult).map((r) => ({
          recovery_rank: numberValue(r[0]),
          customer_id: numberValue(r[1]),
          account_name: stringValue(r[2]),
          risk_tier: stringValue(r[3]),
          composite_health_score: numberValue(r[4]),
          total_amount_at_risk: numberValue(r[5]),
          estimated_recoverable: numberValue(r[6]),
          recovery_confidence: stringValue(r[7]),
          top_check_type: stringValue(r[8]),
          exception_count: numberValue(r[9]),
          highest_anomaly_score: numberValue(r[10]),
          action_plan: stringValue(r[11]),
          assigned_analyst: stringValue(r[12]),
          sla_target: stringValue(r[13]),
          escalation_needed: booleanValue(r[14]),
        }));
        res.json(rows);
      } catch (err) {
        console.error('[recovery] action-plan failed:', err);
        res.status(500).json({ error: 'Failed to generate recovery action plan' });
      }
    });

    // Resolve unattributed exceptions — traces rev-rec exceptions via ERP lineage.
    // GET /api/recovery/unattributed
    app.get('/api/recovery/unattributed', async (_req, res) => {
      try {
        const warehouseResult = await appkit.analytics.query(UNATTRIBUTED_SQL);
        const raw = warehouseResult?.data ?? [];
        res.json(Array.isArray(raw) ? raw : []);
      } catch (err) {
        console.error('[recovery] unattributed failed:', err);
        res.status(500).json({ error: 'Failed to resolve unattributed exceptions' });
      }
    });

    // Recovery summary — headline metrics for the dashboard.
    // GET /api/recovery/summary
    app.get('/api/recovery/summary', async (_req, res) => {
      try {
        const warehouseResult = await appkit.analytics.query(RECOVERY_SUMMARY_SQL);
        const rows = resultRows(warehouseResult);
        const row = rows[0] ?? [];
        res.json({
          opportunity_count: numberValue(row[0]),
          total_recoverable: numberValue(row[1]),
          total_at_risk: numberValue(row[2]),
        });
      } catch (err) {
        console.error('[recovery] summary failed:', err);
        res.status(500).json({ error: 'Failed to load recovery summary' });
      }
    });
  });
}
