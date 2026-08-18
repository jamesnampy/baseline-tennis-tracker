/**
 * Cloudflare Worker API for Baseline.
 *
 * Static assets and the SPA fallback are served by the `assets` binding
 * (see wrangler.jsonc). `run_worker_first` routes only `/api/*` here, so this
 * handler never needs to serve the client bundle itself.
 */
import { handleStrategyRequest, type StrategyEnv } from "./strategy/index.ts";

export interface Env extends StrategyEnv {
  ASSETS: Fetcher;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/strategy") {
      return handleStrategyRequest(request, env);
    }

    if (url.pathname.startsWith("/api/")) {
      return Response.json({ error: "Not found." }, { status: 404 });
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
