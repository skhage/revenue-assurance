import { sql } from '@databricks/appkit';

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

export const CANONICAL_EXCEPTION_ID_SQL = `md5(concat_ws('|', check_type, coalesce(reference_id, ''),
  coalesce(cast(customer_id AS string), ''), cast(amount_at_risk AS string)))`;

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

export interface AnalyticsClient {
  query(
    text: string,
    params?: Record<string, ReturnType<(typeof sql)['string']> | ReturnType<(typeof sql)['int']>>
  ): Promise<{ data_array?: unknown[][] }>;
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

const quote = (value: unknown) => `'${textValue(value).replace(/'/g, "''")}'`;
const nullable = (value: unknown) => (value == null ? 'NULL' : quote(value));

export async function ensureWorkflowSchema(lakebase: LakebaseClient) {
  await lakebase.query('CREATE SCHEMA IF NOT EXISTS ra');
  await lakebase.query(`
    CREATE TABLE IF NOT EXISTS ra.cases (
      exception_id TEXT PRIMARY KEY,
      reference_id TEXT,
      account_name TEXT,
      check_type TEXT,
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
  account_name?: unknown;
  check_type?: unknown;
  amount_at_risk?: unknown;
}

export function identityMatchKey(record: IdentityRecord) {
  return [record.reference_id, record.account_name, record.check_type, Number(record.amount_at_risk ?? 0).toFixed(6)]
    .map((value) => textValue(value).trim().toLowerCase())
    .join('|');
}

export function planIdentityReconciliation(cases: IdentityRecord[], canonicalRows: IdentityRecord[]) {
  const canonicalIds = new Set(canonicalRows.map((row) => row.exception_id));
  const casesById = new Set(cases.map((row) => row.exception_id));
  const matches = new Map<string, string[]>();
  for (const row of canonicalRows) {
    const key = identityMatchKey(row);
    matches.set(key, [...(matches.get(key) ?? []), row.exception_id]);
  }
  const migrations: { legacyId: string; canonicalId: string }[] = [];
  const orphaned: string[] = [];
  for (const row of cases) {
    if (canonicalIds.has(row.exception_id)) continue;
    const candidates = matches.get(identityMatchKey(row)) ?? [];
    if (candidates.length === 1 && !casesById.has(candidates[0]))
      migrations.push({ legacyId: row.exception_id, canonicalId: candidates[0] });
    else orphaned.push(row.exception_id);
  }
  return { migrations, orphaned };
}

export async function reconcileCaseIdentities(analytics: AnalyticsClient, lakebase: LakebaseClient) {
  const { rows: cases } = await lakebase.query(
    'SELECT exception_id, reference_id, account_name, check_type, amount_at_risk FROM ra.cases'
  );
  if (cases.length === 0) return { migrations: 0, orphaned: 0 };
  const warehouse = await analytics.query(
    `SELECT exception_id, reference_id, account_name, check_type, amount_at_risk FROM ${EXCEPTION_VIEW}`
  );
  const canonicalRows = (warehouse.data_array ?? []).map((row) => ({
    exception_id: String(row[0]),
    reference_id: row[1],
    account_name: row[2],
    check_type: row[3],
    amount_at_risk: row[4],
  }));
  const caseRecords: IdentityRecord[] = cases
    .filter((row) => typeof row.exception_id === 'string')
    .map((row) => ({
      exception_id: row.exception_id as string,
      reference_id: row.reference_id,
      account_name: row.account_name,
      check_type: row.check_type,
      amount_at_risk: row.amount_at_risk,
    }));
  const plan = planIdentityReconciliation(caseRecords, canonicalRows);
  for (const migration of plan.migrations) {
    await withTransaction(lakebase, async (client) => {
      await client.query(
        `INSERT INTO ra.cases (exception_id,reference_id,account_name,check_type,severity,amount_at_risk,status,assignee,version,identity_status,created_at,updated_at)
         SELECT $2,reference_id,account_name,check_type,severity,amount_at_risk,status,assignee,version+1,'canonical',created_at,NOW()
         FROM ra.cases WHERE exception_id=$1`,
        [migration.legacyId, migration.canonicalId]
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
    });
    await analytics.query(`DELETE FROM ${WORKFLOW_TABLE} WHERE exception_id = ${quote(migration.legacyId)}`);
  }
  if (plan.orphaned.length) {
    await lakebase.query("UPDATE ra.cases SET identity_status='orphaned' WHERE exception_id = ANY($1::text[])", [
      plan.orphaned,
    ]);
  }
  return { migrations: plan.migrations.length, orphaned: plan.orphaned.length };
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
     ON CONFLICT (exception_id, version) DO NOTHING`,
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

export function createProjection(analytics: AnalyticsClient, lakebase: LakebaseClient) {
  let running: Promise<void> | null = null;
  let ready = false;
  let lastError: string | null = null;

  async function initialize() {
    await ensureWorkflowSchema(lakebase);
    try {
      await analytics.query(CREATE_WORKFLOW_TABLE_SQL);
      await analytics.query(CREATE_EXCEPTION_VIEW_SQL);
      const reconciliation = await reconcileCaseIdentities(analytics, lakebase);
      ready = true;
      lastError = null;
      console.log('[workflow-projection] ready:', reconciliation);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      console.error('[workflow-projection] initialization failed; Lakebase writes remain queued:', error);
    }
  }

  async function flushInternal() {
    const { rows } = await lakebase.query(
      `SELECT * FROM ra.workflow_outbox WHERE projected_at IS NULL ORDER BY id LIMIT 100`
    );
    for (const row of rows) {
      try {
        await analytics.query(`
          MERGE INTO ${WORKFLOW_TABLE} target
          USING (SELECT ${quote(row.exception_id)} exception_id) source
          ON target.exception_id = source.exception_id
          WHEN MATCHED AND target.version <= ${Number(row.version)} THEN UPDATE SET
            status = ${quote(row.status)}, assignee = ${nullable(row.assignee)}, version = ${Number(row.version)},
            latest_note = ${nullable(row.latest_note)}, latest_note_author = ${nullable(row.latest_note_author)},
            note_count = ${Number(row.note_count)}, updated_at = CAST(${quote(row.updated_at)} AS TIMESTAMP), projected_at = current_timestamp()
          WHEN NOT MATCHED THEN INSERT (exception_id, status, assignee, version, latest_note, latest_note_author, note_count, updated_at, projected_at)
          VALUES (${quote(row.exception_id)}, ${quote(row.status)}, ${nullable(row.assignee)}, ${Number(row.version)},
            ${nullable(row.latest_note)}, ${nullable(row.latest_note_author)}, ${Number(row.note_count)},
            CAST(${quote(row.updated_at)} AS TIMESTAMP), current_timestamp())
        `);
        await lakebase.query('UPDATE ra.workflow_outbox SET projected_at = NOW(), last_error = NULL WHERE id = $1', [
          row.id,
        ]);
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        await lakebase.query('UPDATE ra.workflow_outbox SET attempts = attempts + 1, last_error = $2 WHERE id = $1', [
          row.id,
          error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000),
        ]);
        console.error('[workflow-projection] event failed:', row.id, error);
      }
    }
  }

  function flush() {
    if (!running) running = flushInternal().finally(() => (running = null));
    return running;
  }

  async function health() {
    const { rows } = await lakebase.query(
      'SELECT COUNT(*)::int pending, COALESCE(MAX(attempts),0)::int max_attempts FROM ra.workflow_outbox WHERE projected_at IS NULL'
    );
    return {
      ready,
      lastError,
      pending: Number(rows[0]?.pending ?? 0),
      maxAttempts: Number(rows[0]?.max_attempts ?? 0),
    };
  }

  return { initialize, flush, health };
}
