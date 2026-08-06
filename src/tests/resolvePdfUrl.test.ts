import { describe, it, expect } from 'vitest';
import { resolvePdfUrl } from '../services/HilanClient.js';

describe('resolvePdfUrl', () => {
  it('resolves a relative URL under the tenant origin + /Hilannetv2', () => {
    const result = resolvePdfUrl('amdocs', 'PersonalFile/PdfPaySlip.aspx/foo.pdf');
    expect(result).toBe('https://amdocs.net.hilan.co.il/Hilannetv2/PersonalFile/PdfPaySlip.aspx/foo.pdf');
  });

  it('strips leading slashes from a relative URL before joining', () => {
    const result = resolvePdfUrl('amdocs', '/PersonalFile/PdfPaySlip.aspx/foo.pdf');
    expect(result).toBe('https://amdocs.net.hilan.co.il/Hilannetv2/PersonalFile/PdfPaySlip.aspx/foo.pdf');
  });

  it('accepts an absolute URL that is same-origin with the tenant', () => {
    const url = 'https://amdocs.net.hilan.co.il/Hilannetv2/PersonalFile/Pdf106.aspx/x.pdf';
    expect(resolvePdfUrl('amdocs', url)).toBe(url);
  });

  it('rejects an absolute URL pointing at a different domain (SSRF)', () => {
    expect(() => resolvePdfUrl('amdocs', 'https://evil.com/steal.pdf')).toThrow(/Refusing to fetch/);
  });

  it('rejects an absolute URL for a different Hilan tenant', () => {
    expect(() => resolvePdfUrl('amdocs', 'https://technion.net.hilan.co.il/Hilannetv2/x.pdf')).toThrow(
      /Refusing to fetch/
    );
  });
});
