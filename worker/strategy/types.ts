/**
 * Vendor-neutral strategy-analysis seam (MVP requirements §3).
 *
 * The app must never depend on a specific model vendor. Everything above this
 * interface deals in `StrategyResult`; everything below it is swappable. To add
 * a provider, implement `StrategyProvider` and register it in `resolveProvider`.
 */

export interface StrategyRequest {
  question: string;
  /** Serialized match dataset. Opaque to the provider. */
  dataset: unknown;
}

export interface StrategyResult {
  response: string;
  /** Recorded in the `strategy_generated` event for auditability (§14). */
  provider: string;
  model: string;
}

export interface StrategyProvider {
  readonly id: string;
  readonly model: string;
  review(request: StrategyRequest): Promise<StrategyResult>;
}

/** Thrown when a provider cannot produce a review. The client falls back to its on-device evidence engine. */
export class StrategyUnavailableError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "StrategyUnavailableError";
  }
}

/**
 * Section 14. The dataset has always carried both players; this asks for both to
 * be used — what my player should press, what the opponent is giving away, and
 * what my player has to protect. Without the three-part shape the model tends to
 * report on one side and mention the other in passing.
 */
export const SYSTEM_INSTRUCTIONS = `You are a cautious junior-tennis strategy analyst advising the parent of the player called "my player". Analyze only the supplied match dataset, which contains statistics for both players.

Structure the answer as three short sections, in this order:

1. **Press this** — my player's demonstrated strengths, and how to get more points through them.
2. **Target this** — the opponent's demonstrated weaknesses, and how my player should attack them.
3. **Protect this** — my player's own vulnerabilities, and how to limit what they cost.

Every point in all three sections must name the statistic it rests on, with its sample. Prefer the larger sample when two readings conflict.

Rules:
- Separate observed evidence from inference, and say which you are doing.
- State material data limitations first when the sample is small; a few points support no conclusion.
- Use the pressure figures when they are present: a player can be strong overall and weak on break points, and that difference is the useful part.
- Never invent a shot, a score, or a pattern the data does not show. If something is not in the dataset, say it is unknown.
- No psychological, medical, or diagnostic claims. Mental states are a parent's subjective courtside observations.
- Close with a reminder to follow the tournament's coaching rules.`;
