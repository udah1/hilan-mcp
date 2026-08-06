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

  // A naive `FROM <word>` regex misses all of these — they only ever
  // mention the disallowed table via JOIN, a comma-join, a quoted
  // identifier, or a subquery, never immediately after `FROM <bareword>`.
  it('blocks a JOIN against credentials', () => {
    const result = validateSelectQuery(
      'SELECT p.period, c.fields FROM payslips p JOIN credentials c ON p.tenant_subdomain = c.tenant_subdomain'
    );
    expect(result.valid).toBe(false);
  });

  it('blocks a JOIN against sessions', () => {
    const result = validateSelectQuery(
      'SELECT p.period, s.storage_state FROM payslips p JOIN sessions s ON p.tenant_subdomain = s.tenant_subdomain'
    );
    expect(result.valid).toBe(false);
  });

  it('blocks a comma-join against credentials', () => {
    const result = validateSelectQuery('SELECT * FROM payslips, credentials');
    expect(result.valid).toBe(false);
  });

  it('blocks a double-quoted table identifier', () => {
    const result = validateSelectQuery('SELECT * FROM "credentials"');
    expect(result.valid).toBe(false);
  });

  it('blocks a disallowed table referenced only inside a subquery', () => {
    const result = validateSelectQuery(
      'SELECT * FROM payslips WHERE tenant_subdomain IN (SELECT tenant_subdomain FROM sessions)'
    );
    expect(result.valid).toBe(false);
  });

  it('blocks a disallowed table referenced only inside a FROM-subquery', () => {
    const result = validateSelectQuery('SELECT * FROM (SELECT * FROM credentials) x');
    expect(result.valid).toBe(false);
  });

  it('allows PRAGMA index_list on an allowed table', () => {
    expect(validateSelectQuery('PRAGMA index_list(payslips)').valid).toBe(true);
  });

  it('blocks PRAGMA index_list on credentials', () => {
    const result = validateSelectQuery('PRAGMA index_list(credentials)');
    expect(result.valid).toBe(false);
  });

  it('blocks ATTACH DATABASE', () => {
    const result = validateSelectQuery("ATTACH DATABASE '/tmp/evil.db' AS evil");
    expect(result.valid).toBe(false);
  });

  it('blocks DETACH DATABASE', () => {
    const result = validateSelectQuery('DETACH DATABASE evil');
    expect(result.valid).toBe(false);
  });
});
