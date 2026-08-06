import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getAppDataPath } from '../services/DatabaseService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * A "day" cadence for both the network check and re-surfacing an
 * already-shown (but not explicitly dismissed) notice — frequent enough to
 * eventually reach the user, not so frequent it nags on every tool call.
 */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const REGISTRY_URL = 'https://registry.npmjs.org/hilan-mcp/latest';
const FETCH_TIMEOUT_MS = 3000;

interface UpdateCheckState {
  lastCheckedAt?: string;
  latestKnownVersion?: string;
  /** The version we last surfaced an updateNotice for in a tool response. */
  lastNotifiedVersion?: string;
  lastNotifiedAt?: string;
  /** Version the user explicitly said "no" to — never re-notify for this exact version. */
  dismissedVersion?: string;
}

function getStateFilePath(): string {
  // Overridable so unit tests don't read/write the real user's app-data dir.
  const dir = process.env.HILAN_UPDATE_CHECK_STATE_DIR || join(getAppDataPath(), 'HilanMcp');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return join(dir, 'update-check.json');
}

function readState(): UpdateCheckState {
  try {
    const raw = readFileSync(getStateFilePath(), 'utf8');
    return JSON.parse(raw) as UpdateCheckState;
  } catch {
    return {};
  }
}

function writeState(state: UpdateCheckState): void {
  try {
    writeFileSync(getStateFilePath(), JSON.stringify(state, null, 2), { mode: 0o600 });
  } catch {
    // best-effort — an update check is a nicety, never worth crashing the server over
  }
}

/** Reads this package's own version from package.json (two levels up from dist/utils/). */
export function getCurrentVersion(): string {
  try {
    const pkgPath = join(__dirname, '../../package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Basic semver comparison good enough for "is latest newer than current" — no pre-release handling needed for this project's release cadence. */
function isNewerVersion(latest: string, current: string): boolean {
  const a = latest.split('.').map(n => parseInt(n, 10) || 0);
  const b = current.split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

async function fetchLatestVersion(): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(REGISTRY_URL, { signal: controller.signal });
      if (!res.ok) return null;
      const data = (await res.json()) as { version?: string };
      return data.version ?? null;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    // Offline, registry unreachable, corporate proxy blocking it, etc. — never
    // let an update check be the reason a tool call fails.
    return null;
  }
}

export interface UpdateNotice {
  currentVersion: string;
  latestVersion: string;
  message: string;
}

/**
 * Call this once per tool invocation. Returns an `UpdateNotice` to attach to
 * the tool's response at most once a day, and never again for a version the
 * user has explicitly dismissed via `dismissUpdateNotice`. Never throws.
 */
export async function checkForUpdateNotice(): Promise<UpdateNotice | null> {
  const currentVersion = getCurrentVersion();
  const state = readState();
  const now = Date.now();

  const lastCheckedAt = state.lastCheckedAt ? Date.parse(state.lastCheckedAt) : 0;
  let latestVersion = state.latestKnownVersion;

  if (!lastCheckedAt || now - lastCheckedAt >= CHECK_INTERVAL_MS) {
    const fetched = await fetchLatestVersion();
    if (fetched) {
      latestVersion = fetched;
      state.latestKnownVersion = fetched;
    }
    state.lastCheckedAt = new Date(now).toISOString();
    writeState(state);
  }

  if (!latestVersion || !isNewerVersion(latestVersion, currentVersion)) {
    return null;
  }

  if (state.dismissedVersion === latestVersion) {
    return null;
  }

  const lastNotifiedAt = state.lastNotifiedAt ? Date.parse(state.lastNotifiedAt) : 0;
  const alreadyNotifiedThisVersion = state.lastNotifiedVersion === latestVersion;
  if (alreadyNotifiedThisVersion && now - lastNotifiedAt < CHECK_INTERVAL_MS) {
    return null;
  }

  state.lastNotifiedVersion = latestVersion;
  state.lastNotifiedAt = new Date(now).toISOString();
  writeState(state);

  return {
    currentVersion,
    latestVersion,
    message:
      `A new hilan-mcp version is available: ${currentVersion} -> ${latestVersion}. ` +
      `Ask the user if they'd like to update (e.g. by removing any pinned version in their ` +
      `MCP client config's "args" so \`npx hilan-mcp\` picks up the latest, or re-running ` +
      `\`npx hilan-mcp@latest\`), then restart this MCP server. If the user declines, call ` +
      `the "dismissUpdateNotice" tool with version "${latestVersion}" so they aren't asked ` +
      `about this same version again.`,
  };
}

/** Persists that the user declined the update to `version` — suppresses that specific version's notice going forward. */
export function dismissUpdateVersion(version: string): void {
  const state = readState();
  state.dismissedVersion = version;
  writeState(state);
}

/**
 * Attaches an `_updateNotice` message to a tool's result object, if there is
 * one to show. Only merges into plain objects (not arrays/primitives) —
 * anything else is returned unchanged, since there's no sensible place to
 * splice an extra field into it. Extracted as a pure function so Server.ts's
 * wiring (`registerTool`) is directly unit-testable without spinning up the
 * whole MCP transport.
 */
export function mergeUpdateNotice(result: unknown, notice: UpdateNotice | null): unknown {
  if (!notice) return result;
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    return { ...(result as Record<string, unknown>), _updateNotice: notice.message };
  }
  return result;
}
