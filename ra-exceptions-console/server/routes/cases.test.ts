import { describe, expect, it } from 'vitest';
import { canonicalExceptionId } from '../workflow';
import { ensureCase } from './cases';

describe('case creation identity metadata', () => {
  it('persists source_table on every new Lakebase case', async () => {
    const calls: { text: string; params?: unknown[] }[] = [];
    const meta = {
      reference_id: 'INV-1',
      account_name: 'Acme',
      check_type: 'PRICE',
      source_table: 'billing.invoice',
      severity: 'HIGH',
      amount_at_risk: 99,
    };
    const exceptionId = canonicalExceptionId(meta);
    const client = {
      query(text: string, params?: unknown[]) {
        calls.push({ text, params });
        return Promise.resolve({ rows: [] });
      },
    };

    await ensureCase(client, exceptionId, meta);

    const insert = calls.find((call) => call.text.includes('INSERT INTO ra.cases'));
    expect(insert?.text).toContain('source_table');
    expect(insert?.params).toEqual([exceptionId, 'INV-1', 'Acme', 'PRICE', 'billing.invoice', 'HIGH', 99]);
  });

  it('rejects new cases without complete canonical source metadata', async () => {
    const client = { query: () => Promise.resolve({ rows: [] }) };
    await expect(
      ensureCase(client, '236c2537fdee486ab0f97da1f00cb448', {
        reference_id: 'INV-1',
        check_type: 'PRICE',
      })
    ).rejects.toThrow('source_table');
  });
});
