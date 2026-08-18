import assert from "node:assert/strict";
import test from "node:test";
import {
  displayedOpponentName,
  hashShareToken,
  initialsOf,
  isLinkUsable,
  newShareToken,
  redactEvents,
  redactMatch,
  reportOptionsForLink,
} from "../worker/api/share.ts";
import { buildCoachReport, DEFAULT_REPORT_OPTIONS } from "../lib/tennis/report.ts";
import { mergeEvents, shareTokenFromPath } from "../lib/tennis/live.ts";
import { projectScore, scoreSummary } from "../lib/tennis/scoring.ts";

const blankScore = {
  sets: [], games: [0, 0], points: [0, 0], setsWon: [0, 0],
  server: "my", inTiebreak: false, tiebreakTarget: 7, matchComplete: false,
};

const config = {
  myPlayerId: "player_my", opponentId: "player_opp",
  myPlayerName: "Ethan", opponentName: "Noah Vandermeer",
  format: "best_of_3_tiebreak", firstServer: "my", adScoring: true,
  notes: "private parent notes",
  startingMentalState: { my: "focused", opponent: "tense" },
};

const event = (id, sequence, type, payload, extra = {}) => ({
  id, matchId: "match-1", schemaVersion: 1, sequence,
  timestamp: new Date(sequence * 1000).toISOString(), source: "tracked", type, payload, ...extra,
});

function fixtureMatch() {
  const after = { ...blankScore, points: [1, 0] };
  return {
    id: "match-1", schemaVersion: 1,
    createdAt: new Date(0).toISOString(), updatedAt: new Date(9000).toISOString(),
    config,
    events: [
      event("e1", 1, "match_created", { config }),
      event("e2", 2, "match_started", { score: blankScore }),
      event("e3", 3, "serve_attempted", { server: "my", attempt: 1, result: "in" }, { pointGroupId: "g1" }),
      event("e4", 4, "point_completed", {
        winner: "my", loser: "opponent", server: "my", receiver: "opponent",
        serveAttempt: 1, serveResult: "in", faults: 0,
        scoreBefore: blankScore, scoreAfter: after,
        mentalContext: { my: "focused", opponent: "tense" },
      }, { pointGroupId: "g1" }),
      event("e5", 5, "mental_state_changed", {
        player: "my", state: "tense", previousState: "focused",
        captureMoment: "after_point", note: "shoulders dropped", score: after,
      }),
      event("e6", 6, "strategy_generated", {
        cutoffSequence: 5, provider: "anthropic", model: "claude-opus-4-8",
        promptVersion: "strategy-v1", response: "full dataset restated here", evidence: [], coverage: 100,
      }),
    ],
  };
}

const link = (overrides = {}) => ({
  id: "link-1", token_hash: "hash", match_id: "match-1", kind: "live",
  created_at: new Date(0).toISOString(), expires_at: null, revoked_at: null,
  include_mental_states: 0, opponent_display: "initials", include_timeline: 1,
  report_options: null, label: null,
  ...overrides,
});

test("a default share link withholds every mental-state observation", () => {
  const shared = redactMatch(fixtureMatch(), link());
  const serialized = JSON.stringify(shared);
  assert.doesNotMatch(serialized, /shoulders dropped/);
  assert.equal(shared.events.some((item) => item.type === "mental_state_changed"), false);
  assert.deepEqual(shared.config.startingMentalState, { my: "not_observed", opponent: "not_observed" });
  const point = shared.events.find((item) => item.type === "point_completed");
  assert.deepEqual(point.payload.mentalContext, { my: "not_observed", opponent: "not_observed" });
});

test("including mental states still leaves the free-form note behind", () => {
  const shared = redactMatch(fixtureMatch(), link({ include_mental_states: 1 }));
  const observation = shared.events.find((item) => item.type === "mental_state_changed");
  assert.equal(observation.payload.state, "tense");
  assert.equal(observation.payload.note, undefined);
  assert.deepEqual(shared.config.startingMentalState, { my: "focused", opponent: "tense" });
});

test("opponent identity is reduced to initials by default and can be hidden entirely", () => {
  assert.equal(initialsOf("Noah Vandermeer"), "N.V.");
  assert.equal(displayedOpponentName("Noah Vandermeer", "full"), "Noah Vandermeer");
  assert.equal(displayedOpponentName("Noah Vandermeer", "hidden"), "Opponent");
  for (const display of ["initials", "hidden"]) {
    const shared = redactMatch(fixtureMatch(), link({ opponent_display: display }));
    assert.doesNotMatch(JSON.stringify(shared), /Vandermeer/);
    assert.equal(shared.config.opponentId, undefined);
  }
  const full = redactMatch(fixtureMatch(), link({ opponent_display: "full" }));
  assert.equal(full.config.opponentName, "Noah Vandermeer");
  assert.equal(full.config.opponentId, "player_opp");
});

test("private notes and strategy reviews never travel on a share link", () => {
  const shared = redactMatch(fixtureMatch(), link({ opponent_display: "full", include_mental_states: 1 }));
  assert.equal(shared.config.notes, undefined);
  assert.doesNotMatch(JSON.stringify(shared), /private parent notes/);
  assert.doesNotMatch(JSON.stringify(shared), /full dataset restated here/);
});

test("excluding the timeline keeps the score but drops shot-level detail", () => {
  const withTimeline = redactEvents(fixtureMatch().events, link());
  assert.equal(withTimeline.some((item) => item.type === "serve_attempted"), true);
  const withoutTimeline = redactEvents(fixtureMatch().events, link({ include_timeline: 0 }));
  assert.equal(withoutTimeline.some((item) => item.type === "serve_attempted"), false);
  assert.equal(withoutTimeline.some((item) => item.type === "point_completed"), true);
});

test("a spectator rebuilds the score from the same projection the tracker uses", () => {
  const shared = redactMatch(fixtureMatch(), link());
  const score = projectScore(shared.events, shared.config);
  assert.equal(scoreSummary(score, shared.config), "0–0 (15–0)");
});

test("revoked and expired links stop working", () => {
  const now = new Date("2026-08-18T12:00:00.000Z");
  assert.equal(isLinkUsable(link(), now), true);
  assert.equal(isLinkUsable(link({ revoked_at: now.toISOString() }), now), false);
  assert.equal(isLinkUsable(link({ expires_at: "2026-08-18T11:59:59.000Z" }), now), false);
  assert.equal(isLinkUsable(link({ expires_at: "2026-08-18T12:00:01.000Z" }), now), true);
});

test("share tokens are unguessable and stored only as a hash", async () => {
  const token = newShareToken();
  assert.ok(token.length >= 43);
  assert.match(token, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(token, newShareToken());
  const hash = await hashShareToken(token);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hash, await hashShareToken(token));
  assert.notEqual(hash, await hashShareToken(token + "x"));
});

test("only a well-formed share path routes to the spectator view", () => {
  const token = "iWSeL9etoL1rfXRWq0V_zw6GuF-SqHkNm-X-eLvGRHE";
  assert.equal(shareTokenFromPath(`/live/${token}`), token);
  assert.equal(shareTokenFromPath(`/live/${token}/`), token);
  for (const path of ["/", "/live", "/live/", "/live/short", "/live/a b", "/live/x/y", "/livest/abc", `/live/${token}?x=1`]) {
    assert.equal(shareTokenFromPath(path), null, path);
  }
});

test("a spectator deduplicates replayed events by id", () => {
  const make = (id) => ({ id, matchId: "m", schemaVersion: 1, sequence: 1, timestamp: "t", source: "tracked", type: "point_completed", payload: {} });
  const existing = [make("a"), make("b")];
  assert.equal(mergeEvents(existing, []), existing);
  assert.equal(mergeEvents(existing, [make("a"), make("b")]), existing);
  assert.deepEqual(mergeEvents(existing, [make("b"), make("c")]).map((event) => event.id), ["a", "b", "c"]);
});

test("a report link's own flags overrule whatever the stored report options ask for", () => {
  // The stored options want everything; the link was created without any of it.
  const greedy = JSON.stringify({
    opponentIdentity: true, matchStats: true, shotAnalytics: true, timeline: true,
    mentalStates: true, mentalNotes: true, recommendations: true,
  });
  const restricted = reportOptionsForLink(link({ kind: "report", report_options: greedy, opponent_display: "initials", include_mental_states: 0, include_timeline: 0 }));
  assert.equal(restricted.opponentIdentity, false);
  assert.equal(restricted.mentalStates, false);
  assert.equal(restricted.mentalNotes, false);
  assert.equal(restricted.timeline, false);
  // Options that carry no privacy weight are left alone.
  assert.equal(restricted.matchStats, true);
  assert.equal(restricted.shotAnalytics, true);

  const permissive = reportOptionsForLink(link({ kind: "report", report_options: greedy, opponent_display: "full", include_mental_states: 1, include_timeline: 1 }));
  assert.equal(permissive.opponentIdentity, true);
  assert.equal(permissive.mentalStates, true);
  assert.equal(permissive.timeline, true);
});

test("a report link with unreadable or missing options falls back to the defaults", () => {
  for (const stored of [null, "not json", "{"]) {
    const options = reportOptionsForLink(link({ kind: "report", report_options: stored, opponent_display: "full", include_mental_states: 1, include_timeline: 1 }));
    assert.deepEqual(options, DEFAULT_REPORT_OPTIONS, String(stored));
  }
});

test("the hosted report and the download are built from the same redacted match", () => {
  const restrictive = link({ kind: "report", opponent_display: "initials", include_mental_states: 0, include_timeline: 1 });
  const html = buildCoachReport(redactMatch(fixtureMatch(), restrictive), reportOptionsForLink(restrictive));
  assert.match(html, /noindex,nofollow/);
  assert.doesNotMatch(html, /Vandermeer/);
  assert.doesNotMatch(html, /shoulders dropped/);
  assert.doesNotMatch(html, /private parent notes/);
  assert.match(html, /mental-state observations withheld/);
  // Shot analytics are part of the dataset a coach receives.
  assert.match(html, /Shot analytics/);
  assert.match(html, /Forehand impact/);
  assert.match(html, /Net conversion/);
  // Section 18 requires the sample behind every rate to be visible.
  assert.match(html, /n=0|\d+\/\d+ \(\d+%\)/);
});
