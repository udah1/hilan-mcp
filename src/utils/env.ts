/**
 * Optional MCP-server-level defaults for single-tenant setups (the common
 * case: one person, one employer), so the `tenant` argument can be omitted
 * from every tool call and configured once in the MCP server's `env` block
 * instead.
 *
 * Only the FIRST one found is used, in this precedence order:
 *   1. COMPANY_URL      — full URL, e.g. "https://amdocs.net.hilan.co.il"
 *   2. COMPANY_TENANT    — bare subdomain, e.g. "amdocs"
 *   3. COMPANY_CODE      — numeric org code, e.g. "5227" (requires a
 *                          resolution round-trip against net.hilan.co.il)
 *
 * An explicit `tenant` argument passed to a tool call, or `--tenant` passed
 * to the CLI, always overrides these.
 */
export function getDefaultTenantInput(): string | undefined {
  const url = process.env.COMPANY_URL?.trim();
  if (url) return url;

  const tenant = process.env.COMPANY_TENANT?.trim();
  if (tenant) return tenant;

  const code = process.env.COMPANY_CODE?.trim();
  if (code) return code;

  return undefined;
}
