import { sourceLabel } from './format';

describe('sourceLabel', () => {
  it('maps known source schemas to friendly names', () => {
    expect(sourceLabel('salesforce_source.accounts')).toBe('CRM (Salesforce)');
    expect(sourceLabel('oracle_erp_source.invoices')).toBe('ERP (Oracle)');
  });

  it('never leaks the raw schema.table for unknown sources', () => {
    const label = sourceLabel('some_other_schema.table');
    expect(label).toBe('Other source system');
    expect(label).not.toContain('some_other_schema');
    expect(label).not.toContain('.');
  });

  it('falls back to a generic label when empty or missing', () => {
    expect(sourceLabel('')).toBe('Unknown source system');
    expect(sourceLabel(null)).toBe('Unknown source system');
    expect(sourceLabel(undefined)).toBe('Unknown source system');
  });
});
