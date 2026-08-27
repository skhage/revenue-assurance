import { mergeCanonicalStates, summarizeOpenRows } from './analytics';
import { expect, it } from 'vitest';

it('overlays Lakebase state before queue and KPI calculations', () => {
  const rows = [
    { exception_id: 'a', status: 'New', severity: 'HIGH', amount_at_risk: 100, account_name: 'A' },
    { exception_id: 'b', status: 'New', severity: 'MEDIUM', amount_at_risk: 50, account_name: 'B' },
  ];
  const merged = mergeCanonicalStates(rows, [
    { exception_id: 'a', status: 'Recovered', assignee: 'owner@example.com', version: 2 },
  ]);
  expect(merged[0]).toMatchObject({ status: 'Recovered', assignee: 'owner@example.com', case_version: 2 });
  expect(summarizeOpenRows(merged)).toEqual({
    open_exceptions: 1,
    total_at_risk: 50,
    high_severity: 0,
    accounts_affected: 1,
  });
});
