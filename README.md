<div align="center">

# hilan-mcp

**An MCP server for [Hilan](https://net.hilan.co.il) (Hilanet / חילן, חילנט)** — pull your payslips and Form 106 into any AI assistant, for any Hilan tenant.

[![npm version](https://img.shields.io/npm/v/hilan-mcp.svg?color=cb3837&logo=npm)](https://www.npmjs.com/package/hilan-mcp)
[![npm downloads](https://img.shields.io/npm/dm/hilan-mcp.svg?color=blue)](https://www.npmjs.com/package/hilan-mcp)
[![license](https://img.shields.io/npm/l/hilan-mcp.svg?color=green)](https://github.com/udah1/hilan-mcp/blob/master/LICENSE)
[![node](https://img.shields.io/node/v/hilan-mcp.svg)](https://www.npmjs.com/package/hilan-mcp)

</div>

---

There's no official Hilan API. `hilan-mcp` drives a real (headless) Chromium
browser via [Playwright](https://playwright.dev) to log in, then reuses
that same authenticated session to call Hilan's internal endpoints and
download PDFs — no fragile hand-rolled cookie replay, and no plaintext
secrets stored anywhere.

## Table of contents

- [Features](#features)
- [How it works](#how-it-works)
- [Setup](#setup)
  - [0. If you're on npm 12 or newer](#0-if-youre-on-npm-12-or-newer)
  - [1. Register a tenant and enter credentials](#1-register-a-tenant-and-enter-credentials)
  - [2. Add the server to your MCP client config](#2-add-the-server-to-your-mcp-client-config)
  - [3. Use it](#3-use-it)
- [For AI agents setting this up on a user's behalf](#for-ai-agents-eg-claude-setting-this-up-on-a-users-behalf)
- [MCP tools](#mcp-tools)
- [Scope](#scope-v1)
- [Reliability notes](#reliability-notes-learned-from-a-real-end-to-end-run)
- [Security model](#security-model)
- [Development](#development)
- [License](#license)

## Features

- 📄 **Payslips** — structured Bruto/Neto/salary-parts data, plus the PDF, for any month in the tenant's history.
- 🧾 **Form 106** — annual tax summary PDFs, per year.
- 🔐 **Encrypted local storage** — SQLCipher-encrypted SQLite, key never written to disk in plaintext; OS-native credential store (Keychain/DPAPI/Secret Service) support.
- 🏢 **Any Hilan tenant** — login form fields are detected per-tenant instead of hardcoded to one employer.
- 💬 **Answers, not raw JSON** — tools like `query` answer "how much did I earn in June?" straight from local data, no network round-trip.
- 🔄 **Self-updating awareness** — the server checks for newer versions and lets your AI agent offer to update you, without needing its own UI.

## How it works

This server drives a real (headless) Chromium browser via
[Playwright](https://playwright.dev) to log in, then reuses that same
authenticated browser context's HTTP client (`context.request`) to call
Hilan's internal `.asmx` JSON endpoints and download PDFs — so it
automatically inherits whatever cookies/headers a real page load would
have set up, instead of a fragile hand-rolled cookie replay.

Login form fields differ per Hilan tenant (some have 2 fields, some 3), so
the login form is inspected fresh for each tenant the first time you ingest
credentials, rather than hardcoded to one company.

## Setup

### 0. If you're on npm 12 or newer

npm 12 blocks dependency install scripts unless you allow them, and one of
this package's dependencies (`better-sqlite3-multiple-ciphers`, the
encrypted SQLite engine) needs its install script to compile a native
binding. Without it, setup appears to succeed and then every tool that
touches the database fails. Allow it once, for all future `npx` and global
installs:

```bash
npm config set allow-scripts=better-sqlite3-multiple-ciphers --location=user
```

Or per install, if you'd rather not set it globally:

```bash
npm install -g --allow-scripts=better-sqlite3-multiple-ciphers hilan-mcp
```

On npm 11 and older this isn't needed — install scripts still run by
default. Check with `npm --version`.

### 1. Register a tenant and enter credentials

Run this **yourself**, directly in your own terminal — never paste real
credentials into an AI chat. It installs the Chromium browser Playwright
needs (one-time), launches a headless browser, detects your tenant's actual
login fields, and prompts you for each one (passwords are masked). No local
clone or `npm install` needed — `npx` fetches the package on the fly:

```bash
npx hilan-mcp setup --tenant amdocs        # tenant subdomain
# or
npx hilan-mcp setup --tenant 5227          # numeric org code, resolved automatically
```

> If you already have the package installed some other way, the equivalent
> lower-level command is `npx hilan-mcp ingest-creds --tenant <...>` —
> `setup` just also handles the one-time Chromium install first.

The first time you run this you'll be asked to set an **encryption key**
for the local database (min 6 characters) — this key is never written to
disk in plaintext.

For the MCP server to open the database on its own (without a human
present to respond to a prompt every time), it looks for the key in this
order:

1. **OS credential store** (recommended) — run `npx hilan-mcp setup-key`
   once, yourself, in your own terminal. You'll be asked to type a key (or
   press Enter to generate a strong random one), and it's stored in your
   OS's native secure storage: **macOS Keychain** (verified — same file
   that holds your Wi-Fi/browser passwords, silent, no dialogs),
   **Windows** (DPAPI, tied to your Windows user account), or **Linux**
   (Secret Service / `secret-tool`, needs a keyring daemon like GNOME
   Keyring or KWallet). Nothing ends up in any config file at all.
2. **`HILAN_DB_KEY` env var** — set it in the server's `env` block (see
   step 2). Same trust model as any other API key/secret configured for an
   MCP server in `mcp.json` (local file, not committed to git).
3. **Desktop notification** (last resort) — the server falls back to
   asking via a system notification (with a plain terminal prompt as a
   further fallback), but that requires a human to respond within ~30s of
   every tool call that needs the database, so it's not recommended for
   normal use.

### 2. Add the server to your MCP client config

Running the package with **no arguments** starts the MCP server itself
(stdio transport) — that's what your MCP client's config actually invokes:

```json
{
  "mcpServers": {
    "hilan": {
      "command": "npx",
      "args": ["-y", "hilan-mcp"]
    }
  }
}
```

<details>
<summary><strong>Single-employer setup — skip passing <code>tenant</code> on every tool call</strong></summary>

If you only ever use this for **one** employer, you can set a default
tenant in the server's `env` block. Only the **first** of these that's set
is used, in this order — `COMPANY_URL` → `COMPANY_TENANT` → `COMPANY_CODE`:

```json
{
  "mcpServers": {
    "hilan": {
      "command": "npx",
      "args": ["-y", "hilan-mcp"],
      "env": {
        "COMPANY_TENANT": "amdocs",
        "HILAN_DB_KEY": "the-encryption-key-you-set-during-ingest-creds",
        "NODE_EXTRA_CA_CERTS": "/path/to/your-corporate-ca-bundle.pem"
      }
    }
  }
}
```

`HILAN_DB_KEY` is only needed if you didn't run `npx hilan-mcp setup-key`
(see step 1) — the OS credential store takes priority when both are
present. `NODE_EXTRA_CA_CERTS` is only needed on networks with a
TLS-intercepting corporate proxy (see [Reliability notes](#reliability-notes-learned-from-a-real-end-to-end-run)) — omit it otherwise.

| Env var | Example | Notes |
|---|---|---|
| `COMPANY_URL` | `https://amdocs.net.hilan.co.il` | Highest priority. |
| `COMPANY_TENANT` | `amdocs` | Bare subdomain. Used only if `COMPANY_URL` isn't set. |
| `COMPANY_CODE` | `5227` | Numeric org code. Used only if neither above is set — requires an extra lookup round-trip. |

This same fallback also applies to `npx hilan-mcp ingest-creds` —
`--tenant` is optional if one of these env vars is set. An explicit
`tenant` argument (or `--tenant` flag) always overrides the env vars.

</details>

<details>
<summary><strong>Running from a local clone instead of the published package</strong></summary>

Use `"command": "node", "args": ["/absolute/path/to/hilan-mcp/dist/cli/index.js"]`
(after `npm install && npm run build` in that clone) instead of the `npx`
form above.

</details>

### 3. Use it

Ask your assistant things like "sync my last 3 payslips from Hilan",
"download my Form 106 for 2025", or "how much net/gross did I earn in June
2026?" (answered instantly from the local database via the `query` tool,
no network round-trip, once that month has been synced at least once) — see
the full [tool list](#mcp-tools) below.

## For AI agents (e.g. Claude) setting this up on a user's behalf

If a user asks you to set up `hilan-mcp` for them:

1. **You must not** run `ingest-creds`/`setup`/`setup-key` yourself via a
   shell tool — they prompt for a password and/or an encryption key
   interactively, and your shell tool's transcript could capture what the
   user types. Tell the user to open their **own** terminal and run
   `npx hilan-mcp setup --tenant <their-org-code-or-subdomain>` themselves,
   then (recommended) `npx hilan-mcp setup-key`.
   Check their `npm --version` first: on npm 12+ they also need
   [step 0](#0-if-youre-on-npm-12-or-newer) or the database will fail to
   open later, in a way that doesn't look related to installation.
2. Once that's done, **you** can safely add the MCP server entry to the
   client's config file (the JSON blocks above) — that part has no secrets
   in it as long as the user used `setup-key` (OS credential store) rather
   than the `HILAN_DB_KEY` env var fallback.
3. After the config is added, the user (or their client) needs to reload/
   restart the MCP connection for the new tools to appear.
4. Don't enable `HILAN_ENABLE_DEBUG_TOOLS` unless the user explicitly asks
   for the raw `.asmx`/PDF exploration tools — they're an intentional
   escape hatch (see [Security model](#security-model)), not needed for
   normal use.
5. If a tool response includes an `_updateNotice` field, tell the user and
   ask if they'd like to update; if they decline, call `dismissUpdateNotice`
   with that version (see [MCP tools](#mcp-tools)).

## MCP tools

| Tool | Summary |
|---|---|
| `listTenants` | List configured tenants — no secrets. |
| `syncPayslips` | Fetch structured payslip data + PDFs for the last N months. |
| `resyncPayslipMonth` | Re-fetch one specific month, overwriting what's stored. |
| `syncForm106` | Download the Form 106 PDF for a given year. |
| `downloadCombinedPayslipsPdf` | One PDF covering a whole month range. |
| `getSalaryTrends` | Yearly averages, YoY %, CAGR, and notable raises — computed locally. |
| `listTables` / `describeTable` | Inspect the queryable local schema. |
| `query` | Run read-only SQL against local payslip/Form106 data. |
| `getPersonalDetails` | Live lookup of personal details (not persisted). |
| `dismissUpdateNotice` | Suppress a specific version's update notice. |
| `debugCallAsmx` / `debugDownloadPdf` | Raw API exploration — off by default. |

<details>
<summary><strong>Full tool reference (arguments, behavior, notes)</strong></summary>

#### `listTenants()`
Configured tenants (subdomain, capability, whether login has succeeded before) — no secrets.

#### `syncPayslips(tenant?, monthsBack?, skipPdf?)`
Logs in (reusing a saved session if it still works), fetches structured Bruto/Neto/salary-parts data for the last N months (default 3), and downloads each payslip PDF. Set `skipPdf: true` for a much faster numbers-only sync (e.g. "what did I earn this year"). `tenant` is optional if `COMPANY_URL`/`COMPANY_TENANT`/`COMPANY_CODE` is set. The tenant's own archive length caps how far back this can actually go — no need to guess a start date.

#### `resyncPayslipMonth(tenant?, period, skipPdf?)`
Re-fetches **one specific month** (e.g. `"10_2019"` or `"10/2019"`), overwriting whatever's stored. Use this instead of re-running `syncPayslips` over the whole history just to retry one bad/truncated PDF or to answer a one-off "how much did I make in month X" question.

#### `syncForm106(tenant?, year?)`
Logs in and downloads the Form 106 PDF for a given year (or the tenant's default year). Same `tenant` fallback as above.

#### `downloadCombinedPayslipsPdf(tenant?, fromMonth, toMonth, destDir?)`
Downloads **one PDF covering a whole month range** (e.g. all of 2015–2024) instead of one file per month. Automatically splits into multiple files if the range would otherwise exceed the server's URL length limit (see [Reliability notes](#reliability-notes-learned-from-a-real-end-to-end-run)) — practical ceiling is roughly 10–15 years per chunk.

#### `getSalaryTrends(tenant?, fromYear?, toYear?)`
Computes salary growth trends **from locally-synced payslips only** — no live login, no network call. Returns yearly average Bruto/Neto, year-over-year % change between adjacent years, CAGR between the first and last full (12-month) calendar year, overall growth (first vs. last synced month), and "notable jumps" (≥10% YoY change in Bruto). Optional `fromYear`/`toYear` scope the calendar years considered. Prefer this over hand-rolling aggregation with `query` — grouping/sorting by plain `period` text gets cross-year chronology wrong (e.g. `"01_2011"` sorts before `"02_2010"`); this tool sorts by actual calendar month internally.

#### `listTables()` / `describeTable(table)`
Lists queryable tables (`payslips`, `form106` only) and their columns/indexes.

#### `query(sql)`
SELECT-only SQL against `payslips`/`form106`. **`credentials`, `sessions`, and `tenants` are hard-blocked** — see [Security model](#security-model). Good for quick questions like "how much net/gross did I earn in June 2026" without touching the network at all.

#### `getPersonalDetails(tenant?)`
Logs in and returns personal details (name, national ID, birthdate, address, phone, email, work start date, job type). Live lookup only — **not persisted** to the local database.

#### `dismissUpdateNotice(version)`
Call this if the user declines an update you offered them (see below), so that exact version isn't mentioned again.

#### `debugCallAsmx(tenant?, servicePath, body?)` / `debugDownloadPdf(tenant?, relativeUrl, fileName)`
**Debug/exploration only, disabled by default** — raw pass-through to any `.asmx` endpoint, or download of an arbitrary relative PDF URL, on a logged-in session. Requires `HILAN_ENABLE_DEBUG_TOOLS=1` in the server's `env` block; not registered otherwise. Filenames are sanitized (no path traversal) and URLs are restricted to the tenant's own origin (no SSRF).

</details>

**Update notifications**: this server has no UI of its own, so update
checks piggyback on whatever tool the agent happens to call next. At most
once a day, a successful tool response may include an extra
`_updateNotice` field with a message like *"A new hilan-mcp version is
available: 0.1.0 -> 0.2.0..."* — if you're the AI agent reading this, tell
the user and ask if they'd like to update; if they say no, call
`dismissUpdateNotice` with that version so it isn't raised again (a newer
version will still be announced later). The check itself hits the npm
registry with a 3s timeout and silently no-ops if it's unreachable (e.g.
offline, corporate proxy) — it never fails a tool call.

**Concurrency note**: every tool call for a given tenant is automatically
queued and run one-at-a-time internally (see `TenantService.runExclusive`)
— Hilan's site (and/or the network path to it) doesn't handle concurrent
requests from one session well and everything times out otherwise. You
don't need to serialize calls yourself; different tenants still run fully
in parallel.

## Scope (v1)

- ✅ Payslips (list, structured Bruto/Neto/parts, PDF)
- ✅ Form 106 (PDF, per year)
- ⛔ General file archive, Form 101 — not built (v1.1+)
- ⛔ One-time-code / 2FA login — tenants that require it return a clear
  "unsupported" error instead of hanging

Tenants whose internal API response doesn't match the structured shape seen
on the reference tenant (Amdocs) are marked `pdf_only`: payslip syncs still
work and still save a PDF, just without the parsed Bruto/Neto numbers.

## Reliability notes (learned from a real end-to-end run)

<details>
<summary>Corporate TLS-intercepting proxies, PDF URL quirks, truncation retries, URL-length limits, and OTP false positives</summary>

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
  cap (each month adds ~11 chars to the URL). Verified working at 120
  months (10 years, ~1.4KB URL); verified failing at 194 months (~16
  years, 2.2KB URL) — so a ~15-year request is the realistic practical
  ceiling per combined PDF. Not an issue for per-month syncing
  (`syncPayslips`), which never builds one huge URL.
- A tenant's *regular* login page can unconditionally show a "log in with
  a one-time code" button/link even when normal username+password login
  is fully supported and working — don't treat that text alone as proof
  OTP is required. Only genuinely new OTP-input fields (or navigating to
  an OTP-specific route) after a failed login count as OTP being required.

</details>

## Security model

- The whole SQLite database (`~/Library/Application Support/HilanMcp/hilan.db`
  on macOS, XDG/AppData equivalents elsewhere) is encrypted at rest via
  SQLCipher (`better-sqlite3-multiple-ciphers`), keyed by a passphrase you
  choose that is **never persisted to disk**. PDFs live alongside it under
  `.../HilanMcp/pdfs/<tenant>/`, and rolling log files under
  `.../HilanMcp/logs/` (redacted — see below). App-data, PDF, and log
  directories are created with `0700` permissions; the DB and PDF files
  themselves with `0600`.
- `credentials` (your login fields) and `sessions` (saved browser cookies)
  are ordinary tables *inside* that encrypted database, but they are **never
  reachable through the `query`/`listTables`/`describeTable` tools** — those
  are hard-allowlisted to `payslips` and `form106` only, validated via a
  full SQL AST parse (not a regex) so `JOIN`s, subqueries, and quoted
  identifiers can't be used to sneak past the allowlist (see
  `src/utils/sqlValidation.ts` and `src/tests/sqlValidation.test.ts`).
- Cookies and auth headers are redacted from log files and from any error
  message a tool call returns, so a Playwright error can't leak your
  session into your chat history (see `src/utils/redact.ts`).
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
  this hasn't been audited). Off by default (`HILAN_ENABLE_DEBUG_TOOLS`);
  treat it like `query`'s SQL escape hatch — fine for an AI assistant you
  trust to explore with, not something to expose to untrusted input.

## Development

Clone this repo to work on the code itself (not needed just to *use* the
server — see [Setup](#setup) above for that):

```bash
npm install
npm run typecheck
npm test                 # unit tests (SQL allowlist, path-traversal, redaction, update checks, ...)
npm run build            # compile TypeScript -> dist/
npm run start:mcp        # run the server directly from source (stdio transport)
npm run setup            # local equivalent of `npx hilan-mcp setup`
npm run ingest-creds     # register a tenant + credentials (interactive, run yourself)
npm run setup-key        # store the DB encryption key in your OS credential store (interactive, run yourself)
```

`npm publish` ships only `dist/`, `README.md`, and `LICENSE` (see the
`files` field in `package.json`) — source, tests, and local research
artifacts are excluded. `prepublishOnly` runs typecheck + tests + build
first, so a broken build can't be published. The published `bin` entry
(`dist/cli/index.js`) is what `npx hilan-mcp` and `npx hilan-mcp <subcommand>`
both invoke.

## License

[MIT](./LICENSE)
