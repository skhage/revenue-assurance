import { describe, it, expect } from 'vitest';
import { summarizePipelineHealth, parseDqAuditRows, type DqAuditRow } from './dqAudit';

function row(overrides: Partial<DqAuditRow> = {}): DqAuditRow {
  return {
    check_type: 'INLINE',
    dataset: 'salesforce_source.contract',
    expectation_name: 'dq1_source_row_count_in_expected_range',
    update_id: 'u1',
    observed_at: new Date().toISOString(),
    observed_records: 1000,
    passed_records: 1000,
    failed_records: 0,
    status: 'GREEN',
    expected_condition: 'row_count >= 10000',
    ...overrides,
  };
}

describe('summarizePipelineHealth', () => {
  it('reports unavailable when there are no rows', () => {
    const health = summarizePipelineHealth([]);
    expect(health.state).toBe('unavailable');
    expect(health.freshestObservedAt).toBeNull();
  });

  it('reports ok when all rows are GREEN and fresh', () => {
    const health = summarizePipelineHealth([row(), row({ dataset: 'salesforce_source.account' })]);
    expect(health.state).toBe('ok');
    expect(health.freshestObservedAt).not.toBeNull();
  });

  it('reports red when any row is RED, even if fresh', () => {
    const health = summarizePipelineHealth([row(), row({ status: 'RED', dataset: 'oracle_erp_source.gl_je_lines' })]);
    expect(health.state).toBe('red');
    expect(health.reason).toContain('oracle_erp_source.gl_je_lines');
  });

  it('reports stale when the freshest GREEN observation exceeds the threshold', () => {
    const old = new Date(Date.now() - 1000 * 60 * 60 * 100).toISOString(); // 100h old
    const health = summarizePipelineHealth([row({ observed_at: old })], 72);
    expect(health.state).toBe('stale');
    expect(health.reason).toMatch(/100h old/);
  });

  it('respects a custom stale threshold', () => {
    const old = new Date(Date.now() - 1000 * 60 * 60 * 10).toISOString(); // 10h old
    const fresh = summarizePipelineHealth([row({ observed_at: old })], 24);
    expect(fresh.state).toBe('ok');
    const stale = summarizePipelineHealth([row({ observed_at: old })], 5);
    expect(stale.state).toBe('stale');
  });

  it('reports stale when rows exist but no timestamp can be parsed', () => {
    const health = summarizePipelineHealth([row({ observed_at: null })]);
    expect(health.state).toBe('stale');
  });

  it('prioritizes red over stale when both conditions are present', () => {
    const old = new Date(Date.now() - 1000 * 60 * 60 * 100).toISOString();
    const health = summarizePipelineHealth([row({ observed_at: old, status: 'RED' })], 72);
    expect(health.state).toBe('red');
  });
});

describe('parseDqAuditRows', () => {
  it('parses warehouse data_array rows into typed objects', () => {
    const parsed = parseDqAuditRows([
      ['INLINE', 'salesforce_source.contract', 'dq1', 'u1', '2026-08-30T00:00:00Z', '100', '100', '0', 'GREEN', 'cond'],
    ]);
    expect(parsed).toEqual([
      {
        check_type: 'INLINE',
        dataset: 'salesforce_source.contract',
        expectation_name: 'dq1',
        update_id: 'u1',
        observed_at: '2026-08-30T00:00:00Z',
        observed_records: 100,
        passed_records: 100,
        failed_records: 0,
        status: 'GREEN',
        expected_condition: 'cond',
      },
    ]);
  });

  it('defaults an unrecognized status string to GREEN-safe-parsing (only RED is special-cased)', () => {
    const parsed = parseDqAuditRows([['DQ-1', 'ds', 'name', null, null, 10, 10, 0, 'RED', 'cond']]);
    expect(parsed[0].status).toBe('RED');
  });
});
