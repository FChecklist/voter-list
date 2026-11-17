// WebCrypto helpers shared by the Worker, the tests and the in-browser verifier. No Node-only APIs.
const enc = new TextEncoder();
const subtle = (): SubtleCrypto => globalThis.crypto.subtle;

export type Bytes = Uint8Array<ArrayBuffer>;
export const utf8 = (s: string): Bytes => new Uint8Array(enc.encode(s));
export const hex = (b: ArrayBuffer | Uint8Array): string => Array.from(b instanceof Uint8Array ? b : new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
export const fromHex = (h: string): Bytes => new Uint8Array((h.match(/../g) ?? []).map((x) => parseInt(x, 16)));
export function b64url(b: ArrayBuffer | Uint8Array): string {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function fromB64url(s: string): Bytes {
  const p = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(p); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u;
}

export async function sha256Hex(s: string | Bytes): Promise<string> {
  return hex(await subtle().digest("SHA-256", typeof s === "string" ? utf8(s) : s));
}

export async function hmacHex(secret: string, message: string): Promise<string> {
  const k = await subtle().importKey("raw", utf8(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await subtle().sign("HMAC", k, utf8(message)));
}

/** Constant-time string compare (equal length hex/base64 strings). Length difference is not secret here. */
export function timingSafeEqual(a: string, b: string): boolean {
  const x = utf8(a), y = utf8(b);
  let d = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return d === 0;
}

/** Uniform random integer in [0, max) by rejection sampling (no modulo bias). */
export function randomInt(max: number, rnd: (u: Uint32Array) => void = (u) => globalThis.crypto.getRandomValues(u)): number {
  if (!Number.isInteger(max) || max <= 0 || max > 0x100000000) throw new Error("randomInt: bad max");
  const limit = Math.floor(0x100000000 / max) * max;
  const u = new Uint32Array(1);
  for (;;) { rnd(u); if (u[0]! < limit) return u[0]! % max; }
}
export const randomHex = (bytes: number): string => hex(globalThis.crypto.getRandomValues(new Uint8Array(bytes)));

// ---- Ed25519 (log signatures). Workers expose "Ed25519"; older runtimes "NODE-ED25519". ----
const ALGS: any[] = [{ name: "Ed25519" }, { name: "NODE-ED25519", namedCurve: "NODE-ED25519" }];
async function tryAlg<T>(f: (a: any) => Promise<T>): Promise<T> {
  let last: unknown;
  for (const a of ALGS) { try { return await f(a); } catch (e) { last = e; } }
  throw last;
}
export interface KeyMaterial { privateKeyPkcs8: string; publicKeyRaw: string; kid: string }
export async function generateSigningKey(): Promise<KeyMaterial> {
  const kp: CryptoKeyPair = await tryAlg((a) => subtle().generateKey(a, true, ["sign", "verify"]) as Promise<CryptoKeyPair>);
  const priv = new Uint8Array(await subtle().exportKey("pkcs8", kp.privateKey));
  const pub = new Uint8Array(await subtle().exportKey("raw", kp.publicKey));
  return { privateKeyPkcs8: b64url(priv), publicKeyRaw: b64url(pub), kid: (await sha256Hex(pub)).slice(0, 16) };
}
/** Public key (raw, base64url) of a PKCS8 private key, so a deployment only needs ONE secret. */
export async function publicKeyFromPrivate(privateKeyPkcs8: string): Promise<string> {
  const key = await tryAlg((a) => subtle().importKey("pkcs8", fromB64url(privateKeyPkcs8), a, true, ["sign"]));
  const jwk = await subtle().exportKey("jwk", key) as JsonWebKey;
  if (!jwk.x) throw new Error("cannot derive public key");
  return jwk.x; // JWK 'x' for OKP/Ed25519 is the raw public key in base64url
}
export async function signMessage(privateKeyPkcs8: string, message: string): Promise<string> {
  const key = await tryAlg((a) => subtle().importKey("pkcs8", fromB64url(privateKeyPkcs8), a, false, ["sign"]));
  const alg = (key.algorithm as any).name === "Ed25519" ? { name: "Ed25519" } : { name: "NODE-ED25519" };
  return b64url(await subtle().sign(alg as any, key, utf8(message)));
}
export async function verifyMessage(publicKeyRaw: string, message: string, sig: string): Promise<boolean> {
  try {
    const key = await tryAlg((a) => subtle().importKey("raw", fromB64url(publicKeyRaw), a, false, ["verify"]));
    const alg = (key.algorithm as any).name === "Ed25519" ? { name: "Ed25519" } : { name: "NODE-ED25519" };
    return await subtle().verify(alg as any, key, fromB64url(sig), utf8(message));
  } catch { return false; }
}

// ---- AES-GCM for the private store (per-event data key, wrapped by the master secret) ----
async function aesKey(raw: Bytes, usages: KeyUsage[]): Promise<CryptoKey> { return subtle().importKey("raw", raw, "AES-GCM", false, usages); }
export async function aesEncrypt(rawKey32: Bytes, plaintext: string, aad = ""): Promise<string> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv, additionalData: utf8(aad) }, await aesKey(rawKey32, ["encrypt"]), utf8(plaintext)));
  return b64url(new Uint8Array([...iv, ...ct]));
}
export async function aesDecrypt(rawKey32: Bytes, packed: string, aad = ""): Promise<string> {
  const u = fromB64url(packed);
  const pt = await subtle().decrypt({ name: "AES-GCM", iv: u.slice(0, 12), additionalData: utf8(aad) }, await aesKey(rawKey32, ["decrypt"]), u.slice(12));
  return new TextDecoder().decode(pt);
}
/** Master-secret -> 32-byte key for wrapping event keys. */
export async function deriveKey32(secret: string, label: string): Promise<Bytes> { return fromHex(await hmacHex(secret, "voter-list/key/" + label)); }
