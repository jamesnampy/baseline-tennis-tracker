import assert from "node:assert/strict";
import test from "node:test";
import { applyPoint, initialScore, pointScoreLabel } from "../lib/tennis/scoring.ts";
import { eligiblePointOutcomes, isPointOutcomeValid } from "../lib/tennis/model.ts";
import { buildPressureAnalytics } from "../lib/tennis/pressure.ts";
import { createPlayerProfile, linkPlayerIdentity, playerProfileAnalytics, versionPlayerProfile } from "../lib/tennis/profiles.ts";
import { buildExportBundle, zipFiles } from "../lib/tennis/export.ts";
import { buildCoachReport } from "../lib/tennis/report.ts";

const winPoint = (score, player, format = "best_of_3_tiebreak", ad = true) => applyPoint(score, player, format, ad);
function winGame(score, player, format = "best_of_3_tiebreak", ad = true) {
  for (let index = 0; index < 4; index += 1) score = winPoint(score, player, format, ad);
  return score;
}
function winGames(score, player, count, format = "best_of_3_tiebreak", ad = true) {
  for (let index = 0; index < count; index += 1) score = winGame(score, player, format, ad);
  return score;
}

function completedPoint(winner, serveResult = "in") {
  const scoreBefore = initialScore("my");
  return { id: "point", matchId: "match", schemaVersion: 1, sequence: 1, timestamp: new Date(0).toISOString(), source: "tracked", type: "point_completed", pointGroupId: "group", payload: { winner, loser: winner === "my" ? "opponent" : "my", server: "my", receiver: "opponent", serveAttempt: 1, serveResult, faults: 0, scoreBefore, scoreAfter: applyPoint(scoreBefore, winner), mentalContext: { my: "focused", opponent: "not_observed" } } };
}

function fixtureMatch() {
  const point = completedPoint("opponent"); point.payload.scoreBefore.points = [3, 3]; point.payload.scoreAfter = applyPoint(point.payload.scoreBefore, "opponent", "best_of_3_tiebreak", true);
  return { id:"match",schemaVersion:1,createdAt:new Date(0).toISOString(),updatedAt:new Date(0).toISOString(),authorized:true,config:{myPlayerId:"player_my",opponentId:"player_opponent",myPlayerName:"Ethan",opponentName:"Noah",format:"best_of_3_tiebreak",firstServer:"my",adScoring:true,startingMentalState:{my:"focused",opponent:"not_observed"}},events:[point] };
}

test("optional tray offers only the return outcome consistent with the point winner", () => {
  const receiverWon = completedPoint("opponent");
  assert.deepEqual(eligiblePointOutcomes(receiverWon), ["return_winner", "winner", "forced_error", "unforced_error"]);
  assert.equal(isPointOutcomeValid(receiverWon, "return_error"), false);
  const serverWon = completedPoint("my");
  assert.deepEqual(eligiblePointOutcomes(serverWon), ["return_error", "winner", "forced_error", "unforced_error"]);
  assert.equal(isPointOutcomeValid(serverWon, "return_winner"), false);
});

test("pressure analytics use score-before-point samples and disclose coverage", () => {
  const pressure = buildPressureAnalytics(fixtureMatch());
  assert.equal(pressure.opponent.played, 1); assert.equal(pressure.opponent.won, 1);
  assert.equal(pressure.opponent.categories.deuce_advantage.played, 1);
  assert.equal(pressure.opponent.coverage, 100);
});

test("profile edits create a new stable identity and auditable mapping", () => {
  const original = createPlayerProfile("Ethan", "my_player"); const { player, mapping } = versionPlayerProfile(original, "Ethan N.");
  assert.notEqual(player.id, original.id); assert.equal(player.previousVersionId, original.id); assert.equal(mapping.kind, "profile_version");
  assert.throws(() => linkPlayerIdentity(original.id, original.id));
  const stats = playerProfileAnalytics("player_my", [fixtureMatch()]); assert.equal(stats.matchCount, 1); assert.equal(stats.trackedPoints, 1);
});

test("analysis ZIP contains complete vendor-neutral files and API contract", () => {
  const bundle = buildExportBundle(fixtureMatch(), [], [], true);
  for (const name of ["matches.csv","players.csv","identity_mappings.csv","points.csv","serves.csv","shots.csv","mental_states.csv","score_syncs.csv","events.json","schema.json","manifest.json"]) assert.ok(name in bundle.files,name);
  assert.match(bundle.files["schema.json"], /read-only/); assert.doesNotMatch(bundle.files["matches.csv"], /Ethan|Noah/); assert.doesNotMatch(bundle.files["events.json"], /Ethan|Noah/);
  assert.ok(zipFiles(bundle.files).size > 100);
});

test("coach report respects privacy options and remains self-contained", () => {
  const html = buildCoachReport(fixtureMatch(), {opponentIdentity:false,tournamentLink:false,timeline:false,mentalStates:false,mentalNotes:false,recommendations:false});
  assert.match(html,/noindex,nofollow/); assert.doesNotMatch(html,/Noah/); assert.doesNotMatch(html,/Point timeline/); assert.match(html,/dataset baseline-mvp-1.2/);
});

test("advantage scoring requires a two-point margin after deuce", () => {
  let score = initialScore("my");
  for (let index = 0; index < 3; index += 1) { score = winPoint(score, "my"); score = winPoint(score, "opponent"); }
  assert.equal(pointScoreLabel(score, "my", true), "40");
  score = winPoint(score, "my");
  assert.equal(pointScoreLabel(score, "my", true), "AD");
  score = winPoint(score, "opponent");
  assert.equal(pointScoreLabel(score, "my", true), "40");
  score = winPoint(score, "opponent"); score = winPoint(score, "opponent");
  assert.deepEqual(score.games, [0, 1]);
});

test("no-ad scoring awards the game on the deciding point", () => {
  let score = initialScore("my");
  for (let index = 0; index < 3; index += 1) { score = winPoint(score, "my", "best_of_3_tiebreak", false); score = winPoint(score, "opponent", "best_of_3_tiebreak", false); }
  score = winPoint(score, "my", "best_of_3_tiebreak", false);
  assert.deepEqual(score.games, [1, 0]);
});

test("standard set enters a seven-point tiebreak at 6-6 and preserves its score", () => {
  let score = initialScore("my");
  for (let index = 0; index < 6; index += 1) { score = winGame(score, "my"); score = winGame(score, "opponent"); }
  assert.equal(score.inTiebreak, true);
  assert.deepEqual(score.games, [6, 6]);
  for (let index = 0; index < 7; index += 1) score = winPoint(score, "my");
  assert.deepEqual(score.sets[0].games, [7, 6]);
  assert.deepEqual(score.sets[0].tiebreak, [7, 0]);
});

test("tiebreak service rotates one, then two points", () => {
  let score = initialScore("my"); score.games = [6, 6]; score.inTiebreak = true; score.tiebreakStartServer = "my";
  assert.equal(score.server, "my");
  score = winPoint(score, "my"); assert.equal(score.server, "opponent");
  score = winPoint(score, "my"); assert.equal(score.server, "opponent");
  score = winPoint(score, "my"); assert.equal(score.server, "my");
});

test("best of three with match tiebreak starts a ten-point decider at one set all", () => {
  let score = initialScore("my");
  score = winGames(score, "my", 6, "best_of_3_match_tiebreak");
  score = winGames(score, "opponent", 6, "best_of_3_match_tiebreak");
  assert.equal(score.sets.length, 2); assert.deepEqual(score.setsWon, [1, 1]);
  assert.equal(score.inTiebreak, true); assert.equal(score.tiebreakTarget, 10);
  for (let index = 0; index < 10; index += 1) score = winPoint(score, "my", "best_of_3_match_tiebreak");
  assert.equal(score.matchComplete, true); assert.equal(score.winner, "my"); assert.equal(score.sets[2].isMatchTiebreak, true);
});

test("short sets enter a tiebreak at 3-3", () => {
  let score = initialScore("my");
  for (let index = 0; index < 3; index += 1) { score = winGame(score, "my", "short_sets"); score = winGame(score, "opponent", "short_sets"); }
  assert.equal(score.inTiebreak, true); assert.deepEqual(score.games, [3, 3]);
});

test("Pro 8 has no tiebreak and requires a two-game margin", () => {
  let score = initialScore("my");
  for (let index = 0; index < 7; index += 1) { score = winGame(score, "my", "pro_8"); score = winGame(score, "opponent", "pro_8"); }
  score = winGame(score, "my", "pro_8"); assert.equal(score.matchComplete, false);
  score = winGame(score, "opponent", "pro_8"); score = winGame(score, "my", "pro_8"); score = winGame(score, "my", "pro_8");
  assert.equal(score.matchComplete, true); assert.deepEqual(score.sets[0].games, [10, 8]);
});
