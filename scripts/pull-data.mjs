#!/usr/bin/env node
/**
 * Downloads every synced match to this machine for offline analysis.
 *
 * The tracking device stays the only device that records matches. This pulls
 * what it has already pushed to D1, so a laptop can hold the dataset without
 * the app ever syncing matches back down into it.
 *
 *     BASELINE_TOKEN=... npm run pull
 *
 * Produces, under ./baseline-data by default:
 *
 *     matches.json                    every match's metadata and score
 *     combined/points.csv             every point across every match
 *     combined/shots.csv              ... and so on per table
 *     matches/<date>-<opponent>/      one folder per match, full bundle
 *
 * The combined tables are plain concatenation — same headers, each row already
 * carrying its match_id — so a notebook or spreadsheet can read the whole
 * history in one load. No server-side aggregation is involved.
 *
 * Re-running overwrites: the event log is append-only and immutable, so the
 * newest download is always the complete one.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configuredCustomDomain } from "./deploy.mjs";

const OUT_DIR = process.env.BASELINE_OUT ?? "baseline-data";
/** Tables worth stitching together across matches. */
const COMBINED = [
  "matches.csv", "points.csv", "serves.csv", "shots.csv",
  "games.csv", "sets.csv", "mental_states.csv", "score_syncs.csv",
  "match_status.csv", "strategy_reviews.csv", "players.csv", "identity_mappings.csv",
];

const style = {
  step: (text) => console.log(`\n[1m[36m▸ ${text}[0m`),
  ok: (text) => console.log(`  [32m✓[0m ${text}`),
  skip: (text) => console.log(`  [90m·[0m ${text}`),
  fail: (text) => console.error(`\n[31m✗ ${text}[0m`),
};

function baseUrl() {
  if (process.env.BASELINE_URL) return process.env.BASELINE_URL.replace(/\/$/, "");
  const domain = configuredCustomDomain();
  if (domain) return domain;
  throw new Error("No deployment URL. Set BASELINE_URL, or declare a custom domain in wrangler.jsonc.");
}

function token() {
  const value = process.env.BASELINE_TOKEN;
  if (value) return value;
  throw new Error(
    "No API token. Set BASELINE_TOKEN to the deployment's SYNC_TOKEN.\n" +
    "  (The app signs in with a password; scripts use the bearer token, which is what it is for.)",
  );
}

async function api(path, { base, auth }) {
  const response = await fetch(`${base}/api/v1${path}`, { headers: { authorization: `Bearer ${auth}` } });
  if (response.status === 401) throw new Error("The token was rejected. Check BASELINE_TOKEN.");
  if (response.status === 503) throw new Error("Hosted access is disabled on this deployment.");
  if (!response.ok) throw new Error(`GET ${path} returned ${response.status}.`);
  return response.json();
}

/** Pages by updatedAt, which is what the list endpoint filters on. */
async function listMatches(context) {
  const all = [];
  let updatedSince;
  for (;;) {
    const query = new URLSearchParams({ limit: "100" });
    if (updatedSince) query.set("updatedSince", updatedSince);
    const page = await api(`/matches?${query}`, context);
    if (!page.matches.length) break;
    all.push(...page.matches);
    if (!page.nextUpdatedSince || page.nextUpdatedSince === updatedSince) break;
    updatedSince = page.nextUpdatedSince;
    if (page.matches.length < 100) break;
  }
  return all;
}

/** Filesystem-safe, human-scannable folder name. */
function folderName(match) {
  const date = (match.config?.date ?? match.createdAt ?? "").slice(0, 10) || "undated";
  const opponent = (match.config?.opponentName ?? "opponent").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${date}-${opponent || "opponent"}`;
}

/**
 * Concatenates CSVs that share a header, keeping the header once.
 *
 * Every row already carries its own match_id, so the combined table is a
 * faithful superset rather than a summary.
 */
function combineCsv(chunks) {
  let header;
  const body = [];
  for (const chunk of chunks) {
    const lines = chunk.split("\n");
    if (!lines.length) continue;
    const [first, ...rest] = lines;
    if (header === undefined) header = first;
    else if (first !== header) throw new Error("CSV headers differ between matches; refusing to merge them.");
    for (const line of rest) if (line.trim()) body.push(line);
  }
  return header === undefined ? "" : [header, ...body].join("\n") + "\n";
}

async function main() {
  const context = { base: baseUrl(), auth: token() };
  style.step(`Pulling from ${context.base}`);

  const matches = await listMatches(context);
  if (!matches.length) {
    style.skip("No matches have been synced yet. Turn on cloud sync on the tracking device.");
    return;
  }
  style.ok(`${matches.length} match${matches.length === 1 ? "" : "es"} available`);

  mkdirSync(join(OUT_DIR, "matches"), { recursive: true });
  mkdirSync(join(OUT_DIR, "combined"), { recursive: true });

  const collected = new Map(COMBINED.map((name) => [name, []]));
  const index = [];

  style.step("Downloading bundles");
  for (const summary of matches) {
    const bundle = await api(`/matches/${summary.id}/export`, context);
    const detail = await api(`/matches/${summary.id}`, context);
    const dir = join(OUT_DIR, "matches", folderName(summary));
    mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(bundle.files)) {
      writeFileSync(join(dir, name), content);
      if (collected.has(name)) collected.get(name).push(content);
    }
    index.push({
      id: summary.id,
      folder: folderName(summary),
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
      tournamentKey: summary.tournamentKey,
      config: summary.config,
      score: detail.match?.score,
      scoreSummary: detail.match?.scoreSummary,
      complete: detail.match?.complete,
      coverage: detail.coverage,
    });
    style.ok(`${folderName(summary)} · ${detail.match?.scoreSummary ?? "in progress"}`);
  }

  style.step("Writing combined tables");
  for (const [name, chunks] of collected) {
    if (!chunks.length) continue;
    const merged = combineCsv(chunks);
    const rows = Math.max(0, merged.trim().split("\n").length - 1);
    writeFileSync(join(OUT_DIR, "combined", name), merged);
    style.ok(`combined/${name} — ${rows} row${rows === 1 ? "" : "s"}`);
  }

  writeFileSync(join(OUT_DIR, "matches.json"), JSON.stringify({
    generatedAt: new Date().toISOString(),
    source: context.base,
    matchCount: index.length,
    matches: index,
  }, null, 2));

  style.step("Done");
  console.log(`
  ${OUT_DIR}/matches.json          index of every match, with score and coverage
  ${OUT_DIR}/combined/*.csv        every match stitched into one table per topic
  ${OUT_DIR}/matches/<match>/      each match's full bundle, including events.json

  [90mThis folder holds a child's match data. It is gitignored; keep it that way.[0m
`);
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  main().catch((error) => {
    style.fail(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

export { combineCsv, folderName };
