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

/** A raw warehouse row in the exact column order parseDqAuditRows expects. */
function rawRow(
  overrides: Partial<{
    check_type: unknown;
    dataset: unknown;
    expectation_name: unknown;
    update_id: unknown;
    observed_at: unknown;
    observed_records: unknown;
    passed_records: unknown;
    failed_records: unknown;
    status: unknown;
    expected_condition: unknown;
  }> = {}
): unknown[] {
  const base = {
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
    ...overrides,
  };
  return [
    base.check_type,
    base.dataset,
    base.expectation_name,
    base.update_id,
    base.observed_at,
    base.observed_records,
    base.passed_records,
    base.failed_records,
    base.status,
    base.expected_condition,
  ];
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

describe('parseDqAuditRows — happy path', () => {
  it('parses a well-formed GREEN row into typed objects', () => {
    const parsed = parseDqAuditRows([rawRow()]);
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

  it('parses a well-formed RED row (failed_records > 0) as RED', () => {
    const parsed = parseDqAuditRows([
      rawRow({ status: 'RED', passed_records: 10, failed_records: 5, observed_records: 15 }),
    ]);
    expect(parsed[0].status).toBe('RED');
  });
});

describe('parseDqAuditRows — fails closed on unknown/malformed/inconsistent status', () => {
  it('treats a null status as failing, never GREEN', () => {
    const parsed = parseDqAuditRows([rawRow({ status: null })]);
    expect(parsed[0].status).toBe('RED');
  });

  it('treats an empty-string status as failing, never GREEN', () => {
    const parsed = parseDqAuditRows([rawRow({ status: '' })]);
    expect(parsed[0].status).toBe('RED');
  });

  it('treats an unrecognized status string as failing, never GREEN', () => {
    const parsed = parseDqAuditRows([rawRow({ status: 'YELLOW' })]);
    expect(parsed[0].status).toBe('RED');
  });

  it('treats a lowercase "green" as failing — no case-insensitive matching', () => {
    const parsed = parseDqAuditRows([rawRow({ status: 'green' })]);
    expect(parsed[0].status).toBe('RED');
  });

  it('treats a numeric status as failing, never GREEN', () => {
    const parsed = parseDqAuditRows([rawRow({ status: 1 })]);
    expect(parsed[0].status).toBe('RED');
  });

  it('treats a boolean status as failing, never GREEN', () => {
    const parsed = parseDqAuditRows([rawRow({ status: true })]);
    expect(parsed[0].status).toBe('RED');
  });

  it('treats missing observed_records as failing even when status says GREEN', () => {
    const parsed = parseDqAuditRows([rawRow({ observed_records: null })]);
    expect(parsed[0].status).toBe('RED');
  });

  it('treats missing passed_records as failing even when status says GREEN', () => {
    const parsed = parseDqAuditRows([rawRow({ passed_records: undefined })]);
    expect(parsed[0].status).toBe('RED');
  });

  it('treats missing failed_records as failing even when status says GREEN', () => {
    const parsed = parseDqAuditRows([rawRow({ failed_records: null })]);
    expect(parsed[0].status).toBe('RED');
  });

  it('treats an unparseable count string as failing even when status says GREEN', () => {
    const parsed = parseDqAuditRows([rawRow({ observed_records: 'not-a-number' })]);
    expect(parsed[0].status).toBe('RED');
  });

  it('treats a negative count as failing even when status says GREEN', () => {
    const parsed = parseDqAuditRows([rawRow({ failed_records: -1, observed_records: 99 })]);
    expect(parsed[0].status).toBe('RED');
  });

  it('treats failed_records > 0 as failing even when status claims GREEN (status/count mismatch)', () => {
    const parsed = parseDqAuditRows([
      rawRow({ status: 'GREEN', failed_records: 3, passed_records: 97, observed_records: 100 }),
    ]);
    expect(parsed[0].status).toBe('RED');
  });

  it('treats an internally inconsistent row as failing (passed+failed != observed) even when status says GREEN', () => {
    const parsed = parseDqAuditRows([
      rawRow({ status: 'GREEN', passed_records: 90, failed_records: 0, observed_records: 100 }),
    ]);
    expect(parsed[0].status).toBe('RED');
  });

  it('a single malformed row does not corrupt sibling rows in the same batch', () => {
    const parsed = parseDqAuditRows([rawRow({ status: null }), rawRow({ dataset: 'other.dataset' })]);
    expect(parsed[0].status).toBe('RED');
    expect(parsed[1].status).toBe('GREEN');
  });
});

describe('end-to-end: a malformed/unknown-status row blocks the whole pipeline via summarizePipelineHealth', () => {
  it('a single null-status row among otherwise-GREEN rows forces state=red', () => {
    const rows = parseDqAuditRows([rawRow(), rawRow({ status: null, dataset: 'oracle_erp_source.gl_je_lines' })]);
    const health = summarizePipelineHealth(rows);
    expect(health.state).toBe('red');
    expect(health.reason).toContain('oracle_erp_source.gl_je_lines');
  });

  it('an unrecognized status string among otherwise-GREEN rows forces state=red', () => {
    const rows = parseDqAuditRows([rawRow({ status: 'UNKNOWN' })]);
    const health = summarizePipelineHealth(rows);
    expect(health.state).toBe('red');
  });
});
