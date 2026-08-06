#!/usr/bin/env node

import '../utils/consoleRedirect.js';

import { spawnSync } from 'child_process';
import { program } from 'commander';
import { ingestCredentials } from './ingestCredentials.js';
import { setupKey } from './setupKey.js';
import { HilanClient } from '../services/HilanClient.js';
import { getDefaultTenantInput } from '../utils/env.js';
import { configureLogger } from '../utils/logger.js';
import { logInfo, logSuccess, logWarning } from '../utils/cli.js';
import { getCurrentVersion } from '../utils/updateCheck.js';

configureLogger({ enableConsoleOutput: true });

program
  .name('hilan-mcp')
  .description('MCP server for Hilan (Hilanet) payslips/Form106 — run with no arguments to start the MCP server itself (stdio transport)')
  .version(getCurrentVersion());

// Running the package with no subcommand is what an MCP client's config
// actually does (e.g. `{"command": "npx", "args": ["-y", "hilan-mcp"]}`),
// so that's the default action — matching how most MCP server npm
// packages behave. Explicit subcommands below are for one-time setup,
// meant to be run directly by a human in their own terminal.
program
  .command('mcp', { isDefault: true, hidden: true })
  .description('Start the MCP server (stdio transport) — this is the default when run with no arguments')
  .action(async () => {
    const { main } = await import('../mcp/Server.js');
    await main();
  });

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

program
  .command('setup')
  .description(
    'One-time onboarding: installs the Chromium browser Playwright needs, then walks you through ingest-creds. Run this yourself, once, in your own terminal.'
  )
  .option('-t, --tenant <orgCodeOrSubdomain>', 'Org code or tenant subdomain (same as ingest-creds --tenant)')
  .action(async options => {
    logInfo('Checking for the Chromium browser Playwright needs (one-time download if missing)...');
    const install = spawnSync('npx', ['--yes', 'playwright', 'install', 'chromium'], { stdio: 'inherit' });
    if (install.status !== 0) {
      logWarning('Could not confirm Chromium is installed — continuing anyway; ingest-creds will fail clearly if it is actually missing.');
    } else {
      logSuccess('Chromium is ready.');
    }

    const tenantInput = options.tenant || getDefaultTenantInput();
    if (!tenantInput) {
      console.error(
        'No tenant specified. Pass --tenant, or set one of COMPANY_URL / COMPANY_TENANT / COMPANY_CODE in the environment.'
      );
      process.exit(1);
    }
    try {
      await ingestCredentials(tenantInput, process.env.HILAN_DB_KEY);
      await HilanClient.shutdown();
      logInfo('Next: run `npx hilan-mcp setup-key` to store the DB encryption key securely (recommended), then add this server to your MCP client config — see the README.');
      process.exit(0);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : 'Unknown error occurred');
      await HilanClient.shutdown();
      process.exit(1);
    }
  });

program.parse(process.argv);
