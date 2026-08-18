#!/usr/bin/env node
/**
 * Builds and publishes Baseline.
 *
 * Social-preview images need an absolute URL, and a static SPA has no request
 * context to derive one from, so the origin is baked in at build time. On a
 * brand-new worker that origin is not knowable until after the first deploy —
 * so the first run deploys, reads the URL back, records it in `.env.production`,
 * and builds again. Every run after that is a single build and deploy.
 *
 * Set VITE_PUBLIC_ORIGIN yourself (env var or `.env.production`) to skip the
 * discovery pass entirely — required when serving from a custom domain, since
 * the workers.dev URL would then be the wrong origin to bake in.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const ENV_FILE = ".env.production";
const style = {
  step: (text) => console.log(`\n[1m[36m▸ ${text}[0m`),
  ok: (text) => console.log(`  [32m✓[0m ${text}`),
  warn: (text) => console.log(`  [33m![0m ${text}`),
  fail: (text) => console.error(`\n[31m✗ ${text}[0m`),
};

const run = (command, args, { capture = false } = {}) =>
  execFileSync(command, args, {
    encoding: "utf8",
    stdio: capture ? ["inherit", "pipe", "inherit"] : "inherit",
    shell: process.platform === "win32",
  });

function recordedOrigin() {
  if (process.env.VITE_PUBLIC_ORIGIN) return process.env.VITE_PUBLIC_ORIGIN.replace(/\/$/, "");
  if (!existsSync(ENV_FILE)) return "";
  const match = /^VITE_PUBLIC_ORIGIN=(.*)$/m.exec(readFileSync(ENV_FILE, "utf8"));
  return (match?.[1] ?? "").trim().replace(/\/$/, "");
}

function recordOrigin(origin) {
  const line = `VITE_PUBLIC_ORIGIN=${origin}\n`;
  if (!existsSync(ENV_FILE)) {
    writeFileSync(ENV_FILE, `# Written by scripts/deploy.mjs after the first deploy.\n# Change this if you move to a custom domain.\n${line}`);
    return;
  }
  const current = readFileSync(ENV_FILE, "utf8");
  writeFileSync(ENV_FILE, /^VITE_PUBLIC_ORIGIN=.*$/m.test(current)
    ? current.replace(/^VITE_PUBLIC_ORIGIN=.*$/m, line.trim())
    : current + line);
}

function checkConfigured() {
  const config = readFileSync("wrangler.jsonc", "utf8");
  if (config.includes("REPLACE_WITH_D1_DATABASE_ID")) {
    style.fail("The D1 database id in wrangler.jsonc is still a placeholder.");
    console.error("\n  Run setup first:\n\n      npx wrangler login\n      npm run setup:cloudflare\n");
    process.exit(1);
  }
}

/** Pulls the published URL out of wrangler's deploy output. */
function deployedUrl(output) {
  const match = /https:\/\/[^\s]*\.workers\.dev/.exec(output ?? "");
  return match ? match[0] : "";
}

function main() {
  checkConfigured();
  const known = recordedOrigin();

  style.step(known ? `Building for ${known}` : "Building (public origin not yet known)");
  run("npm", ["run", "build"]);

  style.step("Deploying to Cloudflare");
  const output = run("npx", ["wrangler", "deploy"], { capture: !known });
  if (!known) process.stdout.write(output ?? "");

  if (known) {
    style.ok(`Deployed. Public origin: ${known}`);
    return;
  }

  const url = deployedUrl(output);
  if (!url) {
    style.warn("Deployed, but the workers.dev URL could not be read from the output.");
    console.log(`  Set it yourself and redeploy so social previews resolve:\n\n      echo VITE_PUBLIC_ORIGIN=https://your-worker.workers.dev > ${ENV_FILE}\n      npm run deploy\n`);
    return;
  }

  recordOrigin(url);
  style.ok(`Discovered ${url} and recorded it in ${ENV_FILE}`);
  style.step("Rebuilding with the real origin and redeploying");
  run("npm", ["run", "build"]);
  run("npx", ["wrangler", "deploy"]);
  style.ok(`Deployed. Open ${url}`);
  console.log(`\n  [90mThis two-pass build only happens once. Later deploys reuse ${ENV_FILE}.[0m\n`);
}

try {
  main();
} catch (error) {
  style.fail(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
