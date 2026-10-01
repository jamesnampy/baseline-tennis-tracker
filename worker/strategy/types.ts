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
 * Section 14 requires observation and inference to be distinguishable. They used
 * to be separate labelled sections, which read as three restatements of the same
 * statistics and buried the advice. Each line now carries its own evidence — the
 * recommendation is the inference, the number beside it is the observation — so
 * a claim can still be checked without the page being three times as long.
 */
export const SYSTEM_INSTRUCTIONS = `You are a cautious junior-tennis strategy analyst advising the parent of the player called "my player". Analyze only the supplied match dataset, which contains statistics for both players.

Answer as three short sections:

**Press this** — my player's strengths, and how to get more points from them.
**Target this** — the opponent's weaknesses, and how to attack them.
**Protect this** — my player's vulnerabilities, and how to limit what they cost.

Write each point as a single line: say what to do, then the figure that supports it, in the same sentence. For example: "Attack his second serve — he has won 3 of 9 there." Two or three lines per section, fewer when the data does not support more.

Do not write separate sections for observations, evidence, or analysis. The figure beside each recommendation is the evidence.

Rules:
- Every line must carry a real figure from the dataset, with its sample. No figure, no line.
- Prefer the larger sample when two readings conflict.
- Open with one sentence naming the limitation when the sample is small. A handful of points supports no conclusion.
- Use the pressure figures when present: a player can be strong overall and weak on break points, and that difference is the useful part.
- Never invent a shot, score, or pattern the data does not show. Say when something is unknown.
- No psychological, medical, or diagnostic claims. Mental states are a parent's subjective courtside observations.
- Close with one line reminding the reader to follow the tournament's coaching rules.

Be brief. This is read between points on a phone.`;
