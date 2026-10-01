#!/usr/bin/env node
/**
 * Sets a household's sign-in password.
 *
 * `wrangler secret put AUTH_PASSWORD_HASH` stores whatever it is handed, and the
 * Worker expects a derived hash, not a password. Typing the password directly
 * stores something `verifyPassword` can never match: it splits on `$` and
 * requires four `pbkdf2`-prefixed parts, so a plain string fails the format check
 * and returns false for every attempt. Sign-in then fails permanently, and looks
 * exactly like a forgotten password.
 *
 * This derives the hash locally with the parameters worker/api/auth.ts verifies
 * against, and pipes only the hash to wrangler. The password never leaves this
 * process.
 *
 *     npm run set:password                  # production
 *     npm run set:password -- --env ritwik  # another household
 *
 * There is no change-password flow in the app, so this is also how a password is
 * rotated. Changing it invalidates existing sessions, because the cookie signing
 * key is derived from the stored hash.
 */
import { execFileSync } from "node:child_process";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";

/** Must match PBKDF2_ITERATIONS in worker/api/auth.ts. */
const ITERATIONS = 100_000;
const MIN_PASSWORD_LENGTH = 12;

const style = {
  step: (text) => console.log(`\n[1m[36m▸ ${text}[0m`),
  ok: (text) => console.log(`  [32m✓[0m ${text}`),
  fail: (text) => console.error(`\n[31m✗ ${text}[0m`),
};

/**
 * Serialized exactly as worker/api/auth.ts writes it:
 * `pbkdf2$<iterations>$<base64 salt>$<base64 hash>`, standard base64, SHA-256,
 * a 16-byte salt and 32 derived bytes.
 */
export function hashPassword(password, iterations = ITERATIONS) {
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  return `pbkdf2$${iterations}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

function wranglerBin() {
  const local = resolve("node_modules", "wrangler", "bin", "wrangler.js");
  return existsSync(local) ? local : null;
}

function putSecret(hash, environment) {
  const args = ["secret", "put", "AUTH_PASSWORD_HASH"];
  // A named environment needs the source config; the deploy build writes a
  // flattened one into dist/ that carries no environments.
  if (environment) args.push("--env", environment, "-c", "wrangler.jsonc");
  const bin = wranglerBin();
  const options = { input: `${hash}\n`, encoding: "utf8", stdio: ["pipe", "inherit", "inherit"] };
  if (bin) return execFileSync(process.execPath, [bin, ...args], options);
  return execFileSync("npx", ["wrangler", ...args], { ...options, shell: process.platform === "win32" });
}

async function main() {
  const flag = process.argv.indexOf("--env");
  const environment = flag >= 0 ? process.argv[flag + 1] : "";
  if (flag >= 0 && !environment) throw new Error("--env needs an environment name, for example: --env ritwik");

  if (!process.stdin.isTTY) {
    throw new Error("This needs a terminal to prompt for the password. Run it directly, not through a pipe.");
  }

  style.step(`Setting the sign-in password${environment ? ` for "${environment}"` : ""}`);
  console.log("  The password is hashed here and never sent anywhere in readable form.\n");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const password = (await rl.question(`  Password (at least ${MIN_PASSWORD_LENGTH} characters): `)).trim();
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new Error(`That is ${password.length} characters; ${MIN_PASSWORD_LENGTH} is the minimum.`);
    }
    const again = (await rl.question("  Type it again: ")).trim();
    if (password !== again) throw new Error("The two entries did not match. Nothing was changed.");

    putSecret(hashPassword(password), environment);
    style.ok("Stored as a hash. Existing sessions are now invalid; sign in again.");
  } finally {
    rl.close();
  }
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  main().catch((error) => {
    style.fail(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
