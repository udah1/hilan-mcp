import { execFileSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const SERVICE = 'hilan-mcp';
const ACCOUNT = 'db-key';

function tryExec(cmd: string, args: string[], input?: string): string | null {
  try {
    const out = execFileSync(cmd, args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/** Like `tryExec`, but for "set"-style commands that legitimately produce no stdout on success. */
function tryExecOk(cmd: string, args: string[], input?: string): boolean {
  try {
    execFileSync(cmd, args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

function windowsKeyFile(): string {
  const dir = join(process.env.APPDATA || homedir(), 'hilan-mcp');
  return join(dir, 'db-key.dat');
}

/**
 * Reads/writes the DB encryption key from each OS's native secure-credential
 * store, so it never has to sit in plaintext in `mcp.json` or be typed on
 * every server start:
 *
 * - macOS: Keychain, via the built-in `security` CLI. Verified working —
 *   silent, no dialog, no extra dependency.
 * - Windows: DPAPI (`ConvertTo-SecureString`/`ConvertFrom-SecureString` via
 *   PowerShell, both built into Windows). The resulting file is only
 *   decryptable by the same Windows user account on the same machine —
 *   equivalent security property to Keychain. Implemented per Microsoft's
 *   documented DPAPI mechanism, but NOT verified on a real Windows machine.
 * - Linux: Secret Service, via `secret-tool` (part of `libsecret-tools`) —
 *   the same backend GNOME/KDE apps use. Requires a running keyring daemon
 *   (standard on desktop Linux, often absent on headless/server Linux) and
 *   the package installed. NOT verified on a real Linux machine.
 *
 * Every path is wrapped so a failure (tool missing, feature unsupported,
 * anything) just returns null/false — callers should always have a further
 * fallback (env var, interactive prompt).
 */
export function getSecretFromOsStore(): string | null {
  switch (process.platform) {
    case 'darwin':
      return tryExec('security', ['find-generic-password', '-a', ACCOUNT, '-s', SERVICE, '-w']);
    case 'linux':
      return tryExec('secret-tool', ['lookup', 'service', SERVICE, 'account', ACCOUNT]);
    case 'win32':
      return getWindowsSecret();
    default:
      return null;
  }
}

export function setSecretInOsStore(value: string): boolean {
  switch (process.platform) {
    case 'darwin':
      return tryExecOk('security', ['add-generic-password', '-a', ACCOUNT, '-s', SERVICE, '-w', value, '-U']);
    case 'linux':
      return tryExecOk(
        'secret-tool',
        ['store', '--label=hilan-mcp database encryption key', 'service', SERVICE, 'account', ACCOUNT],
        value
      );
    case 'win32':
      return setWindowsSecret(value);
    default:
      return false;
  }
}

function getWindowsSecret(): string | null {
  const file = windowsKeyFile();
  if (!existsSync(file)) return null;
  const script = [
    `$enc = Get-Content -Raw -Path '${file}'`,
    '$secure = $enc | ConvertTo-SecureString',
    '$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)',
    '[Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)',
  ].join('; ');
  return tryExec('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
}

function setWindowsSecret(value: string): boolean {
  const file = windowsKeyFile();
  mkdirSync(join(file, '..'), { recursive: true });
  const escaped = value.replace(/'/g, "''");
  const script = [
    `$secure = ConvertTo-SecureString -String '${escaped}' -AsPlainText -Force`,
    `$secure | ConvertFrom-SecureString | Set-Content -Path '${file}'`,
  ].join('; ');
  return tryExecOk('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]) || existsSync(file);
}
