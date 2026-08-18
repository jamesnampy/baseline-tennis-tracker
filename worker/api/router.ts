/**
 * Versioned, read-only HTTP contract over the hosted event store
 * (requirements section 17), plus the write path cloud sync needs.
 *
 * Hosted access is disabled by default. Without a `SYNC_TOKEN` secret every
 * authenticated route answers 503 and nothing about the device's data is
 * reachable, which is what "device-local records are not exposed to a hosted
 * API unless the user explicitly enables it" means in practice. Set the secret
 * and the same routes require `Authorization: Bearer <token>`.
 *
 * Share links are the one exception: they carry their own unguessable token,
 * are scoped to a single match, and are redacted server-side in `share.ts`.
 */
import { buildStats } from "@/lib/tennis/analytics.ts";
import { buildExportBundle, staleStrategyEventIds } from "@/lib/tennis/export.ts";
import { DATASET_VERSION } from "@/lib/tennis/model.ts";
import type { MatchEvent, MatchRecord } from "@/lib/tennis/model.ts";
import { buildPressureAnalytics } from "@/lib/tennis/pressure.ts";
import {
  activePointEvents,
  numberedPointEvents,
  pointDetailsMap,
  pointGameNumber,
  pointSetNumber,
  projectScore,
  scoreSummary,
} from "@/lib/tennis/scoring.ts";
import {
  hashShareToken,
  isLinkUsable,
  newShareToken,
  redactEvents,
  redactMatch,
  shareLinkSummary,
  type OpponentDisplay,
} from "./share.ts";
import {
  appendEvents,
  eventFromRow,
  type AppendResult,
  findShareLinkByHash,
  getMatchRow,
  insertShareLink,
  latestServerSeq,
  listEventRows,
  listIdentityMappingRows,
  listMatchRows,
  listPlayerRows,
  listShareLinks,
  loadMatch,
  matchFromRows,
  revokeShareLink,
  upsertIdentityMappings,
  upsertMatch,
  upsertPlayers,
} from "./store.ts";

export interface ApiEnv {
  DB?: D1Database;
  /** Shared bearer secret. Unset means hosted access stays off. */
  SYNC_TOKEN?: string;
  /** One room per match: serializes appends and fans them out to spectators. */
  MATCH_ROOM?: DurableObjectNamespace;
}

export const API_PREFIX = "/api/v1";
const API_VERSION = "v1";
const MAX_EVENTS_PER_PUSH = 2000;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });

const notFound = () => json({ error: "Not found." }, 404);

/** Section 17: every response discloses schema, dataset, generation, and coverage. */
function envelope(match: MatchRecord | null, data: Record<string, unknown>): Record<string, unknown> {
  const stats = match ? buildStats(match.events, match.config) : undefined;
  return {
    apiVersion: API_VERSION,
    schemaVersion: 1,
    datasetVersion: DATASET_VERSION,
    generatedAt: new Date().toISOString(),
    anonymized: false,
    coverage: stats
      ? {
          percent: stats.coverage,
          trackedPoints: stats.directlyTrackedPoints,
          estimatedPoints: stats.estimatedTotalPoints,
          completeShotDetails: stats.completeShotDetails,
          scoreSyncs: stats.scoreSyncs,
        }
      : null,
    ...data,
  };
}

function requireDatabase(env: ApiEnv): D1Database | Response {
  if (!env.DB) {
    return json({ error: "Cloud sync is not configured for this deployment." }, 503);
  }
  return env.DB;
}

/**
 * Constant-time-ish comparison. The tokens are equal length in the expected
 * case, so a length mismatch is rejected up front and the loop never leaks
 * position through an early return.
 */
function secretsMatch(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < provided.length; index += 1) {
    difference |= provided.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

function authorize(request: Request, env: ApiEnv): Response | null {
  if (!env.SYNC_TOKEN) {
    return json({ error: "Hosted access is disabled for this deployment." }, 503);
  }
  const header = request.headers.get("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (!token || !secretsMatch(token, env.SYNC_TOKEN)) {
    return json({ error: "Unauthorized." }, 401, { "www-authenticate": "Bearer" });
  }
  return null;
}

function pointRows(match: MatchRecord) {
  const details = pointDetailsMap(match.events);
  return numberedPointEvents(match.events).map(({ point, pointNumber }) => ({
    matchId: match.id,
    pointId: point.pointGroupId,
    pointNumber,
    setNumber: pointSetNumber(point),
    gameNumber: pointGameNumber(point),
    sequence: point.sequence,
    timestamp: point.timestamp,
    server: point.payload.server,
    receiver: point.payload.receiver,
    winner: point.payload.winner,
    loser: point.payload.loser,
    serveAttempt: point.payload.serveAttempt,
    serveResult: point.payload.serveResult,
    faults: point.payload.faults,
    scoreBefore: point.payload.scoreBefore,
    scoreAfter: point.payload.scoreAfter,
    details: details.get(point.pointGroupId) ?? null,
  }));
}

function matchSummary(match: MatchRecord, latestSeq: number) {
  const score = projectScore(match.events, match.config);
  return {
    id: match.id,
    createdAt: match.createdAt,
    updatedAt: match.updatedAt,
    config: match.config,
    score,
    scoreSummary: scoreSummary(score, match.config),
    complete: score.matchComplete,
    eventCount: match.events.length,
    latestServerSeq: latestSeq,
  };
}

async function readJson<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

interface SyncBody {
  match?: { id: string; createdAt: string; updatedAt: string; config: MatchRecord["config"]; authorized?: boolean };
  events?: MatchEvent[];
  players?: Parameters<typeof upsertPlayers>[1];
  identityMappings?: Parameters<typeof upsertIdentityMappings>[1];
}

export async function handleApiRequest(request: Request, env: ApiEnv, url: URL): Promise<Response> {
  const path = url.pathname.slice(API_PREFIX.length) || "/";
  const segments = path.split("/").filter(Boolean);

  // Public: the contract descriptor documents the API without exposing any data.
  if (segments.length === 1 && segments[0] === "schema" && request.method === "GET") {
    return json(contractDescriptor(env));
  }

  if (segments[0] === "live") return handleLiveRequest(request, env, segments, url);

  const denied = authorize(request, env);
  if (denied) return denied;
  const db = requireDatabase(env);
  if (db instanceof Response) return db;

  if (segments[0] === "sync" && segments.length === 1) {
    if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
    return handleSync(request, env, db);
  }

  if (segments[0] === "players" && segments.length === 1 && request.method === "GET") {
    return json(envelope(null, {
      players: (await listPlayerRows(db)).map((row) => ({
        id: row.id,
        displayName: row.display_name,
        role: row.role,
        aliases: JSON.parse(row.aliases) as string[],
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        previousVersionId: row.previous_version_id,
        handedness: row.handedness,
        ustaId: row.usta_id,
        ustaUrl: row.usta_url,
        notes: row.notes,
      })),
      identityMappings: await listIdentityMappingRows(db),
    }));
  }

  if (segments[0] === "share" && segments.length === 2 && request.method === "DELETE") {
    const revoked = await revokeShareLink(db, segments[1]!);
    return revoked ? json({ revoked: true, id: segments[1] }) : notFound();
  }

  if (segments[0] !== "matches") return notFound();

  if (segments.length === 1 && request.method === "GET") {
    const rows = await listMatchRows(db, {
      limit: Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, 200),
      updatedSince: url.searchParams.get("updatedSince") ?? undefined,
      tournament: url.searchParams.get("tournament") ?? undefined,
    });
    return json(envelope(null, {
      matches: rows.map((row) => ({
        id: row.id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        config: JSON.parse(row.config) as MatchRecord["config"],
        tournamentKey: row.tournament_key,
        syncedAt: row.synced_at,
      })),
      nextUpdatedSince: rows.at(-1)?.updated_at ?? null,
    }));
  }

  const matchId = segments[1];
  if (!matchId) return notFound();

  if (segments.length === 2 && request.method === "GET") {
    const match = await loadMatch(db, matchId);
    if (!match) return notFound();
    return json(envelope(match, {
      match: matchSummary(match, await latestServerSeq(db, matchId)),
      stats: buildStats(match.events, match.config),
      pressure: buildPressureAnalytics(match),
    }));
  }

  const resource = segments[2];

  if (segments.length === 3 && resource === "events" && request.method === "GET") {
    const sinceSeq = Number(url.searchParams.get("sinceSeq") ?? 0) || 0;
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 1000) || 1000, 5000);
    const row = await getMatchRow(db, matchId);
    if (!row) return notFound();
    const page = await listEventRows(db, matchId, { sinceSeq, limit });
    const match = matchFromRows(row, await listEventRows(db, matchId));
    return json(envelope(match, {
      matchId,
      events: page.map((eventRow) => ({ serverSeq: eventRow.server_seq, receivedAt: eventRow.received_at, ...eventFromRow(eventRow) })),
      nextSinceSeq: page.at(-1)?.server_seq ?? sinceSeq,
      hasMore: page.length === limit,
    }));
  }

  if (segments.length === 3 && request.method === "GET" && ["points", "serves", "shots", "mental-states", "score-corrections", "strategy-reviews"].includes(resource!)) {
    const match = await loadMatch(db, matchId);
    if (!match) return notFound();
    return json(envelope(match, { matchId, resource, records: resourceRecords(match, resource!) }));
  }

  if (segments.length === 3 && resource === "export" && request.method === "GET") {
    const match = await loadMatch(db, matchId);
    if (!match) return notFound();
    const anonymize = url.searchParams.get("anonymize") === "true";
    const bundle = buildExportBundle(match, [], [], anonymize) as { schemaVersion: number; datasetVersion: string; files: Record<string, string> };
    const file = url.searchParams.get("file");
    if (file) {
      const content = bundle.files[file];
      if (content === undefined) return notFound();
      return new Response(content, {
        headers: {
          "content-type": file.endsWith(".json") ? "application/json" : file.endsWith(".html") ? "text/html; charset=utf-8" : "text/csv; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }
    return json({ ...envelope(match, { matchId, files: bundle.files }), anonymized: anonymize });
  }

  if (segments.length === 3 && resource === "share") {
    if (request.method === "GET") {
      return json(envelope(null, { matchId, links: (await listShareLinks(db, matchId)).map(shareLinkSummary) }));
    }
    if (request.method === "POST") return handleCreateShareLink(request, db, matchId, url);
    return json({ error: "Method not allowed." }, 405);
  }

  return notFound();
}

function resourceRecords(match: MatchRecord, resource: string): unknown[] {
  if (resource === "points") return pointRows(match);
  if (resource === "serves") return match.events.filter((event) => event.type === "serve_attempted");
  if (resource === "shots") return match.events.filter((event) => event.type === "point_annotated");
  if (resource === "mental-states") return match.events.filter((event) => event.type === "mental_state_changed");
  if (resource === "score-corrections") {
    return match.events.filter((event) => event.type === "score_synced" || event.type === "point_undone" || event.type === "event_corrected");
  }
  const stale = staleStrategyEventIds(match) as Set<string>;
  return match.events
    .filter((event) => event.type === "strategy_generated")
    .map((event) => ({ ...event, stale: stale.has(event.id) }));
}

async function handleSync(request: Request, env: ApiEnv, db: D1Database): Promise<Response> {
  const body = await readJson<SyncBody>(request);
  if (!body?.match?.id) return json({ error: "A match with an id is required." }, 400);
  const events = body.events ?? [];
  if (events.length > MAX_EVENTS_PER_PUSH) {
    return json({ error: "Too many events in one push.", limit: MAX_EVENTS_PER_PUSH }, 413);
  }
  if (events.some((event) => event.matchId !== body.match!.id)) {
    return json({ error: "Every event must belong to the pushed match." }, 400);
  }

  await upsertMatch(db, body.match);
  const players = await upsertPlayers(db, body.players ?? []);
  const mappings = await upsertIdentityMappings(db, body.identityMappings ?? []);
  const appended = await appendThroughRoom(env, db, body.match.id, events);
  return json({ matchId: body.match.id, players, identityMappings: mappings, ...appended });
}

/**
 * Appends through the match's Durable Object when one is bound, so writes are
 * serialized and spectators see the point immediately. A deployment without the
 * binding writes straight to D1 and simply has no live fanout — sync, the API,
 * and share-link snapshots all keep working.
 */
async function appendThroughRoom(env: ApiEnv, db: D1Database, matchId: string, events: MatchEvent[]) {
  if (!env.MATCH_ROOM) return appendEvents(db, matchId, events);
  const room = env.MATCH_ROOM.get(env.MATCH_ROOM.idFromName(matchId));
  const response = await room.fetch("https://match-room/append", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ matchId, events }),
  });
  return (await response.json()) as AppendResult;
}

async function handleCreateShareLink(request: Request, db: D1Database, matchId: string, url: URL): Promise<Response> {
  const row = await getMatchRow(db, matchId);
  if (!row) return notFound();
  const body = (await readJson<{
    kind?: "live" | "report";
    expiresInHours?: number;
    includeMentalStates?: boolean;
    includeTimeline?: boolean;
    opponentDisplay?: OpponentDisplay;
    label?: string;
  }>(request)) ?? {};

  const token = newShareToken();
  const createdAt = new Date();
  // Links expire by default. An unbounded link to a child's match is a decision
  // that should have to be made on purpose, not by omission.
  const hours = body.expiresInHours ?? 24;
  const expiresAt = hours > 0 ? new Date(createdAt.getTime() + hours * 3_600_000).toISOString() : null;
  const link = {
    id: crypto.randomUUID(),
    token_hash: await hashShareToken(token),
    match_id: matchId,
    kind: body.kind ?? "live",
    created_at: createdAt.toISOString(),
    expires_at: expiresAt,
    revoked_at: null,
    include_mental_states: body.includeMentalStates ? 1 : 0,
    opponent_display: body.opponentDisplay ?? "initials",
    include_timeline: body.includeTimeline === false ? 0 : 1,
    label: body.label ?? null,
  };
  await insertShareLink(db, link);
  return json({
    ...shareLinkSummary(link),
    // Returned exactly once: only the hash is stored.
    token,
    url: `${url.origin}/live/${token}`,
  }, 201);
}

async function handleLiveRequest(request: Request, env: ApiEnv, segments: string[], url: URL): Promise<Response> {
  const db = requireDatabase(env);
  if (db instanceof Response) return db;
  const token = segments[1];
  if (!token) return notFound();
  if (request.method !== "GET") return json({ error: "Method not allowed." }, 405);


  const link = await findShareLinkByHash(db, await hashShareToken(token));
  // A revoked, expired, or unknown token is answered identically, so a probe
  // cannot tell "wrong token" from "link you no longer have access to".
  if (!link || !isLinkUsable(link)) return json({ error: "This link is no longer available." }, 404);

  const match = await loadMatch(db, link.match_id);
  if (!match) return json({ error: "This link is no longer available." }, 404);
  const visible = redactMatch(match, link);
  const score = projectScore(visible.events, visible.config);

  if (segments.length === 3 && segments[2] === "socket") {
    if (!env.MATCH_ROOM) return json({ error: "Live updates are not enabled for this deployment." }, 503);
    if (request.headers.get("upgrade") !== "websocket") return json({ error: "Expected a WebSocket upgrade." }, 426);
    const room = env.MATCH_ROOM.get(env.MATCH_ROOM.idFromName(link.match_id));
    // The privacy settings travel from the validated link row, never from the
    // client, so a spectator cannot ask for more than the link grants.
    const target = new URL("https://match-room/socket");
    target.searchParams.set("linkId", link.id);
    target.searchParams.set("mental", String(link.include_mental_states));
    target.searchParams.set("timeline", String(link.include_timeline));
    target.searchParams.set("opponent", link.opponent_display);
    return room.fetch(target, request);
  }

  if (segments.length === 3 && segments[2] === "events") {
    const sinceSeq = Number(url.searchParams.get("sinceSeq") ?? 0) || 0;
    const rows = await listEventRows(db, link.match_id, { sinceSeq });
    return json({
      matchId: visible.id,
      events: redactEvents(rows.map(eventFromRow), link),
      latestServerSeq: rows.at(-1)?.server_seq ?? sinceSeq,
      complete: score.matchComplete,
    });
  }

  if (segments.length !== 2) return notFound();

  return json({
    apiVersion: API_VERSION,
    schemaVersion: 1,
    datasetVersion: DATASET_VERSION,
    generatedAt: new Date().toISOString(),
    link: {
      kind: link.kind,
      expiresAt: link.expires_at,
      includeMentalStates: link.include_mental_states === 1,
      includeTimeline: link.include_timeline === 1,
      opponentDisplay: link.opponent_display,
    },
    match: {
      id: visible.id,
      config: visible.config,
      createdAt: visible.createdAt,
      updatedAt: visible.updatedAt,
    },
    score,
    scoreSummary: scoreSummary(score, visible.config),
    trackedPoints: activePointEvents(visible.events).length,
    events: visible.events,
    latestServerSeq: await latestServerSeq(db, link.match_id),
  });
}

function contractDescriptor(env: ApiEnv) {
  return {
    apiVersion: API_VERSION,
    schemaVersion: 1,
    datasetVersion: DATASET_VERSION,
    generatedAt: new Date().toISOString(),
    enabled: Boolean(env.SYNC_TOKEN && env.DB),
    access: "authenticated, read-only, user-scoped, revocable; disabled unless SYNC_TOKEN is set",
    authentication: "Authorization: Bearer <SYNC_TOKEN>",
    resources: [
      { method: "POST", path: `${API_PREFIX}/sync`, description: "Append events and upsert match, players, and identity mappings. Idempotent by event id." },
      { method: "GET", path: `${API_PREFIX}/matches`, description: "List authorized matches.", filters: ["limit", "updatedSince", "tournament"] },
      { method: "GET", path: `${API_PREFIX}/matches/:id`, description: "Match metadata, score projection, statistics, and pressure analytics." },
      { method: "GET", path: `${API_PREFIX}/matches/:id/events`, description: "Ordered, lossless event log.", filters: ["sinceSeq", "limit"] },
      { method: "GET", path: `${API_PREFIX}/matches/:id/points`, description: "Point records with set and game numbers." },
      { method: "GET", path: `${API_PREFIX}/matches/:id/serves` },
      { method: "GET", path: `${API_PREFIX}/matches/:id/shots` },
      { method: "GET", path: `${API_PREFIX}/matches/:id/mental-states` },
      { method: "GET", path: `${API_PREFIX}/matches/:id/score-corrections` },
      { method: "GET", path: `${API_PREFIX}/matches/:id/strategy-reviews`, description: "Includes the stale flag from requirements section 14." },
      { method: "GET", path: `${API_PREFIX}/matches/:id/export`, description: "The same bundle the device downloads.", filters: ["file", "anonymize"] },
      { method: "GET", path: `${API_PREFIX}/players`, description: "Player profiles and identity mappings." },
      { method: "POST", path: `${API_PREFIX}/matches/:id/share`, description: "Create a revocable, expiring, redacted read-only link." },
      { method: "GET", path: `${API_PREFIX}/matches/:id/share`, description: "List a match's links. Tokens are never returned again." },
      { method: "DELETE", path: `${API_PREFIX}/share/:id`, description: "Revoke a link." },
      { method: "GET", path: `${API_PREFIX}/live/:token`, description: "Public redacted snapshot for one share link.", authentication: "share token only" },
      { method: "GET", path: `${API_PREFIX}/live/:token/events`, description: "Incremental redacted events.", filters: ["sinceSeq"] },
    ],
    guarantees: [
      "The exported representation matches the downloadable bundle schema.",
      "Every response reports schema version, dataset version, generation timestamp, coverage, and anonymization status.",
      "Share links exclude mental-state observations and free-form notes unless explicitly included, and are redacted server-side.",
    ],
  };
}
