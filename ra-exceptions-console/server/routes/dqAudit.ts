// Pipeline-reliability read path: surfaces the freshness/quality signal that
// gates the Agent Workbench's downstream panels (Investigation, Prioritization,
// Recovery Playbook). Backed by `dq_audit`, a materialized view already
// produced by the reconciliation pipeline (reconciliation/pipelines/dq_audit.sql)
// — this route does not compute DQ itself, only reads and summarizes it.
//
// No named query + typegen here (contrast with analytics.ts's exceptions_list):
// `appkit generate-types` needs a live warehouse to introspect column types,
// which this route's inline-SQL sibling (QUEUE_SQL in analytics.ts) also avoids.

import type { Application } from 'express';

export interface DqAuditRow {
  check_type: string;
  dataset: string;
  expectation_name: string;
  update_id: string | null;
  observed_at: string | null;
  observed_records: number;
  passed_records: number;
  failed_records: number;
  status: 'GREEN' | 'RED';
  expected_condition: string;
}

export type PipelineState = 'unavailable' | 'red' | 'stale' | 'ok';

export interface PipelineHealth {
  state: PipelineState;
  reason: string;
  rows: DqAuditRow[];
  freshestObservedAt: string | null;
}

interface AppKitWithAnalytics {
  analytics: {
    query(text: string): Promise<{ data_array?: unknown[][] }>;
  };
  server: {
    extend(fn: (app: Application) => void): void;
  };
}

const DQ_AUDIT_SQL = `
SELECT
  check_type,
  dataset,
  expectation_name,
  update_id,
  CAST(observed_at AS STRING) AS observed_at,
  observed_records,
  passed_records,
  failed_records,
  status,
  expected_condition
FROM cdm_tmforum.revenue_assurance.dq_audit
ORDER BY observed_at DESC NULLS LAST
LIMIT 200
`;

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function stringValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/** Parses a count field, returning null (rather than defaulting to 0) when the value is missing or unparseable — a malformed count must be distinguishable from a legitimate zero so it can fail the row closed. */
function parseCount(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Resolves the true GREEN/RED status for a row, failing closed on anything
 * the warehouse sends that isn't an unambiguous, internally-consistent pass.
 * This is the only place status is decided — `parseDqAuditRows` and
 * `summarizePipelineHealth` both trust its output, so a bug here is a
 * silent false-GREEN, not a visible error. Fails closed (RED) when:
 *   - the raw status string is anything other than the exact literal
 *     'GREEN' (null, '', lowercase, 'RED', a number, an unrecognized
 *     string, etc. — there is no allowlist of "safe" alternatives);
 *   - any of observed/passed/failed_records is missing or unparseable;
 *   - any count is negative;
 *   - failed_records is nonzero (a real failure, regardless of what the
 *     status string claims); or
 *   - passed_records + failed_records doesn't reconcile with
 *     observed_records (an internally inconsistent row).
 */
function resolveStatus(
  rawStatus: unknown,
  observed: number | null,
  passed: number | null,
  failed: number | null
): 'GREEN' | 'RED' {
  if (rawStatus !== 'GREEN') return 'RED';
  if (observed === null || passed === null || failed === null) return 'RED';
  if (observed < 0 || passed < 0 || failed < 0) return 'RED';
  if (failed !== 0) return 'RED';
  if (passed + failed !== observed) return 'RED';
  return 'GREEN';
}

export function parseDqAuditRows(dataArray: unknown[][]): DqAuditRow[] {
  return dataArray.map((row) => {
    const observed = parseCount(row[5]);
    const passed = parseCount(row[6]);
    const failed = parseCount(row[7]);
    return {
      check_type: stringValue(row[0]),
      dataset: stringValue(row[1]),
      expectation_name: stringValue(row[2]),
      update_id: stringOrNull(row[3]),
      observed_at: stringOrNull(row[4]),
      observed_records: observed ?? 0,
      passed_records: passed ?? 0,
      failed_records: failed ?? 0,
      status: resolveStatus(row[8], observed, passed, failed),
      expected_condition: stringValue(row[9]),
    };
  });
}

/**
 * Pure summarization of dq_audit rows into a block/warn/ok signal for the
 * Agent Workbench. Kept free of any Express/AppKit dependency so it is
 * directly unit-testable (see dqAudit.test.ts) — the only logic in this file
 * that decides whether downstream agent panels are allowed to recommend.
 */
export function summarizePipelineHealth(rows: DqAuditRow[], staleThresholdHours = 72): PipelineHealth {
  if (rows.length === 0) {
    return { state: 'unavailable', reason: 'No pipeline DQ audit data is available.', rows, freshestObservedAt: null };
  }

  const redRows = rows.filter((r) => r.status === 'RED');
  const observedTimestamps = rows
    .map((r) => r.observed_at)
    .filter((v): v is string => v != null)
    .map((v) => new Date(v).getTime())
    .filter((t) => Number.isFinite(t));
  const freshestMs = observedTimestamps.length > 0 ? Math.max(...observedTimestamps) : null;
  const freshestObservedAt = freshestMs != null ? new Date(freshestMs).toISOString() : null;

  if (redRows.length > 0) {
    const names = redRows
      .map((r) => `${r.dataset}/${r.expectation_name}`)
      .slice(0, 3)
      .join(', ');
    return {
      state: 'red',
      reason: `${redRows.length} DQ check(s) are failing (${names}${redRows.length > 3 ? ', …' : ''}).`,
      rows,
      freshestObservedAt,
    };
  }

  if (freshestMs == null) {
    return {
      state: 'stale',
      reason: 'DQ checks are green but no observation timestamp is available to confirm freshness.',
      rows,
      freshestObservedAt: null,
    };
  }

  const ageHours = (Date.now() - freshestMs) / (1000 * 60 * 60);
  if (ageHours > staleThresholdHours) {
    return {
      state: 'stale',
      reason: `Freshest DQ observation is ${Math.round(ageHours)}h old (threshold ${staleThresholdHours}h).`,
      rows,
      freshestObservedAt,
    };
  }

  return { state: 'ok', reason: 'Pipeline DQ checks are green and fresh.', rows, freshestObservedAt };
}

export function setupDqAuditRoutes(appkit: AppKitWithAnalytics) {
  appkit.server.extend((app) => {
    app.get('/api/dq/audit', async (_req, res) => {
      try {
        const result = await appkit.analytics.query(DQ_AUDIT_SQL);
        const rows = parseDqAuditRows(result.data_array ?? []);
        res.json({ health: summarizePipelineHealth(rows) });
      } catch (err) {
        console.error('[dqAudit] query failed:', err);
        res.json({
          health: {
            state: 'unavailable',
            reason: 'Could not reach the pipeline DQ audit view.',
            rows: [],
            freshestObservedAt: null,
          } satisfies PipelineHealth,
        });
      }
    });
  });
}
