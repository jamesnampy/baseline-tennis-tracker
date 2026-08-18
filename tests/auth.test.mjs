/**
 * Password hashing and session signing. These decide who reaches a child's
 * match data, so they are tested directly rather than only through the router.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  clearedSessionCookie,
  constantTimeEquals,
  hashPassword,
  issueSession,
  MIN_PASSWORD_LENGTH,
  readCookie,
  SESSION_COOKIE,
  sessionCookie,
  verifyPassword,
  verifySession,
} from "../worker/api/auth.ts";

// The real cost is deliberate; tests use a cheap one so they stay fast.
const CHEAP = 1000;

test("a password verifies against its hash and nothing else", async () => {
  const stored = await hashPassword("correct horse battery staple", CHEAP);
  assert.match(stored, /^pbkdf2\$1000\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  assert.equal(await verifyPassword("correct horse battery staple", stored), true);
  assert.equal(await verifyPassword("Correct horse battery staple", stored), false);
  assert.equal(await verifyPassword("", stored), false);
  assert.equal(await verifyPassword("correct horse battery stapl", stored), false);
});

test("the same password hashes differently every time", async () => {
  const first = await hashPassword("correct horse battery staple", CHEAP);
  const second = await hashPassword("correct horse battery staple", CHEAP);
  assert.notEqual(first, second, "a reused salt would make hashes comparable across deployments");
  assert.equal(await verifyPassword("correct horse battery staple", second), true);
});

test("a malformed or downgraded stored hash is rejected rather than trusted", async () => {
  for (const stored of [
    "",
    "notahash",
    "pbkdf2$1000$onlythree",
    "bcrypt$1000$c2FsdA==$aGFzaA==",
    // An attacker lowering the work factor must not make verification cheap.
    "pbkdf2$1$c2FsdA==$aGFzaA==",
    "pbkdf2$abc$c2FsdA==$aGFzaA==",
  ]) {
    assert.equal(await verifyPassword("anything", stored), false, stored);
  }
});

test("a session is signed, expiring, and bound to the password", async () => {
  const stored = await hashPassword("correct horse battery staple", CHEAP);
  const session = await issueSession(stored);
  assert.equal(await verifySession(stored, session.value), true);
  assert.ok(session.maxAge > 0);

  // Tampering with any part invalidates it.
  const [version, expiry, signature] = session.value.split(".");
  assert.equal(await verifySession(stored, `${version}.${Number(expiry) + 3600}.${signature}`), false);
  assert.equal(await verifySession(stored, `${version}.${expiry}.${signature.slice(0, -1)}x`), false);
  assert.equal(await verifySession(stored, "garbage"), false);
  assert.equal(await verifySession(stored, undefined), false);

  // Expired sessions stop working.
  const future = Date.now() + (session.maxAge + 60) * 1000;
  assert.equal(await verifySession(stored, session.value, future), false);

  // Changing the password invalidates every existing session.
  const rotated = await hashPassword("a completely different one", CHEAP);
  assert.equal(await verifySession(rotated, session.value), false);
});

test("the session cookie cannot be read by script and never crosses plain HTTP", async () => {
  const stored = await hashPassword("correct horse battery staple", CHEAP);
  const session = await issueSession(stored);
  const header = sessionCookie(session.value, session.maxAge);
  assert.match(header, /HttpOnly/);
  assert.match(header, /Secure/);
  assert.match(header, /SameSite=Lax/);
  assert.match(header, new RegExp(`^${SESSION_COOKIE}=`));
  // Signing out must expire it, not just blank it.
  assert.match(clearedSessionCookie(), /Max-Age=0/);
});

test("cookie parsing picks the right value out of a crowded header", () => {
  const request = (cookie) => new Request("https://example.com", { headers: { cookie } });
  assert.equal(readCookie(request(`${SESSION_COOKIE}=abc`), SESSION_COOKIE), "abc");
  assert.equal(readCookie(request(`other=1; ${SESSION_COOKIE}=abc; another=2`), SESSION_COOKIE), "abc");
  // A cookie whose name merely ends with ours must not match.
  assert.equal(readCookie(request(`not_${SESSION_COOKIE}=wrong`), SESSION_COOKIE), undefined);
  assert.equal(readCookie(request("other=1"), SESSION_COOKIE), undefined);
  assert.equal(readCookie(new Request("https://example.com"), SESSION_COOKIE), undefined);
});

test("comparison rejects length mismatches and differing content", () => {
  assert.equal(constantTimeEquals("abc", "abc"), true);
  assert.equal(constantTimeEquals("abc", "abd"), false);
  assert.equal(constantTimeEquals("abc", "abcd"), false);
  assert.equal(constantTimeEquals("", ""), true);
});

test("the minimum password length is long enough to be worth throttling", () => {
  assert.ok(MIN_PASSWORD_LENGTH >= 12);
});
