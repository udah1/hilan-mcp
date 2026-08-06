import { chmodSync, createWriteStream, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { format } from 'util';
import { fileURLToPath } from 'url';
import { redactSecrets } from './redact.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const LOGS_DIR = join(__dirname, '../../logs');
const MAX_LOG_SIZE = 10 * 1024 * 1024;
const MAX_LOG_FILES = 5;

if (!existsSync(LOGS_DIR)) {
  mkdirSync(LOGS_DIR, { recursive: true, mode: 0o700 });
} else {
  try {
    chmodSync(LOGS_DIR, 0o700);
  } catch {
    // best-effort — e.g. not the directory owner; not fatal
  }
}

class RollingFileLogger {
  private stream: ReturnType<typeof createWriteStream> | null = null;
  private currentDate: string;
  private fileIndex = 0;
  private filePath: string;

  constructor() {
    this.currentDate = new Date().toISOString().split('T')[0];
    this.filePath = this.getLogFilePath();
    this.ensureStream();
  }

  private getLogFilePath(): string {
    return join(LOGS_DIR, `mcp-${this.currentDate}-${this.fileIndex}.log`);
  }

  private ensureStream() {
    if (!this.stream) {
      this.stream = createWriteStream(this.filePath, { flags: 'a', mode: 0o600 });
      this.stream.on('error', err => {
        console.error('Logging error:', err);
        this.stream = null;
      });
    }
  }

  private rotateIfNeeded() {
    const today = new Date().toISOString().split('T')[0];

    if (today !== this.currentDate) {
      this.currentDate = today;
      this.fileIndex = 0;
      this.filePath = this.getLogFilePath();
      this.closeStream();
      this.ensureStream();
      return;
    }

    try {
      const stats = statSync(this.filePath);
      if (stats.size > MAX_LOG_SIZE) {
        this.fileIndex++;
        this.filePath = this.getLogFilePath();
        this.closeStream();
        this.cleanupOldLogs();
        this.ensureStream();
      }
    } catch {
      this.ensureStream();
    }
  }

  private cleanupOldLogs() {
    try {
      const files = readdirSync(LOGS_DIR)
        .filter(file => file.startsWith('mcp-') && file.endsWith('.log'))
        .map(file => ({ name: file, time: statSync(join(LOGS_DIR, file)).mtime.getTime() }))
        .sort((a, b) => b.time - a.time);

      files.slice(MAX_LOG_FILES).forEach(file => {
        try {
          unlinkSync(join(LOGS_DIR, file.name));
        } catch (err) {
          console.error('Error deleting old log file:', err);
        }
      });
    } catch (err) {
      console.error('Error cleaning up old logs:', err);
    }
  }

  private closeStream() {
    if (this.stream) {
      try {
        this.stream.end();
      } catch (err) {
        console.error('Error closing log stream:', err);
      }
      this.stream = null;
    }
  }

  write(level: string, message: string, ...args: any[]) {
    this.rotateIfNeeded();
    const timestamp = new Date().toISOString();
    // Belt-and-suspenders: callers should already redact before logging, but
    // this is the one choke point all console.warn/error output passes
    // through, so redact here too in case a future call site forgets.
    const formattedMessage = redactSecrets(format(message, ...args));
    const logLine = `[${timestamp}] [${level.toUpperCase()}] ${formattedMessage}\n`;

    if (this.stream) {
      this.stream.write(logLine);
    } else {
      process.stderr.write(logLine);
    }
  }
}

const logger = new RollingFileLogger();

const config = { enableConsoleOutput: true };

const originalConsole = {
  warn: console.warn,
  error: console.error,
};

const consoleMethods = {
  log: (message: string, ...args: any[]) => {
    if (config.enableConsoleOutput) originalConsole.warn(`[LOG] ${message}`, ...args);
    logger.write('info', message, ...args);
  },
  info: (message: string, ...args: any[]) => {
    if (config.enableConsoleOutput) originalConsole.warn(`[INFO] ${message}`, ...args);
    logger.write('info', message, ...args);
  },
  warn: (message: string, ...args: any[]) => {
    if (config.enableConsoleOutput) originalConsole.warn(message, ...args);
    logger.write('warn', message, ...args);
  },
  error: (message: string, ...args: any[]) => {
    if (config.enableConsoleOutput) originalConsole.error(message, ...args);
    logger.write('error', message, ...args);
  },
  debug: (message: string, ...args: any[]) => {
    if (config.enableConsoleOutput) originalConsole.warn(`[DEBUG] ${message}`, ...args);
    logger.write('debug', message, ...args);
  },
};

export function configureLogger(options: { enableConsoleOutput?: boolean }) {
  if (options.enableConsoleOutput !== undefined) {
    config.enableConsoleOutput = options.enableConsoleOutput;
  }
}

for (const [method, impl] of Object.entries(consoleMethods)) {
  try {
    if (method === 'warn' || method === 'error') {
      (console as any)[method] = impl;
    }
  } catch {
    // ignore
  }
}

export { logger, consoleMethods };
