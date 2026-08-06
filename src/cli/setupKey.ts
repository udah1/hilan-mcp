import { randomBytes } from 'crypto';
import inquirer from 'inquirer';
import { setSecretInOsStore } from '../utils/secretStore.js';
import { logError, logInfo, logSuccess, logWarning } from '../utils/cli.js';

function generateStrongKey(): string {
  return randomBytes(24).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);
}

/**
 * Stores the DB encryption key in this OS's native credential store
 * (macOS Keychain / Windows DPAPI / Linux Secret Service) so the MCP server
 * never has to ask for it interactively again. Run this yourself, directly
 * in your own terminal.
 */
export async function setupKey(): Promise<void> {
  const { key } = await inquirer.prompt([
    {
      type: 'password',
      name: 'key',
      message: 'Enter an encryption key (min 6 chars), or press Enter to generate a strong random one:',
    },
  ]);

  let finalKey: string = key.trim();
  const generated = finalKey.length === 0;
  if (generated) {
    finalKey = generateStrongKey();
  }

  if (finalKey.length < 6) {
    logError('Encryption key must be at least 6 characters long.');
    process.exit(1);
  }

  const stored = setSecretInOsStore(finalKey);
  if (!stored) {
    logError(
      `Could not store the key in this OS's credential store (not available on ${process.platform}, or the required tool is missing).`
    );
    logInfo('Fall back to setting HILAN_DB_KEY yourself in the MCP server\'s env block in mcp.json instead.');
    process.exit(1);
  }

  logSuccess('Encryption key stored securely in your OS credential store.');
  if (generated) {
    logWarning(`Your generated key (save this somewhere safe as a backup — you normally won't need to type it again):`);
    console.log(`  ${finalKey}`);
  }
  logInfo('The MCP server will now pick it up automatically on startup — no HILAN_DB_KEY env var needed.');
  logInfo(
    'If HILAN_DB_KEY is also set in mcp.json, this stored key takes priority — you can remove that env var now if you like.'
  );
}
