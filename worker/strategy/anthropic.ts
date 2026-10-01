import Anthropic from "@anthropic-ai/sdk";
import {
  StrategyUnavailableError,
  SYSTEM_INSTRUCTIONS,
  type StrategyProvider,
  type StrategyRequest,
  type StrategyResult,
} from "./types.ts";

/** Change this to move the whole app to another Claude model, or set STRATEGY_MODEL in the environment. */
export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";

export function createAnthropicProvider(apiKey: string, model: string): StrategyProvider {
  // A review runs about twenty seconds. Without an explicit timeout the SDK
  // scales its own upward for large max_tokens and retries twice, so a stall
  // becomes a very long hang rather than an error the app can fall back from.
  const client = new Anthropic({ apiKey, timeout: 60_000, maxRetries: 1 });

  return {
    id: "anthropic",
    model,
    async review({ question, dataset }: StrategyRequest): Promise<StrategyResult> {
      let message: Anthropic.Message;
      try {
        message = await client.messages.create({
          model,
          // Reviews run about 2,000 tokens. A ceiling far above that shapes
          // nothing and only inflates the SDK's timeout.
          max_tokens: 2500,
          system: SYSTEM_INSTRUCTIONS,
          // Adaptive thinking is the only on-mode for this model family; the
          // legacy budget_tokens field is rejected with a 400.
          thinking: { type: "adaptive" },
          output_config: { effort: "low" },
          messages: [
            {
              role: "user",
              content: `${question}\n\nMATCH DATASET\n${JSON.stringify(dataset)}`,
            },
          ],
        });
      } catch (error) {
        if (error instanceof Anthropic.AuthenticationError) {
          throw new StrategyUnavailableError("The strategy model rejected its credentials.", 502);
        }
        if (error instanceof Anthropic.RateLimitError) {
          throw new StrategyUnavailableError("The strategy service is rate limited.", 429);
        }
        if (error instanceof Anthropic.APIError) {
          throw new StrategyUnavailableError("The strategy service is temporarily unavailable.", 502);
        }
        throw new StrategyUnavailableError("The strategy service could not be reached.", 502);
      }

      if (message.stop_reason === "refusal") {
        throw new StrategyUnavailableError("The strategy model declined this request.", 502);
      }

      const text = message.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();

      if (!text) throw new StrategyUnavailableError("The strategy service returned no review.", 502);

      return { response: text, provider: "anthropic", model };
    },
  };
}
