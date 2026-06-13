import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const SALT = 'opencare-integrations-v1';
// Minimal length required for a dedicated integrations encryption key.
const MIN_DEDICATED_KEY_LENGTH = 32;

function getKey(): Buffer {
    // Separation of usage (recommended in production): set INTEGRATIONS_ENCRYPTION_KEY
    // to a dedicated secret so the credential-encryption key is independent from the
    // JWT signing secret. When it is defined and long enough, the key is derived from
    // it (trimmed). Otherwise we FALL BACK to JWT_SECRET so existing encrypted
    // credentials stay decryptable (no migration needed).
    const dedicated = process.env.INTEGRATIONS_ENCRYPTION_KEY?.trim();
    if (dedicated && dedicated.length >= MIN_DEDICATED_KEY_LENGTH) {
        return scryptSync(dedicated, SALT, 32);
    }

    // NOTE: the fallback key MUST stay derived from the raw (untrimmed) JWT_SECRET with
    // this exact salt/length, otherwise existing encrypted credentials become undecryptable.
    const secret = process.env.JWT_SECRET;
    if (!secret) {
        throw new Error('JWT_SECRET is required to encrypt/decrypt integration credentials. Set it in your .env file.');
    }
    return scryptSync(secret, SALT, 32);
}

export function encryptCredentials(data: Record<string, string>): string {
    const key = getKey();
    const iv = randomBytes(16);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return JSON.stringify({
        iv: iv.toString('hex'),
        tag: tag.toString('hex'),
        data: encrypted.toString('hex'),
    });
}

export function decryptCredentials(encryptedJson: string): Record<string, string> {
    const key = getKey();
    const { iv, tag, data } = JSON.parse(encryptedJson) as { iv: string; tag: string; data: string };
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'hex'));
    decipher.setAuthTag(Buffer.from(tag, 'hex'));
    const decrypted = decipher.update(Buffer.from(data, 'hex')).toString('utf8') + decipher.final('utf8');
    return JSON.parse(decrypted) as Record<string, string>;
}
