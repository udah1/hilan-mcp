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
present to respond to a prompt every time), it looks for the key in this
order:

1. **OS credential store** (recommended) — run `npm run setup-key` once,
   yourself, in your own terminal. You'll be asked to type a key (or press
   Enter to generate a strong random one), and it's stored in your OS's
   native secure storage: **macOS Keychain** (verified — same file that
   holds your Wi-Fi/browser passwords, silent, no dialogs), **Windows**
   (DPAPI, tied to your Windows user account), or **Linux** (Secret
   Service / `secret-tool`, needs a keyring daemon like GNOME Keyring or
   KWallet). Nothing ends up in any config file at all.
2. **`HILAN_DB_KEY` env var** — set it in the server's `env` block (see
   step 2). Same trust model as any other API key/secret configured for an
   MCP server in `mcp.json` (local file, not committed to git).
3. **Desktop notification** (last resort) — the server falls back to
   asking via a system notification (with a plain terminal prompt as a
   further fallback), but that requires a human to respond within ~30s of
   every tool call that needs the database, so it's not recommended for
   normal use.

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
        "HILAN_DB_KEY": "the-encryption-key-you-set-during-ingest-creds",
        "NODE_EXTRA_CA_CERTS": "/path/to/your-corporate-ca-bundle.pem"
      }
    }
  }
}
```

`HILAN_DB_KEY` is only needed if you didn't run `npm run setup-key` (see
step 1) — the OS credential store takes priority when both are present.
`NODE_EXTRA_CA_CERTS` is only needed on networks with a TLS-intercepting
corporate proxy (see Reliability notes below) — omit it otherwise.

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
| `syncPayslips(tenant?, monthsBack?, skipPdf?)` | Logs in (reusing a saved session if it still works), fetches structured Bruto/Neto/salary-parts data for the last N months (default 3), and downloads each payslip PDF. Set `skipPdf: true` for a much faster numbers-only sync (e.g. "what did I earn this year"). `tenant` is optional if `COMPANY_URL`/`COMPANY_TENANT`/`COMPANY_CODE` is set (see above). The tenant's own archive length caps how far back this can actually go — no need to guess a start date. |
| `resyncPayslipMonth(tenant?, period, skipPdf?)` | Re-fetches **one specific month** (e.g. `"10_2019"` or `"10/2019"`), overwriting whatever's stored. Use this instead of re-running `syncPayslips` over the whole history just to retry one bad/truncated PDF or to answer a one-off "how much did I make in month X" question. |
| `syncForm106(tenant?, year?)` | Logs in and downloads the Form 106 PDF for a given year (or the tenant's default year). Same `tenant` fallback as above. |
| `listTables` | Lists queryable tables (`payslips`, `form106` only). |
| `describeTable(table)` | Columns + indexes for `payslips` or `form106`. |
| `query(sql)` | SELECT-only SQL against `payslips`/`form106`. **`credentials`, `sessions`, and `tenants` are hard-blocked** — see Security below. Good for quick questions like "how much net/gross did I earn in June 2026" without touching the network at all. |
| `getPersonalDetails(tenant?)` | Logs in and returns personal details (name, national ID, birthdate, address, phone, email, work start date, job type). Live lookup only — **not persisted** to the local database. |
| `debugCallAsmx(tenant?, servicePath, body?)` | **Debug/exploration only** — raw pass-through to any `.asmx` endpoint on a logged-in session, for probing API behavior. Not meant for regular use. |
| `debugDownloadPdf(tenant?, relativeUrl, fileName)` | **Debug/exploration only** — download an arbitrary relative PDF URL (e.g. one returned by `debugCallAsmx`) to inspect it. Not meant for regular use. |

**Concurrency note**: every tool call for a given tenant is automatically
queued and run one-at-a-time internally (see `TenantService.runExclusive`)
— Hilan's site (and/or the network path to it) doesn't handle concurrent
requests from one session well and everything times out otherwise. You
don't need to serialize calls yourself; different tenants still run fully
in parallel.

## Scope (v1)

- ✅ Payslips (list, structured Bruto/Neto/parts, PDF)
- ✅ Form 106 (PDF, per year)
- ⛔ Personal details, general file archive, Form 101 — not built (v1.1+)
- ⛔ One-time-code / 2FA login — tenants that require it return a clear
  "unsupported" error instead of hanging

Tenants whose internal API response doesn't match the structured shape seen
on the reference tenant (Amdocs) are marked `pdf_only`: payslip syncs still
work and still save a PDF, just without the parsed Bruto/Neto numbers.

### Reliability notes (learned from a real end-to-end run)

- **Corporate TLS-intercepting proxies** (e.g. Amdocs's network) break
  Playwright's Node-side `context.request` for the internal API/PDF calls
  with `self-signed certificate in certificate chain`. Set
  `NODE_EXTRA_CA_CERTS` to your organization's exported CA bundle in the
  server's `env` block if you hit this.
- **Direct PDF download URLs are relative to `/Hilannetv2`**, not the
  domain root — a URL returned by the JSON API like
  `PersonalFile/PdfPaySlip.aspx/...` actually lives at
  `<tenant>/Hilannetv2/PersonalFile/PdfPaySlip.aspx/...`. Confirmed via a
  live browser network capture.
- PDF downloads go through an **in-page `fetch()`** (same-origin, raw URL)
  rather than `context.request`, which silently re-encodes literal `/` in
  query strings to `%2F` and gets 404'd by some endpoints.
- The same corporate proxy occasionally **truncates a PDF response
  mid-stream** (observed: suspiciously round 32768-byte cutoffs) without
  the fetch itself erroring. `downloadPdf` checks the whole buffer for the
  standard `%%EOF` PDF trailer (not just the tail — some genuine Hilan
  PDFs have tens/hundreds of KB of trailing null-byte padding *after* a
  valid `%%EOF`) and retries up to 3 times before giving up.
- Combined multi-month PDFs (`PaySlipApiapi.asmx/GetMultiplePaySlipData`,
  one file covering a date range instead of one per month) hit a hard
  **HTTP 404 once the URL exceeds ~2048 characters** — that's IIS's
  default `requestFiltering maxQueryString` limit, not a Hilan-specific
  cap. In practice that's roughly 24 months (2 years) per combined PDF;
  requesting the full ~16-year history in one combined file fails. Not an
  issue for per-month syncing (`syncPayslips`), which never hits this.
- A tenant's *regular* login page can unconditionally show a "log in with
  a one-time code" button/link even when normal username+password login
  is fully supported and working — don't treat that text alone as proof
  OTP is required. Only genuinely new OTP-input fields (or navigating to
  an OTP-specific route) after a failed login count as OTP being required.

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
- `debugCallAsmx` is an intentional escape hatch: it lets a logged-in
  session call **any** `.asmx` endpoint with **any** body, bypassing the
  curated tools above. It was added for API exploration during
  development and is one-employee-scoped (same session, same
  permissions you already have on the site) — it can't reach other
  employees' data or other tenants — but it could in principle call a
  write endpoint (Hilan generally gates writes behind approval flows, but
  this hasn't been audited). Treat it like `query`'s SQL escape hatch:
  fine for an AI assistant you trust to explore with, not something to
  expose to untrusted input.

## Development

```bash
npm run typecheck
npm test                 # SQL-allowlist unit tests
npm run start:mcp        # run the server directly (stdio transport)
npm run ingest-creds     # register a tenant + credentials (interactive, run yourself)
npm run setup-key        # store the DB encryption key in your OS credential store (interactive, run yourself)
```

## License

MIT
