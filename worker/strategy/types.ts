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

export const SYSTEM_INSTRUCTIONS = `You are a cautious junior-tennis strategy analyst. Analyze only the supplied match dataset for both players.
Return concise, practical strategy for the user's player. Separate observed evidence from inference, name material data limitations, avoid psychological or medical diagnosis, and remind the user to follow tournament coaching rules. Never invent unobserved shots or scores.`;
