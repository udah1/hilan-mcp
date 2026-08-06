# hilan-mcp

An MCP server for **Hilan** (Hilanet, `net.hilan.co.il`) — the Israeli
payroll/HR self-service portal used by many companies. It lets an AI
assistant pull your **payslips** and **Form 106** (annual tax summary) for
any Hilan tenant, not just one specific employer.

Modeled on [`asher-mcp`](https://github.com/) (a sibling project solving the
same "log into an Israeli site, cache results, expose via MCP" problem for
bank/credit-card scrapers): encrypted local storage, no plaintext secrets in
`mcp.json`, tools that return aggregated data instead of dumping raw vendor
JSON into your context window.

## How it works

There's no official Hilan API. This server drives a real (headless)
Chromium browser via [Playwright](https://playwright.dev) to log in, then
reuses that same authenticated browser context's HTTP client
(`context.request`) to call Hilan's internal `.asmx` JSON endpoints and
download PDFs — so it automatically inherits whatever cookies/headers a real
page load would have set up, instead of a fragile hand-rolled cookie replay.

Login form fields differ per Hilan tenant (some have 2 fields, some 3), so
the login form is inspected fresh for each tenant the first time you ingest
credentials, rather than hardcoded to one company.

## Setup

```bash
npm install
npx playwright install chromium   # one-time browser download
```

### 1. Register a tenant and enter credentials

Run this **yourself**, directly in your own terminal — never paste real
credentials into an AI chat. This will launch a headless browser, detect
your tenant's actual login fields, and prompt you for each one (passwords
are masked):

```bash
npm run ingest-creds -- --tenant amdocs        # tenant subdomain
# or
npm run ingest-creds -- --tenant 5227          # numeric org code, resolved automatically
```

The first time you run this you'll be asked to set an **encryption key**
for the local database (min 6 characters) — this key is never written to
disk in plaintext.

For the MCP server to open the database on its own (without a human
present to respond to a prompt every time), set that same key as
`HILAN_DB_KEY` in the server's `env` block (see step 2) — same trust model
as any other API key/secret configured for an MCP server in `mcp.json`
(local file, not committed to git). If `HILAN_DB_KEY` isn't set, the server
falls back to asking via a desktop notification (with a plain terminal
prompt as a last resort) — but that requires a human to respond within
~30s of every tool call that needs the database, so it's not recommended
for normal use.

### 2. Add the server to your MCP client config

```json
{
  "mcpServers": {
    "hilan": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/hilan-mcp/src/mcp/Server.ts"]
    }
  }
}
```

If you only ever use this for **one** employer, you can set a default
tenant in the server's `env` block so you never have to pass `tenant` to
any tool call. Only the **first** of these that's set is used, in this
order — `COMPANY_URL` → `COMPANY_TENANT` → `COMPANY_CODE`:

```json
{
  "mcpServers": {
    "hilan": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/hilan-mcp/src/mcp/Server.ts"],
      "env": {
        "COMPANY_TENANT": "amdocs",
        "HILAN_DB_KEY": "the-encryption-key-you-set-during-ingest-creds"
      }
    }
  }
}
```

| Env var | Example | Notes |
|---|---|---|
| `COMPANY_URL` | `https://amdocs.net.hilan.co.il` | Highest priority. |
| `COMPANY_TENANT` | `amdocs` | Bare subdomain. Used only if `COMPANY_URL` isn't set. |
| `COMPANY_CODE` | `5227` | Numeric org code. Used only if neither above is set — requires an extra lookup round-trip against `net.hilan.co.il`. |

This same fallback also applies to `npm run ingest-creds` — `--tenant` is
optional if one of these env vars is set. An explicit `tenant` argument (or
`--tenant` flag) always overrides the env vars.

### 3. Use it

Ask your assistant things like "sync my last 3 payslips from Hilan" or
"download my Form 106 for 2025" — it will call the `syncPayslips` /
`syncForm106` tools below.

## MCP tools

| Tool | Description |
|---|---|
| `listTenants` | Configured tenants (subdomain, capability, whether login has succeeded before) — no secrets. |
| `syncPayslips(tenant?, monthsBack?)` | Logs in (reusing a saved session if it still works), fetches structured Bruto/Neto/salary-parts data for the last N months (default 3), and downloads each payslip PDF. `tenant` is optional if `COMPANY_URL`/`COMPANY_TENANT`/`COMPANY_CODE` is set (see above). |
| `syncForm106(tenant?, year?)` | Logs in and downloads the Form 106 PDF for a given year (or the tenant's default year). Same `tenant` fallback as above. |
| `listTables` | Lists queryable tables (`payslips`, `form106` only). |
| `describeTable(table)` | Columns + indexes for `payslips` or `form106`. |
| `query(sql)` | SELECT-only SQL against `payslips`/`form106`. **`credentials`, `sessions`, and `tenants` are hard-blocked** — see Security below. |

## Scope (v1)

- ✅ Payslips (list, structured Bruto/Neto/parts, PDF)
- ✅ Form 106 (PDF, per year)
- ⛔ Personal details, general file archive, Form 101 — not built (v1.1+)
- ⛔ One-time-code / 2FA login — tenants that require it return a clear
  "unsupported" error instead of hanging

Tenants whose internal API response doesn't match the structured shape seen
on the reference tenant (Amdocs) are marked `pdf_only`: payslip syncs still
work and still save a PDF, just without the parsed Bruto/Neto numbers.

## Security model

- The whole SQLite database (`~/Library/Application Support/HilanMcp/hilan.db`
  on macOS, XDG/AppData equivalents elsewhere) is encrypted at rest via
  SQLCipher (`better-sqlite3-multiple-ciphers`), keyed by a passphrase you
  choose that is **never persisted to disk**.
- `credentials` (your login fields) and `sessions` (saved browser cookies)
  are ordinary tables *inside* that encrypted database, but they are **never
  reachable through the `query`/`listTables`/`describeTable` tools** — those
  are hard-allowlisted to `payslips` and `form106` only (see
  `src/utils/sqlValidation.ts` and `src/tests/sqlValidation.test.ts`).
- Downloaded PDFs live under the same app-data directory with `chmod 600`
  permissions. Don't let that folder sync to iCloud/Dropbox/OneDrive.
- Credential entry (`ingest-creds`) must be run directly by you in your own
  terminal — never through an assistant's shell tool, whose transcript could
  capture what you typed.

## Development

```bash
npm run typecheck
npm test                 # SQL-allowlist unit tests
npm run start:mcp        # run the server directly (stdio transport)
```

## License

MIT
