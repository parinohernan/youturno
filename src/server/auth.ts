const encoder = new TextEncoder();
const COOKIE = "__Host-youturno";
const ITERATIONS = 600_000;
const SESSION_SECONDS = 8 * 60 * 60;

function encode(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decode(value: string): Uint8Array {
  if (!/^[\w-]+$/.test(value) || value.length % 4 === 1) throw new Error("Invalid encoding");
  return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
}

function equal(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12 || password.length > 1024) throw new Error("Invalid password length");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const hash = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", iterations: ITERATIONS, salt: salt.buffer as ArrayBuffer }, key, 256));
  return `pbkdf2-sha256$${ITERATIONS}$${encode(salt)}$${encode(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algorithm, count, saltText, hashText] = stored.split("$");
  if (algorithm !== "pbkdf2-sha256" || count !== String(ITERATIONS) || !saltText || !hashText || password.length > 1024) return false;
  try {
    const salt = decode(saltText);
    const expected = decode(hashText);
    if (salt.length !== 16 || expected.length !== 32) return false;
    const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
    const actual = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", iterations: ITERATIONS, salt: salt.buffer as ArrayBuffer }, key, 256));
    return equal(encode(actual), hashText);
  } catch { return false; }
}

export type Token = { sub: number; sv: number; csrf: string; iat: number; exp: number };

function keyFrom(secret: string): Promise<CryptoKey> {
  if (secret.length < 32) throw new Error("AUTH_SECRET must contain at least 32 characters");
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function signToken(secret: string, userId: number, version: number): Promise<{ jwt: string; csrf: string }> {
  const csrf = encode(crypto.getRandomValues(new Uint8Array(32)));
  const iat = Math.floor(Date.now() / 1000);
  const body: Token = { sub: userId, sv: version, csrf, iat, exp: iat + SESSION_SECONDS };
  const message = `${encode(encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })))}.${encode(encoder.encode(JSON.stringify(body)))}`;
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await keyFrom(secret), encoder.encode(message)));
  return { jwt: `${message}.${encode(signature)}`, csrf };
}

export async function verifyToken(secret: string, jwt: string): Promise<Token | null> {
  const parts = jwt.split(".");
  if (parts.length !== 3 || jwt.length > 4096) return null;
  try {
    const [header, payload, signature] = parts;
    const claims = JSON.parse(new TextDecoder().decode(decode(payload))) as Token;
    const head = JSON.parse(new TextDecoder().decode(decode(header)));
    const now = Math.floor(Date.now() / 1000);
    if (head.alg !== "HS256" || head.typ !== "JWT" || !Number.isSafeInteger(claims.sub) || claims.sub < 1 ||
      !Number.isSafeInteger(claims.sv) || claims.sv < 0 || !Number.isSafeInteger(claims.exp) ||
      !Number.isSafeInteger(claims.iat) || claims.iat > now + 60 || claims.exp <= now ||
      claims.exp - claims.iat !== SESSION_SECONDS || typeof claims.csrf !== "string" || claims.csrf.length !== 43) return null;
    const valid = await crypto.subtle.verify("HMAC", await keyFrom(secret), decode(signature).buffer as ArrayBuffer, encoder.encode(`${header}.${payload}`));
    return valid ? claims : null;
  } catch { return null; }
}

export function safeEqual(a: string, b: string): boolean { return equal(a, b); }
export { COOKIE };
