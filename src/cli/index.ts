#!/usr/bin/env node

import '../utils/consoleRedirect.js';

import { program } from 'commander';
import { ingestCredentials } from './ingestCredentials.js';
import { setupKey } from './setupKey.js';
import { HilanClient } from '../services/HilanClient.js';
import { getDefaultTenantInput } from '../utils/env.js';
import { configureLogger } from '../utils/logger.js';

configureLogger({ enableConsoleOutput: true });

program.name('hilan-mcp').description('CLI for managing hilan-mcp Hilan tenants').version('0.1.0');

program
  .command('ingest-creds')
  .description(
    'Register a Hilan tenant and interactively enter its login credentials (run this yourself, in your own terminal — never paste credentials into chat)'
  )
  .option(
    '-t, --tenant <orgCodeOrSubdomain>',
    'Org code (e.g. 5227) or tenant subdomain (e.g. amdocs). If omitted, falls back to the COMPANY_URL / COMPANY_TENANT / COMPANY_CODE env vars (first one set wins)'
  )
  .option(
    '-k, --key <key>',
    'Encryption key for the database (falls back to the HILAN_DB_KEY env var, then prompts if neither is set)'
  )
  .action(async options => {
    const tenantInput = options.tenant || getDefaultTenantInput();
    if (!tenantInput) {
      console.error(
        'No tenant specified. Pass --tenant, or set one of COMPANY_URL / COMPANY_TENANT / COMPANY_CODE in the environment.'
      );
      process.exit(1);
    }
    try {
      const key = options.key || process.env.HILAN_DB_KEY;
      await ingestCredentials(tenantInput, key);
      await HilanClient.shutdown();
      process.exit(0);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : 'Unknown error occurred');
      await HilanClient.shutdown();
      process.exit(1);
    }
  });

program
  .command('setup-key')
  .description(
    "Store the database encryption key in this OS's native credential store (macOS Keychain / Windows DPAPI / Linux Secret Service) so the MCP server never has to ask for it interactively"
  )
  .action(async () => {
    try {
      await setupKey();
      process.exit(0);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : 'Unknown error occurred');
      process.exit(1);
    }
  });

program.parse(process.argv);
