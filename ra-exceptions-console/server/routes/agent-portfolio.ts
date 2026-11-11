// Agent Portfolio Intelligence routes — proxies 2 UC functions.
//
// UC functions (built by @ai-engineer):
//   1. compute_agent_roi_metrics — per-category ROI, function counts, recovery stats
//   2. assess_agent_coverage_gaps — unworked hotspots and missing supervisor coverage

import type { Application } from 'express';
import { resultRows, type WarehouseResult } from '../warehouse-result';

interface AppKitWithAnalytics {
  analytics: {
    query(text: string): Promise<WarehouseResult>;
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

// ── SQL templates ────────────────────────────────────────────────────────────
//
// Attribution note (RA-APP-REFRESH-AGENT-ROI-FIGURES, 2026-10-25):
// compute_agent_roi_metrics now credits each check_type to exactly ONE category.
// Additive columns (exceptions, at-risk, recovered, written-off, unworked,
// est. recoverable) are therefore summable across rows; cross-cutting categories
// (INVESTIGATION, MONITORING, TRIAGE, ...) carry 0 on additive columns and
// portfolio-level values on rate/ROI columns.
// RA-APP-ROI-ATTRIBUTION-BASIS (2026-10-26): the function now appends
// attribution_basis (PRIMARY | CROSS_CUTTING) as column 15 and returns
// roi_score NULL for CROSS_CUTTING rows, so we key on that instead of the
// old $0-at-risk heuristic.

const ROI_METRICS_SQL = `
SELECT *
FROM cdm_tmforum.revenue_assurance.compute_agent_roi_metrics()
ORDER BY total_amount_at_risk_usd DESC, roi_score DESC NULLS LAST
`;

const COVERAGE_GAPS_SQL = `
SELECT *
FROM cdm_tmforum.revenue_assurance.assess_agent_coverage_gaps()
ORDER BY estimated_impact_usd DESC
`;

const PORTFOLIO_SUMMARY_SQL = `
SELECT
  COUNT(*) AS category_count,
  COALESCE(SUM(function_count), 0) AS total_functions,
  COALESCE(SUM(supervisor_tool_count), 0) AS total_supervisors,
  COALESCE(SUM(total_amount_at_risk_usd), 0) AS total_at_risk,
  COALESCE(SUM(total_recovered_usd), 0) AS total_recovered,
  COALESCE(SUM(estimated_recoverable_usd), 0) AS estimated_recoverable,
  COALESCE(AVG(CASE WHEN attribution_basis = 'PRIMARY' THEN roi_score END), 0) AS avg_roi_score
FROM cdm_tmforum.revenue_assurance.compute_agent_roi_metrics()
`;

// ── Route setup ──────────────────────────────────────────────────────────────

export function setupAgentPortfolioRoutes(appkit: AppKitWithAnalytics) {
  appkit.server.extend((app) => {
    // Agent ROI metrics — per-category breakdown.
    // GET /api/agent-portfolio/roi
    app.get('/api/agent-portfolio/roi', async (_req, res) => {
      try {
        const warehouseResult = await appkit.analytics.query(ROI_METRICS_SQL);
        const rows = resultRows(warehouseResult).map((r) => ({
          agent_category: stringValue(r[0]),
          function_count: numberValue(r[1]),
          supervisor_tool_count: numberValue(r[2]),
          total_exceptions_detected: numberValue(r[3]),
          total_amount_at_risk_usd: numberValue(r[4]),
          total_recovered_usd: numberValue(r[5]),
          total_written_off_usd: numberValue(r[6]),
          recovery_rate_pct: numberValue(r[7]),
          unworked_count: numberValue(r[8]),
          unworked_amount_usd: numberValue(r[9]),
          estimated_recoverable_usd: numberValue(r[10]),
          triage_accuracy_pct: numberValue(r[11]),
          impact_categories: stringValue(r[12]),
          catalog_est_annual_usd: numberValue(r[13]),
          roi_score: r[14] == null ? null : numberValue(r[14]),
          attribution_basis: stringValue(r[15]) === 'CROSS_CUTTING' ? 'CROSS_CUTTING' : 'PRIMARY',
        }));
        res.json(rows);
      } catch (err) {
        console.error('[agent-portfolio] roi failed:', err);
        res.status(500).json({ error: 'Failed to compute agent ROI metrics' });
      }
    });

    // Coverage gaps — unworked hotspots + missing supervisors.
    // GET /api/agent-portfolio/gaps
    app.get('/api/agent-portfolio/gaps', async (_req, res) => {
      try {
        const warehouseResult = await appkit.analytics.query(COVERAGE_GAPS_SQL);
        const rows = resultRows(warehouseResult).map((r) => ({
          gap_type: stringValue(r[0]),
          gap_priority: stringValue(r[1]),
          entity: stringValue(r[2]),
          gap_description: stringValue(r[3]),
          estimated_impact_usd: numberValue(r[4]),
          recommended_action: stringValue(r[5]),
          assigned_to: stringValue(r[6]),
        }));
        res.json(rows);
      } catch (err) {
        console.error('[agent-portfolio] gaps failed:', err);
        res.status(500).json({ error: 'Failed to assess agent coverage gaps' });
      }
    });

    // Portfolio summary KPIs.
    // GET /api/agent-portfolio/summary
    app.get('/api/agent-portfolio/summary', async (_req, res) => {
      try {
        const warehouseResult = await appkit.analytics.query(PORTFOLIO_SUMMARY_SQL);
        const rows = resultRows(warehouseResult);
        const r = rows[0] ?? [];
        res.json({
          category_count: numberValue(r[0]),
          total_functions: numberValue(r[1]),
          total_supervisors: numberValue(r[2]),
          total_at_risk: numberValue(r[3]),
          total_recovered: numberValue(r[4]),
          estimated_recoverable: numberValue(r[5]),
          avg_roi_score: numberValue(r[6]),
        });
      } catch (err) {
        console.error('[agent-portfolio] summary failed:', err);
        res.status(500).json({ error: 'Failed to compute portfolio summary' });
      }
    });
  });
}
