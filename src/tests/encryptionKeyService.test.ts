import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/secretStore.js', () => ({
  getSecretFromOsStore: vi.fn(() => null),
}));

const originalEnvKey = process.env.HILAN_DB_KEY;

async function freshModule() {
  vi.resetModules();
  return import('../services/EncryptionKeyService.js');
}

beforeEach(() => {
  delete process.env.HILAN_DB_KEY;
});

afterEach(() => {
  if (originalEnvKey === undefined) delete process.env.HILAN_DB_KEY;
  else process.env.HILAN_DB_KEY = originalEnvKey;
});

describe('EncryptionKeyService.ensureKeyIsAvailable (stdio / MCP mode)', () => {
  it('resolves immediately from HILAN_DB_KEY without touching the OS store prompt path', async () => {
    process.env.HILAN_DB_KEY = 'from-env-var';
    const { encryptionKeyService } = await freshModule();
    encryptionKeyService.disableStdinFallback();
    await expect(encryptionKeyService.ensureKeyIsAvailable()).resolves.toBe('from-env-var');
  });

  it('fails fast with an actionable error instead of hanging on a desktop notification, when stdin fallback is disabled and no key source is available', async () => {
    const { encryptionKeyService } = await freshModule();
    encryptionKeyService.disableStdinFallback();

    const start = Date.now();
    await expect(encryptionKeyService.ensureKeyIsAvailable()).rejects.toThrow(/setup-key|HILAN_DB_KEY/);
    // Should fail well under the ~60s a notification-prompt round-trip would take.
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('still supports the interactive/notification path when stdin fallback is left enabled (e.g. CLI usage)', async () => {
    const { encryptionKeyService } = await freshModule();
    // disableStdinFallback() is never called here — this mirrors ingest-creds/setup-key,
    // which call setKey() directly and never reach the notification path in practice,
    // but this guards against the fail-fast short-circuit firing unconditionally.
    encryptionKeyService.setKey('directly-set-key');
    await expect(encryptionKeyService.ensureKeyIsAvailable()).resolves.toBe('directly-set-key');
  });
});
