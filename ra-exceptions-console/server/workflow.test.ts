import {
  CANONICAL_EXCEPTION_ID_SQL,
  hasVersionConflict,
  identityMatchKey,
  planIdentityReconciliation,
  withTransaction,
  type LakebaseClient,
} from './workflow';
import { describe, expect, it } from 'vitest';

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
    expect(identityMatchKey(metadata as never)).toBe('inv-1|acme|price|12.500000');
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
});

it('detects actionable optimistic-concurrency conflicts', () => {
  expect(hasVersionConflict(3, 4)).toBe(true);
  expect(hasVersionConflict(4, '4')).toBe(false);
});
