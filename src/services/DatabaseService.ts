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
    db.prepare(
      `INSERT INTO payslips (tenant_subdomain, period, period_label, bruto, neto, salary_parts, pdf_path, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(tenant_subdomain, period) DO UPDATE SET
         period_label = excluded.period_label,
         bruto = excluded.bruto,
         neto = excluded.neto,
         salary_parts = excluded.salary_parts,
         pdf_path = excluded.pdf_path,
         fetched_at = datetime('now')`
    ).run(
      row.tenant_subdomain,
      row.period,
      row.period_label,
      row.bruto,
      row.neto,
      row.salary_parts,
      row.pdf_path
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
