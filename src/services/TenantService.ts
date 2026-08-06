import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { BrowserContext } from 'playwright';
import { SQLiteDatabaseService, getPdfStoragePath } from './DatabaseService.js';
import { HilanClient, HilanLoginError } from './HilanClient.js';
import type {
  Form106InitialDataResponse,
  PaySlipDateOption,
  PaySlipForMonthResponse,
  PaySlipInitialDataResponse,
} from '../types.js';

function sanitizePeriodKey(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

export interface PayslipSyncResult {
  periodLabel: string | null;
  bruto: number | null;
  neto: number | null;
  pdfDownloaded: boolean;
  pdfError?: string;
}

export interface Form106SyncResult {
  year: string;
  pdfDownloaded: boolean;
}

export class TenantService {
  constructor(private db: SQLiteDatabaseService) {}

  /**
   * Hilan's site (and/or the network path to it, e.g. a corporate proxy)
   * doesn't handle concurrent requests from the same session well —
   * observed as `page.goto` timeouts when 8 tool calls for the same tenant
   * ran in parallel. Every public entry point below is routed through this
   * per-tenant queue so callers (including an AI agent that doesn't know
   * better) can never trigger that failure mode; different tenants still
   * run fully in parallel.
   */
  private tenantQueues = new Map<string, Promise<unknown>>();

  private runExclusive<T>(subdomain: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tenantQueues.get(subdomain) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    // Swallow rejections in the chain itself (each caller still gets the
    // real error via the returned promise) so one failure doesn't
    // permanently wedge the queue for this tenant.
    this.tenantQueues.set(subdomain, run.catch(() => undefined));
    return run;
  }

  private tenantPdfDir(subdomain: string): string {
    const dir = join(getPdfStoragePath(), subdomain);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  /**
   * Restores/reuses a session if it still probes valid, otherwise performs a
   * fresh login using the tenant's stored credentials (per-tenant mutex is
   * enforced inside `HilanClient.login`).
   */
  public async ensureLoggedIn(subdomain: string): Promise<BrowserContext> {
    const tenant = await this.db.getTenant(subdomain);
    if (!tenant) {
      throw new HilanLoginError(
        `Unknown tenant "${subdomain}". Ingest credentials first with the ingest-creds CLI.`
      );
    }

    const session = await this.db.getSession(subdomain);
    if (session) {
      const context = await HilanClient.restoreContext(subdomain, session.storage_state);
      const ok = await HilanClient.probeSession(subdomain, context);
      if (ok) {
        return context;
      }
      HilanClient.invalidateContext(subdomain);
      await this.db.clearSession(subdomain);
    }

    const credentials = await this.db.getCredentials(subdomain);
    if (!credentials) {
      throw new HilanLoginError(
        `No credentials stored for tenant "${subdomain}". Ingest credentials first with the ingest-creds CLI.`
      );
    }

    const fields = JSON.parse(credentials.fields);
    return HilanClient.login(subdomain, fields, async storageStateJson => {
      await this.db.saveSession(subdomain, storageStateJson);
    });
  }

  /** Calls PaySlipApiapi.asmx/GetInitialData, records EmployeeId/UserId + capability flag. */
  private async bootstrap(
    subdomain: string,
    context: BrowserContext
  ): Promise<PaySlipInitialDataResponse> {
    const resp = await HilanClient.callAsmx<PaySlipInitialDataResponse>(
      subdomain,
      context,
      'PaySlipApiapi.asmx/GetInitialData',
      { PaySlipType: 0 }
    );

    const employeeId = resp.SelectedEmployee?.EmployeeId ?? null;
    const userId = resp.SelectedEmployee?.UserId ?? null;
    const hasStructuredSummary = typeof resp.PaySlipData?.SalarySummary?.Bruto === 'number';
    const capability = hasStructuredSummary ? 'asmx_json' : 'pdf_only';

    await this.db.setTenantCapability(subdomain, capability, employeeId, userId);
    return resp;
  }

  /**
   * Fetches + persists a single month's payslip data, and (unless
   * `skipPdf`) re-downloads its PDF even if a row already exists.
   * `skipPdf` is much faster — one JSON API call, no browser page/fetch —
   * useful for "what was my salary in X" style questions that don't need
   * the actual PDF file.
   */
  private async processPayslipMonth(
    subdomain: string,
    context: BrowserContext,
    employeeId: number | null,
    dateOption: PaySlipDateOption,
    options: { skipPdf?: boolean } = {}
  ): Promise<PayslipSyncResult> {
    const resp = await HilanClient.callAsmx<PaySlipForMonthResponse>(
      subdomain,
      context,
      'PaySlipApiapi.asmx/GetPaySlipDataForMonth',
      { EmployeeId: employeeId, Months: [dateOption.Id], PaySlipType: 0 }
    );

    const data = resp.PaySlipData;
    const bruto = data?.SalarySummary?.Bruto ?? null;
    const neto = data?.SalarySummary?.Neto ?? null;
    const parts = data?.SalarySummary?.SalaryParts
      ? JSON.stringify(data.SalarySummary.SalaryParts.map(p => ({ name: p.Name ?? '', quantity: p.Quantity ?? 0 })))
      : null;

    let pdfPath: string | null = null;
    let pdfError: string | undefined;
    if (data?.Url && !options.skipPdf) {
      const period = sanitizePeriodKey(dateOption.Id);
      try {
        pdfPath = await HilanClient.downloadPdf(
          subdomain,
          context,
          data.Url,
          this.tenantPdfDir(subdomain),
          `payslip-${period}.pdf`
        );
      } catch (error) {
        // A PDF download failure for one month (e.g. the file isn't
        // published on the site yet) shouldn't discard the structured
        // Bruto/Neto data we already have for this and other months.
        pdfError = error instanceof Error ? error.message : String(error);
      }
    }

    const periodKey = sanitizePeriodKey(dateOption.Id) || dateOption.Name;
    const existing = options.skipPdf ? await this.db.getPayslip(subdomain, periodKey) : null;
    await this.db.upsertPayslip({
      tenant_subdomain: subdomain,
      period: periodKey,
      period_label: dateOption.Name ?? null,
      bruto,
      neto,
      salary_parts: parts,
      // Don't clobber a previously-downloaded PDF just because this call
      // intentionally skipped fetching one.
      pdf_path: options.skipPdf ? (existing?.pdf_path ?? null) : pdfPath,
    });

    return {
      periodLabel: dateOption.Name ?? null,
      bruto,
      neto,
      pdfDownloaded: !!pdfPath,
      ...(pdfError ? { pdfError } : {}),
    };
  }

  public syncPayslips(subdomain: string, monthsBack = 3, skipPdf = false): Promise<PayslipSyncResult[]> {
    return this.runExclusive(subdomain, () => this.syncPayslipsImpl(subdomain, monthsBack, skipPdf));
  }

  private async syncPayslipsImpl(subdomain: string, monthsBack: number, skipPdf: boolean): Promise<PayslipSyncResult[]> {
    const context = await this.ensureLoggedIn(subdomain);
    const initial = await this.bootstrap(subdomain, context);
    const tenant = await this.db.getTenant(subdomain);
    const employeeId = tenant?.employee_id ?? null;

    const dateOptions: PaySlipDateOption[] =
      initial.PaySlipDates && initial.PaySlipDates.length > 0
        ? initial.PaySlipDates.slice(0, monthsBack)
        : initial.SelectedDate
          ? [initial.SelectedDate]
          : [];

    const results: PayslipSyncResult[] = [];
    for (const dateOption of dateOptions) {
      results.push(await this.processPayslipMonth(subdomain, context, employeeId, dateOption, { skipPdf }));
    }
    return results;
  }

  /**
   * Raw escape hatch for exploring/debugging Hilan's `.asmx` API surface
   * against a real logged-in session — e.g. testing whether
   * `GetMultiplePaySlipData` accepts more months than the UI's 12-month
   * picker allows. Not meant for regular use.
   */
  public debugCallAsmx(subdomain: string, servicePath: string, body: Record<string, unknown>): Promise<unknown> {
    return this.runExclusive(subdomain, async () => {
      const context = await this.ensureLoggedIn(subdomain);
      return HilanClient.callAsmx(subdomain, context, servicePath, body);
    });
  }

  /** DEBUG only: download an arbitrary relative PDF URL (e.g. from debugCallAsmx) to inspect it. */
  public debugDownloadPdf(subdomain: string, relativeUrl: string, fileName: string): Promise<string> {
    return this.runExclusive(subdomain, async () => {
      const context = await this.ensureLoggedIn(subdomain);
      return HilanClient.downloadPdf(subdomain, context, relativeUrl, this.tenantPdfDir(subdomain), fileName);
    });
  }

  /**
   * Re-fetches + re-downloads a single, specific month — e.g. to retry a
   * PDF that came back truncated — without re-syncing the entire history.
   * `period` accepts either the stored key format ("MM_YYYY") or the raw
   * Hilan month format ("MM/YYYY").
   */
  public resyncPayslipMonth(subdomain: string, period: string, skipPdf = false): Promise<PayslipSyncResult> {
    return this.runExclusive(subdomain, () => this.resyncPayslipMonthImpl(subdomain, period, skipPdf));
  }

  private async resyncPayslipMonthImpl(subdomain: string, period: string, skipPdf: boolean): Promise<PayslipSyncResult> {
    const context = await this.ensureLoggedIn(subdomain);
    const tenant = await this.db.getTenant(subdomain);
    let employeeId = tenant?.employee_id ?? null;
    if (employeeId === null) {
      const initial = await this.bootstrap(subdomain, context);
      employeeId = initial.SelectedEmployee?.EmployeeId ?? null;
    }

    const monthId = period.includes('/') ? period : period.replace('_', '/');
    const existing = await this.db.getPayslip(subdomain, sanitizePeriodKey(monthId));
    const dateOption: PaySlipDateOption = { Id: monthId, Name: existing?.period_label ?? monthId };

    return this.processPayslipMonth(subdomain, context, employeeId, dateOption, { skipPdf });
  }

  /**
   * Live lookup only — not persisted to the encrypted DB, since it's PII
   * (address, phone, national ID, spouse info) that doesn't need to be
   * cached the way payslip numbers do. Returns a curated subset of
   * `PersonalDetailsApiapi.asmx/GetInitialData`'s response, stripping out
   * the large `Constants`/`Images`/`Enums` UI-localization dictionaries.
   */
  public getPersonalDetails(subdomain: string): Promise<Record<string, unknown>> {
    return this.runExclusive(subdomain, async () => {
      const context = await this.ensureLoggedIn(subdomain);
      const resp = await HilanClient.callAsmx<Record<string, unknown>>(
        subdomain,
        context,
        'PersonalDetailsApiapi.asmx/GetInitialData',
        {}
      );
      const fields = [
        'FirstName',
        'LastName',
        'Identification',
        'Birthdate',
        'Age',
        'Gender',
        'MaritalStatus',
        'Israeli',
        'City',
        'Street',
        'ZipCode',
        'Phone',
        'AnotherPhone',
        'Email',
        'EmailHome',
        'DateOfSeniority',
        'TypeOfJob',
        'SpouseWorkDetails',
        'Children',
      ];
      const picked: Record<string, unknown> = {};
      for (const field of fields) {
        if (field in resp) picked[field] = resp[field];
      }
      return picked;
    });
  }

  public syncForm106(subdomain: string, year?: string): Promise<Form106SyncResult> {
    return this.runExclusive(subdomain, () => this.syncForm106Impl(subdomain, year));
  }

  private async syncForm106Impl(subdomain: string, year?: string): Promise<Form106SyncResult> {
    const context = await this.ensureLoggedIn(subdomain);

    let tenant = await this.db.getTenant(subdomain);
    if (!tenant?.employee_id) {
      await this.bootstrap(subdomain, context);
      tenant = await this.db.getTenant(subdomain);
    }
    const employeeId = tenant?.employee_id ?? null;

    const initial = await HilanClient.callAsmx<Form106InitialDataResponse>(
      subdomain,
      context,
      'Form106Apiapi.asmx/GetInitialData',
      {}
    );

    let pdfLink = initial.PdfViewLink ?? null;
    let selectedYear = year ?? initial.SelectedYear ?? (initial.Dates?.[0] ?? 'unknown');

    if (year && employeeId !== null) {
      const changed = await HilanClient.callAsmx<Form106InitialDataResponse>(
        subdomain,
        context,
        'Form106Apiapi.asmx/EmployeeChanged',
        { selectedYear: year, employeeId }
      );
      pdfLink = changed.PdfViewLink ?? pdfLink;
      selectedYear = changed.SelectedYear ?? year;
    }

    let pdfPath: string | null = null;
    if (pdfLink) {
      pdfPath = await HilanClient.downloadPdf(
        subdomain,
        context,
        pdfLink,
        this.tenantPdfDir(subdomain),
        `form106-${sanitizePeriodKey(selectedYear)}.pdf`
      );
    }

    await this.db.upsertForm106({ tenant_subdomain: subdomain, year: selectedYear, pdf_path: pdfPath });

    return { year: selectedYear, pdfDownloaded: !!pdfPath };
  }
}
