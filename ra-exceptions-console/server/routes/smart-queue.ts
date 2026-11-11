// Smart Queue routes — proxies the 3 Predictive Recovery Prioritizer UC functions.
//
// UC functions (built by @ai-engineer, RA-AI-PREDICTIVE-RECOVERY):
//   1. generate_smart_work_queue — daily optimized analyst queue ranked by ROI-per-hour
//   2. predict_recovery_value — ranked unworked exceptions by predicted $ recovery
//   3. analyze_triage_effectiveness — per-check_type triage accuracy analysis

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

// ── Request schemas ──────────────────────────────────────────────────────────

const WorkQueueQuery = z.object({
  analyst_capacity: z.coerce.number().int().min(1).max(200).default(50),
  focus_check_type: z.string().optional(),
  min_predicted_value: z.coerce.number().min(0).default(50000),
});

const RecoveryOppsQuery = z.object({
  check_type: z.string().optional(),
  min_amount: z.coerce.number().min(0).default(10000),
  priority_filter: z.string().optional(),
  top_n: z.coerce.number().int().min(1).max(200).default(50),
});

const TriageEffQuery = z.object({
  check_type: z.string().optional(),
  min_cases: z.coerce.number().int().min(1).default(50),
});

// ── SQL templates ────────────────────────────────────────────────────────────

// RA-APP-RETEST-CREDIT-SUPERVISOR-1102: the 'NULL' string sentinel now matches 0 rows,
// so it is mapped to a real NULL here.
const WORK_QUEUE_SQL = `
SELECT *
FROM cdm_tmforum.revenue_assurance.generate_smart_work_queue(
  :p_analyst_capacity,
  NULLIF(:p_focus_check_type, 'NULL'),
  :p_min_predicted_value
)
`;

const RECOVERY_OPPS_SQL = `
SELECT *
FROM cdm_tmforum.revenue_assurance.predict_recovery_value(
  NULLIF(:p_check_type, 'NULL'),
  :p_min_amount,
  NULLIF(:p_priority_filter, 'NULL'),
  :p_top_n
)
`;

const TRIAGE_EFF_SQL = `
SELECT *
FROM cdm_tmforum.revenue_assurance.analyze_triage_effectiveness(
  NULLIF(:p_check_type, 'NULL'),
  :p_min_cases
)
`;

// Summary — aggregate KPIs from the smart work queue.
const SMART_QUEUE_SUMMARY_SQL = `
SELECT
  COUNT(*) AS queue_size,
  COALESCE(SUM(predicted_recovery_value), 0) AS total_predicted_recovery,
  COALESCE(SUM(amount_at_risk), 0) AS total_at_risk,
  COALESCE(AVG(roi_per_hour), 0) AS avg_roi_per_hour
FROM cdm_tmforum.revenue_assurance.generate_smart_work_queue(50, NULL, 50000)
`;

// ── Route setup ──────────────────────────────────────────────────────────────

export function setupSmartQueueRoutes(appkit: AppKitWithAnalytics) {
  appkit.server.extend((app) => {
    // Smart work queue — optimized daily analyst queue ranked by ROI-per-hour.
    // GET /api/smart-queue/work-queue?analyst_capacity=50&focus_check_type=...&min_predicted_value=50000
    app.get('/api/smart-queue/work-queue', async (req, res) => {
      const parsed = WorkQueueQuery.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid work queue parameters' });
        return;
      }
      try {
        const { analyst_capacity, focus_check_type, min_predicted_value } = parsed.data;
        const warehouseResult = await appkit.analytics.query(WORK_QUEUE_SQL, {
          p_analyst_capacity: sql.int(analyst_capacity),
          p_focus_check_type: sql.string(focus_check_type ?? 'NULL'),
          p_min_predicted_value: sql.int(Math.round(min_predicted_value)),
        });
        const rows = resultRows(warehouseResult).map((r) => ({
          queue_position: numberValue(r[0]),
          exception_id: stringValue(r[1]),
          check_type: stringValue(r[2]),
          customer_id: numberValue(r[3]),
          account_name: stringValue(r[4]),
          amount_at_risk: numberValue(r[5]),
          predicted_recovery_value: numberValue(r[6]),
          predicted_recovery_rate: numberValue(r[7]),
          roi_per_hour: numberValue(r[8]),
          expected_hours: numberValue(r[9]),
          urgency_tier: stringValue(r[10]),
          investigation_starter: stringValue(r[11]),
        }));
        res.json(rows);
      } catch (err) {
        console.error('[smart-queue] work-queue failed:', err);
        res.status(500).json({ error: 'Failed to generate smart work queue' });
      }
    });

    // Recovery opportunities — ranked unworked exceptions by predicted $ recovery.
    // GET /api/smart-queue/recovery-opportunities?check_type=...&min_amount=10000&top_n=50
    app.get('/api/smart-queue/recovery-opportunities', async (req, res) => {
      const parsed = RecoveryOppsQuery.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid recovery opportunity parameters' });
        return;
      }
      try {
        const { check_type, min_amount, priority_filter, top_n } = parsed.data;
        const warehouseResult = await appkit.analytics.query(RECOVERY_OPPS_SQL, {
          p_check_type: sql.string(check_type ?? 'NULL'),
          p_min_amount: sql.int(Math.round(min_amount)),
          p_priority_filter: sql.string(priority_filter ?? 'NULL'),
          p_top_n: sql.int(top_n),
        });
        const rows = resultRows(warehouseResult).map((r) => ({
          opportunity_rank: numberValue(r[0]),
          exception_id: stringValue(r[1]),
          check_type: stringValue(r[2]),
          customer_id: numberValue(r[3]),
          account_name: stringValue(r[4]),
          amount_at_risk: numberValue(r[5]),
          predicted_recovery_rate: numberValue(r[6]),
          predicted_recovery_value: numberValue(r[7]),
          confidence: stringValue(r[8]),
          review_priority: stringValue(r[9]),
          composite_anomaly_score: numberValue(r[10]),
          customer_risk_tier: stringValue(r[11]),
          recovery_reasoning: stringValue(r[12]),
        }));
        res.json(rows);
      } catch (err) {
        console.error('[smart-queue] recovery-opportunities failed:', err);
        res.status(500).json({ error: 'Failed to predict recovery values' });
      }
    });

    // Triage effectiveness — per-check_type accuracy analysis.
    // GET /api/smart-queue/triage-effectiveness?check_type=...&min_cases=50
    app.get('/api/smart-queue/triage-effectiveness', async (req, res) => {
      const parsed = TriageEffQuery.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid triage effectiveness parameters' });
        return;
      }
      try {
        const { check_type, min_cases } = parsed.data;
        const warehouseResult = await appkit.analytics.query(TRIAGE_EFF_SQL, {
          p_check_type: sql.string(check_type ?? 'NULL'),
          p_min_cases: sql.int(min_cases),
        });
        const rows = resultRows(warehouseResult).map((r) => ({
          check_type: stringValue(r[0]),
          total_cases: numberValue(r[1]),
          triage_accuracy_pct: numberValue(r[2]),
          avg_priority_error: stringValue(r[3]),
          most_common_misclass: stringValue(r[4]),
          recommended_adjustment: stringValue(r[5]),
          recovery_rate_when_accurate: numberValue(r[6]),
          recovery_rate_when_inaccurate: numberValue(r[7]),
          accuracy_delta_impact_pct: numberValue(r[8]),
        }));
        res.json(rows);
      } catch (err) {
        console.error('[smart-queue] triage-effectiveness failed:', err);
        res.status(500).json({ error: 'Failed to analyze triage effectiveness' });
      }
    });

    // Smart queue summary — headline KPIs.
    // GET /api/smart-queue/summary
    app.get('/api/smart-queue/summary', async (_req, res) => {
      try {
        const warehouseResult = await appkit.analytics.query(SMART_QUEUE_SUMMARY_SQL);
        const rows = resultRows(warehouseResult);
        const row = rows[0] ?? [];
        res.json({
          queue_size: numberValue(row[0]),
          total_predicted_recovery: numberValue(row[1]),
          total_at_risk: numberValue(row[2]),
          avg_roi_per_hour: numberValue(row[3]),
        });
      } catch (err) {
        console.error('[smart-queue] summary failed:', err);
        res.status(500).json({ error: 'Failed to load smart queue summary' });
      }
    });
  });
}
