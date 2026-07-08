// Testovací klíč MUSÍ být nastaven dřív, než crypto funkce klíč přečtou.
// crypto.ts čte process.env líně (uvnitř key()), takže stačí nastavit
// před spuštěním testů — import modulu samotný klíč nečte.
process.env.CREDENTIALS_ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"; // 64 hex znaků = 32 bytů

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decryptCredentials,
  decryptSecret,
  encryptCredentials,
  encryptSecret,
} from "./crypto.js";

test("encryptSecret → decryptSecret round-trip", () => {
  const plain = "super tajné heslo ěščř";
  const enc = encryptSecret(plain);
  assert.equal(decryptSecret(enc), plain);
});

test("formát je base64(iv).base64(tag).base64(ciphertext)", () => {
  const enc = encryptSecret("data");
  const parts = enc.split(".");
  assert.equal(parts.length, 3);
  for (const p of parts) assert.ok(p.length > 0);
});

test("encryptCredentials → decryptCredentials round-trip objektu", () => {
  const creds = { token: "abc123", scopes: ["read", "write"], count: 42 };
  const enc = encryptCredentials(creds);
  const dec = decryptCredentials<typeof creds>(enc);
  assert.deepEqual(dec, creds);
});

test("ciphertext se liší mezi voláními (náhodné IV)", () => {
  const a = encryptSecret("same plaintext");
  const b = encryptSecret("same plaintext");
  assert.notEqual(a, b);
  // ale oba dešifrují na stejný text
  assert.equal(decryptSecret(a), "same plaintext");
  assert.equal(decryptSecret(b), "same plaintext");
});

// Přehodí první znak base64 řetězce na jiný → poškodí dekódované bajty.
function flipFirst(b64: string): string {
  const first = b64[0];
  const replacement = first === "A" ? "B" : "A";
  return replacement + b64.slice(1);
}

test("dešifrování poškozeného payloadu vyhodí", () => {
  const enc = encryptSecret("integrita");
  const [iv, tag, data] = enc.split(".");
  // Poškozený ciphertext → GCM auth tag selže
  assert.throws(() => decryptSecret([iv, tag, flipFirst(data!)].join(".")));
  // Poškozený tag také selže
  assert.throws(() => decryptSecret([iv, flipFirst(tag!), data].join(".")));
  // Poškozené IV také selže
  assert.throws(() => decryptSecret([flipFirst(iv!), tag, data].join(".")));
  // Nesprávný počet částí → explicitní chyba formátu
  assert.throws(() => decryptSecret("only.two"), /Neplatný formát/);
});
