import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Šifrování `connections.encrypted_credentials` — AES-256-GCM.
 * Klíč = CREDENTIALS_ENCRYPTION_KEY (32 bytů v hex; `openssl rand -hex 32`).
 * Formát uloženého řetězce: base64(iv).base64(authTag).base64(ciphertext)
 */
function key(): Buffer {
  const hex = process.env.CREDENTIALS_ENCRYPTION_KEY;
  if (!hex) throw new Error("CREDENTIALS_ENCRYPTION_KEY není nastavena.");
  const buf = Buffer.from(hex, "hex");
  if (buf.length !== 32) {
    throw new Error("CREDENTIALS_ENCRYPTION_KEY musí být 32 bytů (64 hex znaků).");
  }
  return buf;
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), enc.toString("base64")].join(".");
}

export function decryptSecret(payload: string): string {
  const [ivB64, tagB64, dataB64] = payload.split(".");
  if (!ivB64 || !tagB64 || !dataB64) throw new Error("Neplatný formát šifrovaného tajemství.");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/** Zašifruje JSON objekt credentials. */
export function encryptCredentials(creds: Record<string, unknown>): string {
  return encryptSecret(JSON.stringify(creds));
}

export function decryptCredentials<T = Record<string, unknown>>(payload: string): T {
  return JSON.parse(decryptSecret(payload)) as T;
}
