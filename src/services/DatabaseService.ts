import Database from 'better-sqlite3-multiple-ciphers';
import { existsSync, chmodSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { validateSelectQuery } from '../utils/sqlValidation.js';
import { encryptionKeyService } from './EncryptionKeyService.js';
import type {
  TenantRow,
  CredentialRow,
  SessionRow,
  PayslipRow,
  Form106Row,
  TenantCapability,
} from '../types.js';

/**
 * Parses a stored "MM_YYYY" period key (see TenantService.sanitizePeriodKey)
 * into a `YYYYMM` integer for correct chronological sorting/grouping —
 * plain text sorting of `period` groups by month across years (e.g.
 * "01_2011" < "01_2012" < ... < "02_2011"), not by actual date. Returns
 * `null` for anything that doesn't match the expected shape, so callers can
 * skip it rather than mis-sort it.
 */
export function computePeriodSort(period: string): number | null {
  const match = /^(\d{2})_(\d{4})$/.exec(period);
  if (!match) return null;
  const month = Number(match[1]);
  const year = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return year * 100 + month;
}

export interface YearlySalaryTrend {
  year: number;
  months: number;
  /** True when fewer than 12 months of this calendar year are synced locally. */
  isPartialYear: boolean;
  avgBruto: number | null;
  avgNeto: number | null;
}

export interface YearOverYearChange {
  fromYear: number;
  toYear: number;
  brutoPct: number | null;
  netoPct: number | null;
}

export interface SalaryTrendsResult {
  tenant: string;
  /** [earliest, latest] calendar year actually covered by the data considered, or null if none. */
  rangeCoveredYears: [number, number] | null;
  totalMonths: number;
  yearly: YearlySalaryTrend[];
  /** Year-over-year change for each pair of *adjacent* calendar years present in `yearly`. */
  yoy: YearOverYearChange[];
  /** Entries from `yoy` where the absolute Bruto change is >= `jumpThresholdPct`. */
  notableJumps: YearOverYearChange[];
  jumpThresholdPct: number;
  overall: {
    firstPeriod: string | null;
    firstPeriodLabel: string | null;
    firstBruto: number | null;
    firstNeto: number | null;
    lastPeriod: string | null;
    lastPeriodLabel: string | null;
    lastBruto: number | null;
    lastNeto: number | null;
    brutoGrowthPct: number | null;
    netoGrowthPct: number | null;
  };
  /** CAGR between the first and last *full* (12-month) calendar year in range; null if fewer than 2 full years are available. */
  cagr: {
    fromYear: number;
    toYear: number;
    brutoCagrPct: number | null;
    netoCagrPct: number | null;
  } | null;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function getAppDataPath() {
  const home = homedir();

  switch (process.platform) {
    case 'win32':
      return process.env.APPDATA || join(home, 'AppData', 'Roaming');
    case 'darwin':
      return join(home, 'Library', 'Application Support');
    default:
      return process.env.XDG_DATA_HOME || join(home, '.local', 'share');
  }
}

/** Where downloaded payslip/Form106 PDFs live — chmod 600, gitignored, never synced. */
export function getPdfStoragePath(): string {
  const dir = join(getAppDataPath(), 'HilanMcp', 'pdfs');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } else {
    try {
      chmodSync(dir, 0o700);
    } catch {
      // best-effort
    }
  }
  return dir;
}

export class SQLiteDatabaseService {
  private db: Database | null = null;
  private static instance: SQLiteDatabaseService | null = null;
  private initialized = false;
  private dbPath: string;

  private static getDefaultDbPath(): string {
    const appDataDir = join(getAppDataPath(), 'HilanMcp');
    const dbPath = join(appDataDir, 'hilan.db');

    if (!existsSync(appDataDir)) {
      mkdirSync(appDataDir, { recursive: true, mode: 0o700 });
    } else {
      try {
        chmodSync(appDataDir, 0o700);
      } catch {
        // best-effort
      }
    }

    return dbPath;
  }

  private constructor(dbPath: string) {
    this.dbPath = dbPath || SQLiteDatabaseService.getDefaultDbPath();

    if (dbPath) {
      const dir = dirname(dbPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
    }
  }

  public static getInstance(dbPath?: string): SQLiteDatabaseService {
    const pathToUse = dbPath || SQLiteDatabaseService.getDefaultDbPath();

    if (SQLiteDatabaseService.instance && SQLiteDatabaseService.instance.dbPath !== pathToUse) {
      SQLiteDatabaseService.instance.close().catch(console.error);
      SQLiteDatabaseService.instance = null;
    }

    if (!SQLiteDatabaseService.instance) {
      SQLiteDatabaseService.instance = new SQLiteDatabaseService(pathToUse);
    }

    return SQLiteDatabaseService.instance;
  }

  public async databaseExists(): Promise<boolean> {
    return existsSync(this.dbPath);
  }

  private ensureReady(): void {
    if (!this.initialized || !this.db) {
      throw new Error('Database is not initialized. Please call initialize() first.');
    }
  }

  private assertInitialized(): Database {
    if (!this.initialized || !this.db) {
      throw new Error('Database not initialized. Call initialize() first.');
    }
    return this.db;
  }

  private async applyEncryption(db: Database, isNewDatabase: boolean): Promise<void> {
    const key = await encryptionKeyService.ensureKeyIsAvailable();

    try {
      // SQLCipher's `key`/`rekey` pragmas take a single-quoted string literal,
      // not a bound parameter — a literal `'` in a user-chosen key would
      // otherwise break out of the literal and corrupt the pragma. Escape it
      // the standard SQL way (double it) rather than rejecting such keys.
      const escapedKey = key.replace(/'/g, "''");
      db.pragma(`cipher='sqlcipher'`);
      db.pragma(`legacy=4`);
      db.pragma(`${isNewDatabase ? 'rekey' : 'key'}='${escapedKey}'`);
      db.prepare('PRAGMA schema_version').get();
    } catch (error) {
      encryptionKeyService.clearKey();
      db.close();
      throw new Error(
        `${error instanceof Error ? error.message : 'Unknown error'}, incorrect key?`
      );
    }
  }

  public async initialize(): Promise<Database> {
    if (this.initialized && this.db) {
      return this.db;
    }

    if (this.db) {
      this.db.close();
      this.db = null;
    }

    const isNewDatabase = !(await this.databaseExists());
    const db = new Database(this.dbPath);

    if (isNewDatabase) {
      try {
        chmodSync(this.dbPath, 0o600);
      } catch (error) {
        db.close();
        throw new Error(
          `Failed to set database file permissions: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    }

    await this.applyEncryption(db, isNewDatabase);

    this.db = db;

    try {
      this.initializeSchema();
      this.initialized = true;
      return db;
    } catch (error) {
      this.db.close();
      this.db = null;
      this.initialized = false;
      throw error;
    }
  }

  private initializeSchema(): void {
    const db = this.db;
    if (!db) {
      throw new Error('Database connection not established');
    }

    db.pragma('foreign_keys = ON');

    db.exec(`
      CREATE TABLE IF NOT EXISTS tenants (
        subdomain TEXT PRIMARY KEY,
        org_code TEXT,
        capability TEXT NOT NULL DEFAULT 'unknown',
        employee_id INTEGER,
        user_id TEXT,
        discovered_fields TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS credentials (
        tenant_subdomain TEXT PRIMARY KEY REFERENCES tenants(subdomain) ON DELETE CASCADE,
        fields TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS sessions (
        tenant_subdomain TEXT PRIMARY KEY REFERENCES tenants(subdomain) ON DELETE CASCADE,
        storage_state TEXT NOT NULL,
        saved_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS payslips (
        tenant_subdomain TEXT NOT NULL REFERENCES tenants(subdomain) ON DELETE CASCADE,
        period TEXT NOT NULL,
        period_label TEXT,
        bruto REAL,
        neto REAL,
        salary_parts TEXT,
        pdf_path TEXT,
        period_sort INTEGER,
        fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (tenant_subdomain, period)
      );

      CREATE TABLE IF NOT EXISTS form106 (
        tenant_subdomain TEXT NOT NULL REFERENCES tenants(subdomain) ON DELETE CASCADE,
        year TEXT NOT NULL,
        pdf_path TEXT,
        fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (tenant_subdomain, year)
      );
    `);

    this.migratePayslipsPeriodSort(db);
  }

  /**
   * Older databases (created before `period_sort` existed) won't have the
   * column yet — SQLite's `CREATE TABLE IF NOT EXISTS` above is a no-op for
   * them. Add it and backfill from the existing `period` values so
   * chronological sorting/grouping (used by `getSalaryTrends`) works
   * without requiring a full re-sync.
   */
  private migratePayslipsPeriodSort(db: Database): void {
    const columns = db.prepare('PRAGMA table_info(payslips)').all() as { name: string }[];
    const hasPeriodSort = columns.some(c => c.name === 'period_sort');

    if (!hasPeriodSort) {
      db.exec('ALTER TABLE payslips ADD COLUMN period_sort INTEGER');
      db.exec(`
        UPDATE payslips
        SET period_sort = CAST(substr(period, 4, 4) AS INTEGER) * 100 + CAST(substr(period, 1, 2) AS INTEGER)
        WHERE period_sort IS NULL
          AND length(period) = 7
          AND substr(period, 3, 1) = '_'
      `);
    }

    db.exec('CREATE INDEX IF NOT EXISTS idx_payslips_tenant_period_sort ON payslips(tenant_subdomain, period_sort)');
  }

  public close(): Promise<void> {
    return new Promise(resolve => {
      const db = this.assertInitialized();
      db.close();
      this.db = null;
      this.initialized = false;
      resolve();
    });
  }

  // --- tenants ---

  public async upsertTenant(subdomain: string, orgCode: string | null): Promise<void> {
    this.ensureReady();
    const db = this.assertInitialized();
    db.prepare(
      `INSERT INTO tenants (subdomain, org_code) VALUES (?, ?)
       ON CONFLICT(subdomain) DO UPDATE SET org_code = COALESCE(excluded.org_code, tenants.org_code), updated_at = datetime('now')`
    ).run(subdomain, orgCode);
  }

  public async setTenantCapability(
    subdomain: string,
    capability: TenantCapability,
    employeeId: number | null,
    userId: string | null
  ): Promise<void> {
    this.ensureReady();
    const db = this.assertInitialized();
    db.prepare(
      `UPDATE tenants SET capability = ?, employee_id = ?, user_id = ?, updated_at = datetime('now') WHERE subdomain = ?`
    ).run(capability, employeeId, userId, subdomain);
  }

  public async setTenantDiscoveredFields(subdomain: string, fieldsJson: string): Promise<void> {
    this.ensureReady();
    const db = this.assertInitialized();
    db.prepare(
      `UPDATE tenants SET discovered_fields = ?, updated_at = datetime('now') WHERE subdomain = ?`
    ).run(fieldsJson, subdomain);
  }

  public async getTenant(subdomain: string): Promise<TenantRow | null> {
    this.ensureReady();
    const db = this.assertInitialized();
    return (db.prepare('SELECT * FROM tenants WHERE subdomain = ?').get(subdomain) as TenantRow) || null;
  }

  public async listTenants(): Promise<TenantRow[]> {
    this.ensureReady();
    const db = this.assertInitialized();
    return db.prepare('SELECT * FROM tenants ORDER BY subdomain').all() as TenantRow[];
  }

  // --- credentials ---

  public async upsertCredentials(subdomain: string, fieldsJson: string): Promise<void> {
    this.ensureReady();
    const db = this.assertInitialized();
    db.prepare(
      `INSERT INTO credentials (tenant_subdomain, fields) VALUES (?, ?)
       ON CONFLICT(tenant_subdomain) DO UPDATE SET fields = excluded.fields, updated_at = datetime('now')`
    ).run(subdomain, fieldsJson);
  }

  public async getCredentials(subdomain: string): Promise<CredentialRow | null> {
    this.ensureReady();
    const db = this.assertInitialized();
    return (
      (db.prepare('SELECT * FROM credentials WHERE tenant_subdomain = ?').get(subdomain) as CredentialRow) ||
      null
    );
  }

  // --- sessions ---

  public async saveSession(subdomain: string, storageStateJson: string): Promise<void> {
    this.ensureReady();
    const db = this.assertInitialized();
    db.prepare(
      `INSERT INTO sessions (tenant_subdomain, storage_state, saved_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(tenant_subdomain) DO UPDATE SET storage_state = excluded.storage_state, saved_at = datetime('now')`
    ).run(subdomain, storageStateJson);
  }

  public async getSession(subdomain: string): Promise<SessionRow | null> {
    this.ensureReady();
    const db = this.assertInitialized();
    return (
      (db.prepare('SELECT * FROM sessions WHERE tenant_subdomain = ?').get(subdomain) as SessionRow) || null
    );
  }

  public async clearSession(subdomain: string): Promise<void> {
    this.ensureReady();
    const db = this.assertInitialized();
    db.prepare('DELETE FROM sessions WHERE tenant_subdomain = ?').run(subdomain);
  }

  // --- payslips / form106 ---

  public async upsertPayslip(row: Omit<PayslipRow, 'fetched_at'>): Promise<void> {
    this.ensureReady();
    const db = this.assertInitialized();
    const periodSort = computePeriodSort(row.period);
    db.prepare(
      `INSERT INTO payslips (tenant_subdomain, period, period_label, bruto, neto, salary_parts, pdf_path, period_sort, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(tenant_subdomain, period) DO UPDATE SET
         period_label = excluded.period_label,
         bruto = excluded.bruto,
         neto = excluded.neto,
         salary_parts = excluded.salary_parts,
         pdf_path = excluded.pdf_path,
         period_sort = excluded.period_sort,
         fetched_at = datetime('now')`
    ).run(
      row.tenant_subdomain,
      row.period,
      row.period_label,
      row.bruto,
      row.neto,
      row.salary_parts,
      row.pdf_path,
      periodSort
    );
  }

  public async getPayslip(subdomain: string, period: string): Promise<PayslipRow | null> {
    this.ensureReady();
    const db = this.assertInitialized();
    const row = db
      .prepare('SELECT * FROM payslips WHERE tenant_subdomain = ? AND period = ?')
      .get(subdomain, period);
    return (row as PayslipRow | undefined) ?? null;
  }

  /**
   * Computes yearly salary trends (average Bruto/Neto, YoY % change, CAGR,
   * overall growth, notable jumps) directly from locally-synced payslips —
   * no live login needed. Groups by `period_sort` (see `computePeriodSort`)
   * rather than the `period` text column, so years sort and group
   * correctly regardless of month.
   */
  public async getSalaryTrends(
    subdomain: string,
    fromYear?: number,
    toYear?: number,
    jumpThresholdPct = 10
  ): Promise<SalaryTrendsResult> {
    this.ensureReady();
    const db = this.assertInitialized();

    const minSort = fromYear !== undefined ? fromYear * 100 + 1 : null;
    const maxSort = toYear !== undefined ? toYear * 100 + 12 : null;

    const rangeClauses: string[] = ['tenant_subdomain = ?', 'period_sort IS NOT NULL'];
    const rangeParams: unknown[] = [subdomain];
    if (minSort !== null) {
      rangeClauses.push('period_sort >= ?');
      rangeParams.push(minSort);
    }
    if (maxSort !== null) {
      rangeClauses.push('period_sort <= ?');
      rangeParams.push(maxSort);
    }
    const whereClause = rangeClauses.join(' AND ');

    const yearlyRows = db
      .prepare(
        `SELECT
           (period_sort / 100) AS year,
           COUNT(*) AS months,
           AVG(bruto) AS avgBruto,
           AVG(neto) AS avgNeto
         FROM payslips
         WHERE ${whereClause}
         GROUP BY year
         ORDER BY year ASC`
      )
      .all(...rangeParams) as { year: number; months: number; avgBruto: number | null; avgNeto: number | null }[];

    const yearly: YearlySalaryTrend[] = yearlyRows.map(r => ({
      year: r.year,
      months: r.months,
      isPartialYear: r.months < 12,
      avgBruto: r.avgBruto === null ? null : round1(r.avgBruto),
      avgNeto: r.avgNeto === null ? null : round1(r.avgNeto),
    }));

    const yoy: YearOverYearChange[] = [];
    for (let i = 1; i < yearly.length; i++) {
      const prev = yearly[i - 1];
      const cur = yearly[i];
      if (cur.year - prev.year !== 1) continue; // gap in the data — not a meaningful YoY comparison
      const brutoPct =
        prev.avgBruto && cur.avgBruto !== null ? round1(((cur.avgBruto - prev.avgBruto) / prev.avgBruto) * 100) : null;
      const netoPct =
        prev.avgNeto && cur.avgNeto !== null ? round1(((cur.avgNeto - prev.avgNeto) / prev.avgNeto) * 100) : null;
      yoy.push({ fromYear: prev.year, toYear: cur.year, brutoPct, netoPct });
    }

    const notableJumps = yoy.filter(c => c.brutoPct !== null && Math.abs(c.brutoPct) >= jumpThresholdPct);

    const firstRow = db
      .prepare(
        `SELECT period, period_label, bruto, neto FROM payslips WHERE ${whereClause} ORDER BY period_sort ASC LIMIT 1`
      )
      .get(...rangeParams) as { period: string; period_label: string | null; bruto: number | null; neto: number | null } | undefined;
    const lastRow = db
      .prepare(
        `SELECT period, period_label, bruto, neto FROM payslips WHERE ${whereClause} ORDER BY period_sort DESC LIMIT 1`
      )
      .get(...rangeParams) as { period: string; period_label: string | null; bruto: number | null; neto: number | null } | undefined;

    const brutoGrowthPct =
      firstRow?.bruto && lastRow?.bruto !== undefined && lastRow?.bruto !== null
        ? round1(((lastRow.bruto - firstRow.bruto) / firstRow.bruto) * 100)
        : null;
    const netoGrowthPct =
      firstRow?.neto && lastRow?.neto !== undefined && lastRow?.neto !== null
        ? round1(((lastRow.neto - firstRow.neto) / firstRow.neto) * 100)
        : null;

    const fullYears = yearly.filter(y => !y.isPartialYear && y.avgBruto !== null && y.avgNeto !== null);
    let cagr: SalaryTrendsResult['cagr'] = null;
    if (fullYears.length >= 2) {
      const startYear = fullYears[0];
      const endYear = fullYears[fullYears.length - 1];
      const yearSpan = endYear.year - startYear.year;
      if (yearSpan > 0) {
        const brutoCagrPct =
          startYear.avgBruto && endYear.avgBruto
            ? round1((Math.pow(endYear.avgBruto / startYear.avgBruto, 1 / yearSpan) - 1) * 100)
            : null;
        const netoCagrPct =
          startYear.avgNeto && endYear.avgNeto
            ? round1((Math.pow(endYear.avgNeto / startYear.avgNeto, 1 / yearSpan) - 1) * 100)
            : null;
        cagr = { fromYear: startYear.year, toYear: endYear.year, brutoCagrPct, netoCagrPct };
      }
    }

    return {
      tenant: subdomain,
      rangeCoveredYears: yearly.length > 0 ? [yearly[0].year, yearly[yearly.length - 1].year] : null,
      totalMonths: yearly.reduce((sum, y) => sum + y.months, 0),
      yearly,
      yoy,
      notableJumps,
      jumpThresholdPct,
      overall: {
        firstPeriod: firstRow?.period ?? null,
        firstPeriodLabel: firstRow?.period_label ?? null,
        firstBruto: firstRow?.bruto ?? null,
        firstNeto: firstRow?.neto ?? null,
        lastPeriod: lastRow?.period ?? null,
        lastPeriodLabel: lastRow?.period_label ?? null,
        lastBruto: lastRow?.bruto ?? null,
        lastNeto: lastRow?.neto ?? null,
        brutoGrowthPct,
        netoGrowthPct,
      },
      cagr,
    };
  }

  public async upsertForm106(row: Omit<Form106Row, 'fetched_at'>): Promise<void> {
    this.ensureReady();
    const db = this.assertInitialized();
    db.prepare(
      `INSERT INTO form106 (tenant_subdomain, year, pdf_path, fetched_at) VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(tenant_subdomain, year) DO UPDATE SET pdf_path = excluded.pdf_path, fetched_at = datetime('now')`
    ).run(row.tenant_subdomain, row.year, row.pdf_path);
  }

  // --- generic safe SQL tool surface (payslips/form106 only) ---

  public async listTables(): Promise<{ success: boolean; tables?: string[]; error?: string }> {
    try {
      const db = this.assertInitialized();
      const rows = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all();
      const tables = (rows as { name: string }[])
        .map(row => row.name)
        .filter(name => name === 'payslips' || name === 'form106');
      return { success: true, tables };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to list tables' };
    }
  }

  public async executeSafeSelectQuery(
    query: string
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    const validation = validateSelectQuery(query);
    if (!validation.valid) {
      return { success: false, error: validation.reason };
    }

    try {
      const db = this.assertInitialized();
      const result = db.prepare(query).all();
      return { success: true, data: result };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error executing query',
      };
    }
  }
}

export function getDbInstance(path?: string) {
  return SQLiteDatabaseService.getInstance(path);
}
