import { createAnthropicProvider, DEFAULT_ANTHROPIC_MODEL } from "./anthropic.ts";
import {
  StrategyUnavailableError,
  type StrategyProvider,
  type StrategyRequest,
} from "./types.ts";

export interface StrategyEnv {
  ANTHROPIC_API_KEY?: string;
  /** Provider id. Defaults to `anthropic`. */
  STRATEGY_PROVIDER?: string;
  /** Model id for the selected provider. */
  STRATEGY_MODEL?: string;
}

const MAX_DATASET_BYTES = 120_000;
const DEFAULT_QUESTION =
  "Given the collected dataset for both players, what is the recommended strategy for my player?";

/** Registry of available providers. Add new vendors here — nothing else changes. */
function resolveProvider(env: StrategyEnv): StrategyProvider | null {
  const id = env.STRATEGY_PROVIDER ?? "anthropic";

  if (id === "anthropic") {
    if (!env.ANTHROPIC_API_KEY) return null;
    return createAnthropicProvider(env.ANTHROPIC_API_KEY, env.STRATEGY_MODEL ?? DEFAULT_ANTHROPIC_MODEL);
  }

  return null;
}

export async function handleStrategyRequest(request: Request, env: StrategyEnv): Promise<Response> {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed." }, { status: 405 });
  }

  const provider = resolveProvider(env);
  // Not an error condition: the client transparently uses its on-device
  // evidence review whenever no hosted provider is configured.
  if (!provider) return Response.json({ error: "Strategy model is not configured." }, { status: 503 });

  let body: Partial<StrategyRequest>;
  try {
    body = (await request.json()) as Partial<StrategyRequest>;
  } catch {
    return Response.json({ error: "Request body must be JSON." }, { status: 400 });
  }

  const serialized = JSON.stringify(body.dataset ?? {});
  if (serialized.length > MAX_DATASET_BYTES) {
    return Response.json({ error: "Dataset is too large." }, { status: 413 });
  }

  try {
    const result = await provider.review({
      question: body.question ?? DEFAULT_QUESTION,
      dataset: body.dataset ?? {},
    });
    return Response.json(result);
  } catch (error) {
    if (error instanceof StrategyUnavailableError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return Response.json({ error: "The strategy service is temporarily unavailable." }, { status: 502 });
  }
}
