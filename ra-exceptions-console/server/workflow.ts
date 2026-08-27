import { sql } from '@databricks/appkit';
import { createHash } from 'node:crypto';

export const STATUSES = ['New', 'Investigating', 'Recovering', 'Recovered', 'WrittenOff'] as const;
export type Status = (typeof STATUSES)[number];

export const TRANSITIONS: Record<Status, Status[]> = {
  New: ['Investigating', 'WrittenOff'],
  Investigating: ['Recovering', 'WrittenOff'],
  Recovering: ['Recovered', 'WrittenOff'],
  Recovered: [],
  WrittenOff: [],
};

export function hasVersionConflict(expectedVersion: number, currentVersion: unknown) {
  return expectedVersion !== Number(currentVersion);
}

export const WORKFLOW_TABLE = 'cdm_tmforum.revenue_assurance.workflow_case_state';
export const EXCEPTION_VIEW = 'cdm_tmforum.revenue_assurance.gold_exception_workflow';

// The only fields that may ever feed the canonical exception id: which check
// flagged it, which source system/table it came from, and that source's own
// immutable record key. Mutable/derived values (amount_at_risk, customer_id,
// account_name) must never appear here — they can be corrected or re-scored
// without the exception's identity changing underneath an open case.
export const CANONICAL_EXCEPTION_ID_FIELDS = ['check_type', 'source_table', 'reference_id'] as const;

export const CANONICAL_EXCEPTION_ID_SQL = `md5(concat_ws('|', check_type, source_table, coalesce(reference_id, '')))`;

export const CREATE_WORKFLOW_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS ${WORKFLOW_TABLE} (
  exception_id STRING NOT NULL,
  status STRING NOT NULL,
  assignee STRING,
  version BIGINT NOT NULL,
  latest_note STRING,
  latest_note_author STRING,
  note_count BIGINT NOT NULL,
  updated_at TIMESTAMP NOT NULL,
  projected_at TIMESTAMP NOT NULL
) USING DELTA
`;

export const CREATE_EXCEPTION_VIEW_SQL = `
CREATE OR REPLACE VIEW ${EXCEPTION_VIEW} AS
WITH exceptions AS (
  SELECT ${CANONICAL_EXCEPTION_ID_SQL} AS exception_id, source.*
  FROM cdm_tmforum.revenue_assurance.gold_leakage_summary source
)
SELECT
  exceptions.*,
  coalesce(workflow.status, 'New') AS status,
  workflow.assignee,
  coalesce(workflow.version, 0) AS case_version,
  workflow.latest_note,
  workflow.latest_note_author,
  coalesce(workflow.note_count, 0) AS note_count,
  workflow.updated_at AS case_updated_at
FROM exceptions
LEFT JOIN ${WORKFLOW_TABLE} workflow USING (exception_id)
`;

export type SqlParam = ReturnType<(typeof sql)[keyof typeof sql]>;

export interface AnalyticsClient {
  query(text: string, params?: Record<string, SqlParam>): Promise<{ data_array?: unknown[][] }>;
}

export interface LakebaseClient {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
  pool: {
    connect(): Promise<{
      query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
      release(): void;
    }>;
  };
}

function textValue(value: unknown) {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value instanceof Date
    ? String(value)
    : '';
}

/**
 * JS mirror of CANONICAL_EXCEPTION_ID_SQL — md5(concat_ws('|', check_type, source_table, coalesce(reference_id, ''))).
 * Spark's concat_ws skips NULL arguments entirely (not just empty-strings them), so a
 * missing check_type/source_table drops out of the joined string rather than becoming ''.
 * reference_id is coalesced to '' in the SQL, so it is always kept.
 */
export function canonicalExceptionId(record: { check_type?: unknown; source_table?: unknown; reference_id?: unknown }) {
  const parts = [record.check_type, record.source_table]
    .filter((value) => value !== null && value !== undefined)
    .map((value) => textValue(value));
  parts.push(textValue(record.reference_id ?? ''));
  return createHash('md5').update(parts.join('|')).digest('hex');
}

export async function ensureWorkflowSchema(lakebase: LakebaseClient) {
  await lakebase.query('CREATE SCHEMA IF NOT EXISTS ra');
  await lakebase.query(`
    CREATE TABLE IF NOT EXISTS ra.cases (
      exception_id TEXT PRIMARY KEY,
      reference_id TEXT,
      account_name TEXT,
      check_type TEXT,
      source_table TEXT,
      severity TEXT,
      amount_at_risk DOUBLE PRECISION,
      status TEXT NOT NULL DEFAULT 'New' CHECK (status IN ('New','Investigating','Recovering','Recovered','WrittenOff')),
      assignee TEXT,
      version BIGINT NOT NULL DEFAULT 0,
      identity_status TEXT NOT NULL DEFAULT 'canonical',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await lakebase.query('ALTER TABLE ra.cases ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 0');
  await lakebase.query(
    "ALTER TABLE ra.cases ADD COLUMN IF NOT EXISTS identity_status TEXT NOT NULL DEFAULT 'canonical'"
  );
  // source_table is part of the immutable identity triple (check_type, source_table, reference_id).
  // Rows created before this column existed have it NULL; reconcileCaseIdentities falls back to a
  // check_type+reference_id match for those instead of the direct canonical-hash comparison.
  await lakebase.query('ALTER TABLE ra.cases ADD COLUMN IF NOT EXISTS source_table TEXT');
  await lakebase.query(`
    CREATE TABLE IF NOT EXISTS ra.workflow_runtime_state (
      singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
      revision BIGINT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await lakebase.query(
    'INSERT INTO ra.workflow_runtime_state(singleton) VALUES(TRUE) ON CONFLICT(singleton) DO NOTHING'
  );
  await lakebase.query(`
    CREATE TABLE IF NOT EXISTS ra.case_notes (
      id BIGSERIAL PRIMARY KEY,
      exception_id TEXT NOT NULL REFERENCES ra.cases(exception_id) ON DELETE CASCADE,
      author TEXT,
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await lakebase.query(`
    CREATE TABLE IF NOT EXISTS ra.workflow_outbox (
      id BIGSERIAL PRIMARY KEY,
      exception_id TEXT NOT NULL,
      version BIGINT NOT NULL,
      status TEXT NOT NULL,
      assignee TEXT,
      latest_note TEXT,
      latest_note_author TEXT,
      note_count BIGINT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      projected_at TIMESTAMPTZ,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      UNIQUE(exception_id, version)
    )
  `);
  await lakebase.query(`
    CREATE TABLE IF NOT EXISTS ra.case_identity_aliases (
      legacy_exception_id TEXT PRIMARY KEY,
      canonical_exception_id TEXT NOT NULL,
      migrated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

interface IdentityRecord {
  exception_id: string;
  reference_id?: unknown;
  check_type?: unknown;
  source_table?: unknown;
}

function hasSourceTable(record: IdentityRecord) {
  return record.source_table != null && textValue(record.source_table).trim() !== '';
}

/**
 * Fallback match key for legacy Lakebase rows created before source_table was captured
 * (so the direct canonical-hash comparison isn't possible for them yet). Built only from
 * immutable fields — check_type and the source system's own reference_id — never
 * amount_at_risk, account_name, or any other value that can drift after a case is opened.
 */
export function identityMatchKey(record: { reference_id?: unknown; check_type?: unknown }) {
  return [record.check_type, record.reference_id].map((value) => textValue(value).trim().toLowerCase()).join('|');
}

export async function bumpWorkflowRevision(client: {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}) {
  const { rows } = await client.query(
    'UPDATE ra.workflow_runtime_state SET revision=revision+1, updated_at=NOW() WHERE singleton=TRUE RETURNING revision'
  );
  return Number(rows[0]?.revision ?? 0);
}

export function planIdentityReconciliation(cases: IdentityRecord[], canonicalRows: IdentityRecord[]) {
  const canonicalIds = new Set(canonicalRows.map((row) => row.exception_id));
  const casesById = new Set(cases.map((row) => row.exception_id));
  const fallbackMatches = new Map<string, string[]>();
  for (const row of canonicalRows) {
    const key = identityMatchKey(row);
    fallbackMatches.set(key, [...(fallbackMatches.get(key) ?? []), row.exception_id]);
  }
  const migrations: { legacyId: string; canonicalId: string }[] = [];
  const orphaned: string[] = [];
  for (const row of cases) {
    if (canonicalIds.has(row.exception_id)) continue;

    if (hasSourceTable(row)) {
      // Immutable identity is fully known — the canonical id is a pure function of it, so
      // recomputing and comparing is exact. No ambiguity is possible: two different source
      // rows never legitimately share (check_type, source_table, reference_id).
      const computed = canonicalExceptionId(row);
      if (canonicalIds.has(computed) && !casesById.has(computed)) {
        migrations.push({ legacyId: row.exception_id, canonicalId: computed });
      } else {
        orphaned.push(row.exception_id);
      }
      continue;
    }

    // Pre-migration legacy row with no source_table on file: best-effort match on the
    // remaining immutable fields. Ambiguous or unmatched rows are orphaned, never guessed.
    const candidates = fallbackMatches.get(identityMatchKey(row)) ?? [];
    if (candidates.length === 1 && !casesById.has(candidates[0]))
      migrations.push({ legacyId: row.exception_id, canonicalId: candidates[0] });
    else orphaned.push(row.exception_id);
  }
  return { migrations, orphaned };
}

export async function reconcileCaseIdentities(analytics: AnalyticsClient, lakebase: LakebaseClient) {
  const { rows: cases } = await lakebase.query(
    'SELECT exception_id, reference_id, check_type, source_table FROM ra.cases'
  );
  if (cases.length === 0) return { migrations: 0, orphaned: 0, backfilled: 0 };
  const warehouse = await analytics.query(
    `SELECT exception_id, reference_id, check_type, source_table FROM ${EXCEPTION_VIEW}`
  );
  const canonicalRows = (warehouse.data_array ?? []).map((row) => ({
    exception_id: String(row[0]),
    reference_id: row[1],
    check_type: row[2],
    source_table: row[3],
  }));
  const caseRecords: IdentityRecord[] = cases
    .filter((row) => typeof row.exception_id === 'string')
    .map((row) => ({
      exception_id: row.exception_id as string,
      reference_id: row.reference_id,
      check_type: row.check_type,
      source_table: row.source_table,
    }));
  const plan = planIdentityReconciliation(caseRecords, canonicalRows);
  for (const migration of plan.migrations) {
    const canonicalSourceTable = canonicalRows.find((row) => row.exception_id === migration.canonicalId)?.source_table;
    await withTransaction(lakebase, async (client) => {
      await client.query(
        `INSERT INTO ra.cases (exception_id,reference_id,account_name,check_type,severity,amount_at_risk,status,assignee,version,identity_status,source_table,created_at,updated_at)
         SELECT $2,reference_id,account_name,check_type,severity,amount_at_risk,status,assignee,version+1,'canonical',COALESCE(source_table,$3),created_at,NOW()
         FROM ra.cases WHERE exception_id=$1`,
        [migration.legacyId, migration.canonicalId, canonicalSourceTable ?? null]
      );
      await client.query('UPDATE ra.case_notes SET exception_id=$2 WHERE exception_id=$1', [
        migration.legacyId,
        migration.canonicalId,
      ]);
      await client.query('DELETE FROM ra.cases WHERE exception_id=$1', [migration.legacyId]);
      await client.query(
        'INSERT INTO ra.case_identity_aliases(legacy_exception_id,canonical_exception_id) VALUES($1,$2) ON CONFLICT(legacy_exception_id) DO UPDATE SET canonical_exception_id=EXCLUDED.canonical_exception_id,migrated_at=NOW()',
        [migration.legacyId, migration.canonicalId]
      );
      await enqueueSnapshot(client, migration.canonicalId);
      await bumpWorkflowRevision(client);
    });
    await analytics.query(`DELETE FROM ${WORKFLOW_TABLE} WHERE exception_id = :legacy_id`, {
      legacy_id: sql.string(migration.legacyId),
    });
  }
  if (plan.orphaned.length) {
    await withTransaction(lakebase, async (client) => {
      const result = await client.query(
        "UPDATE ra.cases SET identity_status='orphaned' WHERE exception_id = ANY($1::text[]) AND identity_status <> 'orphaned' RETURNING exception_id",
        [plan.orphaned]
      );
      if (result.rows.length) await bumpWorkflowRevision(client);
    });
  }
  const missingSources = canonicalRows.filter((canonical) => {
    const current = caseRecords.find((row) => row.exception_id === canonical.exception_id);
    return current && !hasSourceTable(current) && hasSourceTable(canonical);
  });
  if (missingSources.length) {
    await withTransaction(lakebase, async (client) => {
      for (const row of missingSources)
        await client.query(
          "UPDATE ra.cases SET source_table=$2, identity_status='canonical' WHERE exception_id=$1 AND (source_table IS NULL OR btrim(source_table)='')",
          [row.exception_id, textValue(row.source_table)]
        );
    });
  }
  const backfilled = await backfillProjection(analytics, lakebase);
  return { migrations: plan.migrations.length, orphaned: plan.orphaned.length, backfilled };
}

/**
 * Anti-entropy pass: compares each already-canonical Lakebase case's version against the
 * Delta projection's version and re-queues a snapshot for anything missing or stale. This is
 * what guarantees a fresh deployment (or one that skipped flushes) eventually converges —
 * unlike the outbox-driven flush, this does not depend on an exception_id having *changed*.
 */
export async function backfillProjection(
  analytics: AnalyticsClient,
  lakebase: LakebaseClient
) {
  const projected = await analytics.query(`SELECT exception_id, version FROM ${WORKFLOW_TABLE}`);
  const projectedVersion = new Map<string, number>();
  for (const row of projected.data_array ?? []) projectedVersion.set(String(row[0]), Number(row[1] ?? 0));

  const { rows: currentCases } = await lakebase.query('SELECT exception_id, version FROM ra.cases');
  const stale = currentCases.filter((row) => {
    const id = String(row.exception_id);
    const liveVersion = Number(row.version ?? 0);
    const projectedAt = projectedVersion.get(id);
    return projectedAt === undefined || projectedAt < liveVersion;
  });
  if (stale.length === 0) return 0;

  await withTransaction(lakebase, async (client) => {
    for (const row of stale) await enqueueSnapshot(client, String(row.exception_id));
  });
  return stale.length;
}

export async function enqueueSnapshot(
  client: { query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> },
  exceptionId: string
) {
  await client.query(
    `INSERT INTO ra.workflow_outbox
       (exception_id, version, status, assignee, latest_note, latest_note_author, note_count, updated_at)
     SELECT c.exception_id, c.version, c.status, c.assignee, n.body, n.author,
            (SELECT COUNT(*) FROM ra.case_notes all_notes WHERE all_notes.exception_id = c.exception_id), c.updated_at
     FROM ra.cases c
     LEFT JOIN LATERAL (
       SELECT body, author FROM ra.case_notes WHERE exception_id = c.exception_id ORDER BY created_at DESC, id DESC LIMIT 1
     ) n ON TRUE
     WHERE c.exception_id = $1
     ON CONFLICT (exception_id, version) DO UPDATE SET
       status=EXCLUDED.status, assignee=EXCLUDED.assignee, latest_note=EXCLUDED.latest_note,
       latest_note_author=EXCLUDED.latest_note_author, note_count=EXCLUDED.note_count,
       updated_at=EXCLUDED.updated_at, projected_at=NULL, attempts=0, last_error=NULL`,
    [exceptionId]
  );
}

export async function withTransaction<T>(
  lakebase: LakebaseClient,
  operation: (client: Awaited<ReturnType<LakebaseClient['pool']['connect']>>) => Promise<T>
) {
  const client = await lakebase.pool.connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export const RECONCILIATION_INTERVAL_MS = 5 * 60 * 1000;
export const INIT_RETRY_INTERVAL_MS = 30 * 1000;
export const FLUSH_INTERVAL_MS = 30 * 1000;

export function createProjection(analytics: AnalyticsClient, lakebase: LakebaseClient) {
  let running: Promise<void> | null = null;
  let initializing: Promise<void> | null = null;
  let reconciling: Promise<{ migrations: number; orphaned: number; backfilled: number }> | null = null;
  let ready = false;
  let stopped = false;
  let initializationError: string | null = null;
  let lastFlushError: string | null = null;
  let lastReconciliationError: string | null = null;
  let lastFlushAt: Date | null = null;
  let lastFlushAttemptAt: Date | null = null;
  let lastFlushResult: { processed: number; succeeded: number; failed: number } | null = null;
  let lastReconciliationAt: Date | null = null;
  let lastReconciliationAttemptAt: Date | null = null;
  let lastReconciliationResult: { migrations: number; orphaned: number; backfilled: number } | null = null;
  let reconciliationTimer: ReturnType<typeof setInterval> | null = null;
  let flushTimer: ReturnType<typeof setInterval> | null = null;
  let initRetryTimer: ReturnType<typeof setTimeout> | null = null;

  async function runReconciliation() {
    if (reconciling) return reconciling;
    lastReconciliationAttemptAt = new Date();
    reconciling = reconcileCaseIdentities(analytics, lakebase)
      .then((result) => {
        lastReconciliationAt = new Date();
        lastReconciliationResult = result;
        lastReconciliationError = null;
        return result;
      })
      .catch((error) => {
        lastReconciliationError = error instanceof Error ? error.message : String(error);
        throw error;
      })
      .finally(() => {
        reconciling = null;
      });
    return reconciling;
  }

  function scheduleReconciliationTimer() {
    if (reconciliationTimer) return;
    reconciliationTimer = setInterval(() => {
      runReconciliation().catch((error) => {
        console.error('[workflow-projection] scheduled reconciliation failed:', error);
      });
    }, RECONCILIATION_INTERVAL_MS);
    reconciliationTimer.unref?.();
  }

  function scheduleFlushTimer() {
    if (flushTimer) return;
    flushTimer = setInterval(() => {
      flush().catch((error) => {
        console.error('[workflow-projection] scheduled flush failed:', error);
      });
    }, FLUSH_INTERVAL_MS);
    flushTimer.unref?.();
  }

  // Idempotent setup (CREATE TABLE/VIEW IF NOT EXISTS, plus reconciliation, which is itself
  // safe to re-run) means a failed attempt can simply be retried on a timer rather than
  // requiring a process restart. Once ready, the retry loop stops scheduling itself.
  function initialize() {
    if (stopped || ready) return Promise.resolve();
    if (initializing) return initializing;
    initializing = (async () => {
      try {
        await ensureWorkflowSchema(lakebase);
        await analytics.query(CREATE_WORKFLOW_TABLE_SQL);
        await analytics.query(CREATE_EXCEPTION_VIEW_SQL);
        const reconciliation = await runReconciliation();
        await flush();
        ready = true;
        initializationError = null;
        if (initRetryTimer) {
          clearTimeout(initRetryTimer);
          initRetryTimer = null;
        }
        console.log('[workflow-projection] ready:', reconciliation);
        scheduleReconciliationTimer();
        scheduleFlushTimer();
      } catch (error) {
        ready = false;
        initializationError = error instanceof Error ? error.message : String(error);
        console.error('[workflow-projection] initialization failed; retrying:', error);
        if (!stopped && !initRetryTimer) {
          initRetryTimer = setTimeout(() => {
            initRetryTimer = null;
            void initialize();
          }, INIT_RETRY_INTERVAL_MS);
          initRetryTimer.unref?.();
        }
      }
    })().finally(() => {
      initializing = null;
    });
    return initializing;
  }

  async function flushInternal() {
    lastFlushAttemptAt = new Date();
    const { rows } = await lakebase.query(
      `SELECT * FROM ra.workflow_outbox WHERE projected_at IS NULL ORDER BY id LIMIT 100`
    );
    const result = { processed: rows.length, succeeded: 0, failed: 0 };
    for (const row of rows) {
      try {
        const params: Record<string, SqlParam> = {
          exception_id: sql.string(textValue(row.exception_id)),
          status: sql.string(textValue(row.status)),
          assignee: sql.string(row.assignee == null ? '' : textValue(row.assignee)),
          version: sql.bigint(Number(row.version)),
          latest_note: sql.string(row.latest_note == null ? '' : textValue(row.latest_note)),
          latest_note_author: sql.string(row.latest_note_author == null ? '' : textValue(row.latest_note_author)),
          note_count: sql.bigint(Number(row.note_count)),
          updated_at: sql.timestamp(textValue(row.updated_at)),
        };
        const assigneeExpr = row.assignee == null ? 'NULL' : ':assignee';
        const noteExpr = row.latest_note == null ? 'NULL' : ':latest_note';
        const noteAuthorExpr = row.latest_note_author == null ? 'NULL' : ':latest_note_author';
        await analytics.query(
          `MERGE INTO ${WORKFLOW_TABLE} target
          USING (SELECT :exception_id AS exception_id) source
          ON target.exception_id = source.exception_id
          WHEN MATCHED AND target.version <= :version THEN UPDATE SET
            status = :status, assignee = ${assigneeExpr}, version = :version,
            latest_note = ${noteExpr}, latest_note_author = ${noteAuthorExpr},
            note_count = :note_count, updated_at = CAST(:updated_at AS TIMESTAMP), projected_at = current_timestamp()
          WHEN NOT MATCHED THEN INSERT (exception_id, status, assignee, version, latest_note, latest_note_author, note_count, updated_at, projected_at)
          VALUES (:exception_id, :status, ${assigneeExpr}, :version,
            ${noteExpr}, ${noteAuthorExpr}, :note_count,
            CAST(:updated_at AS TIMESTAMP), current_timestamp())`,
          params
        );
        await lakebase.query('UPDATE ra.workflow_outbox SET projected_at = NOW(), last_error = NULL WHERE id = $1', [
          row.id,
        ]);
        result.succeeded += 1;
      } catch (error) {
        result.failed += 1;
        lastFlushError = error instanceof Error ? error.message : String(error);
        await lakebase.query('UPDATE ra.workflow_outbox SET attempts = attempts + 1, last_error = $2 WHERE id = $1', [
          row.id,
          error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000),
        ]);
        console.error('[workflow-projection] event failed:', row.id, error);
      }
    }
    lastFlushAt = new Date();
    lastFlushResult = result;
    if (result.failed === 0) lastFlushError = null;
  }

  function flush() {
    if (!running)
      running = flushInternal()
        .catch((error) => {
          lastFlushError = error instanceof Error ? error.message : String(error);
          throw error;
        })
        .finally(() => (running = null));
    return running;
  }

  async function health() {
    let storageError: string | null = null;
    let pending = 0;
    let maxAttempts = 0;
    let revision = 0;
    let revisionUpdatedAt: unknown = null;
    try {
      const { rows } = await lakebase.query(
        `SELECT
          (SELECT COUNT(*)::int FROM ra.workflow_outbox WHERE projected_at IS NULL) pending,
          (SELECT COALESCE(MAX(attempts),0)::int FROM ra.workflow_outbox WHERE projected_at IS NULL) max_attempts,
          revision, updated_at
         FROM ra.workflow_runtime_state WHERE singleton=TRUE`
      );
      pending = Number(rows[0]?.pending ?? 0);
      maxAttempts = Number(rows[0]?.max_attempts ?? 0);
      revision = Number(rows[0]?.revision ?? 0);
      revisionUpdatedAt = rows[0]?.updated_at ?? null;
    } catch (error) {
      storageError = error instanceof Error ? error.message : String(error);
    }
    return {
      ready,
      lastError: initializationError ?? lastReconciliationError ?? lastFlushError ?? storageError,
      initializationError,
      lastReconciliationError,
      lastFlushError,
      pending,
      maxAttempts,
      revision,
      revisionUpdatedAt,
      reconciling: reconciling !== null,
      initializing: initializing !== null,
      lastFlushAt,
      lastFlushAttemptAt,
      lastFlushResult,
      lastReconciliationAt,
      lastReconciliationAttemptAt,
      lastReconciliationResult,
    };
  }

  function stop() {
    stopped = true;
    if (reconciliationTimer) {
      clearInterval(reconciliationTimer);
      reconciliationTimer = null;
    }
    if (flushTimer) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
    if (initRetryTimer) {
      clearTimeout(initRetryTimer);
      initRetryTimer = null;
    }
  }

  return { initialize, flush, health, stop, runReconciliation };
}
