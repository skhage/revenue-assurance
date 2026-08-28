import { sourceLabel } from './format';

describe('sourceLabel', () => {
  it('maps known source schemas to friendly names', () => {
    expect(sourceLabel('salesforce_source.accounts')).toBe('CRM (Salesforce)');
    expect(sourceLabel('oracle_erp_source.invoices')).toBe('ERP (Oracle)');
  });

  it('falls back to the raw value for unknown schemas', () => {
    expect(sourceLabel('some_other_schema.table')).toBe('some_other_schema.table');
  });

  it('falls back to Unknown when empty or missing', () => {
    expect(sourceLabel('')).toBe('Unknown');
    expect(sourceLabel(null)).toBe('Unknown');
    expect(sourceLabel(undefined)).toBe('Unknown');
  });
});
