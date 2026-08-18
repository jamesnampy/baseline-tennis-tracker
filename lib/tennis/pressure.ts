import type { MatchRecord, PlayerKey, PointCompletedEvent } from "./model.ts";
import { activePointEvents, applyPoint, isBreakPoint } from "./scoring.ts";
import { buildStats } from "./analytics.ts";

export type PressureCategory = "late_game" | "deuce_advantage" | "no_ad_decider" | "break_point" | "game_point" | "set_point" | "match_point" | "tiebreak" | "late_tiebreak";
export type PressureRate = { played: number; won: number };
export type PlayerPressure = { player: PlayerKey; played: number; won: number; servingWon: number; returningWon: number; coverage: number; trackedPoints: number; estimatedPoints: number; categories: Record<PressureCategory, PressureRate> };
const categories: PressureCategory[] = ["late_game", "deuce_advantage", "no_ad_decider", "break_point", "game_point", "set_point", "match_point", "tiebreak", "late_tiebreak"];

export function pressureCategories(point: PointCompletedEvent, match: MatchRecord): PressureCategory[] {
  const before = point.payload.scoreBefore;
  const result = new Set<PressureCategory>();
  if (before.inTiebreak) {
    result.add("tiebreak");
    const lateAt = before.tiebreakTarget === 10 ? 8 : 5;
    if (before.points[0] >= lateAt && before.points[1] >= lateAt) result.add("late_tiebreak");
  } else {
    if (before.points[0] >= 2 && before.points[1] >= 2) result.add("late_game");
    if (match.config.adScoring && before.points[0] >= 3 && before.points[1] >= 3) result.add("deuce_advantage");
    if (!match.config.adScoring && before.points[0] === 3 && before.points[1] === 3) result.add("no_ad_decider");
    if (isBreakPoint(before, point.payload.server, match.config.adScoring)) result.add("break_point");
  }
  for (const candidate of ["my", "opponent"] as PlayerKey[]) {
    const after = applyPoint(before, candidate, match.config.format, match.config.adScoring);
    if (after.games[0] !== before.games[0] || after.games[1] !== before.games[1] || after.sets.length !== before.sets.length) result.add("game_point");
    if (after.setsWon[0] !== before.setsWon[0] || after.setsWon[1] !== before.setsWon[1]) result.add("set_point");
    if (after.matchComplete) result.add("match_point");
  }
  return [...result];
}

export function buildPressureAnalytics(match: MatchRecord): Record<PlayerKey, PlayerPressure> {
  const points = activePointEvents(match.events);
  const data = buildStats(match.events, match.config);
  const make = (player: PlayerKey): PlayerPressure => ({ player, played: 0, won: 0, servingWon: 0, returningWon: 0, coverage: data.coverage, trackedPoints: data.directlyTrackedPoints, estimatedPoints: data.estimatedTotalPoints, categories: Object.fromEntries(categories.map((name) => [name, { played: 0, won: 0 }])) as Record<PressureCategory, PressureRate> });
  const result = { my: make("my"), opponent: make("opponent") };
  for (const point of points) {
    const names = pressureCategories(point, match); if (!names.length) continue;
    for (const player of ["my", "opponent"] as PlayerKey[]) {
      result[player].played += 1;
      if (point.payload.winner === player) { result[player].won += 1; if (point.payload.server === player) result[player].servingWon += 1; else result[player].returningWon += 1; }
      for (const name of names) { result[player].categories[name].played += 1; if (point.payload.winner === player) result[player].categories[name].won += 1; }
    }
  }
  return result;
}
