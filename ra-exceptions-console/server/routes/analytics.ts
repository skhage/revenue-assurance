import { sql } from '@databricks/appkit';
import { z } from 'zod';
import type { Application } from 'express';
import { resultRows, type WarehouseResult } from '../warehouse-result';

interface AppKitWithAnalyticsAndLakebase {
  analytics: {
    query(
      text: string,
      params?: Record<string, ReturnType<(typeof sql)['string']> | ReturnType<(typeof sql)['int']>>
    ): Promise<WarehouseResult>;
  };
  lakebase: {
    query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  };
  server: {
    extend(fn: (app: Application) => void): void;
  };
}

const QueueQuery = z.object({
  check_type: z.string().default('ALL'),
  severity: z.string().default('ALL'),
  search: z.string().default(''),
  row_limit: z.coerce.number().int().min(1).max(100).default(25),
  row_offset: z.coerce.number().int().min(0).default(0),
});

const EXCEPTION_ID_SQL = `md5(concat_ws('|', check_type, coalesce(reference_id, ''),
       coalesce(cast(customer_id AS string), ''), cast(amount_at_risk AS string)))`;

const QUEUE_SQL = `
SELECT
  ${EXCEPTION_ID_SQL} AS exception_id,
  reference_id,
  account_name,
  check_type,
  severity,
  amount_at_risk,
  detection_method,
  source_table,
  customer_id,
  known_leakage_flag
FROM cdm_tmforum.revenue_assurance.gold_leakage_summary
WHERE (:check_type = 'ALL' OR check_type = :check_type)
  AND (:severity = 'ALL' OR severity = :severity)
  AND (
        :search = ''
     OR lower(coalesce(account_name, '')) LIKE '%' || lower(:search) || '%'
     OR lower(coalesce(reference_id, '')) LIKE '%' || lower(:search) || '%'
  )
ORDER BY amount_at_risk DESC
LIMIT :row_limit OFFSET :row_offset
`;

function numberValue(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function booleanValue(value: unknown): boolean {
  return value === true || value === 'true';
}

function stringValue(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
}

export function setupAnalyticsRoutes(appkit: AppKitWithAnalyticsAndLakebase) {
  appkit.server.extend((app) => {
    app.get('/api/analytics/exceptions', async (req, res) => {
      const parsed = QueueQuery.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid queue filters' });
        return;
      }

      try {
        const filters = parsed.data;
        const warehouseResult = await appkit.analytics.query(QUEUE_SQL, {
          check_type: sql.string(filters.check_type),
          severity: sql.string(filters.severity),
          search: sql.string(filters.search),
          row_limit: sql.int(filters.row_limit),
          row_offset: sql.int(filters.row_offset),
        });

        const rows = resultRows(warehouseResult).map((row) => ({
          exception_id: stringValue(row[0]),
          reference_id: stringValue(row[1]),
          account_name: stringValue(row[2]),
          check_type: stringValue(row[3]),
          severity: stringValue(row[4]),
          amount_at_risk: numberValue(row[5]),
          detection_method: stringValue(row[6]),
          source_table: stringValue(row[7]),
          customer_id: numberValue(row[8]),
          known_leakage_flag: booleanValue(row[9]),
          status: 'New',
          assignee: null as string | null,
        }));

        if (rows.length === 0) {
          res.json([]);
          return;
        }

        const { rows: caseRows } = await appkit.lakebase.query(
          `SELECT exception_id, status, assignee
           FROM ra.cases
           WHERE exception_id = ANY($1::text[])`,
          [rows.map((row) => row.exception_id)]
        );
        const caseState = new Map(caseRows.map((row) => [String(row.exception_id), row]));

        res.json(
          rows.map((row) => {
            const state = caseState.get(row.exception_id);
            return {
              ...row,
              status: state ? stringValue(state.status) : 'New',
              assignee: state?.assignee == null ? null : stringValue(state.assignee),
            };
          })
        );
      } catch (err) {
        console.error('[analytics] exception queue failed:', err);
        res.status(500).json({ error: 'Failed to load the exception queue' });
      }
    });

    app.get('/api/analytics/kpis', async (_req, res) => {
      try {
        const { rows: terminalCases } = await appkit.lakebase.query(
          `SELECT exception_id, status, recovered_amount FROM ra.cases WHERE status IN ('Recovered', 'WrittenOff')`
        );
        const terminalIds = terminalCases
          .map((row) => String(row.exception_id))
          .filter((id) => /^[a-f0-9]{32}$/.test(id));
        const recoveredCases = terminalCases.filter((row) => row.status === 'Recovered');
        const recoveredAmount = recoveredCases.reduce((sum, row) => sum + numberValue(row.recovered_amount), 0);
        const openPredicate =
          terminalIds.length === 0 ? 'TRUE' : `exception_id NOT IN (${terminalIds.map((id) => `'${id}'`).join(', ')})`;

        const warehouseResult = await appkit.analytics.query(`
          WITH exceptions AS (
            SELECT
              ${EXCEPTION_ID_SQL} AS exception_id,
              severity,
              amount_at_risk,
              account_name
            FROM cdm_tmforum.revenue_assurance.gold_leakage_summary
          )
          SELECT
            COUNT(*) FILTER (WHERE ${openPredicate}) AS open_exceptions,
            COALESCE(SUM(amount_at_risk), 0) AS total_at_risk,
            COUNT(*) FILTER (WHERE severity = 'HIGH') AS high_severity,
            COUNT(DISTINCT account_name) AS accounts_affected
          FROM exceptions
        `);
        const row = resultRows(warehouseResult)[0] ?? [];

        res.json({
          open_exceptions: numberValue(row[0]),
          total_at_risk: numberValue(row[1]),
          high_severity: numberValue(row[2]),
          accounts_affected: numberValue(row[3]),
          recovered_amount: recoveredAmount,
          recovered_count: recoveredCases.length,
        });
      } catch (err) {
        console.error('[analytics] KPI merge failed:', err);
        res.status(500).json({ error: 'Failed to load KPI summary' });
      }
    });
  });
}
