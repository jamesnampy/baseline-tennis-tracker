import { FORMAT_RULES, hasCompleteShotDetails, isErrorOutcome, otherPlayer } from "./model.ts";
import type {
  MatchConfig,
  MatchEvent,
  PlayerKey,
  PointCompletedEvent,
  PointDetails,
  ShotType,
} from "./model.ts";
import { activePointEvents, isBreakPoint, pointDetailsMap } from "./scoring.ts";

export interface PlayerStats {
  pointsWon: number;
  servicePointsWon: number;
  returnPointsWon: number;
  aces: number;
  doubleFaults: number;
  firstServesIn: number;
  servicePoints: number;
  firstServePointsWon: number;
  secondServePointsWon: number;
  secondServePoints: number;
  returnWinners: number;
  returnErrors: number;
  winners: number;
  forcedErrors: number;
  unforcedErrors: number;
  breakPointsEarned: number;
  breakPointsConverted: number;
  breakPointsFaced: number;
  breakPointsSaved: number;
  longestStreak: number;
  forehandOutcomes: number;
  backhandOutcomes: number;
  rallyWins: Record<string, number>;
  shotTypeOutcomes: Record<ShotType, { winners: number; errors: number; total: number }>;
  winnerPatterns: Record<"approach_shot" | "passing_shot" | "cross_court" | "inside_out" | "inside_in", number>;
}

export interface MatchStats {
  my: PlayerStats;
  opponent: PlayerStats;
  directlyTrackedPoints: number;
  estimatedTotalPoints: number;
  completeShotDetails: number;
  scoreSyncs: number;
  coverage: number;
}

function emptyPlayerStats(): PlayerStats {
  return {
    pointsWon: 0,
    servicePointsWon: 0,
    returnPointsWon: 0,
    aces: 0,
    doubleFaults: 0,
    firstServesIn: 0,
    servicePoints: 0,
    firstServePointsWon: 0,
    secondServePointsWon: 0,
    secondServePoints: 0,
    returnWinners: 0,
    returnErrors: 0,
    winners: 0,
    forcedErrors: 0,
    unforcedErrors: 0,
    breakPointsEarned: 0,
    breakPointsConverted: 0,
    breakPointsFaced: 0,
    breakPointsSaved: 0,
    longestStreak: 0,
    forehandOutcomes: 0,
    backhandOutcomes: 0,
    rallyWins: { "1-5": 0, "6-10": 0, "11-20": 0, "21+": 0 },
    shotTypeOutcomes: {
      groundstroke: { winners: 0, errors: 0, total: 0 },
      slice: { winners: 0, errors: 0, total: 0 },
      volley: { winners: 0, errors: 0, total: 0 },
      drop_shot: { winners: 0, errors: 0, total: 0 },
      lob: { winners: 0, errors: 0, total: 0 },
      overhead: { winners: 0, errors: 0, total: 0 },
    },
    winnerPatterns: { approach_shot: 0, passing_shot: 0, cross_court: 0, inside_out: 0, inside_in: 0 },
  };
}

export function buildStats(events: MatchEvent[], config: MatchConfig): MatchStats {
  const result: MatchStats = {
    my: emptyPlayerStats(),
    opponent: emptyPlayerStats(),
    directlyTrackedPoints: 0,
    estimatedTotalPoints: 0,
    completeShotDetails: 0,
    scoreSyncs: events.filter((event) => event.type === "score_synced").length,
    coverage: 100,
  };
  const points = activePointEvents(events);
  const detailsByPoint = pointDetailsMap(events);
  const streak = { player: undefined as PlayerKey | undefined, count: 0 };

  for (const point of points) {
    const winner = result[point.payload.winner];
    const server = result[point.payload.server];
    const receiverKey = otherPlayer(point.payload.server);
    const receiver = result[receiverKey];
    const details = detailsByPoint.get(point.pointGroupId);
    result.directlyTrackedPoints += 1;
    result.estimatedTotalPoints += 1;
    winner.pointsWon += 1;
    server.servicePoints += 1;
    if (point.payload.winner === point.payload.server) server.servicePointsWon += 1;
    else receiver.returnPointsWon += 1;
    if (point.payload.serveAttempt === 1 && point.payload.serveResult !== "double_fault") {
      server.firstServesIn += 1;
      if (point.payload.winner === point.payload.server) server.firstServePointsWon += 1;
    }
    if (point.payload.serveAttempt === 2) {
      server.secondServePoints += 1;
      if (point.payload.winner === point.payload.server) server.secondServePointsWon += 1;
    }
    if (point.payload.serveResult === "ace") server.aces += 1;
    if (point.payload.serveResult === "double_fault") server.doubleFaults += 1;

    if (isBreakPoint(point.payload.scoreBefore, point.payload.server, config.adScoring)) {
      receiver.breakPointsEarned += 1;
      server.breakPointsFaced += 1;
      if (point.payload.winner === receiverKey) receiver.breakPointsConverted += 1;
      else server.breakPointsSaved += 1;
    }

    if (streak.player === point.payload.winner) streak.count += 1;
    else {
      streak.player = point.payload.winner;
      streak.count = 1;
    }
    winner.longestStreak = Math.max(winner.longestStreak, streak.count);

    if (details) applyDetails(result, point, details);
  }

  // A score sync represents unknown points. We conservatively add its game-score
  // increase to the estimate so coverage never claims those gaps were observed.
  for (const event of events) {
    if (event.type !== "score_synced") continue;
    const beforeGames = event.payload.previous.games[0] + event.payload.previous.games[1];
    const afterGames = event.payload.corrected.games[0] + event.payload.corrected.games[1];
    const unknownGames = Math.max(0, afterGames - beforeGames);
    result.estimatedTotalPoints += unknownGames * 4;
  }
  result.coverage = result.estimatedTotalPoints
    ? Math.round((result.directlyTrackedPoints / result.estimatedTotalPoints) * 100)
    : 100;
  return result;
}

function applyDetails(
  stats: Pick<MatchStats, "my" | "opponent" | "completeShotDetails">,
  point: PointCompletedEvent,
  details: PointDetails,
) {
  const owner = details.finalStrokePlayer ?? point.payload.winner;
  const player = stats[owner];
  if (details.outcome === "winner") player.winners += 1;
  if (details.outcome === "return_winner") player.returnWinners += 1;
  if (details.outcome === "return_error") player.returnErrors += 1;
  if (details.outcome === "forced_error") player.forcedErrors += 1;
  if (details.outcome === "unforced_error") player.unforcedErrors += 1;
  if (details.finalStroke === "forehand") player.forehandOutcomes += 1;
  if (details.finalStroke === "backhand") player.backhandOutcomes += 1;
  const winningOutcome = details.outcome === "winner" || details.outcome === "return_winner";
  if (details.shotType) {
    const breakdown = player.shotTypeOutcomes[details.shotType];
    breakdown.total += 1;
    if (winningOutcome) breakdown.winners += 1;
    if (isErrorOutcome(details.outcome)) breakdown.errors += 1;
  }
  if (winningOutcome) {
    if (details.shotSituation) player.winnerPatterns[details.shotSituation] += 1;
    if (details.advancedShotType) player.winnerPatterns[details.advancedShotType] += 1;
  }
  if (details.rallyRange) stats[point.payload.winner].rallyWins[details.rallyRange] += 1;
  if (hasCompleteShotDetails(details)) stats.completeShotDetails += 1;
}

export type StatsScope = "total" | `set_${number}` | "match_tiebreak";

export function pointStatsScope(point: PointCompletedEvent, config: MatchConfig): StatsScope {
  const score = point.payload.scoreBefore;
  if (FORMAT_RULES[config.format].matchTiebreakThird && score.inTiebreak && score.tiebreakTarget === 10 && score.sets.length >= 2) return "match_tiebreak";
  return `set_${score.sets.length + 1}`;
}

export function filterEventsForStatsScope(events: MatchEvent[], config: MatchConfig, scope: StatsScope): MatchEvent[] {
  if (scope === "total") return events;
  const pointIds = new Set(activePointEvents(events).filter((point) => pointStatsScope(point, config) === scope).map((point) => point.pointGroupId));
  return events.filter((event) => {
    if ("pointGroupId" in event) return pointIds.has(event.pointGroupId);
    if (event.type === "score_synced") {
      const syntheticPoint = { payload: { scoreBefore: event.payload.previous } } as PointCompletedEvent;
      return pointStatsScope(syntheticPoint, config) === scope;
    }
    return false;
  });
}

export function percentage(numerator: number, denominator: number): string {
  return denominator ? `${Math.round((numerator / denominator) * 100)}%` : "—";
}

export function strategyReview(
  stats: MatchStats,
  config: MatchConfig,
): { response: string; evidence: string[] } {
  const mine = stats.my;
  const opponent = stats.opponent;
  const evidence: string[] = [];
  const recommendations: string[] = [];

  const firstServeRate = mine.servicePoints ? mine.firstServesIn / mine.servicePoints : 0;
  const firstServeWon = mine.firstServesIn ? mine.firstServePointsWon / mine.firstServesIn : 0;
  const returnRate = opponent.servicePoints ? mine.returnPointsWon / opponent.servicePoints : 0;

  if (mine.servicePoints >= 4) {
    evidence.push(`${config.myPlayerName} is landing ${percentage(mine.firstServesIn, mine.servicePoints)} of first serves.`);
    if (firstServeRate < 0.55) recommendations.push("Prioritize a higher-margin first serve and make the opponent play more returns.");
    else if (firstServeWon >= 0.6) recommendations.push("Keep protecting the first-serve pattern—it is producing the stronger service result.");
  }
  if (opponent.servicePoints >= 4) {
    evidence.push(`${config.myPlayerName} has won ${percentage(mine.returnPointsWon, opponent.servicePoints)} of return points.`);
    if (returnRate < 0.35) recommendations.push("Use a compact return and aim through the middle to start more neutral rallies.");
    else recommendations.push("Continue applying return pressure; the current return pattern is creating opportunities.");
  }
  if (mine.unforcedErrors > opponent.unforcedErrors) {
    evidence.push(`${config.myPlayerName} has ${mine.unforcedErrors} observed unforced errors versus ${opponent.unforcedErrors} for ${config.opponentName}.`);
    recommendations.push("On neutral balls, choose the higher-margin cross-court target before changing direction.");
  }
  if (mine.rallyWins["1-5"] > mine.rallyWins["6-10"] + mine.rallyWins["11-20"] + mine.rallyWins["21+"]) {
    evidence.push(`${config.myPlayerName} has won most observed points in the 1–5 shot range.`);
    recommendations.push("Look for the first controlled attacking ball, while avoiding rushed low-percentage finishes.");
  }
  if (!recommendations.length) recommendations.push("Keep gathering points before making a major tactical change; the sample is still small.");

  return {
    response: `Recommended strategy for ${config.myPlayerName}:\n\n${recommendations.map((item, index) => `${index + 1}. ${item}`).join("\n")}\n\nThis is a data-supported courtside observation, not a diagnosis. Follow all applicable tournament coaching rules.`,
    evidence,
  };
}
