import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM for the two secrets this app holds at rest: the YouTube cookie
 * jar and the OAuth refresh token.
 *
 * Both are full account credentials — a YouTube cookie jar authenticates every
 * Google service, not just YouTube — so neither is ever written in plaintext,
 * logged, or included in error messages.
 *
 * Layout: iv(12) | authTag(16) | ciphertext
 */
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export class SecretBox {
  private readonly key: Buffer;

  constructor(base64Key: string) {
    if (!base64Key) {
      throw new Error('SECRET_KEY is not set; generate one with the command in .env.example');
    }
    this.key = Buffer.from(base64Key, 'base64');
    if (this.key.length !== 32) {
      throw new Error(`SECRET_KEY must decode to 32 bytes, got ${this.key.length}`);
    }
  }

  seal(plaintext: Buffer | string): Buffer {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  }

  open(sealed: Buffer): Buffer {
    if (sealed.length < IV_LENGTH + TAG_LENGTH) throw new Error('sealed value is truncated');
    const iv = sealed.subarray(0, IV_LENGTH);
    const tag = sealed.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(sealed.subarray(IV_LENGTH + TAG_LENGTH)), decipher.final()]);
  }
}
