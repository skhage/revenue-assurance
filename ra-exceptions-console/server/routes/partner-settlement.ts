// Partner Settlement routes — proxies the 2 UC partner settlement functions via the SQL warehouse.
//
// UC functions (built by @ai-engineer, RA-AI-PARTNER-SETTLEMENT):
//   1. reconcile_partner_settlement — per-reconciliation detail with severity + root causes
//   2. prioritize_partner_disputes  — partner-level ROI-ranked dispute priority list

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

// ── Request schemas ──────────────────────────────────────────────────────────

const ReconcileQuery = z.object({
  partner_id: z.coerce.number().int().optional(),
  settlement_type: z.string().optional(),
  severity_filter: z.string().optional(),
  min_amount: z.coerce.number().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const DisputeQuery = z.object({
  top_n: z.coerce.number().int().min(1).max(100).default(25),
  min_amount: z.coerce.number().min(0).default(0),
  include_escalated: z.coerce.boolean().default(true),
});

// ── SQL builders ─────────────────────────────────────────────────────────────
// UC functions use DEFAULT params (NULL / 'ALL'). The appkit sql.* helpers can't
// represent NULL, so we construct the function-call SQL dynamically. All user
// inputs are validated by zod schemas above; only safe enum strings/integers
// reach these builders.

function reconcileSql(opts: {
  partner_id?: number;
  settlement_type: string;
  severity_filter: string;
  min_amount: number;
  limit: number;
}): string {
  const pid = opts.partner_id ? String(opts.partner_id) : 'NULL';
  const stype = opts.settlement_type || 'ALL';
  const sev = opts.severity_filter || 'ALL';
  return `
SELECT *
FROM cdm_tmforum.revenue_assurance.reconcile_partner_settlement(
  ${pid},
  '${stype}',
  '${sev}',
  ${opts.min_amount},
  ${opts.limit}
)
`;
}

function disputesSql(opts: { top_n: number; min_amount: number; include_escalated: boolean }): string {
  return `
SELECT *
FROM cdm_tmforum.revenue_assurance.prioritize_partner_disputes(
  ${opts.top_n},
  ${opts.min_amount},
  ${opts.include_escalated ? 'TRUE' : 'FALSE'}
)
`;
}

// Summary — aggregate headline from the silver view.
const SUMMARY_SQL = `
SELECT
  COUNT(*) AS total_records,
  COUNT(*) FILTER (WHERE is_actionable = TRUE) AS actionable_count,
  COALESCE(SUM(CASE WHEN is_actionable THEN amount_at_risk ELSE 0 END), 0) AS actionable_amount,
  COUNT(DISTINCT partner_party_role_id) AS partners_affected
FROM cdm_tmforum.revenue_assurance.silver_partner_settlement_reconciliation
`;

// ── Route setup ──────────────────────────────────────────────────────────────

export function setupPartnerSettlementRoutes(appkit: AppKitWithAnalytics) {
  appkit.server.extend((app) => {
    // Partner settlement reconciliation detail.
    // GET /api/partner-settlement/reconcile?partner_id=123&severity_filter=CRITICAL&limit=50
    app.get('/api/partner-settlement/reconcile', async (req, res) => {
      const parsed = ReconcileQuery.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid partner settlement parameters' });
        return;
      }
      try {
        const { partner_id, settlement_type, severity_filter, min_amount, limit } = parsed.data;
        const query = reconcileSql({
          partner_id,
          settlement_type: settlement_type ?? '',
          severity_filter: severity_filter ?? '',
          min_amount,
          limit,
        });
        const warehouseResult = await appkit.analytics.query(query);
        const rows = resultRows(warehouseResult).map((r) => ({
          rev_share_reconciliation_id: numberValue(r[0]),
          partner_party_role_id: numberValue(r[1]),
          operator_billed_amount: numberValue(r[2]),
          partner_reported_amount: numberValue(r[3]),
          variance_amount: numberValue(r[4]),
          variance_percentage: numberValue(r[5]),
          recon_status: stringValue(r[6]),
          settlement_type: stringValue(r[7]),
          settlement_severity: stringValue(r[8]),
          amount_at_risk: numberValue(r[9]),
          discrepancy_count: numberValue(r[10]),
          open_discrepancies: numberValue(r[11]),
          root_causes: Array.isArray(r[12]) ? (r[12] as string[]) : [],
          has_sla_breach: numberValue(r[13]) > 0,
          has_escalation: numberValue(r[14]) > 0,
          total_gross_revenue: numberValue(r[15]),
          avg_split_pct: numberValue(r[16]),
          resolution_deadline_date: stringValue(r[17]),
          recommended_action: stringValue(r[18]),
        }));
        res.json(rows);
      } catch (err) {
        console.error('[partner-settlement] reconcile failed:', err);
        res.status(500).json({ error: 'Failed to reconcile partner settlement' });
      }
    });

    // Partner dispute prioritization — ROI-ranked partner list.
    // GET /api/partner-settlement/disputes?top_n=25&min_amount=1000
    app.get('/api/partner-settlement/disputes', async (req, res) => {
      const parsed = DisputeQuery.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid dispute priority parameters' });
        return;
      }
      try {
        const { top_n, min_amount, include_escalated } = parsed.data;
        const query = disputesSql({ top_n, min_amount, include_escalated });
        const warehouseResult = await appkit.analytics.query(query);
        const rows = resultRows(warehouseResult).map((r) => ({
          partner_party_role_id: numberValue(r[0]),
          total_reconciliations: numberValue(r[1]),
          actionable_recons: numberValue(r[2]),
          actionable_amount_at_risk: numberValue(r[3]),
          total_open_discrepancies: numberValue(r[4]),
          avg_variance_pct: numberValue(r[5]),
          worst_severity: stringValue(r[6]),
          any_sla_breach: numberValue(r[7]) > 0,
          any_escalation: numberValue(r[8]) > 0,
          settlement_types: Array.isArray(r[9]) ? (r[9] as string[]) : [],
          recovery_priority_score: numberValue(r[10]),
          dispute_strategy: stringValue(r[11]),
        }));
        res.json(rows);
      } catch (err) {
        console.error('[partner-settlement] disputes failed:', err);
        res.status(500).json({ error: 'Failed to prioritize partner disputes' });
      }
    });

    // Partner settlement summary — headline metrics.
    // GET /api/partner-settlement/summary
    app.get('/api/partner-settlement/summary', async (_req, res) => {
      try {
        const warehouseResult = await appkit.analytics.query(SUMMARY_SQL);
        const rows = resultRows(warehouseResult);
        const row = rows[0] ?? [];
        res.json({
          total_records: numberValue(row[0]),
          actionable_count: numberValue(row[1]),
          actionable_amount: numberValue(row[2]),
          partners_affected: numberValue(row[3]),
        });
      } catch (err) {
        console.error('[partner-settlement] summary failed:', err);
        res.status(500).json({ error: 'Failed to load partner settlement summary' });
      }
    });
  });
}
