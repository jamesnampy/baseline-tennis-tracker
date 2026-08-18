/**
 * The outbox is exercised against a stubbed IndexedDB and fetch. What matters
 * here is the cursor arithmetic and the promise never to touch the local log —
 * the wire format itself is covered end to end against a real D1 in wrangler dev.
 */
import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

import {
  DEFAULT_SYNC_SETTINGS, flushOutbox, loadSyncSettings, pendingEventCount, pushMatch, saveSyncSettings,
} from "../lib/tennis/sync.ts";

const syncStates = new Map();
const cursors = {
  load: async (matchId) => syncStates.get(matchId),
  save: async (state) => { syncStates.set(state.matchId, state); },
};

const settings = { enabled: true, endpoint: "", token: "secret" };

function fixtureMatch(eventCount = 3) {
  return {
    id: "match-1", schemaVersion: 1,
    createdAt: new Date(0).toISOString(), updatedAt: new Date(eventCount * 1000).toISOString(),
    config: {
      myPlayerId: "player_my", opponentId: "player_opp", myPlayerName: "Ethan", opponentName: "Noah",
      format: "best_of_3_tiebreak", firstServer: "my", adScoring: true,
      startingMentalState: { my: "focused", opponent: "not_observed" },
    },
    events: Array.from({ length: eventCount }, (_, index) => ({
      id: `e${index + 1}`, matchId: "match-1", schemaVersion: 1, sequence: index + 1,
      timestamp: new Date(index * 1000).toISOString(), source: "tracked", type: "point_completed",
      pointGroupId: `g${index + 1}`, payload: {},
    })),
  };
}

let requests = [];
function stubFetch(status = 200) {
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers });
    return { ok: status >= 200 && status < 300, status, json: async () => ({}) };
  };
}

// Node defines `navigator` as a getter-only global, so it has to be redefined
// rather than assigned.
const define = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
const setOnline = (onLine) => define("navigator", { onLine });

beforeEach(() => {
  syncStates.clear();
  requests = [];
  setOnline(true);
  const values = new Map();
  define("localStorage", {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
  });
  stubFetch();
});

test("sync stays off until it is enabled with a token", async () => {
  assert.deepEqual(loadSyncSettings(), DEFAULT_SYNC_SETTINGS);
  assert.equal(saveSyncSettings({ enabled: true, endpoint: "", token: "  " }).enabled, false);
  assert.equal(saveSyncSettings({ enabled: true, endpoint: "https://x.dev/", token: " k " }).endpoint, "https://x.dev");
  const report = await pushMatch(fixtureMatch(), [], [], DEFAULT_SYNC_SETTINGS, cursors);
  assert.equal(report.outcome, "disabled");
  assert.equal(requests.length, 0);
});

test("the first push sends every event and later pushes send only what is new", async () => {
  const match = fixtureMatch(3);
  const first = await pushMatch(match, [], [], settings, cursors);
  assert.equal(first.outcome, "pushed");
  assert.equal(first.pushed, 3);
  assert.deepEqual(requests[0].body.events.map((event) => event.id), ["e1", "e2", "e3"]);

  const grown = { ...match, events: [...match.events, { ...match.events[0], id: "e4", sequence: 4 }] };
  const second = await pushMatch(grown, [], [], settings, cursors);
  assert.equal(second.pushed, 1);
  assert.deepEqual(requests[1].body.events.map((event) => event.id), ["e4"]);

  const third = await pushMatch(grown, [], [], settings, cursors);
  assert.equal(third.outcome, "up-to-date");
  assert.equal(requests.length, 2);
});

test("the outbox never mutates the local event log", async () => {
  const match = fixtureMatch(3);
  const before = JSON.stringify(match);
  await pushMatch(match, [], [], settings, cursors);
  assert.equal(JSON.stringify(match), before);
});

test("offline leaves events queued and does not advance the cursor", async () => {
  setOnline(false);
  const match = fixtureMatch(3);
  const report = await pushMatch(match, [], [], settings, cursors);
  assert.equal(report.outcome, "offline");
  assert.equal(report.pending, 3);
  assert.equal(requests.length, 0);
  assert.equal(pendingEventCount(match, syncStates.get("match-1")), 3);

  setOnline(true);
  assert.equal((await pushMatch(match, [], [], settings, cursors)).pushed, 3);
});

test("a rejected token reports the reason and keeps every event queued", async () => {
  stubFetch(401);
  const match = fixtureMatch(2);
  const report = await pushMatch(match, [], [], settings, cursors);
  assert.equal(report.outcome, "failed");
  assert.match(report.error, /token was rejected/);
  assert.equal(pendingEventCount(match, syncStates.get("match-1")), 2);

  stubFetch(200);
  assert.equal((await pushMatch(match, [], [], settings, cursors)).pushed, 2);
});

test("only the profiles this match references are pushed with it", async () => {
  const players = [
    { id: "player_my", displayName: "Ethan", role: "my_player", aliases: [], createdAt: "a", updatedAt: "a" },
    { id: "player_opp", displayName: "Noah", role: "opponent", aliases: [], createdAt: "a", updatedAt: "a" },
    { id: "player_other", displayName: "Someone else", role: "opponent", aliases: [], createdAt: "a", updatedAt: "a" },
  ];
  const mappings = [
    { id: "m1", fromPlayerId: "guest_1", toPlayerId: "player_opp", kind: "guest_link", createdAt: "a" },
    { id: "m2", fromPlayerId: "guest_2", toPlayerId: "player_other", kind: "guest_link", createdAt: "a" },
  ];
  await pushMatch(fixtureMatch(1), players, mappings, settings, cursors);
  assert.deepEqual(requests[0].body.players.map((player) => player.id), ["player_my", "player_opp"]);
  assert.deepEqual(requests[0].body.identityMappings.map((mapping) => mapping.id), ["m1"]);
  assert.doesNotMatch(JSON.stringify(requests[0].body), /Someone else/);
});

test("flushing pushes queued matches oldest first and stops when the connection drops", async () => {
  const older = { ...fixtureMatch(1), id: "match-old", updatedAt: new Date(1000).toISOString() };
  older.events = older.events.map((event) => ({ ...event, matchId: "match-old" }));
  const newer = { ...fixtureMatch(1), id: "match-new", updatedAt: new Date(5000).toISOString() };
  newer.events = newer.events.map((event) => ({ ...event, matchId: "match-new" }));

  const reports = await flushOutbox([newer, older], [], [], settings, cursors);
  assert.deepEqual(reports.map((report) => report.matchId), ["match-old", "match-new"]);

  syncStates.clear();
  setOnline(false);
  const offline = await flushOutbox([newer, older], [], [], settings, cursors);
  assert.equal(offline.length, 1);
  assert.equal(offline[0].outcome, "offline");
});
