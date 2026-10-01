/**
 * One definition of the statistics tables, rendered by both the Stats screen and
 * the coach report.
 *
 * The two previously built their own rows and drifted: the screen carried service
 * games held, breaks won, serve-split return points and error placement; the
 * report carried break points saved and pressure. Neither was wrong, but a coach
 * and a parent were reading different matches. Scope selection was unified behind
 * `statsScopeOptions` for the same reason; this is the rows.
 *
 * Every cell separates the headline figure from the sample behind it, so each
 * surface can style them differently without either inventing or dropping a
 * number. Section 12 asks for a sample size beside every metric, and section 18
 * asks for the numerator and denominator, so a rate is always `n/d` with the
 * percentage alongside — never a bare percentage.
 */
import { percentage, shotImpact, type MatchStats, type PlayerStats, type ShotBreakdown } from "./analytics.ts";
import type { BallLanding, PlayerKey, ShotType } from "./model.ts";
import type { PlayerPressure, PressureCategory } from "./pressure.ts";

export interface StatCell {
  /** The figure itself: a count, an `n/d` rate, or a signed impact. */
  value: string;
  /** What it was computed from. Omitted when the value is already the whole story. */
  detail?: string;
}

export interface StatRow {
  label: string;
  my: StatCell;
  opponent: StatCell;
}

const count = (value: number): StatCell => ({ value: String(value) });

/** A rate always shows what it was drawn from; `n=0` is said rather than hidden. */
const rate = (numerator: number, denominator: number): StatCell =>
  denominator ? { value: `${numerator}/${denominator}`, detail: percentage(numerator, denominator) } : { value: "—", detail: "n=0" };

/** Point endings that won the point minus those that lost it. */
const impact = (breakdown: ShotBreakdown): StatCell =>
  breakdown.total
    ? { value: `${shotImpact(breakdown) >= 0 ? "+" : ""}${shotImpact(breakdown)}`, detail: `${breakdown.winners}W−${breakdown.errors}E, n=${breakdown.total}` }
    : { value: "—", detail: "n=0" };

const row = (label: string, cell: (side: PlayerStats, other: PlayerStats) => StatCell, stats: MatchStats): StatRow =>
  ({ label, my: cell(stats.my, stats.opponent), opponent: cell(stats.opponent, stats.my) });

export const SHOT_TYPES: ShotType[] = ["groundstroke", "slice", "volley", "drop_shot", "lob", "overhead"];
export const BALL_LANDINGS: BallLanding[] = ["net", "long", "side"];
export const RALLY_RANGES = ["1-5", "6-10", "11-20", "21+"] as const;
export const WINNER_PATTERNS = ["approach_shot", "passing_shot", "cross_court", "inside_out", "inside_in"] as const;

export const SHOT_LABELS: Record<string, string> = {
  groundstroke: "Groundstroke", slice: "Slice", volley: "Volley", drop_shot: "Drop shot",
  lob: "Lob", overhead: "Overhead", approach_shot: "Approach shot", passing_shot: "Passing shot",
  cross_court: "Cross-court", inside_out: "Inside-out", inside_in: "Inside-in",
  net: "Net", long: "Long", side: "Side",
};

const PRESSURE_LABELS: Record<PressureCategory, string> = {
  late_game: "30–30 or later", deuce_advantage: "Deuce or advantage", no_ad_decider: "No-ad deciding point",
  break_point: "Break point", game_point: "Game point", set_point: "Set point",
  match_point: "Match point", tiebreak: "Tiebreak", late_tiebreak: "Late in a tiebreak",
};

/** Score, serve and return. The union of what both surfaces used to carry. */
export function matchRows(stats: MatchStats): StatRow[] {
  return [
    row("Points won", (side) => count(side.pointsWon), stats),
    row("Service points won", (side) => rate(side.servicePointsWon, side.servicePoints), stats),
    // The denominator is the other player's service points: you return what they serve.
    row("Return points won", (side, other) => rate(side.returnPointsWon, other.servicePoints), stats),
    row("First serves in", (side) => rate(side.firstServesIn, side.servicePoints), stats),
    row("First-serve points won", (side) => rate(side.firstServePointsWon, side.firstServesIn), stats),
    row("Second-serve points won", (side) => rate(side.secondServePointsWon, side.secondServePoints), stats),
    row("Aces", (side) => count(side.aces), stats),
    row("Double faults", (side) => count(side.doubleFaults), stats),
    row("Service games held", (side) => rate(side.serviceGamesHeld, side.serviceGames), stats),
    row("Breaks won", (side) => count(side.breaks), stats),
    row("First-serve return points won", (side) => rate(side.firstServeReturnPointsWon, side.firstServeReturnPoints), stats),
    row("Second-serve return points won", (side) => rate(side.secondServeReturnPointsWon, side.secondServeReturnPoints), stats),
    row("Return winners", (side) => count(side.returnWinners), stats),
    row("Return errors", (side) => count(side.returnErrors), stats),
    row("Break points converted", (side) => rate(side.breakPointsConverted, side.breakPointsEarned), stats),
    row("Break points saved", (side) => rate(side.breakPointsSaved, side.breakPointsFaced), stats),
    row("Winners", (side) => count(side.winners), stats),
    row("Errors forced", (side) => count(side.forcedErrors), stats),
    row("Unforced errors", (side) => count(side.unforcedErrors), stats),
    row("Longest point streak", (side) => count(side.longestStreak), stats),
  ];
}

/** Observed point-ending shots. Never every stroke in the rally. */
export function shotRows(stats: MatchStats): StatRow[] {
  return [
    row("Forehand impact", (side) => impact(side.strokeOutcomes.forehand), stats),
    row("Backhand impact", (side) => impact(side.strokeOutcomes.backhand), stats),
    row("Net conversion", (side) => rate(side.netPlay.winners, side.netPlay.total), stats),
    row("Return quality", (side) => side.returnWinners + side.returnErrors
      ? { value: `${side.returnWinners - side.returnErrors >= 0 ? "+" : ""}${side.returnWinners - side.returnErrors}`, detail: `${side.returnWinners}W−${side.returnErrors}E` }
      : { value: "—", detail: "n=0" }, stats),
    ...SHOT_TYPES.map((type) => row(SHOT_LABELS[type]!, (side) => impact(side.shotTypeOutcomes[type]), stats)),
    ...WINNER_PATTERNS.map((pattern) => row(`${SHOT_LABELS[pattern]} winners`, (side) => count(side.winnerPatterns[pattern]), stats)),
  ];
}

/** Points won by rally length. */
export function rallyRows(stats: MatchStats): StatRow[] {
  return RALLY_RANGES.map((range) => row(`${range} shots`, (side) => count(side.rallyWins[range] ?? 0), stats));
}

/**
 * Where errors landed, kept as two groups: a serve into the net and a
 * groundstroke into the net are different mistakes.
 */
export function landingRows(stats: MatchStats): StatRow[] {
  return [
    ...BALL_LANDINGS.map((landing) => row(`Serve · ${SHOT_LABELS[landing]}`, (side) => count(side.serveErrorLanding[landing]), stats)),
    ...BALL_LANDINGS.map((landing) => row(`Rally · ${SHOT_LABELS[landing]}`, (side) => count(side.rallyErrorLanding[landing]), stats)),
  ];
}

/**
 * Pressure, from the score immediately before each point. A point can belong to
 * several categories; the overall row counts it once. Categories nobody reached
 * are left out rather than listed as zeroes.
 */
export function pressureRows(pressure: Record<PlayerKey, PlayerPressure>): StatRow[] {
  const rows: StatRow[] = [
    { label: "All pressure points", my: rate(pressure.my.won, pressure.my.played), opponent: rate(pressure.opponent.won, pressure.opponent.played) },
    { label: "Won while serving", my: count(pressure.my.servingWon), opponent: count(pressure.opponent.servingWon) },
    { label: "Won while returning", my: count(pressure.my.returningWon), opponent: count(pressure.opponent.returningWon) },
  ];
  for (const category of Object.keys(PRESSURE_LABELS) as PressureCategory[]) {
    const mine = pressure.my.categories[category];
    const theirs = pressure.opponent.categories[category];
    if (!mine.played && !theirs.played) continue;
    rows.push({ label: PRESSURE_LABELS[category], my: rate(mine.won, mine.played), opponent: rate(theirs.won, theirs.played) });
  }
  return rows;
}
