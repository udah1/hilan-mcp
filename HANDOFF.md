# HANDOFF — `hilan-mcp`

> Read this first if you're picking up this project in a new session. It
> contains everything gathered so far: the goal, the research, the exact
> files produced, a security incident that happened during research (and
> what to do about it), and the reviewed build plan. The plan itself lives
> in `PLAN.md` in this same folder — read that too, it's the actual spec.

## 1. What this project is

A standalone, publishable (open-source) MCP server for **Hilan** (Hilanet,
`net.hilan.co.il`) — the Israeli payroll/HR self-service portal used by many
companies (the user's employer, Amdocs, among them). Goal: let an AI
assistant pull payslips and Form 106 (annual tax summary) for any Hilan
tenant/company, not just Amdocs.

Modeled explicitly on `~/personal-dev/asher-mcp` (a sibling project in this
same `personal-dev` folder) which already solves "log into an Israeli
financial site with real credentials, cache results, expose via MCP" for
bank/credit-card scrapers. Read `~/personal-dev/asher-mcp` (especially its
credential-encryption and SQL-tool-safety code) as the reference
implementation for patterns to copy, not reinvent.

Background context on *why* the user wants this: see
`~/personal-dev/HomeAssistant/finance/07-payslips.md` and
`~/personal-dev/HomeAssistant/finance/03-bank-mcp-setup.md` (the private
family-finance repo this spun out of) — the user had already manually
downloaded and PDF-parsed his own Amdocs payslips
(`HomeAssistant/finance/scripts/parse_payslips.py`) before asking for this
to be automated and generalized to any company.

## 2. ⚠️ Security incident during research — read before touching credentials again

While building the first exploration script (`explore-logged-in.mjs`), a
masking bug caused the user's **real Hilan password, national ID, and
employee number to be echoed in plaintext** into a Cursor terminal capture
file (`~/.cursor/projects/.../terminals/1.txt`), which the assistant then
read as part of routine follow-up. This was **not sent anywhere external**
(local file only) but defeated the intended "credentials never touch chat
or logs" design.

Root cause: a hand-rolled raw-mode stdin approach to hide password input
didn't actually suppress local terminal echo in Cursor's integrated
terminal. **Fixed** in `probe-api.mjs` (and should be re-verified whenever
this pattern is reused) using the standard Node.js pattern: override the
`readline` instance's own `_writeToOutput` method to swallow everything
except the initial prompt text, rather than trying to manage raw-mode TTY
echo directly. See `probe-api.mjs`'s `prompt()` function for the corrected
version — copy that pattern for any future interactive-secret-entry code
(e.g. the real `ingest-creds` CLI this project will need).

**Action still open for the user**: was recommended to rotate the Hilan
password since it was exposed in a plaintext log. Confirm with the user
whether this was done before doing anything that would require them to
re-enter it.

**Rule going forward**: never prompt for real secrets through a Shell tool
call that the assistant's own transcript/terminal-capture can read. Any
future credential entry must be run by the user themselves in their own
terminal window, exactly as was done for this research (the user ran
`node probe-api.mjs` directly, not via the assistant's Shell tool).

## 3. Research findings (the actual substance)

### 3.1 Multi-tenant login structure
- Generic entry point: `https://net.hilan.co.il/login` — has one field
  (`id="orgId"`, org number) and a "המשך" (continue) submit button. POSTs to
  `login.aspx` and 302-redirects to the tenant's subdomain.
  Tested with org code `5227` (Technion — a real, publicly-known org number
  used in Technion's own published scholarship instructions) → redirected to
  `https://technionadmin.net.hilan.co.il/login`.
- Direct tenant subdomains skip the org-code step entirely, e.g.
  `https://amdocs.net.hilan.co.il/login` (the user's own employer).
- **Login form fields differ per tenant** — this is the single most
  important generalization finding:
  | Tenant | Fields present (by `id`) | Notes |
  |---|---|---|
  | `amdocs.net.hilan.co.il` | `user_nm` (employee number, placeholder "מספר העובד"), `identification` (national ID, "תעודת זהות"), `password_nm` (password, "סיסמה") | 3 fields |
  | `technionadmin.net.hilan.co.il` | `user_nm` (national ID, "תעודת זהות"), `password_nm` (password, "סיסמה") | Only 2 fields — no separate employee number |
  - Both tenants also show a `"כניסה עם קוד חד-פעמי"` (one-time-code login)
    button as an alternate path — never explored, **treat as unsupported in
    v1** (see PLAN.md).
  - **Important structural detail**: the `name` HTML attribute is *empty*
    on every input on both tenants (Angular/Web-Forms hybrid quirk) — `id`
    is the only reliable structured signal for field mapping. Do not build
    field detection around `name` or rely solely on visible label text
    (which is Hebrew and could differ further on untested tenants).
  - Hidden `__VIEWSTATE` / `__VIEWSTATEGENERATOR` fields are present in the
    form (standard ASP.NET Web Forms) — any programmatic login must submit
    the form as a whole (e.g. via Playwright `page.fill` + `click`, which
    naturally includes these) rather than reconstructing the POST by hand.

### 3.2 Post-login internal API (`.asmx` endpoints)
Captured live against the Amdocs tenant (the user's own, with his consent,
using his real login) via a Playwright network listener. **All values were
redacted to type-only placeholders (`0` for numbers, `"[STR]"` for strings)
before anything touched disk** — see `api-shapes-key.json` for the field
**structure** (safe, no real data) of the interesting endpoints:

| Endpoint | Purpose |
|---|---|
| `PaySlipApiapi.asmx/GetInitialData` | List of available payslip periods + structured salary summary (`Bruto`, `Neto`, named `SalaryParts[]`) for the default period + a PDF URL. **Also the source of `SelectedEmployee.EmployeeId`**, needed for later calls. |
| `PaySlipApiapi.asmx/GetPaySlipDataForMonth` | Same structured summary for a specific month. Request body: `{ EmployeeId, Months: [...], PaySlipType }`. |
| `PaySlipApiapi.asmx/GetMultiplePaySlipData` | Returns one combined PDF URL for a list of months. |
| `Form106Apiapi.asmx/GetInitialData` / `EmployeeChanged` | Available tax years + a PDF URL for Form 106. |
| `PersonalDetailsApiapi.asmx/GetInitialData` | Full personal details (address/phone/email/marital status/spouse/children; bank fields present but empty for this user) — **v1.1, not in v1 scope**. |
| `Form101Apiapi.asmx/GetInitialData` | Annual tax-coordination wizard — mostly UI form-definition metadata, complex — **removed from scope entirely**, not worth building against. |
| `HFilesManagementApiapi.asmx/GetInitialData` + `GetData` | General document archive (HR-shared files) — **v1.1, not in v1 scope**. |
| Direct PDF endpoints (no `.asmx`, still need the session cookie) | `PersonalFile/PdfPaySlip.aspx/PaySlip.pdf?Dates=<comma-separated dd/mm/yyyy>&UserId=<redacted>` and `PersonalFile/Pdf106.aspx/Pdf106-<year>.pdf?UserId=<redacted>&Year=<year>` |

All of these require an authenticated session (cookies set by the ASP.NET
login). **Unverified**: whether cookies alone are sufficient for a raw HTTP
client, or whether additional headers/anti-forgery tokens are needed — this
was flagged Critical by plan review and is why `PLAN.md` v2 uses Playwright's
own `context.request` (inherits real browser headers) instead of a
hand-rolled `fetch` client. Verify this assumption early when building.

### 3.3 Menu structure (what's discoverable in the Amdocs ESS home menu)
From `menu-structure.json` (redacted hrefs, safe to read):
personal details, payslip (`/ng/personal-file/payslip`), Form 101 history,
**Form 106** (`/ng/personal-file/form-106`), current Form 101, file
management, ticket/request system, tracked/closed workflow processes,
change password, 2FA settings, terms/privacy/accessibility pages, sitemap.
**No attendance/vacation-balance menu item was found** in this particular
capture — either not exposed in Amdocs' ESS config, or just not visible in
the header/sidebar region that was scraped. Worth a follow-up look if that
data is wanted later.

## 4. Artifacts in this folder — what's safe to read and what isn't

| File | Contents | Safe? |
|---|---|---|
| `PLAN.md` | The actual v2 build plan (post plan-review). **Read this next.** | ✅ Safe, no PII |
| `HANDOFF.md` | This file | ✅ Safe |
| `explore.mjs` | First research script — headless, dumps login form structure for `net.hilan.co.il` and `amdocs.net.hilan.co.il`. No login performed. | ✅ Safe to re-run/reuse |
| `explore-logged-in.mjs` | Second research script — logs in (interactively, masking **was buggy**, see §2), dumps menu structure + redacted request URLs. **Do not reuse the password-masking code from this file** — copy from `probe-api.mjs` instead. | ⚠️ Script has a known bug (fixed in the newer file) |
| `probe-api.mjs` | Third research script — logs in with the **corrected** masking, navigates to payslip/106 screens, captures `.asmx` request/response **shapes only** (deep-redacted). This is the reference implementation for safe interactive secret entry. | ✅ Safe script; produces safe output |
| `menu-structure.json`, `captured-requests.json` | Output of `explore-logged-in.mjs`, redacted (digit-runs ≥5 and `Id=`/`UserId=` params stripped). Manually reviewed, looked clean. | ✅ Believed safe, but gitignored anyway (see below) |
| `api-shapes.json` | Full raw output of `probe-api.mjs`, 1.9MB, 362 captured calls including a lot of noisy polling endpoints (task counts, reminders, etc.) alongside the interesting ones. Deep-redacted (every leaf value replaced). | ✅ Believed safe, but gitignored (large, noisy) |
| `api-shapes-unique.json` | `api-shapes.json` deduplicated by endpoint path (23 unique endpoints). | ✅ Same as above |
| `api-shapes-key.json` | `api-shapes-unique.json` filtered to just the interesting endpoints (PaySlip/Form106/PersonalDetails/HSalary/Files/Form101). **This is the one to actually read** — small and relevant. | ✅ Same as above |
| `shot-1-generic-login.png`, `shot-2-after-org-submit.png`, `shot-3-amdocs-login.png` | Screenshots of login pages only — no authenticated data visible. | ✅ Believed safe |
| `shot-4-dashboard.png` | Screenshot of the **logged-in** dashboard lobby — may show the user's real name or other on-screen details. | ⚠️ Treat as potentially containing PII |

**A `.gitignore` has already been added** that excludes all research
artifacts above except `PLAN.md`, `HANDOFF.md`, and the three `.mjs`
scripts, plus the standard `node_modules/`, `credentials.json`, and
`*.db`/`*.sqlite`. Review it before ever running `git init`/`git push`
in this folder, and re-check it if you add new capture files.

## 5. Current repo state
- `~/personal-dev/hilan-mcp/` — new folder, `npm init`'d, only dependency so
  far is `playwright` (devDependency). No MCP server code has been written
  yet — everything so far is research scripts + the plan. Chromium is
  already installed locally (`npx playwright install chromium` was run).
- Nothing has been committed to git yet in this folder (no `git init` run).

## 6.5 Implementation status (added in a later session)
v1 as specified in `PLAN.md` has been implemented in full:
`src/types.ts`, `src/services/{EncryptionKeyService,DatabaseService,HilanClient,TenantService}.ts`,
`src/utils/{sqlValidation,notify,logger,consoleRedirect,cli}.ts`,
`src/cli/{index,ingestCredentials}.ts`, `src/mcp/Server.ts`, plus a
SQL-allowlist unit test suite (`src/tests/sqlValidation.test.ts`, 11 tests,
all passing — verifies `credentials`/`sessions`/`tenants`/`sqlite_master`
are unreachable). `npm run typecheck`, `npm run build`, and `npm test` all
pass; the MCP server boots successfully over stdio.

**Not yet done / next session should do this:** end-to-end testing against
a real tenant. That requires the user to run `npm run ingest-creds --
--tenant amdocs` (or `technionadmin`) **themselves, in their own terminal**
(never via the assistant's Shell tool — see the security incident in §2),
then ask the assistant to call the `syncPayslips`/`syncForm106` MCP tools
and sanity-check the results (against `finance/scripts/parse_payslips.py`'s
known Amdocs numbers, per the acceptance criteria in `PLAN.md`). Also still
open: confirm whether the user rotated their Hilan password after the
plaintext-leak incident in §2, before they re-enter it here.

## 6. What to build next
Follow `PLAN.md` (v2) exactly — it already incorporates a full 3-critic plan
review (architect/risk/completeness subagents) that caught two Critical
issues in the original v1 plan (unverified cookie-only HTTP replay; an
under-specified SQL tool that could leak credentials) and several High
issues (scope too broad for v1, session lifecycle undefined, `EmployeeId`
sourcing undefined, field-mapping priority backwards). All of those are
already fixed in `PLAN.md`'s v2 architecture section — read the "What the
plan review changed" section there for the reasoning, and the "Architecture
(v2)" section for the concrete design to implement.

Quick orientation if you don't want to read the whole plan first:
- **Browser vs API**: not a strict split. One Playwright browser context per
  tenant handles both the login (rendered page) and every subsequent
  `.asmx`/PDF call (via that same context's `context.request` API client,
  headless) — avoids hand-rolling cookie/header replay.
- **v1 scope**: payslips + Form 106 only. Personal details, file archive,
  Form 101, and OTP/2FA support are all explicitly deferred to v1.1+.
- **Storage**: encrypted SQLite (`better-sqlite3-multiple-ciphers`), same
  pattern as `asher-mcp` — `credentials` and `sessions` tables encrypted and
  never exposed to the `query` SQL tool (which is SELECT-only and
  table-allowlisted, copied from `asher-mcp`'s validator, not reinvented).
- **Acceptance bar**: works end-to-end on Amdocs (matching the user's
  already-known payslip numbers from `parse_payslips.py`), and at least
  logs in generically on a second real tenant (e.g. Technion) without any
  Amdocs-specific code branches.
