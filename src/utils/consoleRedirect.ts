/**
 * Redirects all console output to stderr so stdout stays clean for the MCP
 * stdio transport's JSON-RPC framing.
 */

const originalConsole = {
  log: console.log,
  info: console.info,
  debug: console.debug,
  warn: console.warn,
  error: console.error,
};

export function redirectConsoleToStderr() {
  console.log = (...args: any[]) => {
    process.stderr.write(
      `${args.map(arg => (typeof arg === 'object' ? JSON.stringify(arg) : String(arg))).join(' ')}\n`
    );
  };

  console.info = (...args: any[]) => {
    process.stderr.write(
      `[INFO] ${args.map(arg => (typeof arg === 'object' ? JSON.stringify(arg) : String(arg))).join(' ')}\n`
    );
  };

  console.debug = (...args: any[]) => {
    process.stderr.write(
      `[DEBUG] ${args.map(arg => (typeof arg === 'object' ? JSON.stringify(arg) : String(arg))).join(' ')}\n`
    );
  };

  console.warn = (...args: any[]) => {
    process.stderr.write(
      `[WARN] ${args.map(arg => (typeof arg === 'object' ? JSON.stringify(arg) : String(arg))).join(' ')}\n`
    );
  };

  console.error = originalConsole.error;
}

export function restoreConsole() {
  Object.assign(console, originalConsole);
}

redirectConsoleToStderr();
