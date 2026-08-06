import { sendNotification } from '../utils/notify.js';
import type { NotificationOptions, NotificationCallback } from '../utils/notify.js';
import { getSecretFromOsStore } from '../utils/secretStore.js';

export class EncryptionKeyService {
  private static instance: EncryptionKeyService;
  private currentKey: string | null = null;
  private isPrompting = false;
  private maxRetries = 2;
  // The MCP server communicates over stdio (stdin/stdout carry JSON-RPC
  // frames); reading a raw line from stdin for an interactive key prompt
  // would corrupt that framing and can hang the whole connection. The MCP
  // entrypoint calls `disableStdinFallback()` at startup so that, if the OS
  // credential store, `HILAN_DB_KEY`, and the desktop notification prompt
  // all fail, this throws a clear actionable error instead of touching
  // stdin. CLI commands (ingest-creds, setup-key) never call this, so they
  // keep the terminal fallback.
  private allowStdinFallback = true;

  public disableStdinFallback(): void {
    this.allowStdinFallback = false;
  }

  private constructor() {}

  public static getInstance(): EncryptionKeyService {
    if (!EncryptionKeyService.instance) {
      EncryptionKeyService.instance = new EncryptionKeyService();
    }
    return EncryptionKeyService.instance;
  }

  public setKey(key: string): void {
    if (key.length < 6) {
      throw new Error('Encryption key must be at least 6 characters long');
    }
    this.currentKey = key.trim();
  }

  public getKey(): string | null {
    return this.currentKey;
  }

  public async ensureKeyIsAvailable(): Promise<string> {
    if (this.currentKey) {
      return this.currentKey;
    }

    const osKey = getSecretFromOsStore();
    if (osKey) {
      this.setKey(osKey);
      return this.currentKey as string;
    }

    const envKey = process.env.HILAN_DB_KEY?.trim();
    if (envKey) {
      this.setKey(envKey);
      return this.currentKey as string;
    }

    if (this.isPrompting) {
      return new Promise<string>((resolve, reject) => {
        const check = () => {
          if (this.currentKey) {
            resolve(this.currentKey);
          } else if (!this.isPrompting) {
            reject(new Error('Failed to get encryption key'));
          } else {
            setTimeout(check, 100);
          }
        };
        check();
      });
    }

    return this.promptForEncryptionKey(0);
  }

  private async promptForEncryptionKey(attempt: number): Promise<string> {
    if (attempt >= this.maxRetries) {
      this.isPrompting = false;
      throw new Error('Maximum number of encryption key prompt attempts reached');
    }

    this.isPrompting = true;

    try {
      return new Promise<string>((resolve, reject) => {
        console.log('\n=== Encryption Key Required ===');

        const notificationOptions: NotificationOptions = {
          title: 'Encryption Key Required',
          message: 'Please enter the encryption key for the hilan-mcp database',
          subtitle: 'Database access requires encryption',
          sound: 'Funk',
          timeout: 30,
          wait: true,
          reply: 'Input your encryption key',
        };

        const handleNotificationResponse: NotificationCallback = (err, response, metadata = {}) => {
          if (err) {
            console.error('Error showing notification:', err);
            this.fallbackToTerminal(attempt, resolve, reject);
            return;
          }

          if (response === 'timeout' || response === 'dismissed') {
            console.log('\nEncryption key prompt was closed or timed out');
            this.isPrompting = false;
            reject(new Error('Encryption key input was cancelled'));
            return;
          }

          if (response === 'activate' || response === 'replied') {
            const key = (metadata?.activationValue || metadata?.response || '').toString().trim();

            if (!key) {
              console.error('Error: Encryption key cannot be empty');
              this.promptForEncryptionKey(attempt + 1).then(resolve).catch(reject);
              return;
            }

            try {
              this.setKey(key);
              this.isPrompting = false;
              resolve(key);
            } catch (error) {
              console.error(
                'Error setting encryption key:',
                error instanceof Error ? error.message : String(error)
              );
              this.promptForEncryptionKey(attempt + 1).then(resolve).catch(reject);
            }
          }
        };

        try {
          const optionsWithCallback = { ...notificationOptions, callback: handleNotificationResponse };

          sendNotification(optionsWithCallback).catch(error => {
            console.error('Failed to send notification:', error);
            this.fallbackToTerminal(attempt, resolve, reject);
          });
        } catch (error) {
          console.error('Error sending notification:', error);
          this.fallbackToTerminal(attempt, resolve, reject);
        }
      });
    } catch (error) {
      this.isPrompting = false;
      throw error;
    }
  }

  /** Routes to the stdin prompt, or rejects immediately if that's disabled (see `allowStdinFallback`). */
  private fallbackToTerminal(attempt: number, resolve: (key: string) => void, reject: (reason?: any) => void): void {
    if (!this.allowStdinFallback) {
      this.isPrompting = false;
      reject(
        new Error(
          'Could not obtain the database encryption key: no OS credential store entry, no HILAN_DB_KEY env var, ' +
            'and the desktop notification prompt failed or is unavailable. Since this MCP server runs over stdio, ' +
            'it cannot fall back to a terminal prompt (that would corrupt the MCP protocol stream). ' +
            'Run `npm run setup-key` or set HILAN_DB_KEY in this server\'s env, then retry.'
        )
      );
      return;
    }
    this.promptTerminalForEncryptionKey(attempt, resolve, reject);
  }

  private promptTerminalForEncryptionKey(
    attempt: number,
    resolve: (key: string) => void,
    reject: (reason?: any) => void
  ): void {
    console.log('\nPlease enter the encryption key for the database:');

    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (input: string) => {
      const key = input.trim();

      if (!key) {
        console.error('Error: Encryption key cannot be empty');
        this.promptForEncryptionKey(attempt + 1).then(resolve).catch(reject);
        return;
      }

      try {
        this.setKey(key);
        this.isPrompting = false;
        resolve(key);
      } catch (error) {
        console.error(
          'Error setting encryption key:',
          error instanceof Error ? error.message : String(error)
        );
        this.promptTerminalForEncryptionKey(attempt + 1, resolve, reject);
      }
    });
  }

  public clearKey(): void {
    this.currentKey = null;
  }
}

export const encryptionKeyService = EncryptionKeyService.getInstance();
