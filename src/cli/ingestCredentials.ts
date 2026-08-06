import inquirer from 'inquirer';
import { getDbInstance } from '../services/DatabaseService.js';
import { encryptionKeyService } from '../services/EncryptionKeyService.js';
import { HilanClient, fieldPromptLabel } from '../services/HilanClient.js';
import { createSection, logInfo, logSuccess, logError } from '../utils/cli.js';

async function promptForEncryptionKey(confirm = true): Promise<string> {
  const answers = await inquirer.prompt([
    {
      type: 'password',
      name: 'key',
      message: 'Enter encryption key (min 6 characters):',
      validate: (input: string) => (input.length < 6 ? 'Encryption key must be at least 6 characters long' : true),
    },
  ]);

  if (confirm) {
    await inquirer.prompt([
      {
        type: 'password',
        name: 'confirmKey',
        message: 'Confirm encryption key:',
        validate: (input: string) => (input !== answers.key ? 'Encryption keys do not match' : true),
      },
    ]);
  }

  return answers.key;
}

/**
 * Resolves `tenantInput` (an org code, a bare subdomain, or a full URL) to a
 * tenant subdomain, discovers that tenant's actual login form fields, and
 * interactively prompts (masked for password-type fields) for each one.
 * Never accepts credentials as CLI arguments — this must be run directly by
 * the user in their own terminal, never through an assistant's Shell tool.
 */
export async function ingestCredentials(tenantInput: string, encryptionKey?: string): Promise<void> {
  const isOrgCode = /^\d+$/.test(tenantInput.trim());
  const orgCode = isOrgCode ? tenantInput.trim() : null;

  logInfo(isOrgCode ? `Resolving org code "${tenantInput}"...` : `Using tenant "${tenantInput}"...`);

  const subdomain = await HilanClient.resolveTenantInput(tenantInput);
  if (isOrgCode) {
    logInfo(`Org code resolved to tenant subdomain: ${subdomain}`);
  }

  logInfo(`Loading login page for the tenant to detect its fields...`);
  const fields = await HilanClient.discoverLoginFields(subdomain);
  logInfo(`Detected ${fields.length} field(s): ${fields.map(f => f.id).join(', ')}`);

  const dbService = getDbInstance();
  const dbExists = await dbService.databaseExists();

  try {
    if (!dbExists) {
      logInfo('New database detected. Setting up encryption...');
      const key = encryptionKey || (await promptForEncryptionKey());
      encryptionKeyService.setKey(key);
    } else {
      logInfo('Existing database detected. Please enter the encryption key:');
      const key = encryptionKey || (await promptForEncryptionKey(false));
      encryptionKeyService.setKey(key);
    }

    logInfo('Initializing database...');
    await dbService.initialize();
  } catch (error) {
    logError(`Failed to initialize database: ${error instanceof Error ? error.message : 'Unknown error'}`);
    process.exit(1);
  }

  console.log(createSection({ title: `Credentials for ${subdomain}`, emoji: '🔑', color: 'blue' }));

  const values: Record<string, string> = {};
  for (const field of fields) {
    const answer = await inquirer.prompt([
      {
        type: field.type === 'password' ? 'password' : 'input',
        name: 'value',
        message: `  ${fieldPromptLabel(field)}`,
        validate: (input: string) => (input.trim().length === 0 ? 'This field is required' : true),
      },
    ]);
    values[field.id] = answer.value;
  }

  await dbService.upsertTenant(subdomain, orgCode);
  await dbService.setTenantDiscoveredFields(
    subdomain,
    JSON.stringify(fields.map(f => ({ id: f.id, placeholder: f.placeholder, type: f.type })))
  );
  await dbService.upsertCredentials(subdomain, JSON.stringify(values));

  console.log(createSection({ title: 'Success!', emoji: '✅', color: 'green' }));
  logSuccess(`Credentials for "${subdomain}" have been stored (encrypted). Login has not been tested yet.`);
  logInfo('Call the syncPayslips or syncForm106 MCP tool to log in and fetch data for this tenant.');
}
