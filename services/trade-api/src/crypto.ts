import crypto from "crypto";

// Support both KEYS_ENC_KEY and TRADE_BOT_KEYRING for backward compatibility
const KEY_ENV_PRIMARY = "KEYS_ENC_KEY";
const KEY_ENV_LEGACY = "TRADE_BOT_KEYRING";

let cryptoConfigured = false;
let cryptoError: string | null = null;

function loadKey(): Buffer {
    const raw = process.env[KEY_ENV_PRIMARY] || process.env[KEY_ENV_LEGACY];
    if (!raw) {
        throw new Error(`Missing encryption key: set ${KEY_ENV_PRIMARY} or ${KEY_ENV_LEGACY}`);
    }

    const trimmed = raw.trim();
    let key: Buffer | null = null;

    if (/^[0-9a-fA-F]+$/.test(trimmed)) {
        const buf = Buffer.from(trimmed, "hex");
        if (buf.length === 32) key = buf;
    }

    if (!key) {
        try {
            const buf = Buffer.from(trimmed, "base64");
            if (buf.length === 32) key = buf;
        } catch (_) {
            // ignore
        }
    }

    if (!key) {
        throw new Error(`Encryption key must be 32 bytes (hex or base64)`);
    }

    return key;
}

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
    if (!cachedKey) {
        cachedKey = loadKey();
    }
    return cachedKey;
}

/**
 * Check if encryption is properly configured
 */
export function isCryptoConfigured(): boolean {
    return cryptoConfigured;
}

/**
 * Get the crypto configuration error message (if any)
 */
export function getCryptoError(): string | null {
    return cryptoError;
}

/**
 * Run crypto self-test on startup
 */
function runSelfTest(): void {
    try {
        const testPayload = "pepepow-crypto-self-test-" + Date.now();
        const encrypted = encryptString(testPayload);
        const decrypted = decryptString(encrypted);
        if (decrypted !== testPayload) {
            throw new Error("Self-test decrypt mismatch");
        }
        cryptoConfigured = true;
        console.log("[crypto] self-test passed");
    } catch (err: any) {
        cryptoConfigured = false;
        cryptoError = err?.message || String(err);
        console.error(`[crypto] self-test FAILED: ${cryptoError}`);
    }
}

// Run self-test on module load
try {
    getKey(); // Attempt to load key
    runSelfTest();
} catch (err: any) {
    cryptoConfigured = false;
    cryptoError = err?.message || String(err);
    console.error(`[crypto] initialization FAILED: ${cryptoError}`);
}

export interface EncryptedPayload {
    cipher: string;
    iv: string;
    tag: string;
}

export function encryptString(plainText: string): EncryptedPayload {
    const key = getKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([
        cipher.update(plainText, "utf8"),
        cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    return {
        cipher: encrypted.toString("base64"),
        iv: iv.toString("base64"),
        tag: tag.toString("base64"),
    };
}

export function decryptString(payload: EncryptedPayload): string {
    const key = getKey();
    const iv = Buffer.from(payload.iv, "base64");
    const tag = Buffer.from(payload.tag, "base64");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([
        decipher.update(Buffer.from(payload.cipher, "base64")),
        decipher.final(),
    ]);
    return decrypted.toString("utf8");
}

export interface EncryptedKeyPair {
    keyCipher: string;
    secretCipher: string;
    iv: string;
    tag: string;
}

export function encryptKeyPair(apiKey: string, apiSecret: string): EncryptedKeyPair {
    const payload = JSON.stringify({ apiKey, apiSecret });
    const key = getKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([
        cipher.update(payload, "utf8"),
        cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    const midpoint = Math.ceil(encrypted.length / 2);
    const keyCipher = encrypted.slice(0, midpoint).toString("base64");
    const secretCipher = encrypted.slice(midpoint).toString("base64");

    return {
        keyCipher,
        secretCipher,
        iv: iv.toString("base64"),
        tag: tag.toString("base64"),
    };
}

export function decryptKeyPair(payload: EncryptedKeyPair): { apiKey: string; apiSecret: string } {
    const key = getKey();
    const iv = Buffer.from(payload.iv, "base64");
    const tag = Buffer.from(payload.tag, "base64");
    const cipherBytes = Buffer.concat([
        Buffer.from(payload.keyCipher, "base64"),
        Buffer.from(payload.secretCipher, "base64"),
    ]);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([
        decipher.update(cipherBytes),
        decipher.final(),
    ]);
    const parsed = JSON.parse(decrypted.toString("utf8")) as { apiKey: string; apiSecret: string };
    return { apiKey: parsed.apiKey, apiSecret: parsed.apiSecret };
}
