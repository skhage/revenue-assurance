// Triage routes — proxies the 3 UC triage functions via the SQL warehouse.
//
// UC functions (built by @ai-engineer, RA-AI-BUILD-TRIAGE):
//   1. classify_exception_priority  → single-exception priority classification
//   2. suggest_investigation_path   → check-type-aware investigation playbook
//   3. auto_triage_batch            → batch triage with priority/check_type filters

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

const BatchQuery = z.object({
  priority: z.enum(['P1', 'P2', 'P3', 'P4']).optional(),
  check_type: z.string().optional(),
  row_limit: z.coerce.number().int().min(1).max(200).default(50),
  row_offset: z.coerce.number().int().min(0).default(0),
});

const ClassifyQuery = z.object({
  check_type: z.string(),
  amount_at_risk: z.coerce.number(),
  review_priority: z.string().default('MEDIUM'),
  customer_risk_tier: z.string().default('Medium'),
  anomaly_rank: z.coerce.number().int().default(500),
});

const PlaybookQuery = z.object({
  check_type: z.string(),
  customer_id: z.coerce.number().int(),
  amount_at_risk: z.coerce.number(),
  reference_id: z.string().default(''),
});

const AdaptiveTriageQuery = z.object({
  check_type: z.string(),
  amount_at_risk: z.coerce.number(),
  customer_id: z.coerce.number().int(),
  severity: z.string().default('MEDIUM'),
});

// ── SQL templates ────────────────────────────────────────────────────────────

// auto_triage_batch returns a TABLE result — call it with SELECT * FROM.
const BATCH_SQL = `
SELECT *
FROM cdm_tmforum.revenue_assurance.auto_triage_batch(
  :p_priority_filter,
  :p_check_type_filter
)
LIMIT :row_limit OFFSET :row_offset
`;

const CLASSIFY_SQL = `
SELECT *
FROM cdm_tmforum.revenue_assurance.classify_exception_priority(
  :check_type,
  :amount_at_risk,
  :review_priority,
  :customer_risk_tier,
  :anomaly_rank
)
`;

const PLAYBOOK_SQL = `
SELECT *
FROM cdm_tmforum.revenue_assurance.suggest_investigation_path(
  :check_type,
  :customer_id,
  :amount_at_risk,
  :reference_id
)
ORDER BY step_number
`;

const ADAPTIVE_TRIAGE_SQL = `
SELECT *
FROM cdm_tmforum.revenue_assurance.recommend_adaptive_triage(
  :p_check_type,
  :p_amount_at_risk,
  :p_customer_id,
  :p_severity
)
`;

// P1 count for the dashboard badge — uses batch triage with P1 filter.
const P1_COUNT_SQL = `
SELECT COUNT(*) AS p1_count,
       COALESCE(SUM(amount_at_risk), 0) AS p1_amount
FROM cdm_tmforum.revenue_assurance.auto_triage_batch('P1', NULL)
`;

// Priority distribution summary for the overview.
const PRIORITY_DIST_SQL = `
WITH triaged AS (
  SELECT * FROM cdm_tmforum.revenue_assurance.auto_triage_batch(NULL, NULL)
)
SELECT
  triage_priority AS priority,
  COUNT(*) AS exception_count,
  COALESCE(SUM(amount_at_risk), 0) AS total_at_risk
FROM triaged
GROUP BY triage_priority
ORDER BY triage_priority
`;

// ── Route setup ──────────────────────────────────────────────────────────────

export function setupTriageRoutes(appkit: AppKitWithAnalytics) {
  appkit.server.extend((app) => {
    // Batch triage — filterable list of triaged exceptions.
    app.get('/api/triage/batch', async (req, res) => {
      const parsed = BatchQuery.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid triage filters' });
        return;
      }
      try {
        const { priority, check_type, row_limit, row_offset } = parsed.data;
        const warehouseResult = await appkit.analytics.query(BATCH_SQL, {
          p_priority_filter: sql.string(priority ?? ''),
          p_check_type_filter: sql.string(check_type ?? ''),
          row_limit: sql.int(row_limit),
          row_offset: sql.int(row_offset),
        });
        // auto_triage_batch returns keyed rows — pass them through.
        const raw = warehouseResult?.data ?? [];
        res.json(Array.isArray(raw) ? raw : []);
      } catch (err) {
        console.error('[triage] batch failed:', err);
        res.status(500).json({ error: 'Failed to run batch triage' });
      }
    });

    // Classify a single exception — returns priority, urgency, rationale.
    app.get('/api/triage/classify', async (req, res) => {
      const parsed = ClassifyQuery.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid classify parameters' });
        return;
      }
      try {
        const { check_type, amount_at_risk, review_priority, customer_risk_tier, anomaly_rank } =
          parsed.data;
        const warehouseResult = await appkit.analytics.query(CLASSIFY_SQL, {
          check_type: sql.string(check_type),
          amount_at_risk: sql.int(Math.round(amount_at_risk)),
          review_priority: sql.string(review_priority),
          customer_risk_tier: sql.string(customer_risk_tier),
          anomaly_rank: sql.int(anomaly_rank),
        });
        const rows = resultRows(warehouseResult);
        if (rows.length === 0) {
          res.json(null);
          return;
        }
        const r = rows[0];
        res.json({
          priority: stringValue(r[0]),
          urgency_score: numberValue(r[1]),
          assigned_analyst: stringValue(r[2]),
          rationale: stringValue(r[3]),
          sla_hours: numberValue(r[4]),
        });
      } catch (err) {
        console.error('[triage] classify failed:', err);
        res.status(500).json({ error: 'Failed to classify exception' });
      }
    });

    // Investigation playbook — step-by-step actions for a specific exception.
    app.get('/api/triage/playbook', async (req, res) => {
      const parsed = PlaybookQuery.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid playbook parameters' });
        return;
      }
      try {
        const { check_type, customer_id, amount_at_risk, reference_id } = parsed.data;
        const warehouseResult = await appkit.analytics.query(PLAYBOOK_SQL, {
          check_type: sql.string(check_type),
          customer_id: sql.int(customer_id),
          amount_at_risk: sql.int(Math.round(amount_at_risk)),
          reference_id: sql.string(reference_id),
        });
        const rows = resultRows(warehouseResult).map((r) => ({
          step_number: numberValue(r[0]),
          action: stringValue(r[1]),
          data_source: stringValue(r[2]),
          query_hint: stringValue(r[3]),
          escalation_trigger: stringValue(r[4]),
        }));
        res.json(rows);
      } catch (err) {
        console.error('[triage] playbook failed:', err);
        res.status(500).json({ error: 'Failed to generate investigation playbook' });
      }
    });

    // P1 summary — lightweight endpoint for the dashboard badge.
    app.get('/api/triage/p1-summary', async (_req, res) => {
      try {
        const warehouseResult = await appkit.analytics.query(P1_COUNT_SQL);
        const rows = resultRows(warehouseResult);
        const row = rows[0] ?? [];
        res.json({
          p1_count: numberValue(row[0]),
          p1_amount: numberValue(row[1]),
        });
      } catch (err) {
        console.error('[triage] P1 summary failed:', err);
        res.status(500).json({ error: 'Failed to load P1 summary' });
      }
    });

    // Adaptive triage — learning-informed priority and routing from the feedback loop.
    app.get('/api/triage/adaptive', async (req, res) => {
      const parsed = AdaptiveTriageQuery.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid adaptive triage parameters' });
        return;
      }
      try {
        const { check_type, amount_at_risk, customer_id, severity } = parsed.data;
        const warehouseResult = await appkit.analytics.query(ADAPTIVE_TRIAGE_SQL, {
          p_check_type: sql.string(check_type),
          p_amount_at_risk: sql.int(Math.round(amount_at_risk)),
          p_customer_id: sql.int(customer_id),
          p_severity: sql.string(severity),
        });
        const rows = resultRows(warehouseResult);
        if (rows.length === 0) {
          res.json(null);
          return;
        }
        const r = rows[0];
        res.json({
          adaptive_priority: stringValue(r[0]),
          recommended_method: stringValue(r[1]),
          recommended_analyst: stringValue(r[2]),
          expected_recovery_rate: numberValue(r[3]),
          expected_recovery_value: numberValue(r[4]),
          expected_hours: numberValue(r[5]),
          recovery_roi_per_hour: numberValue(r[6]),
          learning_confidence: stringValue(r[7]),
          routing_rationale: stringValue(r[8]) || null,
          compound_risk_flag: r[9] === true || r[9] === 'true',
        });
      } catch (err) {
        console.error('[triage] adaptive failed:', err);
        res.status(500).json({ error: 'Failed to get adaptive triage recommendation' });
      }
    });

    // Priority distribution — for the overview breakdown.
    app.get('/api/triage/distribution', async (_req, res) => {
      try {
        const warehouseResult = await appkit.analytics.query(PRIORITY_DIST_SQL);
        const rows = resultRows(warehouseResult).map((r) => ({
          priority: stringValue(r[0]),
          exception_count: numberValue(r[1]),
          total_at_risk: numberValue(r[2]),
        }));
        res.json(rows);
      } catch (err) {
        console.error('[triage] distribution failed:', err);
        res.status(500).json({ error: 'Failed to load priority distribution' });
      }
    });
  });
}
