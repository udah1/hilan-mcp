import { sendNotification } from '../utils/notify.js';
import type { NotificationOptions, NotificationCallback } from '../utils/notify.js';
import { getSecretFromOsStore } from '../utils/secretStore.js';

export class EncryptionKeyService {
  private static instance: EncryptionKeyService;
  private currentKey: string | null = null;
  private isPrompting = false;
  private maxRetries = 2;

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
            this.promptTerminalForEncryptionKey(attempt, resolve, reject);
            return;
          }

          if (response === 'timeout' || response === 'dismissed') {
            console.log('\nEncryption key prompt was closed or timed out');
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
            this.promptTerminalForEncryptionKey(attempt, resolve, reject);
          });
        } catch (error) {
          console.error('Error sending notification:', error);
          this.promptTerminalForEncryptionKey(attempt, resolve, reject);
        }
      });
    } catch (error) {
      this.isPrompting = false;
      throw error;
    }
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
