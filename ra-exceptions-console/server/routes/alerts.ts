// Alerts routes — proxies the 3 UC predictive alerting functions via the SQL warehouse.
//
// UC functions (built by @ai-engineer, RA-AI-PREDICTIVE-BUILD):
//   1. detect_emerging_leakage — customer risk profiles with CRITICAL/ELEVATED/WATCH signals
//   2. generate_leakage_alert  — structured alert payloads by type and severity
//   3. proactive_risk_scan     — system-wide health scan with trend signals

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

const EmergingLeakageQuery = z.object({
  customer_id: z.coerce.number().int().optional(),
  min_composite_score: z.coerce.number().min(0).default(1.0),
});

const LeakageAlertQuery = z.object({
  alert_type: z.enum(['ANOMALY_SPIKE', 'FORECAST_BREACH', 'CONCENTRATION_RISK', 'ALL']).default('ALL'),
  severity_floor: z.enum(['CRITICAL', 'ELEVATED', 'WATCH']).default('CRITICAL'),
});

const RiskScanQuery = z.object({
  check_type: z.string().optional(),
  risk_tier: z.string().optional(),
});

// ── SQL templates ────────────────────────────────────────────────────────────

const EMERGING_LEAKAGE_SQL = `
SELECT *
FROM cdm_tmforum.revenue_assurance.detect_emerging_leakage(
  :p_customer_id,
  :p_min_composite_score
)
`;

const LEAKAGE_ALERT_SQL = `
SELECT *
FROM cdm_tmforum.revenue_assurance.generate_leakage_alert(
  :p_alert_type,
  :p_severity_floor
)
`;

const RISK_SCAN_SQL = `
SELECT *
FROM cdm_tmforum.revenue_assurance.proactive_risk_scan(
  :p_check_type,
  :p_risk_tier
)
`;

// Alert badge — count of CRITICAL signals for the header badge.
const CRITICAL_COUNT_SQL = `
SELECT
  COUNT(*) AS critical_count,
  COALESCE(SUM(total_amount_at_risk), 0) AS critical_amount
FROM cdm_tmforum.revenue_assurance.detect_emerging_leakage(NULL, 1.0)
WHERE emerging_risk_signal = 'CRITICAL'
`;

// ── Route setup ──────────────────────────────────────────────────────────────

export function setupAlertRoutes(appkit: AppKitWithAnalytics) {
  appkit.server.extend((app) => {
    // Emerging leakage — customer risk profiles with signal levels.
    // GET /api/alerts/emerging?customer_id=123&min_composite_score=1.0
    app.get('/api/alerts/emerging', async (req, res) => {
      const parsed = EmergingLeakageQuery.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid emerging leakage parameters' });
        return;
      }
      try {
        const { customer_id, min_composite_score } = parsed.data;
        const warehouseResult = await appkit.analytics.query(EMERGING_LEAKAGE_SQL, {
          p_customer_id: sql.int(customer_id ?? 0),
          p_min_composite_score: sql.int(Math.round(min_composite_score * 100)),
        });
        const rows = resultRows(warehouseResult).map((r) => ({
          customer_id: numberValue(r[0]),
          account_name: stringValue(r[1]),
          risk_tier: stringValue(r[2]),
          composite_health_score: numberValue(r[3]),
          total_exceptions: numberValue(r[4]),
          total_amount_at_risk: numberValue(r[5]),
          high_priority_count: numberValue(r[6]),
          dominant_check_type: stringValue(r[7]),
          max_anomaly_score: numberValue(r[8]),
          avg_anomaly_score: numberValue(r[9]),
          anomaly_concentration: numberValue(r[10]),
          emerging_risk_signal: stringValue(r[11]),
          risk_rationale: stringValue(r[12]),
        }));
        res.json(rows);
      } catch (err) {
        console.error('[alerts] emerging leakage failed:', err);
        res.status(500).json({ error: 'Failed to detect emerging leakage' });
      }
    });

    // Leakage alerts — structured alert payloads by type and severity.
    // GET /api/alerts/leakage?alert_type=ALL&severity_floor=CRITICAL
    app.get('/api/alerts/leakage', async (req, res) => {
      const parsed = LeakageAlertQuery.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid alert parameters' });
        return;
      }
      try {
        const { alert_type, severity_floor } = parsed.data;
        const warehouseResult = await appkit.analytics.query(LEAKAGE_ALERT_SQL, {
          p_alert_type: sql.string(alert_type),
          p_severity_floor: sql.string(severity_floor),
        });
        const rows = resultRows(warehouseResult).map((r) => ({
          alert_id: stringValue(r[0]),
          alert_type: stringValue(r[1]),
          severity: stringValue(r[2]),
          title: stringValue(r[3]),
          description: stringValue(r[4]),
          affected_customers: numberValue(r[5]),
          total_amount_at_risk: numberValue(r[6]),
          recommended_action: stringValue(r[7]),
          data_source: stringValue(r[8]),
          generated_at: stringValue(r[9]),
        }));
        res.json(rows);
      } catch (err) {
        console.error('[alerts] leakage alerts failed:', err);
        res.status(500).json({ error: 'Failed to generate leakage alerts' });
      }
    });

    // Proactive risk scan — system-wide health metrics with trend signals.
    // GET /api/alerts/risk-scan?check_type=ar_collection_risk&risk_tier=RED
    app.get('/api/alerts/risk-scan', async (req, res) => {
      const parsed = RiskScanQuery.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid risk scan parameters' });
        return;
      }
      try {
        const { check_type, risk_tier } = parsed.data;
        const warehouseResult = await appkit.analytics.query(RISK_SCAN_SQL, {
          p_check_type: sql.string(check_type ?? ''),
          p_risk_tier: sql.string(risk_tier ?? ''),
        });
        const rows = resultRows(warehouseResult).map((r) => ({
          scan_category: stringValue(r[0]),
          metric_name: stringValue(r[1]),
          metric_value: numberValue(r[2]),
          trend_signal: stringValue(r[3]),
          detail: stringValue(r[4]),
        }));
        res.json(rows);
      } catch (err) {
        console.error('[alerts] risk scan failed:', err);
        res.status(500).json({ error: 'Failed to run proactive risk scan' });
      }
    });

    // Critical alert count — for the header alert badge.
    // GET /api/alerts/critical-summary
    app.get('/api/alerts/critical-summary', async (_req, res) => {
      try {
        const warehouseResult = await appkit.analytics.query(CRITICAL_COUNT_SQL);
        const rows = resultRows(warehouseResult);
        const row = rows[0] ?? [];
        res.json({
          critical_count: numberValue(row[0]),
          critical_amount: numberValue(row[1]),
        });
      } catch (err) {
        console.error('[alerts] critical summary failed:', err);
        res.status(500).json({ error: 'Failed to load critical alert summary' });
      }
    });
  });
}
