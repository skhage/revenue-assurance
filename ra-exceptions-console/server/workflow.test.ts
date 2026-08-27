import {
  CANONICAL_EXCEPTION_ID_SQL,
  RECONCILIATION_INTERVAL_MS,
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
});

describe('canonical identity reconciliation', () => {
  it('defines the hash once and migrates uniquely matched legacy rows', () => {
    expect(CANONICAL_EXCEPTION_ID_SQL.match(/md5/g)).toHaveLength(1);
    const metadata = { reference_id: 'INV-1', account_name: 'Acme', check_type: 'PRICE', amount_at_risk: 12.5 };
    expect(identityMatchKey(metadata as never)).toBe('inv-1|acme|price');
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
    expect(identityMatchKey({ exception_id: '1', ...base, amount_at_risk: 100 })).toBe(
      identityMatchKey({ exception_id: '2', ...base, amount_at_risk: 999 })
    );
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
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function lakebaseWithCases(): LakebaseClient {
    return {
      query(text: string) {
        if (text.includes('FROM ra.cases'))
          return Promise.resolve({ rows: [{ exception_id: 'x', reference_id: 'r', account_name: 'a', check_type: 't', amount_at_risk: 1 }] });
        if (text.includes('COUNT(*)'))
          return Promise.resolve({ rows: [{ pending: 0, max_attempts: 0 }] });
        return Promise.resolve({ rows: [] });
      },
      pool: { connect: () => Promise.resolve({ query: () => Promise.resolve({ rows: [] }), release: () => {} }) },
    };
  }

  it('runs reconciliation on a timer after initialization', async () => {
    let reconcileCount = 0;
    const analytics: AnalyticsClient = {
      query(text: string) {
        if (text.startsWith('SELECT exception_id')) reconcileCount++;
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
        if (text.startsWith('SELECT exception_id')) {
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
        if (text.startsWith('SELECT exception_id')) {
          queryCount++;
          if (queryCount > 1) return Promise.reject(new Error('warehouse timeout'));
        }
        return Promise.resolve({ data_array: [] });
      },
    };
    const lakebase = lakebaseWithCases();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const consoleLSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const projection = createProjection(failingAnalytics, lakebase);
    await projection.initialize();
    expect(queryCount).toBe(1);
    await vi.advanceTimersByTimeAsync(RECONCILIATION_INTERVAL_MS);
    const health = await projection.health();
    expect(health.lastError).toContain('warehouse timeout');
    expect(health.ready).toBe(true);
    projection.stop();
    consoleSpy.mockRestore();
    consoleLSpy.mockRestore();
  });

  it('stop() clears the reconciliation timer', async () => {
    let reconcileCount = 0;
    const analytics: AnalyticsClient = {
      query(text: string) {
        if (text.startsWith('SELECT exception_id')) reconcileCount++;
        return Promise.resolve({ data_array: [] });
      },
    };
    const lakebase = lakebaseWithCases();
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const projection = createProjection(analytics, lakebase);
    await projection.initialize();
    expect(reconcileCount).toBe(1);
    projection.stop();
    await vi.advanceTimersByTimeAsync(RECONCILIATION_INTERVAL_MS * 3);
    expect(reconcileCount).toBe(1);
    consoleSpy.mockRestore();
  });
});
