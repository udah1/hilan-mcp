import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDefaultTenantInput } from '../utils/env.js';

const ENV_KEYS = ['COMPANY_URL', 'COMPANY_TENANT', 'COMPANY_CODE'] as const;
const originalEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

describe('getDefaultTenantInput', () => {
  it('returns undefined when none are set', () => {
    expect(getDefaultTenantInput()).toBeUndefined();
  });

  it('returns COMPANY_URL when only it is set', () => {
    process.env.COMPANY_URL = 'https://amdocs.net.hilan.co.il';
    expect(getDefaultTenantInput()).toBe('https://amdocs.net.hilan.co.il');
  });

  it('prefers COMPANY_URL over COMPANY_TENANT and COMPANY_CODE', () => {
    process.env.COMPANY_URL = 'https://amdocs.net.hilan.co.il';
    process.env.COMPANY_TENANT = 'amdocs';
    process.env.COMPANY_CODE = '5227';
    expect(getDefaultTenantInput()).toBe('https://amdocs.net.hilan.co.il');
  });

  it('prefers COMPANY_TENANT over COMPANY_CODE when COMPANY_URL is unset', () => {
    process.env.COMPANY_TENANT = 'amdocs';
    process.env.COMPANY_CODE = '5227';
    expect(getDefaultTenantInput()).toBe('amdocs');
  });

  it('falls back to COMPANY_CODE when only it is set', () => {
    process.env.COMPANY_CODE = '5227';
    expect(getDefaultTenantInput()).toBe('5227');
  });

  it('trims whitespace and ignores blank values', () => {
    process.env.COMPANY_URL = '   ';
    process.env.COMPANY_TENANT = '  amdocs  ';
    expect(getDefaultTenantInput()).toBe('amdocs');
  });
});
