import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3-multiple-ciphers';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { computePeriodSort, getDbInstance, SQLiteDatabaseService } from '../services/DatabaseService.js';
import { encryptionKeyService } from '../services/EncryptionKeyService.js';

const TEST_KEY = 'test-key-not-a-real-secret';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hilan-mcp-salary-trends-'));
  encryptionKeyService.setKey(TEST_KEY);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('computePeriodSort', () => {
  it('parses a well-formed "MM_YYYY" key into a YYYYMM integer', () => {
    expect(computePeriodSort('07_2026')).toBe(202607);
    expect(computePeriodSort('01_2010')).toBe(201001);
  });

  it('sorts correctly across years, unlike plain text sorting of the period string', () => {
    const periods = ['01_2011', '02_2010', '12_2010', '01_2010'];
    const sorted = [...periods].sort((a, b) => computePeriodSort(a)! - computePeriodSort(b)!);
    expect(sorted).toEqual(['01_2010', '02_2010', '12_2010', '01_2011']);
    // Confirms the bug this fixes: plain text sort gets this wrong.
    expect([...periods].sort()).not.toEqual(sorted);
  });

  it('returns null for malformed periods', () => {
    expect(computePeriodSort('2026-07')).toBeNull();
    expect(computePeriodSort('13_2020')).toBeNull();
    expect(computePeriodSort('garbage')).toBeNull();
  });
});

async function seedPayslips(
  db: SQLiteDatabaseService,
  subdomain: string,
  rows: Array<{ period: string; bruto: number; neto: number }>
) {
  await db.upsertTenant(subdomain, null);
  for (const row of rows) {
    await db.upsertPayslip({
      tenant_subdomain: subdomain,
      period: row.period,
      period_label: row.period,
      bruto: row.bruto,
      neto: row.neto,
      salary_parts: null,
      pdf_path: null,
    });
  }
}

describe('getSalaryTrends', () => {
  it('computes yearly averages, YoY change, CAGR, and overall growth from stored payslips', async () => {
    const db = getDbInstance(join(dir, 'trends.db'));
    await db.initialize();

    // Two full years (2020, 2021) with a clear 20% Bruto raise, entered
    // out of chronological order to exercise period_sort-based grouping.
    await seedPayslips(db, 'acme', [
      { period: '02_2020', bruto: 10000, neto: 8000 },
      { period: '01_2021', bruto: 12000, neto: 9000 },
      { period: '01_2020', bruto: 10000, neto: 8000 },
      { period: '02_2021', bruto: 12000, neto: 9000 },
      ...Array.from({ length: 10 }, (_, i) => ({
        period: `${String(i + 3).padStart(2, '0')}_2020`,
        bruto: 10000,
        neto: 8000,
      })),
      ...Array.from({ length: 10 }, (_, i) => ({
        period: `${String(i + 3).padStart(2, '0')}_2021`,
        bruto: 12000,
        neto: 9000,
      })),
    ]);

    const trends = await db.getSalaryTrends('acme');

    expect(trends.rangeCoveredYears).toEqual([2020, 2021]);
    expect(trends.totalMonths).toBe(24);
    expect(trends.yearly).toEqual([
      { year: 2020, months: 12, isPartialYear: false, avgBruto: 10000, avgNeto: 8000 },
      { year: 2021, months: 12, isPartialYear: false, avgBruto: 12000, avgNeto: 9000 },
    ]);
    expect(trends.yoy).toEqual([{ fromYear: 2020, toYear: 2021, brutoPct: 20, netoPct: 12.5 }]);
    expect(trends.notableJumps).toHaveLength(1);
    expect(trends.cagr).toEqual({ fromYear: 2020, toYear: 2021, brutoCagrPct: 20, netoCagrPct: 12.5 });
    expect(trends.overall.firstPeriod).toBe('01_2020');
    expect(trends.overall.lastPeriod).toBe('12_2021');
    expect(trends.overall.brutoGrowthPct).toBe(20);

    await db.close();
  });

  it('respects fromYear/toYear filtering', async () => {
    const db = getDbInstance(join(dir, 'trends-range.db'));
    await db.initialize();
    await seedPayslips(db, 'acme', [
      { period: '06_2015', bruto: 5000, neto: 4000 },
      { period: '06_2020', bruto: 10000, neto: 8000 },
      { period: '06_2025', bruto: 20000, neto: 15000 },
    ]);

    const trends = await db.getSalaryTrends('acme', 2018, 2022);
    expect(trends.rangeCoveredYears).toEqual([2020, 2020]);
    expect(trends.yearly).toHaveLength(1);
    expect(trends.yearly[0].year).toBe(2020);

    await db.close();
  });

  it('skips YoY comparisons across a gap in the data (non-adjacent years)', async () => {
    const db = getDbInstance(join(dir, 'trends-gap.db'));
    await db.initialize();
    await seedPayslips(db, 'acme', [
      { period: '01_2018', bruto: 8000, neto: 6000 },
      { period: '01_2022', bruto: 16000, neto: 12000 },
    ]);

    const trends = await db.getSalaryTrends('acme');
    expect(trends.yearly.map(y => y.year)).toEqual([2018, 2022]);
    expect(trends.yoy).toEqual([]); // 2018 -> 2022 is not adjacent, so no YoY entry
    expect(trends.cagr).toBeNull(); // both years are partial (1 month each)

    await db.close();
  });

  it('returns an empty-but-valid result for a tenant with no synced payslips', async () => {
    const db = getDbInstance(join(dir, 'trends-empty.db'));
    await db.initialize();
    await db.upsertTenant('acme', null);

    const trends = await db.getSalaryTrends('acme');
    expect(trends.rangeCoveredYears).toBeNull();
    expect(trends.yearly).toEqual([]);
    expect(trends.overall.firstPeriod).toBeNull();
    expect(trends.cagr).toBeNull();

    await db.close();
  });
});

describe('payslips schema migration (period_sort backfill)', () => {
  it('adds and backfills period_sort for a pre-existing database created without it', async () => {
    const dbPath = join(dir, 'legacy.db');

    // Simulate a database created by an older version of hilan-mcp, before
    // `period_sort` existed.
    const legacyDb = new Database(dbPath);
    const escapedKey = TEST_KEY.replace(/'/g, "''");
    legacyDb.pragma(`cipher='sqlcipher'`);
    legacyDb.pragma(`legacy=4`);
    legacyDb.pragma(`rekey='${escapedKey}'`);
    legacyDb.exec(`
      CREATE TABLE tenants (
        subdomain TEXT PRIMARY KEY,
        org_code TEXT,
        capability TEXT NOT NULL DEFAULT 'unknown',
        employee_id INTEGER,
        user_id TEXT,
        discovered_fields TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE payslips (
        tenant_subdomain TEXT NOT NULL REFERENCES tenants(subdomain) ON DELETE CASCADE,
        period TEXT NOT NULL,
        period_label TEXT,
        bruto REAL,
        neto REAL,
        salary_parts TEXT,
        pdf_path TEXT,
        fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (tenant_subdomain, period)
      );
    `);
    legacyDb
      .prepare(`INSERT INTO tenants (subdomain) VALUES ('acme')`)
      .run();
    legacyDb
      .prepare(
        `INSERT INTO payslips (tenant_subdomain, period, bruto, neto) VALUES ('acme', '03_2019', 9000, 7000)`
      )
      .run();
    legacyDb.close();

    const db = getDbInstance(dbPath);
    await db.initialize();

    const trends = await db.getSalaryTrends('acme');
    expect(trends.yearly).toEqual([{ year: 2019, months: 1, isPartialYear: true, avgBruto: 9000, avgNeto: 7000 }]);

    await db.close();
  });
});
