/**
 * Password login for the tracker's own device.
 *
 * The point of this module is that nothing secret has to live on the device.
 * Cloudflare holds a PBKDF2 hash of the password — not the password — and the
 * browser holds only a signed, expiring session cookie it cannot read. What the
 * user keeps is a password they chose, not a random string they have to file
 * away somewhere.
 *
 * A bearer token remains supported for scripts and the read-only analysis API,
 * where there is no browser to hold a cookie.
 */

const encoder = new TextEncoder();

/**
 * Workers' WebCrypto refuses PBKDF2 above 100,000 iterations:
 *
 *   NotSupportedError: Pbkdf2 failed: iteration counts above 100000 are not
 *   supported (requested 210000).
 *
 * So this is the platform ceiling, not a chosen number, and it is below the
 * OWASP recommendation for PBKDF2-HMAC-SHA256. The per-IP login throttle and
 * the minimum password length carry the rest of the weight.
 */
export const MAX_SUPPORTED_ITERATIONS = 100_000;
export const PBKDF2_ITERATIONS = MAX_SUPPORTED_ITERATIONS;
export const SESSION_COOKIE = "baseline_session";
export const MIN_PASSWORD_LENGTH = 12;
/** Failed logins allowed per IP inside the throttle window. */
export const MAX_ATTEMPTS = 8;
export const THROTTLE_WINDOW_SECONDS = 15 * 60;
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const fromBase64 = (value: string): Uint8Array =>
  Uint8Array.from(atob(value), (character) => character.charCodeAt(0));

const toBase64Url = (bytes: Uint8Array): string =>
  toBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

/** Rejects on length before comparing, then compares every byte regardless. */
export function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  // `salt as BufferSource`: the DOM lib narrows this to ArrayBuffer-backed views,
  // which a plain Uint8Array does not satisfy under Workers types.
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" }, key, 256);
  return new Uint8Array(bits);
}

/** Serialized as `pbkdf2$<iterations>$<salt>$<hash>` so the cost can be raised later. */
export async function hashPassword(password: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, iterations);
  return `pbkdf2$${iterations}$${toBase64(salt)}$${toBase64(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]);
  // Too low is a downgrade attempt; too high is a hash this runtime cannot
  // verify at all, and would otherwise throw out of the request.
  if (!Number.isInteger(iterations) || iterations < 1000 || iterations > MAX_SUPPORTED_ITERATIONS) return false;
  try {
    const salt = fromBase64(parts[2]!);
    const actual = toBase64(await pbkdf2(password, salt, iterations));
    return constantTimeEquals(actual, parts[3]!);
  } catch {
    return false;
  }
}

/**
 * The cookie signing key is derived from the stored hash rather than being a
 * second secret to manage. Changing the password therefore invalidates every
 * existing session, which is the behaviour you want from a password change.
 */
async function signingKey(passwordHash: string): Promise<CryptoKey> {
  const material = await crypto.subtle.digest("SHA-256", encoder.encode(`${passwordHash}:session-v1`));
  return crypto.subtle.importKey("raw", material, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

async function sign(passwordHash: string, payload: string): Promise<string> {
  const key = await signingKey(passwordHash);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return toBase64Url(new Uint8Array(signature));
}

export async function issueSession(passwordHash: string, now = Date.now()): Promise<{ value: string; maxAge: number }> {
  const expiry = Math.floor(now / 1000) + SESSION_TTL_SECONDS;
  const payload = `v1.${expiry}`;
  return { value: `${payload}.${await sign(passwordHash, payload)}`, maxAge: SESSION_TTL_SECONDS };
}

export async function verifySession(passwordHash: string, token: string | undefined, now = Date.now()): Promise<boolean> {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return false;
  const expiry = Number(parts[1]);
  if (!Number.isInteger(expiry) || expiry * 1000 <= now) return false;
  return constantTimeEquals(parts[2]!, await sign(passwordHash, `v1.${parts[1]}`));
}

export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return undefined;
}

export function sessionCookie(value: string, maxAge: number): string {
  // HttpOnly so no script can read it, Secure so it never crosses plain HTTP,
  // Lax so a share link opened from a message cannot carry it anywhere.
  return `${SESSION_COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

export const clearedSessionCookie = (): string =>
  `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
