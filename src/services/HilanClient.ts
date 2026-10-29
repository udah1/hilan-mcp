import { chromium, type Browser, type BrowserContext, type APIResponse } from 'playwright';
import { writeFileSync, chmodSync } from 'fs';
import { join, basename, resolve, relative, isAbsolute } from 'path';
import type { LoginFieldValues } from '../types.js';

/**
 * Resolves `fileName` against `destDir`, refusing to write anywhere outside
 * it. `fileName` is developer-controlled for the normal sync/resync tools,
 * but the `debugDownloadPdf` MCP tool passes it through from an AI agent, so
 * a `../../../.ssh/authorized_keys`-style value must never escape `destDir`.
 */
export function safeDestPath(destDir: string, fileName: string): string {
  const safeName = basename(fileName);
  if (!safeName || safeName === '.' || safeName === '..') {
    throw new HilanLoginError(`Invalid file name: ${fileName}`);
  }
  const resolvedDir = resolve(destDir);
  const resolvedPath = resolve(resolvedDir, safeName);
  // path.relative + the '..'/absolute check (rather than a raw string
  // startsWith(resolvedDir + '/')) is the portable way to test containment,
  // since it uses the platform's own separator instead of assuming '/'.
  const rel = relative(resolvedDir, resolvedPath);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new HilanLoginError(`Refusing to write outside the destination directory: ${fileName}`);
  }
  return resolvedPath;
}

/**
 * Resolves a (possibly relative) PDF URL against the tenant's own origin,
 * refusing any absolute URL that points elsewhere. Extracted as a pure
 * function (no BrowserContext needed) so it's directly unit-testable.
 *
 * Relative PDF URLs returned by the JSON API (e.g. `PaySlipData.Url`) are
 * relative to the app's `/Hilannetv2` virtual directory, not the domain
 * root — confirmed against a real browser network capture
 * (`.../Hilannetv2/PersonalFile/PdfPaySlip.aspx/...`). Absolute URLs are
 * only accepted if they're same-origin with the tenant itself — this is an
 * authenticated fetch that sends the tenant's session cookies
 * (`credentials: 'include'`), so letting a caller (e.g. the debug tools,
 * whose URL can come from an AI agent) redirect it to an arbitrary domain
 * would be an SSRF/cookie-leak vector.
 */
export function resolvePdfUrl(subdomain: string, url: string): string {
  const baseUrl = normalizeBaseUrl(subdomain);
  if (url.startsWith('http')) {
    if (!url.startsWith(`${baseUrl}/`)) {
      throw new HilanLoginError(`Refusing to fetch a PDF URL outside the tenant's own origin: ${url}`);
    }
    return url;
  }
  return `${baseUrl}/Hilannetv2/${url.replace(/^\/+/, '')}`;
}

export class HilanUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HilanUnsupportedError';
  }
}

export class HilanLoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HilanLoginError';
  }
}

export interface DiscoveredField {
  id: string;
  placeholder: string;
  type: string;
}

/**
 * Fallback labels, only used when a tenant's login page doesn't expose a
 * placeholder for a given field `id`. `user_nm` is deliberately generic
 * here — on Amdocs it means "employee number", but on tenants without a
 * separate `identification` field (e.g. Technion) it means "national ID"
 * instead. The live placeholder scraped from that tenant's own page (below)
 * is always preferred and is what actually disambiguates this per tenant.
 */
const KNOWN_FIELD_LABELS: Record<string, string> = {
  user_nm: 'employee number or national ID (depends on this tenant)',
  identification: 'national ID',
  password_nm: 'password',
};

const HEBREW_REGEX = /[\u0590-\u05FF]/;
const RTL_ISOLATE_START = '\u2067'; // RLI - Right-to-Left Isolate
const RTL_ISOLATE_END = '\u2069'; // PDI - Pop Directional Isolate

/**
 * Wraps Hebrew text in Unicode bidi isolate marks so terminals with proper
 * bidi support render it (and any trailing punctuation like ":") in the
 * correct visual order instead of mirrored/reversed when it's embedded in
 * an otherwise LTR line (e.g. inquirer's "  <label>:" prompt prefix).
 */
function isolateIfHebrew(text: string): string {
  return HEBREW_REGEX.test(text) ? `${RTL_ISOLATE_START}${text}${RTL_ISOLATE_END}` : text;
}

/** Builds a ready-to-use "<label>:" prompt suffix for a discovered login field. */
export function fieldPromptLabel(field: DiscoveredField): string {
  const placeholder = field.placeholder?.trim();
  if (placeholder) {
    return isolateIfHebrew(`${placeholder}:`);
  }
  const fallback = KNOWN_FIELD_LABELS[field.id] || field.id;
  return `${fallback}:`;
}

/**
 * Accepts a bare subdomain ("amdocs") or any URL on that tenant — including
 * one with a path/query, e.g. copy-pasted straight from the browser's
 * address bar while on the login page or any other Hilan screen — and
 * normalizes it down to just the tenant's origin.
 */
export function normalizeBaseUrl(tenantOrUrl: string): string {
  const trimmed = tenantOrUrl.trim();
  if (trimmed.startsWith('http')) {
    try {
      return new URL(trimmed).origin;
    } catch {
      return trimmed.replace(/\/$/, '');
    }
  }
  return `https://${trimmed.replace(/\/$/, '')}.net.hilan.co.il`;
}

export function subdomainFromBaseUrl(baseUrl: string): string {
  const host = new URL(baseUrl).hostname;
  return host.split('.')[0];
}

/**
 * Escapes a DOM element `id` (scraped from the tenant's own login page, see
 * `discoverLoginFields`) for safe use inside a `#<id>` CSS selector. Real
 * IDs are always simple identifiers in practice, but this avoids silently
 * breaking (or worse, matching the wrong element) if some tenant's markup
 * ever uses an id with a character that's special in CSS (a dot, colon,
 * space, leading digit, etc.) — Node has no built-in `CSS.escape`.
 */
function cssEscapeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, ch => `\\${ch}`);
}

/**
 * Owns one headless Playwright browser for the whole process and one
 * BrowserContext per tenant (login + every subsequent `.asmx`/PDF call goes
 * through that same context's `context.request` API client — no separate
 * cookie-replay HTTP layer).
 */
export class HilanClient {
  private static browserPromise: Promise<Browser> | null = null;
  private static contexts = new Map<string, BrowserContext>();
  private static loginLocks = new Map<string, Promise<void>>();

  private static async getBrowser(): Promise<Browser> {
    if (!HilanClient.browserPromise) {
      HilanClient.browserPromise = chromium.launch({ headless: true });
    }
    return HilanClient.browserPromise;
  }

  /**
   * Accepts whatever a user/env-var gave us — a numeric org code, a bare
   * subdomain, or a full URL — and resolves it to a tenant subdomain.
   */
  public static async resolveTenantInput(raw: string): Promise<string> {
    const trimmed = raw.trim();
    if (/^\d+$/.test(trimmed)) {
      return HilanClient.resolveOrgCode(trimmed);
    }
    return subdomainFromBaseUrl(normalizeBaseUrl(trimmed));
  }

  /** Resolves an org code (numeric) to its tenant subdomain via the generic org-code login page. */
  public static async resolveOrgCode(orgCode: string): Promise<string> {
    const browser = await HilanClient.getBrowser();
    const page = await browser.newPage();
    try {
      await page.goto('https://net.hilan.co.il/login', { waitUntil: 'networkidle' });
      await page.fill('#orgId', orgCode);
      // "המשך" does not navigate on click. It POSTs LoginApi/SelectOrg, and the
      // page changes location only after that response. The generic page is
      // already network-idle, so waitForLoadState() returns immediately and
      // used to read the URL before the request was even sent.
      const selectOrg = page.waitForResponse(
        res => res.url().includes('/LoginApi/SelectOrg') && res.request().method() === 'POST',
        { timeout: 8000 }
      );
      // If click throws, this waiter must not surface as an unhandled rejection.
      void selectOrg.catch(() => {});
      await page.click('button[type="submit"]');
      try {
        const response = await selectOrg;
        const body = (await response.json().catch(() => null)) as { IsFail?: boolean } | null;
        if (body?.IsFail) {
          throw new HilanLoginError(`Org code "${orgCode}" did not resolve to a tenant subdomain.`);
        }
        await page.waitForURL(url => url.hostname !== 'net.hilan.co.il', { timeout: 8000 });
      } catch (error) {
        if (error instanceof HilanLoginError) throw error;
        if (error instanceof Error && error.name === 'TimeoutError') {
          throw new HilanLoginError(`Org code "${orgCode}" did not resolve to a tenant subdomain.`);
        }
        throw error;
      }
      const finalUrl = page.url();
      if (finalUrl.includes('net.hilan.co.il/login') && !finalUrl.startsWith('https://net.hilan.co.il')) {
        return subdomainFromBaseUrl(finalUrl);
      }
      if (finalUrl === 'https://net.hilan.co.il/login' || finalUrl === 'https://net.hilan.co.il/') {
        throw new HilanLoginError(`Org code "${orgCode}" did not resolve to a tenant subdomain.`);
      }
      return subdomainFromBaseUrl(finalUrl);
    } finally {
      await page.close();
    }
  }

  /** Loads the login page for a tenant and reports the input fields actually present. */
  public static async discoverLoginFields(subdomain: string): Promise<DiscoveredField[]> {
    const baseUrl = normalizeBaseUrl(subdomain);
    const browser = await HilanClient.getBrowser();
    const page = await browser.newPage();
    try {
      await page.goto(`${baseUrl}/login`, { waitUntil: 'networkidle' });
      const fields = await page.$$eval(
        '#mainForm input[type="text"], #mainForm input[type="password"]',
        els =>
          els.map(e => ({
            id: (e as HTMLInputElement).id,
            placeholder: (e as HTMLInputElement).placeholder || '',
            type: (e as HTMLInputElement).type,
          }))
      );
      const withIds = fields.filter(f => f.id);
      if (withIds.length === 0) {
        throw new HilanLoginError(
          `Unrecognized login form at ${baseUrl}/login — no #mainForm text/password inputs with an id were found.`
        );
      }
      return withIds;
    } finally {
      await page.close();
    }
  }

  private static async withLoginLock<T>(subdomain: string, fn: () => Promise<T>): Promise<T> {
    const previous = HilanClient.loginLocks.get(subdomain) || Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    HilanClient.loginLocks.set(subdomain, previous.then(() => gate));
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Performs a fresh login for the tenant, persists the resulting
   * storage state, and caches the live context in memory. Serialized per
   * tenant so two concurrent tool calls never trigger two parallel logins.
   */
  public static async login(
    subdomain: string,
    fields: LoginFieldValues,
    onSessionSaved: (storageStateJson: string) => Promise<void>
  ): Promise<BrowserContext> {
    return HilanClient.withLoginLock(subdomain, async () => {
      const baseUrl = normalizeBaseUrl(subdomain);
      const browser = await HilanClient.getBrowser();
      const context = await browser.newContext();
      const page = await context.newPage();

      try {
        await page.goto(`${baseUrl}/login`, { waitUntil: 'networkidle' });

        for (const [id, value] of Object.entries(fields)) {
          await page.fill(`#${cssEscapeId(id)}`, value);
        }

        const submitBtn = page.locator('#mainForm button[type="submit"]');
        if ((await submitBtn.count()) > 0) {
          await submitBtn.first().click();
        } else {
          await page.keyboard.press('Enter');
        }

        let loggedIn = false;
        for (let i = 0; i < 20; i++) {
          await page.waitForTimeout(1000);
          if (!page.url().includes('/login')) {
            loggedIn = true;
            break;
          }
        }

        if (!loggedIn) {
          // A static "log in with a one-time code" button/link is present on
          // some tenants' *regular* login pages regardless of outcome — that
          // alone is not proof OTP was actually required. Only treat this as
          // an unsupported OTP flow if the form actually changed to show a
          // dedicated OTP-code input (i.e. the original fields we just
          // submitted are gone, replaced by something new), or the URL moved
          // to an OTP/verification-specific route.
          const currentUrl = page.url();
          const movedToOtpRoute = /otp|verification|two-?factor|2fa/i.test(currentUrl);

          const originalFieldIds = Object.keys(fields);
          const notSelector = originalFieldIds.map(id => `:not(#${id})`).join('');
          const newFieldCount = await page
            .locator(`#mainForm input[type="text"]${notSelector}, #mainForm input[type="tel"]${notSelector}, #mainForm input[type="number"]${notSelector}`)
            .count()
            .catch(() => 0);

          if (movedToOtpRoute || newFieldCount > 0) {
            throw new HilanUnsupportedError(
              `Tenant "${subdomain}" requires one-time-code (OTP/2FA) login, which is not supported yet.`
            );
          }

          const errorText = await page
            .locator('.validation-summary-errors, .field-validation-error, [class*="error" i]')
            .first()
            .textContent()
            .catch(() => null);

          throw new HilanLoginError(
            `Login failed for tenant "${subdomain}" — still on the login page after submitting.` +
              (errorText?.trim() ? ` Site error: "${errorText.trim()}"` : ' Check the stored credentials.')
          );
        }

        await page.waitForTimeout(1000);
        const storageState = await context.storageState();
        await onSessionSaved(JSON.stringify(storageState));

        await page.close();
        HilanClient.contexts.set(subdomain, context);
        return context;
      } catch (error) {
        await context.close().catch(() => {});
        throw error;
      }
    });
  }

  /** Restores a context from a previously saved storage state without re-logging in. */
  public static async restoreContext(subdomain: string, storageStateJson: string): Promise<BrowserContext> {
    const existing = HilanClient.contexts.get(subdomain);
    if (existing) {
      return existing;
    }
    const browser = await HilanClient.getBrowser();
    const context = await browser.newContext({ storageState: JSON.parse(storageStateJson) });
    HilanClient.contexts.set(subdomain, context);
    return context;
  }

  public static invalidateContext(subdomain: string): void {
    const context = HilanClient.contexts.get(subdomain);
    if (context) {
      context.close().catch(() => {});
      HilanClient.contexts.delete(subdomain);
    }
  }

  /** Lightweight probe to check whether a restored/cached session still works. */
  public static async probeSession(subdomain: string, context: BrowserContext): Promise<boolean> {
    const baseUrl = normalizeBaseUrl(subdomain);
    try {
      const res = await context.request.post(
        `${baseUrl}/Hilannetv2/Services/Public/WS/PaySlipApiapi.asmx/GetInitialData`,
        { data: { PaySlipType: 0 }, headers: { 'Content-Type': 'application/json; charset=UTF-8' } }
      );
      if (!res.ok()) return false;
      const json = await res.json().catch(() => null);
      return !!json && json.IsNonAuthorizedForEmployee !== true;
    } catch {
      return false;
    }
  }

  public static async callAsmx<T = any>(
    subdomain: string,
    context: BrowserContext,
    servicePath: string,
    body: Record<string, unknown>
  ): Promise<T> {
    const baseUrl = normalizeBaseUrl(subdomain);
    const res: APIResponse = await context.request.post(
      `${baseUrl}/Hilannetv2/Services/Public/WS/${servicePath}`,
      { data: body, headers: { 'Content-Type': 'application/json; charset=UTF-8' } }
    );
    if (!res.ok()) {
      throw new HilanLoginError(
        `Hilan API call to ${servicePath} failed for tenant "${subdomain}": HTTP ${res.status()}`
      );
    }
    return res.json();
  }

  /**
   * Downloads a PDF (URL may be absolute or relative to the tenant's base
   * URL) and returns the local path.
   *
   * Deliberately uses an in-page `fetch()` (via `page.evaluate`) rather than
   * Playwright's Node-side `context.request` — the latter re-encodes raw
   * "/" characters inside the query string to "%2F", which some of Hilan's
   * direct PDF endpoints (IIS, double-escaping protection) reject with a
   * 404. A real browser tab sends the URL byte-for-byte as given, which is
   * what these endpoints actually expect.
   */
  public static async downloadPdf(
    subdomain: string,
    context: BrowserContext,
    url: string,
    destDir: string,
    fileName: string
  ): Promise<string> {
    const baseUrl = normalizeBaseUrl(subdomain);
    const absoluteUrl = resolvePdfUrl(subdomain, url);

    // The Amdocs network's corporate TLS-intercepting proxy occasionally
    // truncates a response mid-stream (observed: exact 32768-byte cutoffs,
    // a suspiciously round proxy-buffer size) — the fetch still resolves
    // "successfully" with a partial body instead of throwing. Detect this
    // by checking for the standard PDF end-of-file marker and retry a
    // couple of times before giving up.
    let lastError: string | undefined;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const page = await context.newPage();
      let result: { ok: boolean; status: number; base64?: string };
      try {
        // A fresh page starts at about:blank (a null origin), so a same-origin
        // fetch() to the tenant's domain would be blocked by CORS. Navigate
        // there first so the fetch below runs from the correct origin.
        await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
        result = await page.evaluate(async (u: string) => {
          const res = await fetch(u, { credentials: 'include' });
          if (!res.ok) {
            return { ok: false, status: res.status };
          }
          const buf = await res.arrayBuffer();
          const bytes = new Uint8Array(buf);
          let binary = '';
          const chunkSize = 0x8000;
          for (let i = 0; i < bytes.length; i += chunkSize) {
            binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
          }
          return { ok: true, status: res.status, base64: btoa(binary) };
        }, absoluteUrl);
      } finally {
        await page.close();
      }

      if (!result.ok || !result.base64) {
        throw new HilanLoginError(`Failed to download PDF from ${absoluteUrl}: HTTP ${result.status}`);
      }

      const buffer = Buffer.from(result.base64, 'base64');
      // Some genuine (non-truncated) Hilan PDFs — observed on an old 2010
      // payslip, and on large multi-month combined PDFs — have anywhere
      // from several KB to hundreds of KB of trailing null-byte padding
      // *after* a perfectly valid `%%EOF` marker, so checking only a
      // trailing window gives false positives. Search the whole buffer
      // instead; genuine truncation (the proxy cutting the stream mid-page)
      // won't have written a `%%EOF` token anywhere.
      const looksTruncated = !buffer.includes('%%EOF');
      if (looksTruncated) {
        lastError = `response looked truncated (${buffer.length} bytes, no %%EOF trailer found) on attempt ${attempt}`;
        continue;
      }

      const destPath = safeDestPath(destDir, fileName);
      writeFileSync(destPath, buffer);
      chmodSync(destPath, 0o600);
      return destPath;
    }

    throw new HilanLoginError(`Failed to download a complete PDF from ${absoluteUrl}: ${lastError}`);
  }

  public static async shutdown(): Promise<void> {
    for (const context of HilanClient.contexts.values()) {
      await context.close().catch(() => {});
    }
    HilanClient.contexts.clear();
    if (HilanClient.browserPromise) {
      const browser = await HilanClient.browserPromise;
      await browser.close().catch(() => {});
      HilanClient.browserPromise = null;
    }
  }
}
