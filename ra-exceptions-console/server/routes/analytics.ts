import { sql } from '@databricks/appkit';
import { z } from 'zod';
import type { Application } from 'express';
import { EXCEPTION_VIEW, type AnalyticsClient, type LakebaseClient } from '../workflow';

interface AppKitWithAnalyticsAndLakebase {
  analytics: AnalyticsClient;
  lakebase: LakebaseClient;
  server: { extend(fn: (app: Application) => void): void };
}

const QueueQuery = z.object({
  check_type: z.string().max(200).default('ALL'),
  severity: z.string().max(50).default('ALL'),
  search: z.string().max(500).default(''),
  row_limit: z.coerce.number().int().min(1).max(100).default(25),
  row_offset: z.coerce.number().int().min(0).default(0),
});

const QUEUE_SQL = `SELECT exception_id, reference_id, account_name, check_type, severity, amount_at_risk,
  detection_method, source_table, customer_id, known_leakage_flag, status, assignee, case_version
FROM ${EXCEPTION_VIEW}
WHERE (:check_type='ALL' OR check_type=:check_type) AND (:severity='ALL' OR severity=:severity)
AND (:search='' OR lower(coalesce(account_name,'')) LIKE '%' || lower(:search) || '%'
  OR lower(coalesce(reference_id,'')) LIKE '%' || lower(:search) || '%')
ORDER BY amount_at_risk DESC LIMIT :row_limit OFFSET :row_offset`;

const KPI_ROWS_SQL = `SELECT exception_id, severity, amount_at_risk, account_name, status FROM ${EXCEPTION_VIEW}`;

const numberValue = (value: unknown) => (Number.isFinite(Number(value ?? 0)) ? Number(value ?? 0) : 0);
const booleanValue = (value: unknown) => value === true || value === 'true';
const stringValue = (value: unknown) =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';

export function mergeCanonicalStates<
  T extends { exception_id: string; status: string; assignee?: string | null; case_version?: number },
>(rows: T[], states: Record<string, unknown>[]) {
  const byId = new Map(states.map((state) => [String(state.exception_id), state]));
  return rows.map((row) => {
    const state = byId.get(row.exception_id);
    return state
      ? {
          ...row,
          status: stringValue(state.status),
          assignee: state.assignee == null ? null : stringValue(state.assignee),
          case_version: numberValue(state.version),
        }
      : row;
  });
}

export function summarizeOpenRows(
  rows: { status: string; severity: string; amount_at_risk: number; account_name: string }[]
) {
  const open = rows.filter((row) => row.status !== 'Recovered' && row.status !== 'WrittenOff');
  return {
    open_exceptions: open.length,
    total_at_risk: open.reduce((sum, row) => sum + row.amount_at_risk, 0),
    high_severity: open.filter((row) => row.severity === 'HIGH').length,
    accounts_affected: new Set(open.map((row) => row.account_name).filter(Boolean)).size,
  };
}

export function setupAnalyticsRoutes(appkit: AppKitWithAnalyticsAndLakebase) {
  async function liveStates(exceptionIds?: string[]) {
    if (exceptionIds?.length === 0) return [];
    const result = await appkit.lakebase.query(
      `SELECT exception_id,status,assignee,version FROM ra.cases ${exceptionIds ? 'WHERE exception_id = ANY($1::text[])' : ''}`,
      exceptionIds ? [exceptionIds] : []
    );
    return result.rows;
  }

  appkit.server.extend((app) => {
    app.get('/api/analytics/exceptions', async (req, res) => {
      const parsed = QueueQuery.safeParse(req.query);
      if (!parsed.success) return void res.status(400).json({ error: 'Invalid queue filters' });
      try {
        const filters = parsed.data;
        const result = await appkit.analytics.query(QUEUE_SQL, {
          check_type: sql.string(filters.check_type),
          severity: sql.string(filters.severity),
          search: sql.string(filters.search),
          row_limit: sql.int(filters.row_limit),
          row_offset: sql.int(filters.row_offset),
        });
        const rows = (result.data_array ?? []).map((row) => ({
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
          status: stringValue(row[10]),
          assignee: row[11] == null ? null : stringValue(row[11]),
          case_version: numberValue(row[12]),
        }));
        res.json(mergeCanonicalStates(rows, await liveStates(rows.map((row) => row.exception_id))));
      } catch (error) {
        console.error('[analytics] exception queue failed:', error);
        res.status(500).json({ error: 'Failed to load the exception queue' });
      }
    });

    app.get('/api/analytics/kpis', async (_req, res) => {
      try {
        const result = await appkit.analytics.query(KPI_ROWS_SQL);
        const rows = (result.data_array ?? []).map((row) => ({
          exception_id: stringValue(row[0]),
          severity: stringValue(row[1]),
          amount_at_risk: numberValue(row[2]),
          account_name: stringValue(row[3]),
          status: stringValue(row[4]),
        }));
        res.json(summarizeOpenRows(mergeCanonicalStates(rows, await liveStates())));
      } catch (error) {
        console.error('[analytics] KPI merge failed:', error);
        res.status(500).json({ error: 'Failed to load KPI summary' });
      }
    });

    app.get('/api/analytics/root-causes', async (_req, res) => {
      try {
        const result = await appkit.analytics.query(
          `SELECT exception_id, check_type, amount_at_risk, status FROM ${EXCEPTION_VIEW}`
        );
        const rows = mergeCanonicalStates(
          (result.data_array ?? []).map((row) => ({
            exception_id: stringValue(row[0]),
            check_type: stringValue(row[1]),
            amount_at_risk: numberValue(row[2]),
            status: stringValue(row[3]),
          })),
          await liveStates()
        );
        const groups = new Map<string, { check_type: string; exception_count: number; amount_at_risk: number }>();
        for (const row of rows)
          if (row.status !== 'Recovered' && row.status !== 'WrittenOff') {
            const group = groups.get(row.check_type) ?? {
              check_type: row.check_type,
              exception_count: 0,
              amount_at_risk: 0,
            };
            group.exception_count += 1;
            group.amount_at_risk += row.amount_at_risk;
            groups.set(row.check_type, group);
          }
        res.json([...groups.values()].sort((a, b) => b.amount_at_risk - a.amount_at_risk));
      } catch (error) {
        console.error('[analytics] root causes failed:', error);
        res.status(500).json({ error: 'Failed to load root causes' });
      }
    });
  });
}
