import assert from "node:assert/strict";
import test from "node:test";
import { applyPoint, initialScore, numberedPointEvents, pointScoreLabel } from "../lib/tennis/scoring.ts";
import { eligiblePointOutcomes, hasCompleteShotDetails, isErrorOutcome, isPointOutcomeValid, pointDetailsPlayer, usesAdvancedShotOptions, usesBallLandingOptions } from "../lib/tennis/model.ts";
import { buildStats, filterEventsForStatsScope, pointStatsScope } from "../lib/tennis/analytics.ts";
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

test("ball landing appears only for return and unforced errors", () => {
  for (const outcome of ["return_error", "forced_error", "unforced_error"]) assert.equal(isErrorOutcome(outcome), true);
  for (const outcome of ["return_winner", "winner", "ace", "double_fault"]) assert.equal(isErrorOutcome(outcome), false);
  assert.equal(usesBallLandingOptions("return_error"),true); assert.equal(usesBallLandingOptions("unforced_error"),true);
  for (const outcome of ["return_winner","winner","forced_error","ace","double_fault"]) assert.equal(usesBallLandingOptions(outcome),false);
});

test("advanced tray requires one selection from each advanced row before auto-advance", () => {
  const base = { outcome:"winner",rallyRange:"1-5",finalStroke:"forehand",shotType:"groundstroke" };
  assert.equal(hasCompleteShotDetails({ ...base, shotSituation:"approach_shot" }), false);
  assert.equal(hasCompleteShotDetails({ ...base, advancedShotType:"cross_court" }), false);
  assert.equal(hasCompleteShotDetails({ ...base, shotSituation:"approach_shot",advancedShotType:"cross_court" }), true);
  assert.equal(hasCompleteShotDetails({ ...base,outcome:"unforced_error" }), false);
  assert.equal(hasCompleteShotDetails({ ...base,outcome:"unforced_error",ballLanding:"long" }), false);
  assert.equal(hasCompleteShotDetails({ ...base,outcome:"unforced_error",ballLanding:"long",shotSituation:"passing_shot",advancedShotType:"inside_out" }), true);
  assert.equal(hasCompleteShotDetails({ ...base,outcome:"forced_error",ballLanding:"side",shotSituation:"approach_shot" }), false);
  assert.equal(hasCompleteShotDetails({ ...base,outcome:"forced_error",shotSituation:"approach_shot",advancedShotType:"inside_in" }), true);
  for (const outcome of ["return_winner","return_error","winner","forced_error","unforced_error"]) assert.equal(usesAdvancedShotOptions(outcome),true);
});

test("winner and forced-error shot details belong to the point winner", () => {
  const point=completedPoint("opponent");
  assert.equal(pointDetailsPlayer(point,"winner"),"opponent"); assert.equal(pointDetailsPlayer(point,"forced_error"),"opponent"); assert.equal(pointDetailsPlayer(point,"return_winner"),"opponent");
  assert.equal(pointDetailsPlayer(point,"unforced_error"),"my"); assert.equal(pointDetailsPlayer(point,"return_error"),"my");
});

test("timeline point numbers increase by one regardless of event sequence", () => {
  const first = completedPoint("my"); first.id="point-1"; first.pointGroupId="group-1"; first.sequence=3;
  const second = completedPoint("opponent"); second.id="point-2"; second.pointGroupId="group-2"; second.sequence=9;
  assert.deepEqual(numberedPointEvents([first,second]).map(({pointNumber})=>pointNumber),[1,2]);
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
  assert.match(bundle.files["points.csv"], /point_number/); assert.match(bundle.files["shots.csv"], /shot_situation/);
  assert.ok(zipFiles(bundle.files).size > 100);
});

test("coach report respects privacy options and remains self-contained", () => {
  const match=fixtureMatch(); match.config.tournamentName="Private event"; match.config.tournamentUrl="https://example.com/private";
  const html = buildCoachReport(match, {opponentIdentity:false,matchStats:false,timeline:false,mentalStates:false,mentalNotes:false,recommendations:false});
  assert.match(html,/noindex,nofollow/); assert.doesNotMatch(html,/Noah/); assert.doesNotMatch(html,/Point timeline|Match stats|https:\/\//); assert.match(html,/dataset baseline-mvp-1.2/);
});

test("advanced stats break shot types into errors and winner patterns", () => {
  const match=fixtureMatch(); const point=match.events[0];
  match.events.push({id:"annotation-1",matchId:match.id,schemaVersion:1,sequence:2,timestamp:new Date(1).toISOString(),source:"tracked",type:"point_annotated",pointGroupId:point.pointGroupId,payload:{outcome:"unforced_error",finalStrokePlayer:"my",shotType:"slice",shotSituation:"passing_shot",advancedShotType:"inside_out"}});
  const winner=completedPoint("my"); winner.id="winner"; winner.pointGroupId="winner-group"; winner.sequence=3; match.events.push(winner,{id:"annotation-2",matchId:match.id,schemaVersion:1,sequence:4,timestamp:new Date(2).toISOString(),source:"tracked",type:"point_annotated",pointGroupId:winner.pointGroupId,payload:{outcome:"winner",finalStrokePlayer:"my",shotType:"groundstroke",shotSituation:"approach_shot",advancedShotType:"cross_court"}});
  const forced=completedPoint("my"); forced.id="forced"; forced.pointGroupId="forced-group"; forced.sequence=5; match.events.push(forced,{id:"annotation-3",matchId:match.id,schemaVersion:1,sequence:6,timestamp:new Date(3).toISOString(),source:"tracked",type:"point_annotated",pointGroupId:forced.pointGroupId,payload:{outcome:"forced_error",finalStrokePlayer:"my",shotType:"slice",shotSituation:"passing_shot",advancedShotType:"inside_in"}});
  const stats=buildStats(match.events,match.config);
  assert.equal(stats.my.shotTypeOutcomes.slice.errors,1); assert.equal(stats.my.shotTypeOutcomes.slice.winners,1); assert.equal(stats.my.shotTypeOutcomes.slice.total,2); assert.equal(stats.my.shotTypeOutcomes.groundstroke.winners,1);
  assert.equal(stats.my.winnerPatterns.approach_shot,1); assert.equal(stats.my.winnerPatterns.cross_court,1); assert.equal(stats.my.winnerPatterns.inside_out,0);
});

test("stats can be scoped to each set, match tiebreak, or total", () => {
  const match=fixtureMatch(); match.config.format="best_of_3_match_tiebreak"; const first=match.events[0];
  const second=completedPoint("my"); second.id="set-2"; second.pointGroupId="set-2-group"; second.sequence=2; second.payload.scoreBefore.sets=[{games:[6,4]}];
  const decider=completedPoint("my"); decider.id="match-tb"; decider.pointGroupId="match-tb-group"; decider.sequence=3; decider.payload.scoreBefore.sets=[{games:[6,4]},{games:[4,6]}]; decider.payload.scoreBefore.inTiebreak=true; decider.payload.scoreBefore.tiebreakTarget=10;
  match.events=[first,second,decider];
  assert.equal(pointStatsScope(first,match.config),"set_1"); assert.equal(pointStatsScope(second,match.config),"set_2"); assert.equal(pointStatsScope(decider,match.config),"match_tiebreak");
  assert.equal(buildStats(filterEventsForStatsScope(match.events,match.config,"set_1"),match.config).directlyTrackedPoints,1);
  assert.equal(buildStats(filterEventsForStatsScope(match.events,match.config,"set_2"),match.config).directlyTrackedPoints,1);
  assert.equal(buildStats(filterEventsForStatsScope(match.events,match.config,"match_tiebreak"),match.config).directlyTrackedPoints,1);
  assert.equal(buildStats(filterEventsForStatsScope(match.events,match.config,"total"),match.config).directlyTrackedPoints,3);
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
