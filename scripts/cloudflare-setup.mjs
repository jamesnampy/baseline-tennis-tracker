#!/usr/bin/env node
/**
 * One-time Cloudflare provisioning for Baseline.
 *
 * Creates the D1 database, writes its id into wrangler.jsonc, applies the
 * migrations, and sets the SYNC_TOKEN secret. It deliberately does NOT deploy —
 * publishing the app is a separate, explicit step (`npm run deploy`).
 *
 * Safe to re-run: every step checks for its own result first, so a half-finished
 * setup can be resumed rather than restarted.
 *
 * Requires `npx wrangler login` first; that flow opens a browser and cannot be
 * scripted.
 */
import { execFileSync } from "node:child_process";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";

const WRANGLER_CONFIG = "wrangler.jsonc";
const DATABASE_NAME = "baseline-tennis-tracker";
const PLACEHOLDER = "REPLACE_WITH_D1_DATABASE_ID";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Must match worker/api/auth.ts. Workers' WebCrypto rejects anything above this.
const PBKDF2_ITERATIONS = 100_000;
const MIN_PASSWORD_LENGTH = 12;

const dryRun = process.argv.includes("--dry-run");
const resetPassword = process.argv.includes("--reset-password");

const style = {
  step: (text) => console.log(`\n[1m[36m▸ ${text}[0m`),
  ok: (text) => console.log(`  [32m✓[0m ${text}`),
  skip: (text) => console.log(`  [90m·[0m ${text}`),
  warn: (text) => console.log(`  [33m![0m ${text}`),
  fail: (text) => console.error(`\n[31m✗ ${text}[0m`),
};

/**
 * Runs the locally installed wrangler directly with node.
 *
 * Going through `npx` needs shell:true on Windows, which Node deprecates
 * (DEP0190) because arguments are concatenated rather than escaped. Every
 * argument here is a literal, so nothing was actually at risk - but resolving
 * the bin and skipping the shell removes the warning and a process hop.
 */
function wranglerBin() {
  const local = resolve("node_modules", "wrangler", "bin", "wrangler.js");
  return existsSync(local) ? local : null;
}

function runWrangler(args, { capture = true, input } = {}) {
  const bin = wranglerBin();
  const stdio = capture ? ["pipe", "pipe", "pipe"] : "inherit";
  if (bin) {
    return execFileSync(process.execPath, [bin, ...args], { encoding: "utf8", stdio, input });
  }
  return execFileSync("npx", ["wrangler", ...args], { encoding: "utf8", stdio, input, shell: process.platform === "win32" });
}

function wrangler(args, { capture = true, input } = {}) {
  if (dryRun) {
    console.log(`  [90m[dry run] wrangler ${args.join(" ")}[0m`);
    return "";
  }
  return runWrangler(args, { capture, input });
}

function requireLogin() {
  style.step("Checking Cloudflare authentication");
  let output;
  try {
    output = runWrangler(["whoami"]);
  } catch {
    output = "";
  }
  if (/not authenticated/i.test(output) || !output) {
    style.fail("Not logged in to Cloudflare.");
    console.error("\n  Run this yourself first (it opens a browser):\n");
    console.error("      npx wrangler login\n");
    console.error("  Then re-run:  npm run setup:cloudflare\n");
    process.exit(1);
  }
  const account = /│\s+(.+?)\s+│\s+([0-9a-f]{32})\s+│/.exec(output);
  style.ok(account ? `Authenticated as ${account[1]} (${account[2]})` : "Authenticated");
}

/** Finds the database by name, creating it only if it does not already exist. */
function ensureDatabase() {
  style.step(`Provisioning the D1 database "${DATABASE_NAME}"`);
  let existing = [];
  try {
    existing = JSON.parse(wrangler(["d1", "list", "--json"]) || "[]");
  } catch {
    existing = [];
  }
  let found = existing.find((database) => database.name === DATABASE_NAME);
  if (found) {
    style.skip(`Already exists (${found.uuid})`);
    return found.uuid;
  }

  wrangler(["d1", "create", DATABASE_NAME]);
  try {
    existing = JSON.parse(wrangler(["d1", "list", "--json"]) || "[]");
  } catch {
    existing = [];
  }
  found = existing.find((database) => database.name === DATABASE_NAME);
  if (!found && !dryRun) throw new Error(`Created "${DATABASE_NAME}" but could not read its id back from d1 list.`);
  if (found) style.ok(`Created (${found.uuid})`);
  return found?.uuid ?? "";
}

/**
 * Targeted replacement rather than parse-and-rewrite: wrangler.jsonc carries
 * comments that explain the bindings, and JSON.stringify would delete them.
 */
function writeDatabaseId(databaseId) {
  style.step("Writing the database id into wrangler.jsonc");
  if (!databaseId) {
    style.skip("[dry run] would write the id of the database it just created");
    return;
  }
  const config = readFileSync(WRANGLER_CONFIG, "utf8");
  const current = /"database_id":\s*"([^"]*)"/.exec(config);
  if (!current) throw new Error(`No database_id field found in ${WRANGLER_CONFIG}.`);
  if (current[1] === databaseId) {
    style.skip("Already set");
    return;
  }
  if (current[1] !== PLACEHOLDER && UUID.test(current[1])) {
    style.warn(`Leaving the existing id ${current[1]} alone. Edit ${WRANGLER_CONFIG} by hand to point at a different database.`);
    return;
  }
  if (dryRun) {
    style.skip(`[dry run] would set database_id to ${databaseId}`);
    return;
  }
  writeFileSync(WRANGLER_CONFIG, config.replace(/"database_id":\s*"[^"]*"/, `"database_id": "${databaseId}"`));
  style.ok(`Set to ${databaseId}`);
}

function applyMigrations() {
  style.step("Applying migrations to the remote database");
  const output = wrangler(["d1", "migrations", "apply", DATABASE_NAME, "--remote"], { input: "y\n" });
  if (/No migrations to apply/i.test(output)) style.skip("Already up to date");
  else style.ok("Applied");
}

/**
 * Whether SYNC_TOKEN already exists: true, false, or null when wrangler's output
 * could not be read. Null matters — overwriting a live token would silently
 * break every device already syncing, so an unreadable answer must not be
 * treated as "absent".
 */
function syncTokenExists() {
  for (const args of [["secret", "list", "--format", "json"], ["secret", "list"]]) {
    let output;
    try {
      output = wrangler(args);
    } catch (error) {
      output = String(error?.stdout ?? "") + String(error?.stderr ?? "");
    }
    if (dryRun) return true;
    // Secrets live on the Worker, so they cannot be set until it exists. On a
    // first run this is the expected state, not a failure.
    if (/Worker .*not found|not_found|10007/i.test(output)) return "no-worker";
    try {
      const parsed = JSON.parse(output);
      if (Array.isArray(parsed)) return parsed.some((secret) => secret?.name === "SYNC_TOKEN");
    } catch {
      if (/SYNC_TOKEN/.test(output)) return true;
      // A readable listing with no SYNC_TOKEN in it is a real "no".
      if (/secret|name/i.test(output)) return false;
    }
  }
  return null;
}

/**
 * Hashes the password here so the plaintext never reaches Cloudflare. Format
 * matches worker/api/auth.ts: pbkdf2$<iterations>$<salt>$<hash>.
 */
function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, 32, "sha256");
  return `pbkdf2$${PBKDF2_ITERATIONS}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

function secretExists(name) {
  for (const args of [["secret", "list", "--format", "json"], ["secret", "list"]]) {
    let output;
    try {
      output = wrangler(args);
    } catch (error) {
      output = String(error?.stdout ?? "") + String(error?.stderr ?? "");
    }
    if (dryRun) return true;
    if (/Worker .*not found|not_found|10007/i.test(output)) return "no-worker";
    try {
      const parsed = JSON.parse(output);
      if (Array.isArray(parsed)) return parsed.some((secret) => secret?.name === name);
    } catch {
      if (new RegExp(name).test(output)) return true;
      if (/secret|name/i.test(output)) return false;
    }
  }
  return null;
}

/**
 * The account password. This is what a browser signs in with, so it is the one
 * credential that has to be memorable — nothing is stored on the device.
 */
async function ensurePassword(rl) {
  style.step("Setting the account password");
  const exists = secretExists("AUTH_PASSWORD_HASH");
  if (exists === "no-worker") return "pending-deploy";
  if (exists === true && !resetPassword) {
    style.skip("Already set. Re-run with --reset-password to change it.");
    return null;
  }
  if (exists === true) style.warn("Changing the password signs out every device.");

  // Without a terminal there is nobody to prompt, and retrying on EOF would
  // spin forever rather than failing.
  if (!process.stdin.isTTY) {
    style.warn("Setting a password needs an interactive terminal.");
    console.log("\n  Run this directly in your terminal:\n");
    console.log("      npm run setup:cloudflare\n");
    return "pending-input";
  }

  let password = "";
  for (let attempt = 1; ; attempt += 1) {
    if (attempt > 3) {
      style.fail("Giving up after three attempts. Nothing was changed.");
      return "pending-input";
    }
    password = (await rl.question(`  Choose a password (at least ${MIN_PASSWORD_LENGTH} characters): `)).trim();
    if (password.length < MIN_PASSWORD_LENGTH) {
      style.warn(`Too short — ${MIN_PASSWORD_LENGTH} characters minimum.`);
      continue;
    }
    const again = (await rl.question("  Type it again: ")).trim();
    if (again !== password) {
      style.warn("Those did not match.");
      continue;
    }
    break;
  }

  wrangler(["secret", "put", "AUTH_PASSWORD_HASH"], { input: `${hashPassword(password)}\n` });
  style.ok("Stored as a PBKDF2 hash. Cloudflare never sees the password itself.");
  return "set";
}

async function ensureSyncToken(rl, passwordState) {
  style.step("Setting the SYNC_TOKEN secret");
  const exists = syncTokenExists();
  if (exists === "no-worker") return "pending-deploy";
  if (exists === true) {
    style.skip("Already set. Run `npx wrangler secret put SYNC_TOKEN` to rotate it.");
    return null;
  }
  // With a password configured, the app signs in and needs no token at all. A
  // token is only for scripts hitting the API, so it is opt-in.
  if (passwordState) {
    const wanted = (await rl.question("  Also create a bearer token for scripts and the analysis API? [y/N] ")).trim().toLowerCase();
    if (wanted !== "y" && wanted !== "yes") {
      style.skip("Skipped. The app signs in with the password; add one later with `npx wrangler secret put SYNC_TOKEN`.");
      return null;
    }
  }
  if (exists === null) {
    style.warn("Could not read the existing secrets from Cloudflare.");
    const answer = rl ? (await rl.question("  Generate and store a new SYNC_TOKEN? This replaces any existing one and will stop devices already syncing. [y/N] ")).trim().toLowerCase() : "n";
    if (answer !== "y" && answer !== "yes") {
      style.skip("Left alone. Set it yourself with `npx wrangler secret put SYNC_TOKEN`.");
      return null;
    }
  }
  // 32 random bytes. This is the only credential guarding cloud sync and the
  // read-only API, so it is generated rather than left to a typed passphrase.
  const token = randomBytes(32).toString("base64url");
  wrangler(["secret", "put", "SYNC_TOKEN"], { input: `${token}\n` });
  style.ok("Generated and stored");
  if (rl) {
    console.log(`\n  [1mSYNC_TOKEN[0m — paste this into the app's Export screen to turn on cloud sync.`);
    console.log(`  It is not recoverable from Cloudflare; save it now.\n`);
    console.log(`      ${token}\n`);
  }
  return token;
}

async function main() {
  console.log("\n[1mBaseline · Cloudflare setup[0m");
  if (dryRun) style.warn("Dry run: nothing will be created or changed.");

  requireLogin();
  const databaseId = ensureDatabase();
  writeDatabaseId(databaseId);
  applyMigrations();

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let passwordState;
  let tokenState;
  try {
    passwordState = await ensurePassword(rl);
    if (passwordState !== "pending-deploy") tokenState = await ensureSyncToken(rl, passwordState);
  } finally {
    rl.close();
  }

  // Secrets need a Worker to live on, so nothing more can be done until the
  // first deploy has created one.
  if (passwordState === "pending-input") return;

  if (passwordState === "pending-deploy" || tokenState === "pending-deploy") {
    style.skip("The Worker does not exist yet, so it has nothing to hold secrets.");
    console.log("\n  Deploy first, then run this again:\n");
    console.log("      npm run deploy");
    console.log("      npm run setup:cloudflare\n");
    return;
  }

  style.step("Setup complete");
  console.log(`
  Optional, for the hosted AI strategy review:
      npx wrangler secret put ANTHROPIC_API_KEY

  Then publish:
      npm run deploy

  [90mDeploying publishes the tracker at its configured domain. Matches stay on
  the device until you enable cloud sync, and the API refuses every request
  without the SYNC_TOKEN, so nothing is exposed by the deploy itself.[0m
`);
}

main().catch((error) => {
  style.fail(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
