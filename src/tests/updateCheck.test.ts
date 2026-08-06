import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

async function freshModule() {
  vi.resetModules();
  return import('../utils/updateCheck.js');
}

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'hilan-mcp-update-check-'));
  process.env.HILAN_UPDATE_CHECK_STATE_DIR = stateDir;
});

afterEach(() => {
  delete process.env.HILAN_UPDATE_CHECK_STATE_DIR;
  rmSync(stateDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

function mockRegistryVersion(version: string | null) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: version !== null,
      json: async () => ({ version }),
    }))
  );
}

describe('checkForUpdateNotice', () => {
  it('returns null when the registry has no newer version than current', async () => {
    const { checkForUpdateNotice, getCurrentVersion } = await freshModule();
    mockRegistryVersion(getCurrentVersion());
    expect(await checkForUpdateNotice()).toBeNull();
  });

  it('returns a notice the first time a newer version is seen', async () => {
    const { checkForUpdateNotice, getCurrentVersion } = await freshModule();
    const current = getCurrentVersion();
    const [major, minor, patch] = current.split('.').map(Number);
    const newer = `${major}.${minor}.${patch + 1}`;
    mockRegistryVersion(newer);

    const notice = await checkForUpdateNotice();
    expect(notice).not.toBeNull();
    expect(notice?.latestVersion).toBe(newer);
    expect(notice?.currentVersion).toBe(current);
  });

  it('does not repeat the notice for the same version on an immediate second call', async () => {
    const { checkForUpdateNotice, getCurrentVersion } = await freshModule();
    const current = getCurrentVersion();
    const [major, minor, patch] = current.split('.').map(Number);
    const newer = `${major}.${minor}.${patch + 1}`;
    mockRegistryVersion(newer);

    const first = await checkForUpdateNotice();
    const second = await checkForUpdateNotice();
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('never re-notifies about a version once dismissed', async () => {
    const { checkForUpdateNotice, dismissUpdateVersion, getCurrentVersion } = await freshModule();
    const current = getCurrentVersion();
    const [major, minor, patch] = current.split('.').map(Number);
    const newer = `${major}.${minor}.${patch + 1}`;
    mockRegistryVersion(newer);

    dismissUpdateVersion(newer);
    const notice = await checkForUpdateNotice();
    expect(notice).toBeNull();
  });

  it('never throws when the registry is unreachable', async () => {
    const { checkForUpdateNotice } = await freshModule();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      })
    );
    await expect(checkForUpdateNotice()).resolves.toBeNull();
  });

  it('does not hit the network again on a second call within the 24h cache window', async () => {
    const { checkForUpdateNotice, getCurrentVersion } = await freshModule();
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ version: getCurrentVersion() }) }));
    vi.stubGlobal('fetch', fetchMock);

    await checkForUpdateNotice();
    await checkForUpdateNotice();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still notifies about an even newer version after an older one was dismissed', async () => {
    const { checkForUpdateNotice, dismissUpdateVersion, getCurrentVersion } = await freshModule();
    const current = getCurrentVersion();
    const [major, minor, patch] = current.split('.').map(Number);
    const dismissed = `${major}.${minor}.${patch + 1}`;
    const evenNewer = `${major}.${minor}.${patch + 2}`;

    dismissUpdateVersion(dismissed);
    mockRegistryVersion(evenNewer);

    const notice = await checkForUpdateNotice();
    expect(notice?.latestVersion).toBe(evenNewer);
  });

  it('exposes a well-formed semver-like current version', async () => {
    const { getCurrentVersion } = await freshModule();
    expect(getCurrentVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('mergeUpdateNotice', () => {
  const notice = { currentVersion: '0.1.0', latestVersion: '0.2.0', message: 'update available' };

  it('returns the result unchanged when there is no notice', async () => {
    const { mergeUpdateNotice } = await freshModule();
    expect(mergeUpdateNotice({ success: true }, null)).toEqual({ success: true });
  });

  it('splices _updateNotice into a plain-object result', async () => {
    const { mergeUpdateNotice } = await freshModule();
    expect(mergeUpdateNotice({ success: true, data: { a: 1 } }, notice)).toEqual({
      success: true,
      data: { a: 1 },
      _updateNotice: 'update available',
    });
  });

  it('leaves an array result untouched even when a notice is present (no sensible place to attach a field)', async () => {
    const { mergeUpdateNotice } = await freshModule();
    expect(mergeUpdateNotice([1, 2, 3], notice)).toEqual([1, 2, 3]);
  });

  it('leaves a primitive result untouched even when a notice is present', async () => {
    const { mergeUpdateNotice } = await freshModule();
    expect(mergeUpdateNotice('plain string', notice)).toBe('plain string');
    expect(mergeUpdateNotice(null, notice)).toBeNull();
  });
});
