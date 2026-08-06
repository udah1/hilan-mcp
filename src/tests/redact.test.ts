import { describe, it, expect } from 'vitest';
import { redactSecrets, redactError } from '../utils/redact.js';

describe('redactSecrets', () => {
  it('redacts a Playwright-style call-log cookie line', () => {
    const input = 'apiRequestContext.post: some error\nCall log:\n  - cookie: MRHSession=abc123; ASP.NET_SessionId=xyz\n  - other line';
    const result = redactSecrets(input);
    expect(result).not.toContain('MRHSession');
    expect(result).not.toContain('ASP.NET_SessionId');
    expect(result).toContain('cookie: [REDACTED]');
    expect(result).toContain('other line');
  });

  it('redacts a Set-Cookie header', () => {
    const result = redactSecrets('set-cookie: session=abc123; Path=/');
    expect(result).not.toContain('abc123');
  });

  it('redacts an Authorization bearer token', () => {
    const result = redactSecrets('Authorization: Bearer sk-secret-token-here');
    expect(result).not.toContain('sk-secret-token-here');
  });

  it('leaves unrelated text untouched', () => {
    const input = 'Failed to download PDF from https://example.com/x.pdf: HTTP 404';
    expect(redactSecrets(input)).toBe(input);
  });

  it('redactError extracts and redacts an Error message', () => {
    const err = new Error('boom\n  - cookie: MRHSession=abc123');
    expect(redactError(err)).not.toContain('abc123');
  });
});
