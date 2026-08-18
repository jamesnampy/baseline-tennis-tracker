import assert from "node:assert/strict";
import test from "node:test";
import { applyPoint, derivedCompletions, initialScore, numberedPointEvents, pointGameNumber, pointScoreLabel, pointSetNumber, projectScore } from "../lib/tennis/scoring.ts";
import { eligiblePointOutcomes, hasCompleteShotDetails, isErrorOutcome, isPointOutcomeValid, pointDetailsPlayer, usesAdvancedShotOptions, usesBallLandingOptions } from "../lib/tennis/model.ts";
import { buildStats, filterEventsForStatsScope, pointStatsScope, shotImpact } from "../lib/tennis/analytics.ts";
import { buildPressureAnalytics } from "../lib/tennis/pressure.ts";
import { createPlayerProfile, linkPlayerIdentity, playerProfileAnalytics, versionPlayerProfile } from "../lib/tennis/profiles.ts";
import { buildExportBundle, staleStrategyEventIds, zipFiles } from "../lib/tennis/export.ts";
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

test("game completion is derived once per game and names the holder or breaker", () => {
  const before = initialScore("my");
  const after = winGame(before, "my");
  const [game] = derivedCompletions(before, after);
  assert.equal(game.type, "game_completed");
  assert.deepEqual([game.payload.setNumber, game.payload.gameNumber], [1, 1]);
  assert.equal(game.payload.winner, "my"); assert.equal(game.payload.hold, true);
  const broken = derivedCompletions(before, winGame(before, "opponent"))[0];
  assert.equal(broken.payload.hold, false);
  // A point that does not end a game derives nothing at all.
  assert.deepEqual(derivedCompletions(before, winPoint(before, "my")), []);
});

test("set and match completion derive together with the closing game", () => {
  let score = winGames(initialScore("my"), "my", 5);
  score = winGames(score, "opponent", 4);
  const beforeSet = score;
  const afterSet = winGame(beforeSet, "my");
  assert.deepEqual(derivedCompletions(beforeSet, afterSet).map((event) => event.type), ["game_completed", "set_completed"]);
  const set = derivedCompletions(beforeSet, afterSet)[1];
  assert.deepEqual(set.payload.games, [6, 4]); assert.equal(set.payload.winner, "my"); assert.deepEqual(set.payload.setsWon, [1, 0]);

  let second = winGames(afterSet, "my", 5);
  second = winGames(second, "opponent", 4);
  const final = winGame(second, "my");
  const types = derivedCompletions(second, final).map((event) => event.type);
  assert.deepEqual(types, ["game_completed", "set_completed", "match_completed"]);
  assert.equal(derivedCompletions(second, final)[2].payload.reason, "score");
});

test("a set tiebreak derives one game plus the set and keeps its tiebreak score", () => {
  // Alternate games: winning six straight would complete the set at 6-0 long before 6-6.
  let score = initialScore("my");
  for (let index = 0; index < 6; index += 1) { score = winGame(score, "my"); score = winGame(score, "opponent"); }
  const before = score;
  assert.equal(before.inTiebreak, true);
  let after = before;
  for (let index = 0; index < 7; index += 1) after = winPoint(after, "my");
  const [game, set] = derivedCompletions(before, after);
  assert.equal(game.type, "game_completed"); assert.deepEqual(game.payload.tiebreak, [7, 0]); assert.equal(game.payload.gameNumber, 13);
  assert.equal(set.type, "set_completed"); assert.deepEqual(set.payload.games, [7, 6]); assert.deepEqual(set.payload.tiebreak, [7, 0]);
});

test("a match tiebreak completes a set without inventing a game", () => {
  const before = { ...initialScore("my"), sets: [{ games: [6, 4] }, { games: [4, 6] }], setsWon: [1, 1], inTiebreak: true, tiebreakTarget: 10, tiebreakStartServer: "my" };
  let after = before;
  for (let index = 0; index < 10; index += 1) after = winPoint(after, "my", "best_of_3_match_tiebreak");
  const types = derivedCompletions(before, after).map((event) => event.type);
  assert.deepEqual(types, ["set_completed", "match_completed"]);
  assert.equal(derivedCompletions(before, after)[0].payload.isMatchTiebreak, true);
});

test("score synchronization derives sets and match completion but never fabricates games", () => {
  const before = initialScore("my");
  const corrected = { ...initialScore("my"), sets: [{ games: [6, 3] }], setsWon: [1, 0] };
  const types = derivedCompletions(before, corrected, { includeGames: false }).map((event) => event.type);
  assert.deepEqual(types, ["set_completed"]);
  assert.deepEqual(derivedCompletions(before, corrected, { includeGames: true }).map((event) => event.type), ["game_completed", "set_completed"]);
});

test("a point reports the set and game it was played in", () => {
  const point = completedPoint("my");
  assert.equal(pointSetNumber(point), 1); assert.equal(pointGameNumber(point), 1);
  point.payload.scoreBefore.sets = [{ games: [6, 4] }]; point.payload.scoreBefore.games = [3, 2];
  assert.equal(pointSetNumber(point), 2); assert.equal(pointGameNumber(point), 6);
});

test("a retirement ends the match without inventing points", () => {
  const match = fixtureMatch();
  const score = projectScore(match.events, match.config);
  match.events.push({ id: "retire", matchId: match.id, schemaVersion: 1, sequence: 2, timestamp: new Date(4).toISOString(), source: "tracked", type: "player_retired", payload: { player: "opponent", winner: "my", score } });
  const projected = projectScore(match.events, match.config);
  assert.equal(projected.matchComplete, true); assert.equal(projected.winner, "my");
  assert.equal(buildStats(match.events, match.config).directlyTrackedPoints, 1);
});

test("a strategy review goes stale once a point it analyzed is undone", () => {
  const match = fixtureMatch();
  const point = match.events[0];
  match.events.push({ id: "review", matchId: match.id, schemaVersion: 1, sequence: 2, timestamp: new Date(5).toISOString(), source: "analysis", type: "strategy_generated", payload: { cutoffSequence: 2, provider: "on-device", model: "evidence-engine-v1", promptVersion: "strategy-v1", response: "x", evidence: [], coverage: 100 } });
  assert.equal(staleStrategyEventIds(match).size, 0);
  match.events.push({ id: "undo", matchId: match.id, schemaVersion: 1, sequence: 3, timestamp: new Date(6).toISOString(), source: "corrected", type: "point_undone", payload: { pointGroupId: point.pointGroupId, voidedEventIds: [point.id] } });
  assert.deepEqual([...staleStrategyEventIds(match)], ["review"]);
});

test("the export bundle publishes derived game, set, status, and review tables", () => {
  const match = fixtureMatch();
  match.events.push({ id: "game-1", matchId: match.id, schemaVersion: 1, sequence: 2, timestamp: new Date(7).toISOString(), source: "automatic", type: "game_completed", pointGroupId: "group", payload: { setNumber: 1, gameNumber: 1, winner: "opponent", server: "my", hold: false, games: [0, 1] } });
  match.events.push({ id: "set-1", matchId: match.id, schemaVersion: 1, sequence: 3, timestamp: new Date(8).toISOString(), source: "corrected", type: "set_completed", payload: { setNumber: 1, winner: "opponent", games: [4, 6], isMatchTiebreak: false, setsWon: [0, 1] } });
  const bundle = buildExportBundle(match);
  for (const name of ["games.csv", "sets.csv", "match_status.csv", "strategy_reviews.csv"]) assert.ok(name in bundle.files, name);
  assert.match(bundle.files["games.csv"], /game-1/); assert.match(bundle.files["sets.csv"], /set-1/);
  assert.match(bundle.files["points.csv"], /set_number/); assert.match(bundle.files["points.csv"], /game_number/);
  assert.match(bundle.files["manifest.json"], /baseline-mvp-1\.2\.2/);
});

test("stroke impact subtracts errors instead of counting every observation", () => {
  const match = fixtureMatch();
  match.events = [];
  let sequence = 0;
  // Two forehand winners and three forehand unforced errors, all my player's.
  const add = (outcome, finalStroke, shotType) => {
    const point = completedPoint(outcome === "winner" ? "my" : "opponent");
    sequence += 1; point.id = `p${sequence}`; point.pointGroupId = `g${sequence}`; point.sequence = sequence;
    match.events.push(point, {
      id: `a${sequence}`, matchId: match.id, schemaVersion: 1, sequence: sequence + 100,
      timestamp: new Date(sequence).toISOString(), source: "tracked", type: "point_annotated",
      pointGroupId: point.pointGroupId, payload: { outcome, finalStroke, shotType, finalStrokePlayer: "my" },
    });
  };
  add("winner", "forehand", "groundstroke");
  add("winner", "forehand", "groundstroke");
  add("unforced_error", "forehand", "groundstroke");
  add("unforced_error", "forehand", "groundstroke");
  add("unforced_error", "forehand", "groundstroke");

  const stroke = buildStats(match.events, match.config).my.strokeOutcomes.forehand;
  assert.deepEqual(stroke, { winners: 2, errors: 3, total: 5 });
  // The whole point of the fix: five observed forehands nets to -1, not +5.
  assert.equal(shotImpact(stroke), -1);
});

test("net conversion counts volleys and overheads, not drop shots", () => {
  const match = fixtureMatch();
  match.events = [];
  let sequence = 0;
  const add = (outcome, shotType) => {
    const point = completedPoint(outcome === "winner" ? "my" : "opponent");
    sequence += 1; point.id = `p${sequence}`; point.pointGroupId = `g${sequence}`; point.sequence = sequence;
    match.events.push(point, {
      id: `a${sequence}`, matchId: match.id, schemaVersion: 1, sequence: sequence + 100,
      timestamp: new Date(sequence).toISOString(), source: "tracked", type: "point_annotated",
      pointGroupId: point.pointGroupId, payload: { outcome, finalStroke: "forehand", shotType, finalStrokePlayer: "my" },
    });
  };
  add("winner", "volley");
  add("winner", "overhead");
  add("unforced_error", "volley");
  add("winner", "drop_shot");

  const stats = buildStats(match.events, match.config).my;
  assert.deepEqual(stats.netPlay, { winners: 2, errors: 1, total: 3 });
  assert.equal(shotImpact(stats.netPlay), 1);
  assert.equal(stats.shotTypeOutcomes.drop_shot.winners, 1);
});

test("a forced error credits the player who forced it, on both the stroke and the shot type", () => {
  const match = fixtureMatch();
  match.events = [];
  const point = completedPoint("my");
  point.id = "p1"; point.pointGroupId = "g1"; point.sequence = 1;
  match.events.push(point, {
    id: "a1", matchId: match.id, schemaVersion: 1, sequence: 2,
    timestamp: new Date(1).toISOString(), source: "tracked", type: "point_annotated",
    pointGroupId: "g1", payload: { outcome: "forced_error", finalStroke: "backhand", shotType: "slice", finalStrokePlayer: "my" },
  });
  const stats = buildStats(match.events, match.config).my;
  assert.deepEqual(stats.strokeOutcomes.backhand, { winners: 1, errors: 0, total: 1 });
  assert.deepEqual(stats.shotTypeOutcomes.slice, { winners: 1, errors: 0, total: 1 });
});

test("shot attribution and the win/error tally agree for every outcome", () => {
  // Section 8: winner, return winner, and forced error belong to the point
  // winner; unforced error and return error belong to the point loser. The
  // shot tallies must follow the same split, or a stroke's impact would credit
  // the wrong player.
  const winning = ["winner", "return_winner", "forced_error"];
  const losing = ["unforced_error", "return_error"];
  for (const outcome of [...winning, ...losing]) {
    const pointWonByMy = completedPoint("my");
    const owner = pointDetailsPlayer(pointWonByMy, outcome);
    assert.equal(owner, winning.includes(outcome) ? "my" : "opponent", outcome);

    const match = fixtureMatch();
    match.events = [pointWonByMy, {
      id: "a1", matchId: match.id, schemaVersion: 1, sequence: 2,
      timestamp: new Date(1).toISOString(), source: "tracked", type: "point_annotated",
      pointGroupId: pointWonByMy.pointGroupId,
      payload: { outcome, finalStroke: "forehand", shotType: "groundstroke", finalStrokePlayer: owner },
    }];
    const stats = buildStats(match.events, match.config)[owner].strokeOutcomes.forehand;
    // The owner's shot won the point exactly when the owner won the point.
    assert.equal(stats.winners, owner === pointWonByMy.payload.winner ? 1 : 0, outcome);
    assert.equal(stats.errors, owner === pointWonByMy.payload.winner ? 0 : 1, outcome);
    assert.equal(stats.total, 1, outcome);
  }
});
