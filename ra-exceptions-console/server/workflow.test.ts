import {
  CANONICAL_EXCEPTION_ID_SQL,
  FLUSH_INTERVAL_MS,
  INIT_RETRY_INTERVAL_MS,
  RECONCILIATION_INTERVAL_MS,
  backfillProjection,
  bumpWorkflowRevision,
  canonicalExceptionId,
  createProjection,
  hasVersionConflict,
  identityMatchKey,
  planIdentityReconciliation,
  withTransaction,
  type AnalyticsClient,
  type LakebaseClient,
  type SqlParam,
} from './workflow';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function fakeLakebase(fail = false) {
  const statements: string[] = [];
  let released = false;
  const query = (text: string) => {
    statements.push(text);
    if (fail && text === 'work') throw new Error('note insert failed');
    return Promise.resolve({ rows: [] });
  };
  const client = {
    query,
    release() {
      released = true;
    },
  };
  const lakebase: LakebaseClient = {
    query,
    pool: {
      connect() {
        return Promise.resolve(client);
      },
    },
  };
  return { lakebase, statements, wasReleased: () => released };
}

function fakeAnalytics() {
  const calls: { text: string; params?: Record<string, SqlParam> }[] = [];
  const analytics: AnalyticsClient = {
    query(text: string, params?: Record<string, SqlParam>) {
      calls.push({ text, params });
      return Promise.resolve({ data_array: [] });
    },
  };
  return { analytics, calls };
}

describe('workflow transactions', () => {
  it('commits status-plus-note work on one client', async () => {
    const fake = fakeLakebase();
    await withTransaction(fake.lakebase, async (client) => {
      await client.query('work');
    });
    expect(fake.statements).toEqual(['BEGIN', 'work', 'COMMIT']);
    expect(fake.wasReleased()).toBe(true);
  });

  it('rolls back the whole mutation when note work fails', async () => {
    const fake = fakeLakebase(true);
    await expect(withTransaction(fake.lakebase, async (client) => client.query('work'))).rejects.toThrow(
      'note insert failed'
    );
    expect(fake.statements).toEqual(['BEGIN', 'work', 'ROLLBACK']);
    expect(fake.wasReleased()).toBe(true);
  });

  it('increments the shared workflow revision atomically', async () => {
    const statements: string[] = [];
    const revision = await bumpWorkflowRevision({
      query(text: string) {
        statements.push(text);
        return Promise.resolve({ rows: [{ revision: 7 }] });
      },
    });
    expect(revision).toBe(7);
    expect(statements[0]).toContain('revision=revision+1');
  });
});

describe('canonical identity reconciliation', () => {
  it('keeps exact JS and SQL parity for the immutable identity triple', () => {
    expect(CANONICAL_EXCEPTION_ID_SQL).toBe(
      "md5(concat_ws('|', check_type, source_table, coalesce(reference_id, '')))"
    );
    expect(
      canonicalExceptionId({ check_type: 'PRICE', source_table: 'billing.invoice', reference_id: 'INV-1' })
    ).toBe('236c2537fdee486ab0f97da1f00cb448');
  });

  it('migrates uniquely matched legacy rows without using mutable fields', () => {
    const metadata = { reference_id: 'INV-1', account_name: 'Acme', check_type: 'PRICE', amount_at_risk: 12.5 };
    expect(identityMatchKey(metadata)).toBe('price|inv-1');
    expect(
      planIdentityReconciliation(
        [{ exception_id: 'legacy', ...metadata }],
        [{ exception_id: 'canonical', ...metadata }]
      )
    ).toEqual({ migrations: [{ legacyId: 'legacy', canonicalId: 'canonical' }], orphaned: [] });
  });

  it('marks ambiguous or unmatched cases orphaned instead of guessing', () => {
    const row = {
      exception_id: 'legacy',
      reference_id: 'INV-1',
      account_name: 'Acme',
      check_type: 'PRICE',
      amount_at_risk: 12.5,
    };
    expect(planIdentityReconciliation([row], [])).toEqual({ migrations: [], orphaned: ['legacy'] });
  });

  it('matches despite amount_at_risk drift (stable identity)', () => {
    const legacy = { exception_id: 'leg', reference_id: 'INV-1', account_name: 'Acme', check_type: 'PRICE', amount_at_risk: 12.5 };
    const canonical = { exception_id: 'can', reference_id: 'INV-1', account_name: 'Acme', check_type: 'PRICE', amount_at_risk: 99.99 };
    expect(planIdentityReconciliation([legacy], [canonical])).toEqual({
      migrations: [{ legacyId: 'leg', canonicalId: 'can' }],
      orphaned: [],
    });
  });

  it('identity key excludes volatile financial fields', () => {
    const base = { reference_id: 'X', account_name: 'Y', check_type: 'Z' };
    const lowRisk = { ...base, source_table: 'invoice', amount_at_risk: 100 };
    const highRisk = { ...base, source_table: 'invoice', amount_at_risk: 999 };
    expect(identityMatchKey(base)).toBe(identityMatchKey({ ...base }));
    expect(canonicalExceptionId(lowRisk)).toBe(canonicalExceptionId(highRisk));
  });
});

describe('projection anti-entropy', () => {
  it('requeues every case missing from or newer than the Delta workflow table', async () => {
    const queued: string[] = [];
    const analytics: AnalyticsClient = {
      query() {
        return Promise.resolve({ data_array: [['fresh', 2], ['stale', 1]] });
      },
    };
    const lakebase: LakebaseClient = {
      query(text: string) {
        if (text === 'SELECT exception_id, version FROM ra.cases')
          return Promise.resolve({
            rows: [
              { exception_id: 'missing', version: 0 },
              { exception_id: 'stale', version: 3 },
              { exception_id: 'fresh', version: 2 },
            ],
          });
        return Promise.resolve({ rows: [] });
      },
      pool: {
        connect: () =>
          Promise.resolve({
            query(text: string, params?: unknown[]) {
              if (text.includes('INSERT INTO ra.workflow_outbox')) queued.push(String(params?.[0]));
              return Promise.resolve({ rows: [] });
            },
            release() {},
          }),
      },
    };
    await expect(backfillProjection(analytics, lakebase)).resolves.toBe(2);
    expect(queued).toEqual(['missing', 'stale']);
  });

  it('reopens a previously projected outbox version for repair', async () => {
    const fake = fakeLakebase();
    const { enqueueSnapshot } = await import('./workflow');
    await enqueueSnapshot(fake.lakebase, 'case-id');
    expect(fake.statements.join('\n')).toContain('projected_at=NULL');
    expect(fake.statements.join('\n')).toContain('attempts=0');
  });
});

it('detects actionable optimistic-concurrency conflicts', () => {
  expect(hasVersionConflict(3, 4)).toBe(true);
  expect(hasVersionConflict(4, '4')).toBe(false);
});

describe('flushInternal SQL injection prevention', () => {
  it('uses parameter binding instead of string interpolation for user-controlled values', async () => {
    const { analytics, calls } = fakeAnalytics();
    const outboxRow = {
      id: 1,
      exception_id: "'; DROP TABLE workflow_case_state; --",
      status: "New'; DELETE FROM ra.cases; --",
      assignee: null,
      version: 1,
      latest_note: "Robert'); DROP TABLE ra.cases;--",
      latest_note_author: "Bobby Tables",
      note_count: 1,
      updated_at: '2024-01-01T00:00:00Z',
    };
    const lakebaseStatements: string[] = [];
    const lakebase: LakebaseClient = {
      query(text: string) {
        lakebaseStatements.push(text);
        if (text.includes('workflow_outbox WHERE projected_at IS NULL'))
          return Promise.resolve({ rows: [outboxRow] });
        if (text.includes('COUNT(*)'))
          return Promise.resolve({ rows: [{ pending: 0, max_attempts: 0 }] });
        return Promise.resolve({ rows: [] });
      },
      pool: { connect: () => Promise.resolve({ query: () => Promise.resolve({ rows: [] }), release: () => {} }) },
    };
    const projection = createProjection(analytics, lakebase);
    await projection.flush();
    expect(calls).toHaveLength(1);
    const mergeCall = calls[0];
    expect(mergeCall.text).toContain(':exception_id');
    expect(mergeCall.text).toContain(':status');
    expect(mergeCall.text).toContain(':version');
    expect(mergeCall.text).not.toContain("'; DROP TABLE");
    expect(mergeCall.text).not.toContain("Bobby Tables");
    expect(mergeCall.params?.exception_id).toEqual(expect.objectContaining({ value: "'; DROP TABLE workflow_case_state; --" }));
    expect(mergeCall.params?.status).toEqual(expect.objectContaining({ value: "New'; DELETE FROM ra.cases; --" }));
    expect(mergeCall.params?.latest_note).toEqual(expect.objectContaining({ value: "Robert'); DROP TABLE ra.cases;--" }));
    expect(mergeCall.params?.latest_note_author).toEqual(expect.objectContaining({ value: "Bobby Tables" }));
    projection.stop();
  });

  it('handles null assignee and note fields with SQL NULL literal', async () => {
    const { analytics, calls } = fakeAnalytics();
    const outboxRow = {
      id: 2,
      exception_id: 'exc-1',
      status: 'New',
      assignee: null,
      version: 0,
      latest_note: null,
      latest_note_author: null,
      note_count: 0,
      updated_at: '2024-06-01T12:00:00Z',
    };
    const lakebase: LakebaseClient = {
      query(text: string) {
        if (text.includes('workflow_outbox WHERE projected_at IS NULL'))
          return Promise.resolve({ rows: [outboxRow] });
        return Promise.resolve({ rows: [] });
      },
      pool: { connect: () => Promise.resolve({ query: () => Promise.resolve({ rows: [] }), release: () => {} }) },
    };
    const projection = createProjection(analytics, lakebase);
    await projection.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain('assignee = NULL');
    expect(calls[0].text).toContain('latest_note = NULL');
    expect(calls[0].text).toContain('latest_note_author = NULL');
    projection.stop();
  });

  it('never embeds raw values for strings containing SQL metacharacters', async () => {
    const { analytics, calls } = fakeAnalytics();
    const adversarial = "test' OR '1'='1";
    const outboxRow = {
      id: 3,
      exception_id: adversarial,
      status: adversarial,
      assignee: adversarial,
      version: 5,
      latest_note: adversarial,
      latest_note_author: adversarial,
      note_count: 2,
      updated_at: '2024-01-01T00:00:00Z',
    };
    const lakebase: LakebaseClient = {
      query(text: string) {
        if (text.includes('workflow_outbox WHERE projected_at IS NULL'))
          return Promise.resolve({ rows: [outboxRow] });
        return Promise.resolve({ rows: [] });
      },
      pool: { connect: () => Promise.resolve({ query: () => Promise.resolve({ rows: [] }), release: () => {} }) },
    };
    const projection = createProjection(analytics, lakebase);
    await projection.flush();
    const sql = calls[0].text;
    expect(sql).not.toContain(adversarial);
    expect(sql).not.toContain("'1'='1");
    projection.stop();
  });
});

describe('recurrent reconciliation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function lakebaseWithCases(): LakebaseClient {
    return {
      query(text: string) {
        if (text.includes('FROM ra.cases'))
          return Promise.resolve({ rows: [{ exception_id: 'x', reference_id: 'r', account_name: 'a', check_type: 't', amount_at_risk: 1 }] });
        if (text.includes('FROM ra.workflow_runtime_state'))
          return Promise.resolve({ rows: [{ pending: 0, max_attempts: 0, revision: 4, updated_at: 'now' }] });
        return Promise.resolve({ rows: [] });
      },
      pool: { connect: () => Promise.resolve({ query: () => Promise.resolve({ rows: [] }), release: () => {} }) },
    };
  }

  it('runs reconciliation on a timer after initialization', async () => {
    let reconcileCount = 0;
    const analytics: AnalyticsClient = {
      query(text: string) {
        if (text.includes(`FROM cdm_tmforum.revenue_assurance.gold_exception_workflow`)) reconcileCount++;
        return Promise.resolve({ data_array: [] });
      },
    };
    const lakebase = lakebaseWithCases();
    const projection = createProjection(analytics, lakebase);
    await projection.initialize();
    expect(reconcileCount).toBe(1);
    await vi.advanceTimersByTimeAsync(RECONCILIATION_INTERVAL_MS);
    expect(reconcileCount).toBe(2);
    projection.stop();
  });

  it('prevents overlapping reconciliation runs', async () => {
    let resolveReconcile: () => void = () => {};
    let callCount = 0;
    const slowAnalytics: AnalyticsClient = {
      query(text: string) {
        if (text.includes(`FROM cdm_tmforum.revenue_assurance.gold_exception_workflow`)) {
          callCount++;
          return new Promise((resolve) => {
            resolveReconcile = () => resolve({ data_array: [] });
          });
        }
        return Promise.resolve({ data_array: [] });
      },
    };
    const lakebase = lakebaseWithCases();
    const projection = createProjection(slowAnalytics, lakebase);
    const first = projection.runReconciliation();
    await Promise.resolve();
    const second = projection.runReconciliation();
    expect(callCount).toBe(1);
    resolveReconcile();
    await first;
    await second;
    projection.stop();
  });

  it('captures errors from scheduled reconciliation without crashing', async () => {
    let queryCount = 0;
    const failingAnalytics: AnalyticsClient = {
      query(text: string) {
        if (text.includes(`FROM cdm_tmforum.revenue_assurance.gold_exception_workflow`)) {
          queryCount++;
          if (queryCount > 1) return Promise.reject(new Error('warehouse timeout'));
        }
        return Promise.resolve({ data_array: [] });
      },
    };
    const lakebase = lakebaseWithCases();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const projection = createProjection(failingAnalytics, lakebase);
    await projection.initialize();
    expect(queryCount).toBe(1);
    await vi.advanceTimersByTimeAsync(RECONCILIATION_INTERVAL_MS);
    const health = await projection.health();
    expect(health.lastError).toContain('warehouse timeout');
    expect(health.ready).toBe(true);
    projection.stop();
  });

  it('retries initialization and reports recovered health', async () => {
    let setupAttempts = 0;
    const analytics: AnalyticsClient = {
      query(text: string) {
        if (text.includes('CREATE TABLE')) {
          setupAttempts += 1;
          if (setupAttempts === 1) return Promise.reject(new Error('warehouse unavailable'));
        }
        return Promise.resolve({ data_array: [] });
      },
    };
    const lakebase = lakebaseWithCases();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const projection = createProjection(analytics, lakebase);
    await projection.initialize();
    expect((await projection.health()).ready).toBe(false);
    await vi.advanceTimersByTimeAsync(INIT_RETRY_INTERVAL_MS);
    const health = await projection.health();
    expect(setupAttempts).toBe(2);
    expect(health.ready).toBe(true);
    expect(health.lastFlushAt).toBeInstanceOf(Date);
    expect(health.lastFlushAttemptAt).toBeInstanceOf(Date);
    expect(health.lastReconciliationAt).toBeInstanceOf(Date);
    expect(health.lastReconciliationAttemptAt).toBeInstanceOf(Date);
    expect(health.revision).toBe(4);
    projection.stop();
  });

  it('stop() clears initialization, flush, and reconciliation timers', async () => {
    let reconcileCount = 0;
    let flushCount = 0;
    const analytics: AnalyticsClient = {
      query(text: string) {
        if (text.includes(`FROM cdm_tmforum.revenue_assurance.gold_exception_workflow`)) reconcileCount++;
        return Promise.resolve({ data_array: [] });
      },
    };
    const base = lakebaseWithCases();
    const lakebase: LakebaseClient = {
      ...base,
      query(text: string, params?: unknown[]) {
        if (text.includes('workflow_outbox WHERE projected_at IS NULL ORDER BY')) flushCount++;
        return base.query(text, params);
      },
    };
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const projection = createProjection(analytics, lakebase);
    await projection.initialize();
    expect(reconcileCount).toBe(1);
    expect(flushCount).toBe(1);
    projection.stop();
    await vi.advanceTimersByTimeAsync(Math.max(RECONCILIATION_INTERVAL_MS, FLUSH_INTERVAL_MS) * 3);
    expect(reconcileCount).toBe(1);
    expect(flushCount).toBe(1);
    consoleSpy.mockRestore();
  });
});
