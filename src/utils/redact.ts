/**
 * Strips session cookies / auth headers out of error text before it's
 * logged to disk or returned to an MCP client.
 *
 * Playwright's own error messages sometimes embed a "Call log" trace of the
 * underlying HTTP request, including the literal `cookie:` header — which
 * for this app *is* the live Hilan session token. That's fine to see once
 * while debugging locally, but it must never end up in a log file (which
 * could get backed up/synced) or in a tool response text that gets stored
 * in an AI assistant's chat transcript.
 */
export function redactSecrets(text: string): string {
  if (typeof text !== 'string') return text;
  return text
    .replace(/(^|\n)(\s*-?\s*)(cookie|set-cookie)\s*:\s*.*/gi, '$1$2$3: [REDACTED]')
    .replace(/(authorization\s*:\s*)(bearer\s+)?\S+/gi, '$1[REDACTED]');
}

/** Redacts an Error (or unknown thrown value) into a safe-to-log/return message. */
export function redactError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecrets(message);
}
