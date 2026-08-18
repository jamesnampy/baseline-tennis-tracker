#!/usr/bin/env node
/**
 * Builds and publishes Baseline.
 *
 * Social-preview images need an absolute URL, and a static SPA has no request
 * context to derive one from, so the origin is baked in at build time.
 *
 * The origin is resolved in this order:
 *
 *   1. VITE_PUBLIC_ORIGIN in the environment
 *   2. VITE_PUBLIC_ORIGIN in .env.production
 *   3. the custom domain declared in wrangler.jsonc  ← how this project runs
 *   4. discovered from the first deploy's workers.dev URL, then recorded
 *
 * Reading the custom domain from wrangler.jsonc means the origin is committed
 * config rather than an untracked file, so a fresh clone deploys correctly on
 * the first pass with nothing to remember.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ENV_FILE = ".env.production";
const style = {
  step: (text) => console.log(`\n[1m[36m▸ ${text}[0m`),
  ok: (text) => console.log(`  [32m✓[0m ${text}`),
  warn: (text) => console.log(`  [33m![0m ${text}`),
  fail: (text) => console.error(`\n[31m✗ ${text}[0m`),
};

/**
 * Runs the locally installed wrangler directly with node.
 *
 * Going through `npx` needs shell:true on Windows, which Node deprecates
 * (DEP0190) because arguments are concatenated rather than escaped. Every
 * argument here is a literal, so nothing was actually at risk - but resolving
 * the bin and skipping the shell removes the warning and a process hop.
 */
/** Path to a locally installed CLI's entry script, or null if it is not there. */
function localBin(...segments) {
  const local = resolve("node_modules", ...segments);
  return existsSync(local) ? local : null;
}

const wranglerBin = () => localBin("wrangler", "bin", "wrangler.js");
const viteBin = () => localBin("vite", "bin", "vite.js");

/**
 * Builds without going through npm.
 *
 * Node refuses to spawn a .cmd shim without shell:true on Windows, so
 * `npm.cmd run build` fails with EINVAL. Running vite's own entry script with
 * node sidesteps the shim entirely and behaves the same on every platform.
 */
const build = (origin) => {
  // The origin has to reach the build as an environment variable. Resolving it
  // here and only printing it is how the first deploy shipped a relative
  // og:image while claiming to build for the custom domain.
  const env = origin ? { ...process.env, VITE_PUBLIC_ORIGIN: origin } : process.env;
  const bin = viteBin();
  if (bin) return execFileSync(process.execPath, [bin, "build"], { encoding: "utf8", stdio: "inherit", env });
  return execFileSync("npm", ["run", "build"], { encoding: "utf8", stdio: "inherit", shell: true, env });
};

const deploy = ({ capture = false } = {}) => {
  const bin = wranglerBin();
  const stdio = capture ? ["inherit", "pipe", "inherit"] : "inherit";
  if (bin) return execFileSync(process.execPath, [bin, "deploy"], { encoding: "utf8", stdio });
  return execFileSync("npx", ["wrangler", "deploy"], { encoding: "utf8", stdio, shell: process.platform === "win32" });
};

/**
 * Parses JSONC. wrangler.jsonc carries comments explaining every binding, and a
 * naive comment strip would also gut the "https://" inside any string value, so
 * this walks the text and leaves string literals alone.
 */
export function parseJsonc(text) {
  let out = "";
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];
    if (inLineComment) {
      if (character === "\n") { inLineComment = false; out += character; }
      continue;
    }
    if (inBlockComment) {
      if (character === "*" && next === "/") { inBlockComment = false; index += 1; }
      continue;
    }
    if (inString) {
      out += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') { inString = true; out += character; continue; }
    if (character === "/" && next === "/") { inLineComment = true; index += 1; continue; }
    if (character === "/" && next === "*") { inBlockComment = true; index += 1; continue; }
    out += character;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

/** The custom domain this worker is routed to, if one is declared. */
export function configuredCustomDomain(text = readFileSync("wrangler.jsonc", "utf8")) {
  try {
    const config = parseJsonc(text);
    const route = (config.routes ?? []).find((entry) => entry?.custom_domain && typeof entry.pattern === "string");
    if (!route) return "";
    // A route pattern may carry a path; only the host is the origin.
    return `https://${route.pattern.split("/")[0]}`;
  } catch {
    return "";
  }
}

function recordedOrigin() {
  if (process.env.VITE_PUBLIC_ORIGIN) return process.env.VITE_PUBLIC_ORIGIN.replace(/\/$/, "");
  if (existsSync(ENV_FILE)) {
    const match = /^VITE_PUBLIC_ORIGIN=(.*)$/m.exec(readFileSync(ENV_FILE, "utf8"));
    const fromFile = (match?.[1] ?? "").trim().replace(/\/$/, "");
    if (fromFile) return fromFile;
  }
  return configuredCustomDomain();
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
  build(known);

  style.step("Deploying to Cloudflare");
  const output = deploy({ capture: !known });
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
  build(url);
  deploy();
  style.ok(`Deployed. Open ${url}`);
  console.log(`\n  [90mThis two-pass build only happens once. Later deploys reuse ${ENV_FILE}.[0m\n`);
}

// Importing this module (the config tests do) must not deploy anything.
if (process.argv[1] && import.meta.filename === process.argv[1]) {
  try {
    main();
  } catch (error) {
    style.fail(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
