import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { getDbInstance, SQLiteDatabaseService } from '../services/DatabaseService.js';
import { encryptionKeyService } from '../services/EncryptionKeyService.js';
import { HilanClient } from '../services/HilanClient.js';
import { TenantService } from '../services/TenantService.js';
import { getDefaultTenantInput } from '../utils/env.js';
import { redactError } from '../utils/redact.js';
import '../utils/consoleRedirect.js';
import { configureLogger } from '../utils/logger.js';
configureLogger({ enableConsoleOutput: true });

// This server communicates over stdio — an interactive stdin key prompt
// would corrupt the MCP JSON-RPC framing (and can hang the connection
// entirely). See EncryptionKeyService.disableStdinFallback for the
// resulting (clear, actionable) error instead.
encryptionKeyService.disableStdinFallback();

interface TextContent {
  type: 'text';
  text: string;
  [key: string]: unknown;
}

type ZodRecord<T extends z.ZodTypeAny = z.ZodTypeAny> = Record<string, z.infer<T>>;

interface ToolSchema {
  description?: string;
  inputSchema?: Record<string, ZodRecord>;
}

type ToolHandler = (params: Record<string, unknown>) => Promise<unknown>;

class Server {
  private server: McpServer;
  private databaseService: SQLiteDatabaseService;
  private tenantService: TenantService;
  private tools: Map<string, { handler: ToolHandler; schema?: ToolSchema }> = new Map();

  constructor() {
    this.server = new McpServer({ name: 'hilan-mcp-server', version: '0.1.0' });
    this.databaseService = getDbInstance();
    this.tenantService = new TenantService(this.databaseService);
    this.setupTools();
    this.setupErrorHandling();
  }

  private setupErrorHandling() {
    this.server.server.onerror = (error: Error) => {
      console.error('[Error] MCP Server error:', redactError(error));
    };

    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private textResponse(text: string): { content: TextContent[] } {
    return { content: [{ type: 'text', text }] };
  }

  private registerTool(name: string, handler: ToolHandler, schema?: ToolSchema) {
    this.tools.set(name, { handler, schema });
    const { description, inputSchema } = schema || {};

    this.server.tool(name, description || '', inputSchema || {}, async (params: Record<string, unknown>) => {
      try {
        const result = await handler(params);
        return this.textResponse(JSON.stringify(result));
      } catch (error: unknown) {
        const safeMessage = redactError(error) || `Error in ${name}`;
        console.error(`Error in ${name}:`, safeMessage);
        throw new McpError(ErrorCode.InternalError, safeMessage);
      }
    });
  }

  private async withDb<T>(fn: (db: SQLiteDatabaseService) => Promise<T> | T): Promise<T> {
    await encryptionKeyService.ensureKeyIsAvailable();
    await this.databaseService.initialize();
    return fn(this.databaseService);
  }

  /**
   * Resolves the `tenant` a tool was called with, falling back to this
   * server process's COMPANY_URL / COMPANY_TENANT / COMPANY_CODE env vars
   * (see src/utils/env.ts) for single-tenant setups.
   */
  private async resolveTenant(tenantParam?: string): Promise<string> {
    const raw = tenantParam?.trim() || getDefaultTenantInput();
    if (!raw) {
      throw new Error(
        'No tenant specified. Pass a "tenant" argument, or set one of COMPANY_URL / COMPANY_TENANT / COMPANY_CODE in this MCP server\'s env (only the first one found, in that order, is used).'
      );
    }
    return HilanClient.resolveTenantInput(raw);
  }

  private setupTools() {
    this.registerTool(
      'listTenants',
      async () => {
        return this.withDb(async db => {
          const tenants = await db.listTenants();
          return {
            success: true,
            data: {
              tenants: tenants.map(t => ({
                subdomain: t.subdomain,
                orgCode: t.org_code,
                capability: t.capability,
                hasEmployeeId: t.employee_id !== null,
              })),
            },
          };
        });
      },
      { description: 'List configured Hilan tenants (no secrets returned)' }
    );

    this.registerTool(
      'syncPayslips',
      async params => {
        const { tenant, monthsBack, skipPdf } = params as { tenant?: string; monthsBack?: number; skipPdf?: boolean };
        return this.withDb(async () => {
          const resolvedTenant = await this.resolveTenant(tenant);
          const results = await this.tenantService.syncPayslips(resolvedTenant, monthsBack ?? 3, skipPdf ?? false);
          return { success: true, data: { tenant: resolvedTenant, payslips: results } };
        });
      },
      {
        description:
          'Log into a Hilan tenant (using previously ingested credentials) and sync recent payslips (structured Bruto/Neto/parts + PDF)',
        inputSchema: {
          tenant: z
            .string()
            .optional()
            .describe(
              'Tenant subdomain, e.g. "amdocs". Optional if this server has COMPANY_URL / COMPANY_TENANT / COMPANY_CODE set in its env'
            ),
          monthsBack: z
            .number()
            .int()
            .min(1)
            .max(600)
            .optional()
            .describe(
              'How many recent months to sync (default 3). The tenant itself caps how far back its payslip archive actually goes — this is just a sanity ceiling, not a real limit.'
            ),
          skipPdf: z
            .boolean()
            .optional()
            .describe(
              'If true, only fetch/store the structured Bruto/Neto/parts data and skip downloading PDFs — much faster for quick numeric questions. Any previously-downloaded PDF for a month is left untouched. Default false.'
            ),
        },
      }
    );

    this.registerTool(
      'downloadCombinedPayslipsPdf',
      async params => {
        const { tenant, fromMonth, toMonth } = params as { tenant?: string; fromMonth: string; toMonth: string };
        if (!fromMonth || !toMonth) throw new Error('fromMonth and toMonth are required');
        return this.withDb(async () => {
          const resolvedTenant = await this.resolveTenant(tenant);
          const chunks = await this.tenantService.downloadCombinedPayslipsPdf(resolvedTenant, fromMonth, toMonth);
          return { success: true, data: { tenant: resolvedTenant, files: chunks } };
        });
      },
      {
        description:
          'Downloads ONE PDF covering every payslip in a date range (instead of one file per month) — handy for printing/sharing a multi-year span at once. Automatically splits into multiple files for very long ranges (Hilan\'s combined-PDF endpoint has a practical ceiling of roughly 12-15 years per file due to a URL-length limit on their end).',
        inputSchema: {
          tenant: z
            .string()
            .optional()
            .describe(
              'Tenant subdomain, e.g. "amdocs". Optional if this server has COMPANY_URL / COMPANY_TENANT / COMPANY_CODE set in its env'
            ),
          fromMonth: z.string().describe('Start of the range (inclusive), "MM_YYYY" or "MM/YYYY", e.g. "01/2020"'),
          toMonth: z.string().describe('End of the range (inclusive), "MM_YYYY" or "MM/YYYY", e.g. "12/2025"'),
        },
      }
    );

    this.registerTool(
      'getPersonalDetails',
      async params => {
        const { tenant } = params as { tenant?: string };
        return this.withDb(async () => {
          const resolvedTenant = await this.resolveTenant(tenant);
          const details = await this.tenantService.getPersonalDetails(resolvedTenant);
          return { success: true, data: details };
        });
      },
      {
        description:
          'Logs in and fetches personal details (name, national ID, birthdate, address, phone, email, work start date, job type). This is a live lookup, not stored in the local database.',
        inputSchema: {
          tenant: z
            .string()
            .optional()
            .describe(
              'Tenant subdomain, e.g. "amdocs". Optional if this server has COMPANY_URL / COMPANY_TENANT / COMPANY_CODE set in its env'
            ),
        },
      }
    );

    // debugCallAsmx / debugDownloadPdf are an intentional escape hatch used
    // during development to explore Hilan's `.asmx` API surface directly —
    // debugCallAsmx can POST to any endpoint under the tenant's live
    // session (Hilan generally gates writes behind approval flows, but this
    // hasn't been audited), and debugDownloadPdf fetches an arbitrary
    // same-origin URL. Neither is needed for normal use, so both are
    // disabled unless explicitly opted into — never on by default for
    // strangers installing this from npm.
    if (process.env.HILAN_ENABLE_DEBUG_TOOLS === '1') {
      this.registerTool(
        'debugCallAsmx',
        async params => {
          const { tenant, servicePath, body } = params as { tenant?: string; servicePath: string; body?: Record<string, unknown> };
          if (!servicePath) throw new Error('servicePath is required');
          return this.withDb(async () => {
            const resolvedTenant = await this.resolveTenant(tenant);
            const result = await this.tenantService.debugCallAsmx(resolvedTenant, servicePath, body ?? {});
            return { success: true, data: result };
          });
        },
        {
          description:
            'DEBUG/exploration only: raw pass-through to any PaySlipApiapi/Form106Apiapi .asmx endpoint on a logged-in session, for testing API behavior. Not for regular use.',
          inputSchema: {
            tenant: z.string().optional(),
            servicePath: z.string().describe('e.g. "PaySlipApiapi.asmx/GetMultiplePaySlipData"'),
            body: z.record(z.unknown()).optional().describe('JSON body to POST'),
          },
        }
      );

      this.registerTool(
        'debugDownloadPdf',
        async params => {
          const { tenant, relativeUrl, fileName } = params as { tenant?: string; relativeUrl: string; fileName: string };
          if (!relativeUrl || !fileName) throw new Error('relativeUrl and fileName are required');
          return this.withDb(async () => {
            const resolvedTenant = await this.resolveTenant(tenant);
            const path = await this.tenantService.debugDownloadPdf(resolvedTenant, relativeUrl, fileName);
            return { success: true, data: { path } };
          });
        },
        {
          description: 'DEBUG/exploration only: download an arbitrary relative PDF URL (e.g. one returned by debugCallAsmx) to inspect it. Not for regular use.',
          inputSchema: {
            tenant: z.string().optional(),
            relativeUrl: z.string(),
            fileName: z.string(),
          },
        }
      );
    }

    this.registerTool(
      'resyncPayslipMonth',
      async params => {
        const { tenant, period, skipPdf } = params as { tenant?: string; period: string; skipPdf?: boolean };
        if (!period) throw new Error('period is required');
        return this.withDb(async () => {
          const resolvedTenant = await this.resolveTenant(tenant);
          const result = await this.tenantService.resyncPayslipMonth(resolvedTenant, period, skipPdf ?? false);
          return { success: true, data: { tenant: resolvedTenant, period, payslip: result } };
        });
      },
      {
        description:
          'Re-fetch a single specific month (structured data, and by default the PDF too), overwriting whatever is already stored for it. Use this to retry one bad/truncated PDF, or to quickly check one month\'s numbers, instead of re-running syncPayslips over the whole history.',
        inputSchema: {
          tenant: z
            .string()
            .optional()
            .describe(
              'Tenant subdomain, e.g. "amdocs". Optional if this server has COMPANY_URL / COMPANY_TENANT / COMPANY_CODE set in its env'
            ),
          period: z
            .string()
            .describe('The month to resync, as "MM_YYYY" (matches the stored period key) or "MM/YYYY", e.g. "10_2019" or "10/2019"'),
          skipPdf: z
            .boolean()
            .optional()
            .describe('If true, only fetch the structured Bruto/Neto/parts data and skip the PDF — fast, no browser download. Default false.'),
        },
      }
    );

    this.registerTool(
      'syncForm106',
      async params => {
        const { tenant, year } = params as { tenant?: string; year?: string };
        return this.withDb(async () => {
          const resolvedTenant = await this.resolveTenant(tenant);
          const result = await this.tenantService.syncForm106(resolvedTenant, year);
          return { success: true, data: { tenant: resolvedTenant, form106: result } };
        });
      },
      {
        description: 'Log into a Hilan tenant and download Form 106 (annual tax summary) for a given year, or the default year',
        inputSchema: {
          tenant: z
            .string()
            .optional()
            .describe(
              'Tenant subdomain, e.g. "amdocs". Optional if this server has COMPANY_URL / COMPANY_TENANT / COMPANY_CODE set in its env'
            ),
          year: z.string().optional().describe('Tax year, e.g. "2025" (defaults to the tenant\'s current default year)'),
        },
      }
    );

    this.registerTool(
      'listTables',
      async () => {
        return this.withDb(async db => {
          const result = await db.listTables();
          if (!result.success) throw new Error(result.error || 'Failed to list tables');
          return { success: true, data: { tables: result.tables } };
        });
      },
      { description: 'List queryable tables (payslips, form106 — credentials/sessions are never exposed here)' }
    );

    this.registerTool(
      'describeTable',
      async params => {
        const { table } = params as { table: string };
        if (!table) throw new Error('Table name is required');
        return this.withDb(async db => {
          const columnsResult = await db.executeSafeSelectQuery(`PRAGMA table_info(${table})`);
          const indexesResult = await db.executeSafeSelectQuery(`PRAGMA index_list(${table})`);
          if (!columnsResult.success) throw new Error(columnsResult.error || 'Failed to get table columns');
          if (!indexesResult.success) throw new Error(indexesResult.error || 'Failed to get table indexes');
          return { success: true, data: { columns: columnsResult.data, indexes: indexesResult.data } };
        });
      },
      {
        description: 'Get columns and indexes for a table (payslips or form106 only)',
        inputSchema: { table: z.enum(['payslips', 'form106']).describe('Table to describe') },
      }
    );

    this.registerTool(
      'query',
      async params => {
        const { sql } = params as { sql: string };
        if (!sql) throw new Error('sql is required');
        return this.withDb(async db => {
          const result = await db.executeSafeSelectQuery(sql);
          if (!result.success) throw new Error(result.error || 'Query execution failed');
          return { success: true, data: result.data };
        });
      },
      {
        description:
          'Execute a SELECT-only SQL query against payslips/form106 (allowlisted; credentials/sessions/tenants are never reachable)',
        inputSchema: { sql: z.string().describe('SQL SELECT query, e.g. "SELECT * FROM payslips ORDER BY period DESC"') },
      }
    );
  }

  public async start() {
    try {
      await this.server.connect(new StdioServerTransport());
      console.error('hilan-mcp server started successfully');
    } catch (error) {
      console.error('Failed to start hilan-mcp server:', redactError(error));
      throw error;
    }
  }

  public async close() {
    await this.server.close();
  }
}

const isMain = process.argv[1] && process.argv[1] === new URL(import.meta.url).pathname;

/** Exported so the `hilan-mcp` CLI's default command can start the server without re-executing this module as a script. */
export async function main() {
  try {
    const server = new Server();
    await server.start();
  } catch (error) {
    console.error('Failed to start hilan-mcp server:', redactError(error));
    process.exit(1);
  }
}

if (isMain) {
  main().catch(error => {
    console.error('Unhandled error in hilan-mcp server:', redactError(error));
    process.exit(1);
  });
}

export { Server };
