import { describe, it, expect } from 'vitest';
import { validateSelectQuery } from '../utils/sqlValidation.js';

describe('validateSelectQuery', () => {
  it('allows SELECT on payslips', () => {
    expect(validateSelectQuery('SELECT * FROM payslips').valid).toBe(true);
  });

  it('allows SELECT on form106', () => {
    expect(validateSelectQuery('SELECT year, pdf_path FROM form106').valid).toBe(true);
  });

  it('blocks SELECT on credentials', () => {
    const result = validateSelectQuery('SELECT * FROM credentials');
    expect(result.valid).toBe(false);
  });

  it('blocks SELECT on sessions', () => {
    const result = validateSelectQuery('SELECT * FROM sessions');
    expect(result.valid).toBe(false);
  });

  it('blocks SELECT on tenants', () => {
    const result = validateSelectQuery('SELECT * FROM tenants');
    expect(result.valid).toBe(false);
  });

  it('blocks SELECT on sqlite_master', () => {
    const result = validateSelectQuery('SELECT * FROM sqlite_master');
    expect(result.valid).toBe(false);
  });

  it('blocks multi-statement queries', () => {
    const result = validateSelectQuery("SELECT * FROM payslips; DROP TABLE payslips;");
    expect(result.valid).toBe(false);
  });

  it('blocks non-SELECT statements', () => {
    const result = validateSelectQuery("DELETE FROM payslips");
    expect(result.valid).toBe(false);
  });

  it('blocks INSERT disguised via UNION from a joined disallowed table', () => {
    const result = validateSelectQuery('SELECT * FROM payslips UNION SELECT * FROM credentials');
    expect(result.valid).toBe(false);
  });

  it('allows PRAGMA table_info on an allowed table', () => {
    expect(validateSelectQuery('PRAGMA table_info(payslips)').valid).toBe(true);
  });

  it('blocks PRAGMA table_info on credentials', () => {
    const result = validateSelectQuery('PRAGMA table_info(credentials)');
    expect(result.valid).toBe(false);
  });
});
