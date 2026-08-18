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
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";

const WRANGLER_CONFIG = "wrangler.jsonc";
const DATABASE_NAME = "baseline-tennis-tracker";
const PLACEHOLDER = "REPLACE_WITH_D1_DATABASE_ID";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const dryRun = process.argv.includes("--dry-run");

const style = {
  step: (text) => console.log(`\n[1m[36m▸ ${text}[0m`),
  ok: (text) => console.log(`  [32m✓[0m ${text}`),
  skip: (text) => console.log(`  [90m·[0m ${text}`),
  warn: (text) => console.log(`  [33m![0m ${text}`),
  fail: (text) => console.error(`\n[31m✗ ${text}[0m`),
};

function wrangler(args, { capture = true, input } = {}) {
  if (dryRun) {
    console.log(`  [90m[dry run] wrangler ${args.join(" ")}[0m`);
    return "";
  }
  return execFileSync("npx", ["wrangler", ...args], {
    encoding: "utf8",
    stdio: capture ? ["pipe", "pipe", "pipe"] : "inherit",
    input,
    shell: process.platform === "win32",
  });
}

function requireLogin() {
  style.step("Checking Cloudflare authentication");
  let output;
  try {
    output = execFileSync("npx", ["wrangler", "whoami"], {
      encoding: "utf8",
      shell: process.platform === "win32",
    });
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
  return found?.uuid ?? PLACEHOLDER;
}

/**
 * Targeted replacement rather than parse-and-rewrite: wrangler.jsonc carries
 * comments that explain the bindings, and JSON.stringify would delete them.
 */
function writeDatabaseId(databaseId) {
  style.step("Writing the database id into wrangler.jsonc");
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
    } catch {
      continue;
    }
    if (dryRun) return true;
    try {
      const parsed = JSON.parse(output);
      if (Array.isArray(parsed)) return parsed.some((secret) => secret?.name === "SYNC_TOKEN");
    } catch {
      if (/\bSYNC_TOKEN\b/.test(output)) return true;
      // A readable listing with no SYNC_TOKEN in it is a real "no".
      if (/secret|name/i.test(output)) return false;
    }
  }
  return null;
}

async function ensureSyncToken(rl) {
  style.step("Setting the SYNC_TOKEN secret");
  const exists = syncTokenExists();
  if (exists) {
    style.skip("Already set. Run `npx wrangler secret put SYNC_TOKEN` to rotate it.");
    return null;
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
  try {
    await ensureSyncToken(rl);
  } finally {
    rl.close();
  }

  style.step("Setup complete");
  console.log(`
  Optional, for the hosted AI strategy review:
      npx wrangler secret put ANTHROPIC_API_KEY

  Then publish:
      npm run deploy

  [90mDeploying makes the app reachable at its workers.dev URL. Matches stay on
  the device until you enable cloud sync, and the API refuses every request
  without the SYNC_TOKEN, so nothing is exposed by the deploy itself.[0m
`);
}

main().catch((error) => {
  style.fail(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
