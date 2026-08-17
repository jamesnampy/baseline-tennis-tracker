export type PlayerKey = "my" | "opponent";

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
export type ShotType =
  | "groundstroke"
  | "slice"
  | "volley"
  | "drop_shot"
  | "lob"
  | "overhead";
export type AdvancedShotType =
  | "passing_shot"
  | "cross_court"
  | "inside_out"
  | "inside_in";

export interface MatchConfig {
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
  shotType?: ShotType;
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
  source: "tracked" | "automatic" | "corrected" | "analysis";
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
  | StrategyEvent;

export interface MatchRecord {
  id: string;
  schemaVersion: 1;
  createdAt: string;
  updatedAt: string;
  config: MatchConfig;
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

export const deepCloneScore = (score: ScoreState): ScoreState =>
  JSON.parse(JSON.stringify(score)) as ScoreState;
