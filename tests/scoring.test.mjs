import assert from "node:assert/strict";
import test from "node:test";
import { applyPoint, derivedCompletions, initialScore, numberedPointEvents, pointGameNumber, pointScoreLabel, pointSetNumber, projectScore, setDurations, formatDuration} from "../lib/tennis/scoring.ts";
import {FORMAT_RULES, DATASET_VERSION, eligiblePointOutcomes, hasCompleteShotDetails, isErrorOutcome, isPointOutcomeValid, pointDetailsPlayer, usesAdvancedShotOptions, usesBallLandingOptions, usesRallyRange, usesCourtPosition} from "../lib/tennis/model.ts";
import { buildStats, filterEventsForStatsScope, pointStatsScope, shotImpact, statsScopeOptions} from "../lib/tennis/analytics.ts";
import { buildPressureAnalytics, pressureCategories} from "../lib/tennis/pressure.ts";
import { createPlayerProfile, linkPlayerIdentity, playerProfileAnalytics, versionPlayerProfile } from "../lib/tennis/profiles.ts";
import { buildExportBundle, staleStrategyEventIds, zipFiles } from "../lib/tennis/export.ts";
import { buildCoachReport } from "../lib/tennis/report.ts";
import { matchRows, pressureRows } from "../lib/tennis/stattables.ts";

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

test("the tray asks only what an outcome can answer, and waits for all of it", () => {
  const rally = { rallyRange: "1-5", finalStroke: "forehand", shotType: "groundstroke" };

  // A rally ending needs both advanced rows and a court position.
  const winner = { ...rally, outcome: "winner", shotSituation: "approach_shot", advancedShotType: "cross_court" };
  assert.equal(hasCompleteShotDetails(winner), false, "court position is still missing");
  assert.equal(hasCompleteShotDetails({ ...winner, courtPosition: "net" }), true);
  assert.equal(hasCompleteShotDetails({ ...winner, courtPosition: "net", shotSituation: undefined }), false);

  // An unforced error additionally needs where the ball landed.
  const unforced = { ...rally, outcome: "unforced_error", shotSituation: "passing_shot", advancedShotType: "down_the_line", courtPosition: "baseline" };
  assert.equal(hasCompleteShotDetails(unforced), false, "ball landing is still missing");
  assert.equal(hasCompleteShotDetails({ ...unforced, ballLanding: "long" }), true);

  // A return error asks for neither advanced row, nor rally length, nor position.
  assert.equal(usesAdvancedShotOptions("return_error"), false);
  assert.equal(usesRallyRange("return_error"), false);
  assert.equal(usesCourtPosition("return_error"), false);
  assert.equal(hasCompleteShotDetails({ finalStroke: "backhand", shotType: "slice", outcome: "return_error", ballLanding: "net" }), true);

  // A return winner keeps the advanced rows — the run-around and passing-shot
  // distinctions are real on a return — but not rally length or position.
  assert.equal(usesAdvancedShotOptions("return_winner"), true);
  assert.equal(usesRallyRange("return_winner"), false);
  assert.equal(usesCourtPosition("return_winner"), false);
  assert.equal(hasCompleteShotDetails({ finalStroke: "forehand", shotType: "groundstroke", outcome: "return_winner", shotSituation: "passing_shot", advancedShotType: "cross_court" }), true);

  // Position is asked for every rally ending and no serve ending.
  for (const outcome of ["winner", "forced_error", "unforced_error"]) assert.equal(usesCourtPosition(outcome), true, outcome);
  for (const outcome of ["ace", "double_fault", "return_winner", "return_error"]) assert.equal(usesCourtPosition(outcome), false, outcome);
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
  assert.match(html,/noindex,nofollow/); assert.doesNotMatch(html,/Noah/); assert.doesNotMatch(html,/Point timeline|Match stats|https:\/\//); assert.ok(html.includes(`dataset ${DATASET_VERSION}`), "the report states the dataset version");
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
  assert.ok(bundle.files["manifest.json"].includes(DATASET_VERSION), 'the export states the dataset version');
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

/** Builds a match by playing the given point winners in order, first server "my". */
function matchFrom(winners, overrides = {}) {
  const config = { myPlayerName: "Ethan", opponentName: "Noah", format: "best_of_3_tiebreak", firstServer: "my", adScoring: true, startingMentalState: { my: "focused", opponent: "not_observed" }, ...overrides };
  let score = initialScore(config.firstServer);
  const events = []; let seq = 1;
  winners.forEach((entry, index) => {
    const winner = typeof entry === "string" ? entry : entry.winner;
    const serveAttempt = typeof entry === "string" ? 1 : (entry.serveAttempt ?? 1);
    const serveResult = typeof entry === "string" ? "in" : (entry.serveResult ?? "in");
    const before = JSON.parse(JSON.stringify(score));
    const after = applyPoint(score, winner, config.format, config.adScoring);
    events.push({ id: `e${seq}`, matchId: "m", schemaVersion: 1, sequence: seq++, timestamp: new Date(0).toISOString(), source: "tracked", type: "point_completed", pointGroupId: `g${index}`,
      payload: { winner, loser: winner === "my" ? "opponent" : "my", server: before.server, receiver: before.server === "my" ? "opponent" : "my", serveAttempt, serveResult, faults: serveAttempt === 2 ? 1 : 0, scoreBefore: before, scoreAfter: after, mentalContext: { my: "focused", opponent: "not_observed" } } });
    score = after;
  });
  return { id: "m", schemaVersion: 1, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), authorized: true, config, events };
}

test("a service game won by the server is a hold, and one lost is a break", () => {
  const held = matchFrom(["my", "my", "my", "my"]);
  const heldStats = buildStats(held.events, held.config);
  assert.equal(heldStats.my.serviceGames, 1);
  assert.equal(heldStats.my.serviceGamesHeld, 1);
  assert.equal(heldStats.my.serviceGamesLost, 0);
  assert.equal(heldStats.opponent.breaks, 0, "no break when the server held");

  const broken = matchFrom(["opponent", "opponent", "opponent", "opponent"]);
  const brokenStats = buildStats(broken.events, broken.config);
  assert.equal(brokenStats.my.serviceGames, 1, "the game is still counted against the server");
  assert.equal(brokenStats.my.serviceGamesHeld, 0);
  assert.equal(brokenStats.my.serviceGamesLost, 1);
  assert.equal(brokenStats.opponent.breaks, 1);
  assert.equal(brokenStats.my.breaks, 0);
});

test("an unfinished game counts towards no hold or break", () => {
  const match = matchFrom(["my", "my"]);
  const stats = buildStats(match.events, match.config);
  assert.equal(stats.my.serviceGames, 0);
  assert.equal(stats.my.serviceGamesHeld, 0);
  assert.equal(stats.opponent.breaks, 0);
});

test("tiebreak points produce no holds or breaks, because service rotates inside one", () => {
  // Six games each, then the tiebreak. Service alternates, so both players serve.
  const toSixAll = [];
  for (let game = 0; game < 12; game += 1) {
    const winner = game % 2 === 0 ? "my" : "opponent";
    for (let point = 0; point < 4; point += 1) toSixAll.push(winner);
  }
  const match = matchFrom([...toSixAll, "my", "my", "my", "my", "my", "my", "my"]);
  const stats = buildStats(match.events, match.config);
  // Twelve completed games, six served by each; every one held.
  assert.equal(stats.my.serviceGames + stats.opponent.serviceGames, 12);
  assert.equal(stats.my.serviceGamesHeld, 6);
  assert.equal(stats.opponent.serviceGamesHeld, 6);
  assert.equal(stats.my.breaks + stats.opponent.breaks, 0);
});

test("return points are split by the serve the receiver had to play", () => {
  const match = matchFrom([
    { winner: "opponent", serveAttempt: 1 },
    { winner: "my", serveAttempt: 1 },
    { winner: "opponent", serveAttempt: 2 },
    { winner: "opponent", serveAttempt: 2, serveResult: "double_fault" },
  ]);
  const stats = buildStats(match.events, match.config);
  // "my" served all four; "opponent" received all four.
  assert.equal(stats.opponent.firstServeReturnPoints, 2);
  assert.equal(stats.opponent.firstServeReturnPointsWon, 1);
  assert.equal(stats.opponent.secondServeReturnPoints, 2);
  assert.equal(stats.opponent.secondServeReturnPointsWon, 2, "a double fault is a second-serve return point won");
  assert.equal(stats.my.firstServeReturnPoints, 0, "the server receives nothing");
});

test("serve errors and rally errors are reported as separate landing breakdowns", () => {
  const match = matchFrom(["opponent", "my"]);
  match.events.push(
    { id: "a1", matchId: "m", schemaVersion: 1, sequence: 90, timestamp: new Date(0).toISOString(), source: "tracked", type: "point_annotated", pointGroupId: "g0",
      payload: { outcome: "unforced_error", ballLanding: "long", finalStrokePlayer: "my", responsiblePlayer: "my" } },
    { id: "a2", matchId: "m", schemaVersion: 1, sequence: 91, timestamp: new Date(0).toISOString(), source: "tracked", type: "point_annotated", pointGroupId: "g1",
      payload: { firstServeLanding: "net", secondServeLanding: "side" } },
  );
  const stats = buildStats(match.events, match.config);
  // "my" served both points, and made the rally error on the first.
  assert.deepEqual(stats.my.rallyErrorLanding, { net: 0, long: 1, side: 0 });
  assert.deepEqual(stats.my.serveErrorLanding, { net: 1, long: 0, side: 1 });
  assert.deepEqual(stats.opponent.rallyErrorLanding, { net: 0, long: 0, side: 0 }, "the receiver made neither error");
  assert.deepEqual(stats.opponent.serveErrorLanding, { net: 0, long: 0, side: 0 });
});

test("the coach report scopes its statistics and separates the timeline", () => {
  // Two straight sets: 6 games of 4 points each, twice.
  const match = matchFrom(Array.from({ length: 48 }, () => "my"));
  const html = buildCoachReport(match);
  for (const marker of ['data-panel="panel-statistics"', 'data-panel="panel-timeline"', 'data-panel="panel-analysis"',
                        'data-scope="scope-total"', 'data-scope="scope-set-1"', 'data-scope="scope-set-2"',
                        'id="scope-total"', 'id="panel-timeline"']) {
    assert.ok(html.includes(marker), marker);
  }
  assert.ok(html.includes("Match statistics"));
  assert.ok(html.includes("Shot analytics"));
  assert.ok(html.includes("Point timeline"));
  // Exactly one scope panel starts visible, and one top-level panel.
  assert.equal((html.match(/class="scope-panel on"/g) ?? []).length, 1);
  assert.equal((html.match(/class="panel on"/g) ?? []).length, 1);
  // Printing must not hide anything behind a tab.
  assert.ok(html.includes(".panel,.scope-panel{display:block!important}"));
  // Self-contained: no external stylesheet, script, or image.
  assert.doesNotMatch(html, /src="http|href="http/);
});

test("a report with no tracked points still renders, with no empty scopes", () => {
  const match = matchFrom([]);
  const html = buildCoachReport(match);
  assert.doesNotMatch(html, /data-scope="scope-set-1"/, "an unplayed set is never offered");
  assert.ok(html.includes("No points recorded."));
});

test("scopes offered by the report match the ones the Stats screen offers", () => {
  const match = matchFrom(Array.from({ length: 24 }, () => "my"));
  // The tracker also offers the set in progress; the report only what was played.
  assert.deepEqual(statsScopeOptions(match.events, match.config, false).map((o) => o.id), ["total", "set_1"]);
  assert.deepEqual(statsScopeOptions(match.events, match.config).map((o) => o.id), ["total", "set_1", "set_2"]);
});

test("one definition of the statistics rows drives both the screen and the report", () => {
  const match = matchFrom(Array.from({ length: 24 }, (_, index) => (index % 4 === 3 ? "opponent" : "my")));
  const stats = buildStats(match.events, match.config);
  const labels = matchRows(stats).map((entry) => entry.label);

  // Metrics that used to exist on only one of the two surfaces.
  for (const screenOnly of ["Service games held", "Breaks won", "First-serve return points won", "Second-serve return points won"]) {
    assert.ok(labels.includes(screenOnly), `${screenOnly} missing from the shared rows`);
  }
  for (const reportOnly of ["Break points saved", "Points won", "Longest point streak"]) {
    assert.ok(labels.includes(reportOnly), `${reportOnly} missing from the shared rows`);
  }

  // And the report renders them, so the two can no longer disagree.
  const html = buildCoachReport(match);
  for (const label of ["Service games held", "Breaks won", "Break points saved", "Where errors landed", "Points won by rally length"]) {
    assert.ok(html.includes(label), `${label} missing from the report`);
  }
});

test("every rate carries its numerator, denominator and percentage", () => {
  const match = matchFrom(Array.from({ length: 24 }, () => "my"));
  const rows = matchRows(buildStats(match.events, match.config));
  const served = rows.find((entry) => entry.label === "Service points won");
  assert.match(served.my.value, /^\d+\/\d+$/, "a rate shows n/d, never a bare percentage");
  assert.match(served.my.detail, /^\d+%$/);
  // A metric with no observations says so rather than printing a misleading zero.
  const empty = matchRows(buildStats(matchFrom([]).events, match.config)).find((entry) => entry.label === "Service points won");
  assert.equal(empty.my.value, "—");
  assert.equal(empty.my.detail, "n=0");
});

test("pressure rows omit categories nobody reached", () => {
  const match = matchFrom(Array.from({ length: 24 }, () => "my"));
  const labels = pressureRows(buildPressureAnalytics(match)).map((entry) => entry.label);
  assert.ok(labels.includes("All pressure points"));
  assert.ok(!labels.includes("Late in a tiebreak"), "no tiebreak was played");
});

test("a format declares how long its deciding tiebreak is", () => {
  // Short sets decide on a 7-point tiebreak; sets-to-6 on a 10-point one.
  const short = matchFrom([], { format: "short_sets_match_tiebreak" });
  const long = matchFrom([], { format: "best_of_3_match_tiebreak" });
  assert.equal(FORMAT_RULES[short.config.format].matchTiebreakTarget, 7);
  assert.equal(FORMAT_RULES[long.config.format].matchTiebreakTarget, 10);

  // Reaching one set all opens the decider at the format's own length.
  const decider = (format, target) => {
    let score = initialScore("my");
    for (let game = 0; game < (format === "short_sets_match_tiebreak" ? 4 : 6); game += 1) score = winGame(score, "my", format);
    for (let game = 0; game < (format === "short_sets_match_tiebreak" ? 4 : 6); game += 1) score = winGame(score, "opponent", format);
    assert.equal(score.sets.length, 2, `${format}: two sets should be complete`);
    assert.equal(score.inTiebreak, true, `${format}: the decider should be a tiebreak`);
    assert.equal(score.tiebreakTarget, target, `${format}: wrong decider length`);
    return score;
  };
  decider("short_sets_match_tiebreak", 7);
  decider("best_of_3_match_tiebreak", 10);
});

test("a seven-point decider is still recognised as the match tiebreak", () => {
  const format = "short_sets_match_tiebreak";
  let score = initialScore("my");
  for (let game = 0; game < 4; game += 1) score = winGame(score, "my", format);
  for (let game = 0; game < 4; game += 1) score = winGame(score, "opponent", format);
  // Win it 7-5, which a 10-point decider would not have ended.
  for (let point = 0; point < 5; point += 1) { score = applyPoint(score, "my", format, true); score = applyPoint(score, "opponent", format, true); }
  for (let point = 0; point < 2; point += 1) score = applyPoint(score, "my", format, true);
  assert.equal(score.matchComplete, true, "7-5 should decide a 7-point tiebreak");
  assert.equal(score.sets.at(-1).isMatchTiebreak, true, "recorded as a match tiebreak, not an ordinary set");
  assert.deepEqual(score.sets.at(-1).tiebreak, [7, 5]);
});

test("late-tiebreak pressure follows the decider's length", () => {
  // Two points short of the target: 5-5 in a seven, 8-8 in a ten.
  for (const [format, lateAt, target] of [["short_sets_match_tiebreak", 5, 7], ["best_of_3_match_tiebreak", 8, 10]]) {
    const match = matchFrom([], { format });
    const before = { ...initialScore("my"), inTiebreak: true, tiebreakTarget: target, sets: [{ games: [4, 6] }, { games: [6, 4] }], points: [lateAt, lateAt] };
    const point = completedPoint("my");
    point.payload.scoreBefore = before;
    assert.ok(pressureCategories(point, { ...match, events: [point] }).includes("late_tiebreak"), `${format} should be late at ${lateAt}-${lateAt}`);
  }
});

/** Builds a match whose events carry controllable timestamps. */
function timedMatch(entries) {
  const config = { myPlayerName: "Ethan", opponentName: "Noah", format: "short_sets", firstServer: "my", adScoring: true, startingMentalState: { my: "focused", opponent: "not_observed" } };
  const at = (minutes) => new Date(Date.UTC(2026, 9, 4, 12, minutes)).toISOString();
  return { config, at, events: entries.map((entry, index) => ({ id: `e${index}`, matchId: "m", schemaVersion: 1, sequence: index + 1, timestamp: at(entry.minute), source: "tracked", ...entry.event })) };
}

test("a set runs from the previous set's end, so durations leave no gap", () => {
  const { events } = timedMatch([
    // Warm-up before the first point is not part of the first set.
    { minute: 10, event: { type: "point_completed", pointGroupId: "g1", payload: { winner: "my", loser: "opponent", server: "my", receiver: "opponent", serveAttempt: 1, serveResult: "in", faults: 0, scoreBefore: initialScore("my"), scoreAfter: initialScore("my"), mentalContext: { my: "focused", opponent: "not_observed" } } } },
    { minute: 40, event: { type: "set_completed", pointGroupId: "g1", payload: { setNumber: 1, winner: "my", games: [4, 1], setsWon: [1, 0] } } },
    { minute: 45, event: { type: "point_completed", pointGroupId: "g2", payload: { winner: "my", loser: "opponent", server: "my", receiver: "opponent", serveAttempt: 1, serveResult: "in", faults: 0, scoreBefore: initialScore("my"), scoreAfter: initialScore("my"), mentalContext: { my: "focused", opponent: "not_observed" } } } },
    { minute: 80, event: { type: "set_completed", pointGroupId: "g2", payload: { setNumber: 2, winner: "opponent", games: [2, 4], setsWon: [1, 1] } } },
  ]);
  const durations = setDurations(events);
  assert.equal(durations.length, 2);
  assert.equal(durations[0].seconds, 30 * 60, "first set: first point to set end");
  // The changeover belongs to set two, so the two durations are contiguous.
  assert.equal(durations[1].seconds, 40 * 60, "second set: previous end to its own end");
  assert.equal(durations[0].endedAt, durations[1].startedAt, "no time falls between sets");
});

test("a set closed by a manual correction ends and restarts at the correction", () => {
  const before = initialScore("my");
  const corrected = { ...initialScore("my"), sets: [{ games: [4, 2] }], setsWon: [1, 0] };
  const { events } = timedMatch([
    { minute: 5, event: { type: "point_completed", pointGroupId: "g1", payload: { winner: "my", loser: "opponent", server: "my", receiver: "opponent", serveAttempt: 1, serveResult: "in", faults: 0, scoreBefore: before, scoreAfter: before, mentalContext: { my: "focused", opponent: "not_observed" } } } },
    { minute: 35, event: { type: "score_synced", payload: { previous: before, corrected, reason: "Missed points", valid: true } } },
  ]);
  const durations = setDurations(events);
  assert.equal(durations.length, 1);
  assert.equal(durations[0].seconds, 30 * 60);
});

test("durations are formatted the same wherever they are shown", () => {
  assert.equal(formatDuration(47 * 60), "47m");
  assert.equal(formatDuration(84 * 60), "1h 24m");
  assert.equal(formatDuration(0), "—");
});
