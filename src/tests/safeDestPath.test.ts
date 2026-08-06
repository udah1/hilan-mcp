import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { safeDestPath, HilanLoginError } from '../services/HilanClient.js';

describe('safeDestPath', () => {
  const destDir = '/tmp/hilan-mcp-test-pdfs';

  it('allows a plain file name', () => {
    expect(safeDestPath(destDir, 'payslip-01_2025.pdf')).toBe(join(destDir, 'payslip-01_2025.pdf'));
  });

  it('strips directory components from a traversal attempt', () => {
    // basename() reduces "../../../.ssh/authorized_keys" to
    // "authorized_keys", so the write still lands (harmlessly) inside
    // destDir rather than escaping it.
    const result = safeDestPath(destDir, '../../../.ssh/authorized_keys');
    expect(result).toBe(join(destDir, 'authorized_keys'));
  });

  it('rejects an absolute path disguised as a file name', () => {
    // On POSIX, basename('/etc/passwd') === 'passwd', so this also just
    // lands inside destDir — verify it never resolves to /etc/passwd.
    const result = safeDestPath(destDir, '/etc/passwd');
    expect(result).toBe(join(destDir, 'passwd'));
    expect(result.startsWith(destDir)).toBe(true);
  });

  it('rejects a bare ".."', () => {
    expect(() => safeDestPath(destDir, '..')).toThrow(HilanLoginError);
  });

  it('rejects an empty file name', () => {
    expect(() => safeDestPath(destDir, '')).toThrow(HilanLoginError);
  });

  it('never produces a path outside destDir for any input', () => {
    const attempts = ['../evil.pdf', '../../evil.pdf', '....//....//evil.pdf', 'a/../../b.pdf'];
    for (const attempt of attempts) {
      const result = safeDestPath(destDir, attempt);
      expect(result === destDir || result.startsWith(destDir + '/')).toBe(true);
    }
  });
});
