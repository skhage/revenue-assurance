// Prevention Intelligence routes — proxies 3 Prevention Intelligence UC functions.
//
// UC functions (built by @ai-engineer, RA-AI-CLOSEDLOOP-RECOVERY-V2):
//   1. compute_prevention_intelligence — systemic root causes + preventable leakage
//   2. generate_leakage_prevention_rules — actionable prevention rules
//   3. evaluate_prevention_roi — business case builder with payback periods

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

const IntelligenceQuery = z.object({
  min_written_off: z.coerce.number().min(0).default(100000),
  min_recurrence: z.coerce.number().int().min(1).default(3),
  top_n: z.coerce.number().int().min(1).max(50).default(25),
});

const RulesQuery = z.object({
  prevention_category: z.string().optional(),
  top_n: z.coerce.number().int().min(1).max(50).default(10),
});

const RoiQuery = z.object({
  budget: z.coerce.number().min(0).default(5000000),
  horizon_months: z.coerce.number().int().min(1).max(60).default(12),
  top_n: z.coerce.number().int().min(1).max(25).default(10),
});

// ── SQL templates ────────────────────────────────────────────────────────────

const INTELLIGENCE_SQL = `
SELECT *
FROM cdm_tmforum.revenue_assurance.compute_prevention_intelligence(
  :p_min_written_off,
  :p_min_recurrence,
  :p_top_n
)
`;

const RULES_SQL = `
SELECT *
FROM cdm_tmforum.revenue_assurance.generate_leakage_prevention_rules(
  NULLIF(:p_category, 'NULL'), -- RA-APP-RETEST-CREDIT-SUPERVISOR-1102: 'NULL' sentinel -> real NULL
  :p_top_n
)
`;

const ROI_SQL = `
SELECT *
FROM cdm_tmforum.revenue_assurance.evaluate_prevention_roi(
  :p_budget,
  :p_horizon,
  :p_top_n
)
`;

const SUMMARY_SQL = `
SELECT
  COUNT(*) AS root_cause_count,
  COALESCE(SUM(preventable_amount), 0) AS total_preventable,
  COALESCE(SUM(annual_written_off), 0) AS total_written_off,
  COUNT(DISTINCT prevention_category) AS category_count,
  COALESCE(AVG(prevention_rate_estimate), 0) AS avg_prevention_rate
FROM cdm_tmforum.revenue_assurance.compute_prevention_intelligence(100000.0, 3, 25)
`;

// ── Route setup ──────────────────────────────────────────────────────────────

export function setupPreventionRoutes(appkit: AppKitWithAnalytics) {
  appkit.server.extend((app) => {
    // Prevention intelligence — systemic root causes ranked by preventable amount.
    // GET /api/prevention/intelligence?min_written_off=100000&min_recurrence=3&top_n=25
    app.get('/api/prevention/intelligence', async (req, res) => {
      const parsed = IntelligenceQuery.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid prevention intelligence parameters' });
        return;
      }
      try {
        const { min_written_off, min_recurrence, top_n } = parsed.data;
        const warehouseResult = await appkit.analytics.query(INTELLIGENCE_SQL, {
          p_min_written_off: sql.int(Math.round(min_written_off)),
          p_min_recurrence: sql.int(min_recurrence),
          p_top_n: sql.int(top_n),
        });
        const rows = resultRows(warehouseResult).map((r) => ({
          prevention_category: stringValue(r[0]),
          check_type: stringValue(r[1]),
          systemic_root_cause: stringValue(r[2]),
          affected_customers: numberValue(r[3]),
          total_exceptions: numberValue(r[4]),
          annual_leakage_at_risk: numberValue(r[5]),
          annual_written_off: numberValue(r[6]),
          prevention_rate_estimate: numberValue(r[7]),
          preventable_amount: numberValue(r[8]),
          recurrence_rate: numberValue(r[9]),
          avg_detection_to_resolution_hrs: numberValue(r[10]),
          recommended_control: stringValue(r[11]),
          implementation_complexity: stringValue(r[12]),
          priority_score: numberValue(r[13]),
        }));
        res.json(rows);
      } catch (err) {
        console.error('[prevention] intelligence failed:', err);
        res.status(500).json({ error: 'Failed to compute prevention intelligence' });
      }
    });

    // Prevention rules — actionable rules with trigger/validation/enforcement.
    // GET /api/prevention/rules?prevention_category=...&top_n=10
    app.get('/api/prevention/rules', async (req, res) => {
      const parsed = RulesQuery.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid prevention rules parameters' });
        return;
      }
      try {
        const { prevention_category, top_n } = parsed.data;
        const warehouseResult = await appkit.analytics.query(RULES_SQL, {
          p_category: sql.string(prevention_category ?? 'NULL'),
          p_top_n: sql.int(top_n),
        });
        const rows = resultRows(warehouseResult).map((r) => ({
          rule_id: stringValue(r[0]),
          rule_name: stringValue(r[1]),
          prevention_category: stringValue(r[2]),
          target_check_types: stringValue(r[3]),
          trigger_condition: stringValue(r[4]),
          validation_logic: stringValue(r[5]),
          enforcement_point: stringValue(r[6]),
          estimated_annual_prevention: numberValue(r[7]),
          affected_customer_count: numberValue(r[8]),
          exception_reduction_pct: numberValue(r[9]),
          implementation_steps: stringValue(r[10]),
          data_sources_required: stringValue(r[11]),
          complexity: stringValue(r[12]),
          roi_score: numberValue(r[13]),
        }));
        res.json(rows);
      } catch (err) {
        console.error('[prevention] rules failed:', err);
        res.status(500).json({ error: 'Failed to generate prevention rules' });
      }
    });

    // ROI calculator — business case builder with payback periods.
    // GET /api/prevention/roi?budget=5000000&horizon_months=12&top_n=10
    app.get('/api/prevention/roi', async (req, res) => {
      const parsed = RoiQuery.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid ROI parameters' });
        return;
      }
      try {
        const { budget, horizon_months, top_n } = parsed.data;
        const warehouseResult = await appkit.analytics.query(ROI_SQL, {
          p_budget: sql.int(Math.round(budget)),
          p_horizon: sql.int(horizon_months),
          p_top_n: sql.int(top_n),
        });
        const rows = resultRows(warehouseResult).map((r) => ({
          initiative_name: stringValue(r[0]),
          prevention_category: stringValue(r[1]),
          check_types_covered: stringValue(r[2]),
          annual_leakage_prevented: numberValue(r[3]),
          annual_investigation_cost_saved: numberValue(r[4]),
          annual_write_off_avoided: numberValue(r[5]),
          total_annual_benefit: numberValue(r[6]),
          estimated_implementation_cost: numberValue(r[7]),
          payback_period_months: numberValue(r[8]),
          net_roi_pct: numberValue(r[9]),
          cumulative_benefit: numberValue(r[10]),
          customers_protected: numberValue(r[11]),
          exceptions_eliminated: numberValue(r[12]),
          priority_rank: numberValue(r[13]),
          recommendation: stringValue(r[14]),
        }));
        res.json(rows);
      } catch (err) {
        console.error('[prevention] roi failed:', err);
        res.status(500).json({ error: 'Failed to evaluate prevention ROI' });
      }
    });

    // Prevention summary — headline KPIs.
    // GET /api/prevention/summary
    app.get('/api/prevention/summary', async (_req, res) => {
      try {
        const warehouseResult = await appkit.analytics.query(SUMMARY_SQL);
        const rows = resultRows(warehouseResult);
        const row = rows[0] ?? [];
        res.json({
          root_cause_count: numberValue(row[0]),
          total_preventable: numberValue(row[1]),
          total_written_off: numberValue(row[2]),
          category_count: numberValue(row[3]),
          avg_prevention_rate: numberValue(row[4]),
        });
      } catch (err) {
        console.error('[prevention] summary failed:', err);
        res.status(500).json({ error: 'Failed to load prevention summary' });
      }
    });
  });
}
