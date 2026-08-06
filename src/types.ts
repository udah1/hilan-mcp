/**
 * Core TypeScript type definitions for hilan-mcp.
 */

export type TenantCapability = 'unknown' | 'asmx_json' | 'pdf_only';

export interface TenantRow {
  subdomain: string;
  org_code: string | null;
  capability: TenantCapability;
  employee_id: number | null;
  user_id: string | null;
  discovered_fields: string | null; // JSON array of {id, placeholder, type} found on the login form
  created_at: string;
  updated_at: string;
}

/** Raw id->value map for whatever fields the tenant's login form happened to have. */
export type LoginFieldValues = Record<string, string>;

export interface CredentialRow {
  tenant_subdomain: string;
  fields: string; // JSON-serialized LoginFieldValues
  updated_at: string;
}

export interface SessionRow {
  tenant_subdomain: string;
  storage_state: string; // JSON-serialized Playwright storageState()
  saved_at: string;
}

export interface SalaryPart {
  name: string;
  quantity: number;
}

export interface PayslipRow {
  tenant_subdomain: string;
  period: string; // e.g. "2026-07", derived from the PaySlipDates entry used
  period_label: string | null; // human-readable label from Hilan (e.g. "יולי 2026")
  bruto: number | null;
  neto: number | null;
  salary_parts: string | null; // JSON-serialized SalaryPart[]
  pdf_path: string | null;
  fetched_at: string;
}

export interface Form106Row {
  tenant_subdomain: string;
  year: string;
  pdf_path: string | null;
  fetched_at: string;
}

/** Shape we look for in PaySlipApiapi.asmx/GetInitialData to source EmployeeId/UserId. */
export interface SelectedEmployee {
  UserId: string;
  EmployeeId: number;
  FirstName?: string;
  LastName?: string;
  EmployeeTitle?: string;
}

export interface PaySlipDateOption {
  Id: string;
  Name: string;
}

export interface SalarySummary {
  Bruto?: number;
  Neto?: number;
  SalaryParts?: Array<{ Name?: string; Quantity?: number }>;
}

export interface PaySlipData {
  Url?: string;
  SalarySummary?: SalarySummary;
}

export interface PaySlipInitialDataResponse {
  IsHasPayslipAvailable?: boolean;
  PaySlipDates?: PaySlipDateOption[];
  PaySlipData?: PaySlipData;
  SelectedDate?: PaySlipDateOption;
  SelectedEmployee?: SelectedEmployee;
}

export interface PaySlipForMonthResponse {
  PaySlipData?: PaySlipData;
}

export interface Form106InitialDataResponse {
  Dates?: string[];
  SelectedYear?: string;
  PdfViewLink?: string;
  SelectedEmployee?: SelectedEmployee;
}
