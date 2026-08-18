import {
  deepCloneScore,
  FORMAT_RULES,
  otherPlayer,
  PLAYER_INDEX,
} from "./model.ts";
import type {
  GameCompletedEvent,
  MatchCompletedEvent,
  MatchConfig,
  MatchEvent,
  MatchFormatId,
  PlayerKey,
  PointCompletedEvent,
  PointDetails,
  ScoreState,
  SetCompletedEvent,
} from "./model.ts";

export function initialScore(firstServer: PlayerKey): ScoreState {
  return {
    sets: [],
    games: [0, 0],
    points: [0, 0],
    setsWon: [0, 0],
    server: firstServer,
    inTiebreak: false,
    tiebreakTarget: 7,
    matchComplete: false,
  };
}

function tiebreakServer(start: PlayerKey, pointIndex: number): PlayerKey {
  if (pointIndex === 0) return start;
  const pair = Math.floor((pointIndex - 1) / 2);
  return pair % 2 === 0 ? otherPlayer(start) : start;
}

function finishMatchIfNeeded(score: ScoreState, format: MatchFormatId) {
  const setsNeeded = FORMAT_RULES[format].bestOfSets === 1 ? 1 : 2;
  const winnerIndex = score.setsWon[0] >= setsNeeded ? 0 : score.setsWon[1] >= setsNeeded ? 1 : -1;
  if (winnerIndex >= 0) {
    score.matchComplete = true;
    score.winner = winnerIndex === 0 ? "my" : "opponent";
  }
}

function beginNextSet(score: ScoreState, format: MatchFormatId) {
  const rules = FORMAT_RULES[format];
  if (
    rules.matchTiebreakThird &&
    score.sets.length === 2 &&
    score.setsWon[0] === 1 &&
    score.setsWon[1] === 1
  ) {
    score.games = [0, 0];
    score.points = [0, 0];
    score.inTiebreak = true;
    score.tiebreakTarget = 10;
    score.tiebreakStartServer = score.server;
    return;
  }
  score.games = [0, 0];
  score.points = [0, 0];
  score.inTiebreak = false;
  score.tiebreakTarget = 7;
  score.tiebreakStartServer = undefined;
}

function completeRegularSet(score: ScoreState, winnerIndex: 0 | 1, format: MatchFormatId) {
  score.sets.push({ games: [...score.games] as [number, number] });
  score.setsWon[winnerIndex] += 1;
  finishMatchIfNeeded(score, format);
  if (!score.matchComplete) beginNextSet(score, format);
}

function completeTiebreak(score: ScoreState, winnerIndex: 0 | 1, format: MatchFormatId) {
  const tiebreak = [...score.points] as [number, number];
  const isMatchTiebreak = score.tiebreakTarget === 10 && score.sets.length === 2;
  const startingServer = score.tiebreakStartServer ?? score.server;
  if (isMatchTiebreak) {
    score.sets.push({
      games: winnerIndex === 0 ? [1, 0] : [0, 1],
      tiebreak,
      isMatchTiebreak: true,
    });
  } else {
    const games = [...score.games] as [number, number];
    games[winnerIndex] += 1;
    score.sets.push({ games, tiebreak });
  }
  score.setsWon[winnerIndex] += 1;
  score.server = otherPlayer(startingServer);
  score.points = [0, 0];
  score.inTiebreak = false;
  score.tiebreakStartServer = undefined;
  finishMatchIfNeeded(score, format);
  if (!score.matchComplete) beginNextSet(score, format);
}

function completeGame(score: ScoreState, winnerIndex: 0 | 1, format: MatchFormatId) {
  score.points = [0, 0];
  score.games[winnerIndex] += 1;
  score.server = otherPlayer(score.server);
  const rules = FORMAT_RULES[format];

  if (rules.id === "pro_8") {
    if (score.games[winnerIndex] >= rules.gamesToWin && Math.abs(score.games[0] - score.games[1]) >= 2) {
      completeRegularSet(score, winnerIndex, format);
    }
    return;
  }

  if (rules.tiebreakAt !== undefined && score.games[0] === rules.tiebreakAt && score.games[1] === rules.tiebreakAt) {
    score.inTiebreak = true;
    score.tiebreakTarget = 7;
    score.tiebreakStartServer = score.server;
    return;
  }

  if (score.games[winnerIndex] >= rules.gamesToWin && Math.abs(score.games[0] - score.games[1]) >= 2) {
    completeRegularSet(score, winnerIndex, format);
  }
}

export function applyPoint(
  current: ScoreState,
  winner: PlayerKey,
  format: MatchFormatId,
  adScoring: boolean,
): ScoreState {
  if (current.matchComplete) return deepCloneScore(current);
  const score = deepCloneScore(current);
  const winnerIndex = PLAYER_INDEX[winner];
  const loserIndex = winnerIndex === 0 ? 1 : 0;

  if (score.inTiebreak) {
    score.points[winnerIndex] += 1;
    if (
      score.points[winnerIndex] >= score.tiebreakTarget &&
      score.points[winnerIndex] - score.points[loserIndex] >= 2
    ) {
      completeTiebreak(score, winnerIndex, format);
      return score;
    }
    const nextPointIndex = score.points[0] + score.points[1];
    score.server = tiebreakServer(score.tiebreakStartServer ?? current.server, nextPointIndex);
    return score;
  }

  score.points[winnerIndex] += 1;
  const wonGame = score.points[winnerIndex] >= 4 &&
    (!adScoring || score.points[winnerIndex] - score.points[loserIndex] >= 2);
  if (wonGame) completeGame(score, winnerIndex, format);
  return score;
}

export function pointScoreLabel(score: ScoreState, player: PlayerKey, adScoring: boolean): string {
  const index = PLAYER_INDEX[player];
  if (score.inTiebreak) return String(score.points[index]);
  const mine = score.points[index];
  const theirs = score.points[index === 0 ? 1 : 0];
  if (adScoring && mine >= 3 && theirs >= 3) {
    if (mine === theirs) return "40";
    if (mine === theirs + 1) return "AD";
    if (theirs === mine + 1) return "40";
  }
  return ["0", "15", "30", "40"][Math.min(mine, 3)] ?? "40";
}

export function scoreSummary(score: ScoreState, config: MatchConfig): string {
  const completed = score.sets.map((set) =>
    set.isMatchTiebreak
      ? `${set.tiebreak?.[0] ?? 0}–${set.tiebreak?.[1] ?? 0}`
      : `${set.games[0]}–${set.games[1]}`,
  );
  const current = score.matchComplete ? [] : [
    score.inTiebreak
      ? `${score.points[0]}–${score.points[1]}`
      : `${score.games[0]}–${score.games[1]} (${pointScoreLabel(score, "my", config.adScoring)}–${pointScoreLabel(score, "opponent", config.adScoring)})`,
  ];
  return [...completed, ...current].join(", ");
}

export function voidedPointIds(events: MatchEvent[]): Set<string> {
  return new Set(
    events
      .filter((event) => event.type === "point_undone")
      .map((event) => event.payload.pointGroupId),
  );
}

export function activePointEvents(events: MatchEvent[]): PointCompletedEvent[] {
  const voided = voidedPointIds(events);
  return events.filter(
    (event): event is PointCompletedEvent =>
      event.type === "point_completed" && !voided.has(event.pointGroupId),
  );
}

export function numberedPointEvents(events: MatchEvent[]) {
  return activePointEvents(events).map((point, index) => ({ point, pointNumber: index + 1 }));
}

export function pointDetailsMap(events: MatchEvent[]): Map<string, PointDetails> {
  const voided = voidedPointIds(events);
  const details = new Map<string, PointDetails>();
  for (const event of events) {
    if (event.type === "point_annotated" && !voided.has(event.pointGroupId)) {
      details.set(event.pointGroupId, { ...(details.get(event.pointGroupId) ?? {}), ...event.payload });
    }
  }
  return details;
}

export function projectScore(events: MatchEvent[], config: MatchConfig): ScoreState {
  const voided = voidedPointIds(events);
  let score = initialScore(config.firstServer);
  for (const event of events) {
    if (event.type === "point_completed" && !voided.has(event.pointGroupId)) {
      score = applyPoint(score, event.payload.winner, config.format, config.adScoring);
    } else if (event.type === "score_synced") {
      score = deepCloneScore(event.payload.corrected);
    } else if (event.type === "player_retired") {
      // A retirement ends the match at whatever score has been recorded; it never
      // invents games. game_completed/set_completed/match_completed are derived
      // outputs and deliberately do not feed back into the projection.
      score = deepCloneScore(event.payload.score);
      score.matchComplete = true;
      score.winner = event.payload.winner;
    }
  }
  return score;
}

/** 1-based set number the point was played in (requirements section 13). */
export function pointSetNumber(point: PointCompletedEvent): number {
  return point.payload.scoreBefore.sets.length + 1;
}

/**
 * 1-based game number within the point's set. A tiebreak counts as the game
 * after the last completed one; a 10-point match tiebreak reports game 1 of its
 * own set because it replaces the deciding set entirely.
 */
export function pointGameNumber(point: PointCompletedEvent): number {
  const before = point.payload.scoreBefore;
  return before.games[0] + before.games[1] + 1;
}

export type DerivedCompletion =
  | { type: "game_completed"; payload: GameCompletedEvent["payload"] }
  | { type: "set_completed"; payload: SetCompletedEvent["payload"] }
  | { type: "match_completed"; payload: MatchCompletedEvent["payload"] };

const keyOf = (index: number): PlayerKey => (index === 0 ? "my" : "opponent");

/**
 * Diffs two score snapshots and returns the game, set, and match completions
 * that happened between them, in order.
 *
 * `includeGames` is false for score synchronization: a correction can jump
 * several games at once, and emitting one game_completed per jump would either
 * lose games or invent them. Sets and match completion stay exact either way.
 */
export function derivedCompletions(
  before: ScoreState,
  after: ScoreState,
  { includeGames = true }: { includeGames?: boolean } = {},
): DerivedCompletion[] {
  const completions: DerivedCompletion[] = [];
  const setCompleted = after.sets.length > before.sets.length;
  const completedSet = setCompleted ? after.sets[after.sets.length - 1] : undefined;
  const setNumber = before.sets.length + 1;

  const setWinnerIndex = after.setsWon[0] > before.setsWon[0] ? 0 : after.setsWon[1] > before.setsWon[1] ? 1 : -1;
  const gamesPlayedBefore = before.games[0] + before.games[1];

  if (includeGames) {
    if (setCompleted && completedSet && !completedSet.isMatchTiebreak && setWinnerIndex >= 0) {
      // The final game of a set is the one that completed it, tiebreaks included.
      completions.push({
        type: "game_completed",
        payload: {
          setNumber,
          gameNumber: gamesPlayedBefore + 1,
          winner: keyOf(setWinnerIndex),
          server: before.server,
          hold: keyOf(setWinnerIndex) === (before.inTiebreak ? before.tiebreakStartServer ?? before.server : before.server),
          games: [...completedSet.games] as [number, number],
          tiebreak: completedSet.tiebreak ? ([...completedSet.tiebreak] as [number, number]) : undefined,
        },
      });
    } else if (!setCompleted) {
      const gameWinnerIndex = after.games[0] > before.games[0] ? 0 : after.games[1] > before.games[1] ? 1 : -1;
      if (gameWinnerIndex >= 0) {
        completions.push({
          type: "game_completed",
          payload: {
            setNumber,
            gameNumber: gamesPlayedBefore + 1,
            winner: keyOf(gameWinnerIndex),
            server: before.server,
            hold: keyOf(gameWinnerIndex) === before.server,
            games: [...after.games] as [number, number],
          },
        });
      }
    }
  }

  if (setCompleted && completedSet && setWinnerIndex >= 0) {
    completions.push({
      type: "set_completed",
      payload: {
        setNumber,
        winner: keyOf(setWinnerIndex),
        games: [...completedSet.games] as [number, number],
        tiebreak: completedSet.tiebreak ? ([...completedSet.tiebreak] as [number, number]) : undefined,
        isMatchTiebreak: Boolean(completedSet.isMatchTiebreak),
        setsWon: [...after.setsWon] as [number, number],
      },
    });
  }

  if (after.matchComplete && !before.matchComplete && after.winner) {
    completions.push({
      type: "match_completed",
      payload: { winner: after.winner, reason: "score", score: deepCloneScore(after) },
    });
  }

  return completions;
}

export function isBreakPoint(score: ScoreState, server: PlayerKey, adScoring: boolean): boolean {
  if (score.inTiebreak) return false;
  const receiver = otherPlayer(server);
  const r = score.points[PLAYER_INDEX[receiver]];
  const s = score.points[PLAYER_INDEX[server]];
  if (!adScoring) return r === 3;
  return r >= 3 && r > s;
}
