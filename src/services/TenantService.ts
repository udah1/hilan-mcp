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

  public async syncPayslips(subdomain: string, monthsBack = 3): Promise<PayslipSyncResult[]> {
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
        ? JSON.stringify(
            data.SalarySummary.SalaryParts.map(p => ({ name: p.Name ?? '', quantity: p.Quantity ?? 0 }))
          )
        : null;

      let pdfPath: string | null = null;
      let pdfError: string | undefined;
      if (data?.Url) {
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
      await this.db.upsertPayslip({
        tenant_subdomain: subdomain,
        period: periodKey,
        period_label: dateOption.Name ?? null,
        bruto,
        neto,
        salary_parts: parts,
        pdf_path: pdfPath,
      });

      results.push({
        periodLabel: dateOption.Name ?? null,
        bruto,
        neto,
        pdfDownloaded: !!pdfPath,
        ...(pdfError ? { pdfError } : {}),
      });
    }

    return results;
  }

  public async syncForm106(subdomain: string, year?: string): Promise<Form106SyncResult> {
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
