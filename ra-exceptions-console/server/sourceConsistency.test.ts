import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');

describe('canonical production sources', () => {
  it('routes dashboard and Genie exception reads through the workflow view', () => {
    const dashboard = readFileSync(
      resolve(root, 'Lakelink Fiber — Revenue Assurance Command Center.lvdash.json'),
      'utf8'
    );
    const genie = readFileSync(resolve(root, 'resources/revenue_assurance.geniespace.json'), 'utf8');
    expect(dashboard).toContain('cdm_tmforum.revenue_assurance.gold_exception_workflow');
    expect(genie).toContain('cdm_tmforum.revenue_assurance.gold_exception_workflow');
    expect(genie).not.toContain('"identifier": "cdm_tmforum.revenue_assurance.gold_leakage_summary"');
  });

  it('has removed duplicate queue and KPI SQL definitions', () => {
    for (const name of ['exceptions_list.sql', 'kpi_summary.sql', 'rootcause_breakdown.sql']) {
      expect(() => readFileSync(resolve(root, 'ra-exceptions-console/config/queries', name), 'utf8')).toThrow();
    }
  });
});
