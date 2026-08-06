# Plan v2: `hilan-mcp` — generic MCP server for Hilan (net.hilan.co.il) ESS

> v2: revised after a 3-critic plan review (architect/risk/completeness) found two
> Critical issues (in consensus across all three critics) and several High issues
> in v1. See "Changelog from v1" at the bottom for exactly what changed and why.

## Goal
Build a standalone, publishable (open-source) MCP server that lets any Hilan
("Hilanet") employee-self-service user connect their own tenant and pull their
payslips and Form 106 into an AI assistant — modeled on the existing local
`asher-mcp` project (encrypted local credential storage, no plaintext secrets
in `mcp.json`, tools that return aggregated data instead of dumping raw JSON
into context).

## Background / research already done
(unchanged from v1 — see full detail there; summary:)
- No official API. Multi-tenant by subdomain (`https://<tenant>.net.hilan.co.il`),
  reached either directly or via an org-code redirect at `net.hilan.co.il/login`.
- Login form fields differ per tenant (confirmed on 2 real tenants: Amdocs has
  3 fields keyed by `id="user_nm"`/`id="identification"`/`id="password_nm"`;
  Technion has only 2, `id="user_nm"`/`id="password_nm"`). **`name` attributes
  are always empty on both tenants — `id` is the only stable, structured
  signal; visible label text is Hebrew and not to be relied on as the primary
  signal.**
- After login, the Angular app calls internal `.asmx` JSON endpoints
  (`/Hilannetv2/Services/Public/WS/*.asmx/*`). Captured and schema-verified
  (redacted) against Amdocs: `PaySlipApiapi` (list, per-month, multi-month PDF),
  `Form106Apiapi` (years + PDF link), `PersonalDetailsApiapi`,
  `Form101Apiapi`, `HFilesManagementApiapi`. Direct PDF endpoints also
  confirmed (`PdfPaySlip.aspx`, `Pdf106.aspx`).
- `asher-mcp` (`~/personal-dev/asher-mcp`) is the proven local precedent for
  the security/storage model to copy.

## What the plan review changed (read this first)

### Fix 1 (was Critical, consensus 3/3): don't hand-roll cookie replay over `fetch`
v1 proposed extracting cookies from Playwright and then making raw
`fetch`/`undici` calls to the `.asmx` endpoints. All three critics flagged
that ASP.NET/Angular apps commonly require more than the cookie header
(anti-forgery tokens, exact `Content-Type`, `Referer`/`Origin`) — hand-rolling
this is fragile and unverified for even the one tenant we've seen.

**Fix:** use Playwright's own `context.request` (the `APIRequestContext` bound
to the same authenticated browser context) to make the `.asmx` calls, instead
of a separate HTTP client. This is still fast (it's a raw HTTP client under
the hood, no page rendering per call) but automatically inherits cookies AND
whatever headers a real navigation would have set up, without us having to
reverse-engineer the exact header/token contract by hand. The browser context
itself can stay alive headless in the background between calls (not a full
visible page) rather than being thrown away after login. This is the
single biggest architecture change from v1.

### Fix 2 (was Critical, consensus 3/3): lock down the SQL query tool
v1's `query(tenant, sql)` copied `asher-mcp`'s *name* but not its actual
safety mechanism. **Fix:** copy the mechanism exactly — SELECT-only, single
statement, explicit table allowlist (`payslips`, `form106` — only the
non-secret cache tables), hard-block `credentials`/`sessions`/`sqlite_*` and
any `PRAGMA`, same as `asher-mcp`'s validator.

### Fix 3 (was High): narrow v1 scope, design the fallback for real
v1 tried to ship 5 document modules + SQL + PDF-fallback + 2 auth flows at
once — too much surface for an unverified vendor API. **Fix:** v1 ships only
**payslips + Form 106** end-to-end (the two things actually asked for), with
an explicit per-tenant capability flag (`asmx_json` vs `pdf_only`) decided at
first login and a real PDF-download code path for tenants where the `.asmx`
shape doesn't match what we saw on Amdocs. Personal details / files / Form
101 are v1.1, not v1.

### Fix 4 (was High): session lifecycle
Sessions (the Playwright persistent context / storage state) are saved
encrypted per tenant with a recorded timestamp; a lightweight probe call
before each sync decides reuse-vs-relogin; a per-tenant mutex prevents two
tool calls from triggering two parallel logins.

### Fix 5 (was High): where `EmployeeId` comes from
Documented explicitly: it's read from the `SelectedEmployee.EmployeeId`
field present in `PaySlipApiapi.asmx/GetInitialData`'s response (confirmed in
the captured schema) right after login, then cached per tenant — not
guessed or hardcoded.

### Fix 6 (was High): field-mapping priority
Detection order is now: (1) known `id` values (`user_nm`, `identification`,
`password_nm` — confirmed stable across both tested tenants) → (2)
placeholder/aria-label keyword table as a fallback for unrecognized `id`s →
(3) fail loudly with a structured "unrecognized login form, here's what I
found" error rather than guessing positionally.

### Other fixes folded in
- PDFs stored under the app-data dir with `chmod 600`, gitignored, documented
  as "don't let this folder sync to iCloud/Dropbox" in the README (mirrors
  `asher-mcp`'s SQLite file permissions).
- OTP/2FA tenants are explicitly **unsupported in v1** with a clear MCP error
  ("this tenant requires one-time-code login, not supported yet") rather than
  a half-built manual workaround — smaller surface, honest about the gap.
- Form 101 fully removed from v1 scope (it's a multi-step wizard, mostly UI
  metadata, not a documented retrieval target the user asked for).
- Test strategy added: redacted fixture files (already have some from
  research) become unit-test fixtures for the field-mapping and JSON-parsing
  logic; a manual two-tenant checklist (Amdocs end-to-end, Technion at least
  login + PDF fallback) gates the v1 release.
- Cross-platform key entry: keep `asher-mcp`'s notification-first approach on
  macOS, but explicitly document and test the plain stdin/CLI prompt fallback
  as the primary path on Linux/Windows (since this will be a public repo).

## Explicit goals (v1)
1. Publishable as a standalone repo at `~/personal-dev/hilan-mcp`, usable by
   any Hilan tenant, not hardcoded to Amdocs.
2. v1 feature scope: **payslips** (list, structured Bruto/Neto/parts data,
   PDF) and **Form 106** (PDF, per year) — with graceful PDF-only degradation
   for tenants whose `.asmx` shape doesn't match Amdocs.
3. Credentials encrypted at rest, `asher-mcp`'s trust model exactly (local
   SQLite via `better-sqlite3-multiple-ciphers`, key never persisted to disk,
   CLI `ingest-creds`, nothing through chat).
4. Login field mapping and per-tenant capability (JSON API vs PDF-only) are
   discovered and cached per tenant at first login, not hardcoded.

## Architecture (v2)

**Answering directly: browser or API? → both, but not split the way v1 had it.**
Playwright drives the *whole* authenticated session (login **and** every
subsequent data call), using its `context.request` API client instead of
rendering pages after login. So there is exactly one browser context per
tenant per session — used first to log in (rendered page, so we can find the
form and detect OTP), then reused headlessly as an HTTP client for every
`.asmx` call and PDF download. No separate cookie-replay HTTP layer.

### End-to-end flow (this is "the loop")
1. **Resolve tenant** — stored subdomain, or first-time org-code lookup via
   `net.hilan.co.il/login` (cache the redirect target).
2. **Login** (Playwright, headless, one browser context per tenant):
   - Load `/login`, read `#mainForm` inputs' `id` attributes.
   - Map by known `id` table first, placeholder/aria-label keywords as
     fallback; fail with a structured diagnostic if unresolved.
   - Fill + submit; wait for URL to leave `/login`.
   - If an OTP/2FA challenge is detected (heuristic: URL/DOM signals distinct
     from the normal post-login landing route) → return a clear
     "unsupported: this tenant requires one-time-code login" error and stop.
   - On success, persist the context's storage state (cookies) **encrypted**
     in the `sessions` table, keyed by tenant, with a timestamp.
3. **Bootstrap** — call `PaySlipApiapi.asmx/GetInitialData` via
   `context.request.post(...)` (same context, so cookies/headers are
   whatever a real page load would send). Record `EmployeeId` and whether
   the response shape matches what we expect (capability flag `asmx_json`).
   If it doesn't match (different Hilan version/config) → set capability
   flag `pdf_only` and fall back to the direct PDF endpoints
   (`PersonalFile/PdfPaySlip.aspx`, `PersonalFile/Pdf106.aspx`) using the
   same authenticated context for the whole tenant going forward.
4. **Sync tools** call the appropriate path (`asmx_json` or `pdf_only`) based
   on the tenant's stored capability flag, write structured data + PDFs to
   the local cache, and are safe to call repeatedly (idempotent upsert keyed
   by `(tenant, period, doc_type)`).
5. **Re-auth**: before any sync, a lightweight probe call checks if the saved
   session still works; if not, step 2 runs again under a per-tenant mutex
   (so concurrent tool calls don't trigger parallel logins).

### Stack
Node.js + TypeScript, Playwright (browser + `APIRequestContext`, no separate
HTTP client library needed), `better-sqlite3-multiple-ciphers` for encrypted
storage (same dependency `asher-mcp` already solved the Apple-Silicon/Node 26
build issue for), `@modelcontextprotocol/sdk` for the MCP server.

### Storage (encrypted SQLite, `asher-mcp` pattern)
- `tenants` — subdomain, org code, discovered login-field map, capability
  flag (`asmx_json`/`pdf_only`), `EmployeeId`.
- `credentials` — encrypted login fields per tenant. **Never in the SQL
  allowlist below.**
- `sessions` — encrypted storage-state blob + timestamp per tenant. **Never
  in the SQL allowlist below.**
- `payslips` — one row per `(tenant, period)`: Bruto, Neto, `SalaryParts`
  JSON, local PDF path, fetch timestamp. In the SQL allowlist.
- `form106` — one row per `(tenant, year)`: local PDF path, fetch timestamp.
  In the SQL allowlist.

### MCP tools (v1)
- `listTenants` — configured tenants, no secrets.
- `syncPayslips(tenant, monthsBack?)` — runs the flow above, upserts
  `payslips`, downloads PDFs.
- `syncForm106(tenant, year?)` — same for `form106`.
- `query(tenant, sql)` — SELECT-only, allowlisted to `payslips`/`form106`
  only, blocking `credentials`/`sessions`/`tenants`/`PRAGMA` — copied from
  `asher-mcp`'s validator, not reinvented.
- `listTables` / `describeTable` — mirrors `asher-mcp`, so `query` is
  actually usable without guessing column names.
- Credential ingestion: CLI `ingest-creds` reading a local gitignored JSON
  template, same UX as `asher-mcp` — never through chat.

## v1.1 (explicitly deferred, not built now)
- Personal details, general file archive, Form 101.
- OTP/2FA support (manual session-import workaround, if ever).
- Any non-macOS-tested encryption-key UX polish beyond the stdin fallback.

## Acceptance criteria for "v1 done"
- Amdocs tenant: login → `syncPayslips` returns structured Bruto/Neto/parts
  matching `finance/scripts/parse_payslips.py`'s numbers for the same months
  → `syncForm106` downloads a valid PDF for a known year.
- Technion tenant (or another second real tenant): login succeeds using the
  same generic field-mapping code (no Amdocs-specific branches); if its
  `.asmx` shape doesn't match, `pdf_only` fallback still produces a valid
  payslip PDF.
- `query` tool cannot return anything from `credentials` or `sessions` under
  any input (tested explicitly).
- No credential value ever appears in a log file or terminal capture
  (tested explicitly, given the real incident during research where a
  masking bug leaked a real password into a terminal log).
- OTP-requiring tenants return a clear, documented "unsupported" error
  instead of hanging or crashing.

## Changelog from v1
- Replaced "Playwright for login, raw fetch for data" with "Playwright
  context.request for both" (Critical fix).
- Added SQL allowlist/validation spec instead of a bare `query` tool
  (Critical fix).
- Cut v1 scope from 5 document modules to 2 (payslips, Form 106); Form 101
  removed entirely; personal details/files moved to v1.1.
- Added explicit session table, TTL/reuse probe, and per-tenant mutex.
- Documented `EmployeeId` sourcing from `GetInitialData`.
- Changed field-mapping priority to `id`-first instead of label-first.
- Added PDF file permissions/backup guidance, OTP-unsupported error instead
  of hand-waved "manual step", and a concrete acceptance-criteria section.
