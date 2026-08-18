/**
 * Cloudflare Worker API for Baseline.
 *
 * Static assets and the SPA fallback are served by the `assets` binding
 * (see wrangler.jsonc). `run_worker_first` routes only `/api/*` here, so this
 * handler never needs to serve the client bundle itself.
 */
import { API_PREFIX, handleApiRequest, handleReportRequest, REPORT_PREFIX, type ApiEnv } from "./api/router.ts";
import { handleStrategyRequest, type StrategyEnv } from "./strategy/index.ts";

export { MatchRoom } from "./live/room.ts";

export interface Env extends StrategyEnv, ApiEnv {
  ASSETS: Fetcher;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/strategy") {
      return handleStrategyRequest(request, env);
    }

    if (url.pathname === API_PREFIX || url.pathname.startsWith(`${API_PREFIX}/`)) {
      return handleApiRequest(request, env, url);
    }

    if (url.pathname.startsWith("/api/")) {
      return Response.json({ error: "Not found." }, { status: 404 });
    }

    // Coach reports are server-rendered HTML, not part of the SPA: a coach opens
    // the link and gets the report, with no client bundle in between.
    if (url.pathname.startsWith(REPORT_PREFIX)) {
      return handleReportRequest(request, env, url);
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
