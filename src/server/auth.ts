const encoder = new TextEncoder();
const COOKIE = "__Host-youturno";
const ITERATIONS = 600_000;
const SESSION_SECONDS = 8 * 60 * 60;
export const CUSTOMER_COOKIE = "yt_book";
export const CUSTOMER_STATE_COOKIE = "yt_oauth";
export const CUSTOMER_SECONDS = 30 * 24 * 60 * 60;
const STATE_SECONDS = 10 * 60;

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

export type CustomerClaims = { sub: string; email: string; name: string; iat: number; exp: number };

/** One-time OAuth nonce, base64url like every other signed value here. */
export function randomNonce(): string {
  return encode(crypto.getRandomValues(new Uint8Array(32)));
}

async function hmac(secret: string, message: string): Promise<string> {
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await keyFrom(secret), encoder.encode(message)));
  return encode(signature);
}

/** Same construction as `signToken`, with a `typ` that keeps the two cookie families distinct. */
async function signPayload(secret: string, typ: string, claims: Record<string, string>, lifetime: number): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  const body: Record<string, unknown> = { ...claims, iat, exp: iat + lifetime };
  const header = encode(encoder.encode(JSON.stringify({ alg: "HS256", typ })));
  const payload = encode(encoder.encode(JSON.stringify(body)));
  const message = `${header}.${payload}`;
  return `${message}.${await hmac(secret, message)}`;
}

async function verifyPayload<T>(
  secret: string, typ: string, token: string, lifetime: number, claimsValid: (claims: T & { iat: number; exp: number }) => boolean,
): Promise<(T & { iat: number; exp: number }) | null> {
  const parts = token.split(".");
  if (parts.length !== 3 || token.length > 4096) return null;
  try {
    const [header, payload, signature] = parts;
    const head = JSON.parse(new TextDecoder().decode(decode(header)));
    const claims = JSON.parse(new TextDecoder().decode(decode(payload))) as T & { iat: number; exp: number };
    const now = Math.floor(Date.now() / 1000);
    if (head.alg !== "HS256" || head.typ !== typ || !Number.isSafeInteger(claims.iat) || claims.iat > now + 60 ||
      !Number.isSafeInteger(claims.exp) || claims.exp <= now || claims.exp - claims.iat !== lifetime) return null;
    if (!claimsValid(claims)) return null;
    const valid = await crypto.subtle.verify("HMAC", await keyFrom(secret), decode(signature).buffer as ArrayBuffer, encoder.encode(`${header}.${payload}`));
    return valid ? claims : null;
  } catch { return null; }
}

export type CustomerSession = { sub: string; email: string; name: string };

/** The signed customer identity stored in the public booking cookie. */
export async function signCustomerToken(secret: string, customer: CustomerSession): Promise<string> {
  return signPayload(secret, "CUSTOMER", { sub: customer.sub, email: customer.email, name: customer.name }, CUSTOMER_SECONDS);
}

export async function verifyCustomerToken(secret: string, jwt: string): Promise<CustomerClaims | null> {
  return verifyPayload<CustomerClaims>(secret, "CUSTOMER", jwt, CUSTOMER_SECONDS, (claims) =>
    claims.sub.length > 0 && claims.email.includes("@") && claims.name.length <= 200);
}

export type OAuthState = { n: string; s: string };

/** The signed `state` parameter echoed by Google's consent redirect. */
export async function signCustomerState(secret: string, state: OAuthState): Promise<string> {
  return signPayload(secret, "CUSTOMER-OAUTH-STATE", { n: state.n, s: state.s }, STATE_SECONDS);
}

export async function verifyCustomerState(secret: string, token: string): Promise<OAuthState | null> {
  return verifyPayload<OAuthState>(secret, "CUSTOMER-OAUTH-STATE", token, STATE_SECONDS, (state) =>
    state.n.length > 0 && state.s.length > 0);
}
