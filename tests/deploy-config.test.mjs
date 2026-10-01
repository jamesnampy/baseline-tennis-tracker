/**
 * The deploy script reads wrangler.jsonc to learn the public origin, so a
 * malformed parse would silently bake the wrong URL into the social tags. These
 * tests cover the JSONC handling and pin the deployment shape the project
 * actually runs with.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { configuredCustomDomain, parseJsonc } from "../scripts/deploy.mjs";

test("JSONC parsing survives comments, and leaves URLs inside strings alone", () => {
  const parsed = parseJsonc(`{
    // a line comment mentioning https://example.com/not-a-comment
    "keep": "https://baseline.jamesvibecode.com/path", /* trailing block */
    /* a block
       comment spanning lines */
    "escaped": "a \\" quote // still in the string",
    "nested": { "list": [1, 2] },
  }`);
  assert.equal(parsed.keep, "https://baseline.jamesvibecode.com/path");
  assert.equal(parsed.escaped, 'a " quote // still in the string');
  assert.deepEqual(parsed.nested.list, [1, 2]);
});

test("the committed wrangler config parses and declares the deployment shape", () => {
  const config = parseJsonc(readFileSync("wrangler.jsonc", "utf8"));
  assert.equal(config.name, "baseline-tennis-tracker");
  // One canonical public origin: the custom domain, with workers.dev disabled.
  assert.equal(config.workers_dev, false);
  const custom = config.routes.filter((route) => route.custom_domain);
  assert.equal(custom.length, 1);
  assert.equal(custom[0].pattern, "baseline.jamesvibecode.com");
  // The Worker must see these before the asset server does.
  assert.deepEqual(config.assets.run_worker_first, ["/api/*", "/report/*"]);
  assert.equal(config.assets.not_found_handling, "single-page-application");
  assert.equal(config.d1_databases[0].binding, "DB");
  assert.equal(config.durable_objects.bindings[0].class_name, "MatchRoom");
});

test("the public origin resolves to the custom domain, host only", () => {
  assert.equal(configuredCustomDomain(), "https://baseline.jamesvibecode.com");
  // A pattern carrying a path still yields just the origin.
  assert.equal(
    configuredCustomDomain(`{"routes":[{"pattern":"baseline.jamesvibecode.com/app/*","custom_domain":true}]}`),
    "https://baseline.jamesvibecode.com",
  );
  // A plain route is not a custom domain and must not be used as the origin.
  assert.equal(configuredCustomDomain(`{"routes":[{"pattern":"example.com/*","zone_name":"example.com"}]}`), "");
  assert.equal(configuredCustomDomain("{}"), "");
  assert.equal(configuredCustomDomain("not json at all"), "");
});

test("combining CSVs keeps one header and every row", async () => {
  const { combineCsv, folderName } = await import("../scripts/pull-data.mjs");
  const a = '"match_id","point"\n"m1","1"\n"m1","2"\n';
  const b = '"match_id","point"\n"m2","1"\n';
  const merged = combineCsv([a, b]);
  assert.equal(merged, '"match_id","point"\n"m1","1"\n"m1","2"\n"m2","1"\n');
  assert.equal(combineCsv([]), "");
  // A table only one match has still comes through whole.
  assert.equal(combineCsv([b]), b);
  // Mismatched headers would silently corrupt a merged table, so refuse.
  assert.throws(() => combineCsv([a, '"different","header"\n"x","y"\n']), /headers differ/);

  assert.equal(folderName({ config: { date: "2026-08-18", opponentName: "Noah Vandermeer" } }), "2026-08-18-noah-vandermeer");
  assert.equal(folderName({ createdAt: "2026-01-02T10:00:00.000Z", config: {} }), "2026-01-02-opponent");
  // Punctuation must not escape into a path.
  assert.equal(folderName({ config: { date: "2026-08-18", opponentName: "A/B .. C" } }), "2026-08-18-a-b-c");
});

/**
 * A second household runs as a named environment. Isolation is a property of the
 * bindings, not of application code, so these pin it: the day two environments
 * share a database id or a hostname, one family starts reading another's match
 * data, and nothing in the app would notice.
 */
test("every environment binds its own database, hostname and worker name", () => {
  const config = parseJsonc(readFileSync("wrangler.jsonc", "utf8"));
  const environments = [
    { label: "production", scope: config },
    ...Object.entries(config.env ?? {}).map(([label, scope]) => ({ label, scope })),
  ];
  assert.ok(environments.length > 1, "there should be more than production here");

  const seen = { name: new Map(), database: new Map(), host: new Map() };
  for (const { label, scope } of environments) {
    const database = scope.d1_databases?.[0];
    const host = scope.routes?.[0]?.pattern;
    assert.ok(database?.database_id, `${label} declares no database id`);
    assert.doesNotMatch(database.database_id, /REPLACE_WITH/, `${label} still has a placeholder database id`);
    assert.ok(host, `${label} declares no custom domain`);
    assert.equal(scope.workers_dev, false, `${label} must not also serve from workers.dev`);
    // Each must bind D1 and the match room, or the environment silently loses
    // sync and live links rather than failing loudly.
    assert.equal(database.binding, "DB");
    assert.equal(scope.durable_objects?.bindings?.[0]?.class_name, "MatchRoom");

    for (const [key, value] of [["name", scope.name], ["database", database.database_id], ["host", host]]) {
      const previous = seen[key].get(value);
      assert.equal(previous, undefined, `${label} shares its ${key} with ${previous}`);
      seen[key].set(value, label);
    }
  }
});

test("the deploy script reads each environment's own origin", () => {
  const text = readFileSync("wrangler.jsonc", "utf8");
  const config = parseJsonc(text);
  assert.equal(configuredCustomDomain(text, ""), "https://baseline.jamesvibecode.com");
  for (const [label, scope] of Object.entries(config.env ?? {})) {
    assert.equal(configuredCustomDomain(text, label), `https://${scope.routes[0].pattern}`);
  }
  // An unknown environment yields nothing rather than falling back to production,
  // which would bake the wrong absolute URLs into a build.
  assert.equal(configuredCustomDomain(text, "no-such-environment"), "");
});
