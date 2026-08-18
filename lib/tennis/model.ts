/** Bumped whenever the exported dataset shape changes. Exports and reports must agree. */
export const DATASET_VERSION = "baseline-mvp-1.2.2";

export type PlayerKey = "my" | "opponent";
export type PlayerRole = "my_player" | "opponent" | "guest";

export interface PlayerProfile {
  id: string;
  displayName: string;
  role: PlayerRole;
  aliases: string[];
  createdAt: string;
  updatedAt: string;
  previousVersionId?: string;
  handedness?: "left" | "right";
  ustaId?: string;
  ustaUrl?: string;
  notes?: string;
}

export interface IdentityMapping {
  id: string;
  fromPlayerId: string;
  toPlayerId: string;
  kind: "guest_link" | "merge" | "profile_version";
  createdAt: string;
}

export type MatchFormatId =
  | "best_of_3_tiebreak"
  | "best_of_3_match_tiebreak"
  | "short_sets"
  | "short_sets_match_tiebreak"
  | "pro_8";

export type MentalState =
  | "positive"
  | "focused"
  | "tense"
  | "frustrated"
  | "disengaged"
  | "not_observed";

export type PointOutcome =
  | "return_winner"
  | "return_error"
  | "winner"
  | "forced_error"
  | "unforced_error"
  | "ace"
  | "double_fault";

export type RallyRange = "1-5" | "6-10" | "11-20" | "21+";
export type FinalStroke = "forehand" | "backhand" | "neither";
export type BallLanding = "net" | "long" | "side";
export type ShotType =
  | "groundstroke"
  | "slice"
  | "volley"
  | "drop_shot"
  | "lob"
  | "overhead";
export type ShotSituation = "approach_shot" | "passing_shot";
export type AdvancedShotType =
  // passing_shot remains readable for events captured before schema 1.2.1.
  | "passing_shot"
  | "cross_court"
  | "inside_out"
  | "inside_in";

export interface MatchConfig {
  myPlayerId?: string;
  opponentId?: string;
  myPlayerName: string;
  opponentName: string;
  format: MatchFormatId;
  firstServer: PlayerKey;
  adScoring: boolean;
  tournamentUrl?: string;
  tournamentName?: string;
  round?: string;
  date?: string;
  location?: string;
  court?: string;
  notes?: string;
  startingMentalState: Record<PlayerKey, MentalState>;
}

export interface SetScore {
  games: [number, number];
  tiebreak?: [number, number];
  isMatchTiebreak?: boolean;
}

export interface ScoreState {
  sets: SetScore[];
  games: [number, number];
  points: [number, number];
  setsWon: [number, number];
  server: PlayerKey;
  inTiebreak: boolean;
  tiebreakTarget: 7 | 10;
  tiebreakStartServer?: PlayerKey;
  matchComplete: boolean;
  winner?: PlayerKey;
}

export interface PointDetails {
  outcome?: PointOutcome;
  rallyRange?: RallyRange;
  finalStroke?: FinalStroke;
  ballLanding?: BallLanding;
  shotType?: ShotType;
  shotSituation?: ShotSituation;
  advancedShotType?: AdvancedShotType;
  responsiblePlayer?: PlayerKey;
  benefitingPlayer?: PlayerKey;
  finalStrokePlayer?: PlayerKey;
}

export interface EventBase {
  id: string;
  matchId: string;
  schemaVersion: 1;
  sequence: number;
  timestamp: string;
  source: "tracked" | "automatic" | "corrected" | "imported" | "analysis";
  /** Requirements section 15: reference to a corrected or preceding event. */
  correctsEventId?: string;
}

export interface MatchCreatedEvent extends EventBase {
  type: "match_created";
  payload: { config: MatchConfig };
}

export interface MatchStartedEvent extends EventBase {
  type: "match_started";
  payload: { score: ScoreState };
}

export interface ServeAttemptedEvent extends EventBase {
  type: "serve_attempted";
  pointGroupId: string;
  payload: {
    server: PlayerKey;
    attempt: 1 | 2;
    result: "in" | "fault" | "ace";
  };
}

export interface PointCompletedEvent extends EventBase {
  type: "point_completed";
  pointGroupId: string;
  payload: {
    winner: PlayerKey;
    loser: PlayerKey;
    server: PlayerKey;
    receiver: PlayerKey;
    serveAttempt: 1 | 2;
    serveResult: "in" | "ace" | "double_fault";
    faults: 0 | 1 | 2;
    scoreBefore: ScoreState;
    scoreAfter: ScoreState;
    mentalContext: Record<PlayerKey, MentalState>;
  };
}

export interface PointAnnotatedEvent extends EventBase {
  type: "point_annotated";
  pointGroupId: string;
  payload: PointDetails;
}

export interface MentalStateEvent extends EventBase {
  type: "mental_state_changed";
  payload: {
    player: PlayerKey;
    state: MentalState;
    previousState: MentalState;
    captureMoment: "after_point" | "game_end" | "set_end" | "manual";
    linkedPointGroupId?: string;
    score: ScoreState;
    note?: string;
  };
}

export interface ScoreSyncedEvent extends EventBase {
  type: "score_synced";
  payload: {
    previous: ScoreState;
    corrected: ScoreState;
    reason: string;
    valid: boolean;
  };
}

export interface PointUndoneEvent extends EventBase {
  type: "point_undone";
  payload: { pointGroupId: string; voidedEventIds: string[] };
}

export interface StrategyRequestedEvent extends EventBase {
  type: "strategy_requested";
  payload: {
    requestId: string;
    cutoffSequence: number;
    question: string;
    promptVersion: string;
    coverage: number;
  };
}

export interface StrategyEvent extends EventBase {
  type: "strategy_generated";
  payload: {
    cutoffSequence: number;
    provider: string;
    model: string;
    promptVersion: string;
    response: string;
    evidence: string[];
    coverage: number;
    /** Links back to the strategy_requested event. Absent on reviews captured before schema 1.2.2. */
    requestId?: string;
    requestedAt?: string;
  };
}

/**
 * Derived completion events (requirements section 15). These are projections of
 * the score, appended as `automatic` events so the timeline, exports, and the
 * hosted API all see game, set, and match boundaries without recomputing them.
 *
 * A completion caused by a point carries that point's `pointGroupId`, so undo
 * voids it with the rest of the point group and no separate rule is needed.
 */
export interface GameCompletedEvent extends EventBase {
  type: "game_completed";
  pointGroupId?: string;
  payload: {
    setNumber: number;
    gameNumber: number;
    winner: PlayerKey;
    server: PlayerKey;
    /** True when the game's server won it. Meaningless for tiebreak games; see `tiebreak`. */
    hold: boolean;
    games: [number, number];
    tiebreak?: [number, number];
  };
}

export interface SetCompletedEvent extends EventBase {
  type: "set_completed";
  pointGroupId?: string;
  payload: {
    setNumber: number;
    winner: PlayerKey;
    games: [number, number];
    tiebreak?: [number, number];
    isMatchTiebreak: boolean;
    setsWon: [number, number];
  };
}

export interface MatchCompletedEvent extends EventBase {
  type: "match_completed";
  pointGroupId?: string;
  payload: {
    winner: PlayerKey;
    reason: "score" | "retirement";
    score: ScoreState;
  };
}

/** Requirements section 4: retirement is a match-status event, never a mental state. */
export interface PlayerRetiredEvent extends EventBase {
  type: "player_retired";
  payload: {
    player: PlayerKey;
    winner: PlayerKey;
    score: ScoreState;
    note?: string;
  };
}

/** Requirements section 10: corrections are compensating events referencing the affected event. */
export interface EventCorrectedEvent extends EventBase {
  type: "event_corrected";
  correctsEventId: string;
  payload: {
    reason: string;
    changes: Record<string, unknown>;
  };
}

export type MatchEvent =
  | MatchCreatedEvent
  | MatchStartedEvent
  | ServeAttemptedEvent
  | PointCompletedEvent
  | PointAnnotatedEvent
  | MentalStateEvent
  | ScoreSyncedEvent
  | PointUndoneEvent
  | GameCompletedEvent
  | SetCompletedEvent
  | MatchCompletedEvent
  | PlayerRetiredEvent
  | EventCorrectedEvent
  | StrategyRequestedEvent
  | StrategyEvent;

export interface MatchRecord {
  id: string;
  schemaVersion: 1;
  createdAt: string;
  updatedAt: string;
  config: MatchConfig;
  authorized?: boolean;
  events: MatchEvent[];
}

export interface FormatRule {
  id: MatchFormatId;
  label: string;
  shortLabel: string;
  description: string;
  gamesToWin: number;
  tiebreakAt?: number;
  matchTiebreakThird: boolean;
  bestOfSets: 1 | 3;
}

export const FORMAT_RULES: Record<MatchFormatId, FormatRule> = {
  best_of_3_tiebreak: {
    id: "best_of_3_tiebreak",
    label: "Best of 3 · Tiebreak Sets",
    shortLabel: "Best of 3",
    description: "Sets to 6 · 7-point tiebreak at 6–6",
    gamesToWin: 6,
    tiebreakAt: 6,
    matchTiebreakThird: false,
    bestOfSets: 3,
  },
  best_of_3_match_tiebreak: {
    id: "best_of_3_match_tiebreak",
    label: "Best of 3 · 10-Point Match Tiebreak",
    shortLabel: "10-point third",
    description: "Sets to 6 · deciding set is a 10-point tiebreak",
    gamesToWin: 6,
    tiebreakAt: 6,
    matchTiebreakThird: true,
    bestOfSets: 3,
  },
  short_sets: {
    id: "short_sets",
    label: "Best of 3 · Short Sets",
    shortLabel: "Short sets",
    description: "Sets to 4 · 7-point tiebreak at 3–3",
    gamesToWin: 4,
    tiebreakAt: 3,
    matchTiebreakThird: false,
    bestOfSets: 3,
  },
  short_sets_match_tiebreak: {
    id: "short_sets_match_tiebreak",
    label: "Short Sets · 10-Point Match Tiebreak",
    shortLabel: "Short + MTB",
    description: "Sets to 4 · deciding set is a 10-point tiebreak",
    gamesToWin: 4,
    tiebreakAt: 3,
    matchTiebreakThird: true,
    bestOfSets: 3,
  },
  pro_8: {
    id: "pro_8",
    label: "Pro 8",
    shortLabel: "Pro 8",
    description: "One set to 8 · win by 2 · no tiebreak",
    gamesToWin: 8,
    matchTiebreakThird: false,
    bestOfSets: 1,
  },
};

export const PLAYER_INDEX: Record<PlayerKey, 0 | 1> = { my: 0, opponent: 1 };
export const otherPlayer = (player: PlayerKey): PlayerKey =>
  player === "my" ? "opponent" : "my";

/** Outcomes that are valid for the recorded serve and point-winner context. */
export function eligiblePointOutcomes(point: PointCompletedEvent): PointOutcome[] {
  if (point.payload.serveResult === "ace") return ["ace"];
  if (point.payload.serveResult === "double_fault") return ["double_fault"];
  const returnOutcome: PointOutcome = point.payload.winner === point.payload.receiver
    ? "return_winner"
    : "return_error";
  return [returnOutcome, "winner", "forced_error", "unforced_error"];
}

export function isPointOutcomeValid(point: PointCompletedEvent, outcome: PointOutcome): boolean {
  return eligiblePointOutcomes(point).includes(outcome);
}

export function isErrorOutcome(outcome?: PointOutcome): boolean {
  return outcome === "return_error" || outcome === "forced_error" || outcome === "unforced_error";
}

export function usesAdvancedShotOptions(outcome?: PointOutcome): boolean {
  return outcome === "return_winner" || outcome === "return_error" || outcome === "winner" || outcome === "forced_error" || outcome === "unforced_error";
}

export function usesBallLandingOptions(outcome?: PointOutcome): boolean {
  return outcome === "return_error" || outcome === "unforced_error";
}

export function pointDetailsPlayer(point: PointCompletedEvent, outcome: PointOutcome): PlayerKey {
  return outcome === "winner" || outcome === "return_winner" || outcome === "forced_error"
    ? point.payload.winner
    : point.payload.loser;
}

export function hasCompleteShotDetails(details: PointDetails): boolean {
  const advancedComplete = !usesAdvancedShotOptions(details.outcome) || Boolean(details.shotSituation && details.advancedShotType);
  return Boolean(
    details.rallyRange &&
    details.finalStroke &&
    details.shotType &&
    advancedComplete &&
    (!usesBallLandingOptions(details.outcome) || details.ballLanding),
  );
}

export const deepCloneScore = (score: ScoreState): ScoreState =>
  JSON.parse(JSON.stringify(score)) as ScoreState;
