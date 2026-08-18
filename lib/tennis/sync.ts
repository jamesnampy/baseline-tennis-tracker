/**
 * Client-side cloud sync (requirements sections 16, 17, and 21).
 *
 * The device stays authoritative. Every action is written to IndexedDB first;
 * this module pushes what has already been saved to the hosted store afterwards,
 * and never the other way round. Nothing here can change the local event order —
 * it only reads `match.events` and advances a cursor.
 *
 * Sync is opt-in and off until the user turns it on and signs in, matching
 * section 17: device-local records are not exposed to a hosted API unless the
 * user explicitly enables an upload capability.
 *
 * No credential is stored on the device. Signing in exchanges the account
 * password for an HttpOnly session cookie the browser holds and no script —
 * including this one — can read.
 *
 * The push is an outbox, not a request/response: it is safe to call after every
 * save, safe to call while offline, and safe to replay. Events carry
 * client-generated UUIDs and the server ignores ones it already holds, so a
 * duplicate push costs a round trip and nothing else.
 */
import type { IdentityMapping, MatchRecord, PlayerProfile } from "./model.ts";
import type { CoachReportOptions } from "./report.ts";
import { loadSyncState, saveSyncState, type MatchSyncState } from "./storage.ts";

const SETTINGS_KEY = "baseline.sync.settings";

export interface SyncSettings {
  enabled: boolean;
  /** Empty means the same origin the app is served from. */
  endpoint: string;
  /**
   * Optional bearer token, for pointing the app at an endpoint on another
   * origin where a cookie would not be sent. Same-origin deployments — the
   * normal case — leave this empty and rely on the session cookie.
   */
  token: string;
}

export const DEFAULT_SYNC_SETTINGS: SyncSettings = { enabled: false, endpoint: "", token: "" };

export function loadSyncSettings(): SyncSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SYNC_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<SyncSettings>;
    return {
      enabled: Boolean(parsed.enabled),
      endpoint: (parsed.endpoint ?? "").replace(/\/$/, ""),
      token: parsed.token ?? "",
    };
  } catch {
    return DEFAULT_SYNC_SETTINGS;
  }
}

export function saveSyncSettings(settings: SyncSettings): SyncSettings {
  const cleaned: SyncSettings = {
    enabled: settings.enabled,
    endpoint: settings.endpoint.trim().replace(/\/$/, ""),
    token: settings.token.trim(),
  };
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(cleaned));
  } catch {
    /* Private-mode storage failures leave sync off rather than breaking tracking. */
  }
  return cleaned;
}

/**
 * Where sync cursors live. IndexedDB in the app; injectable so the cursor
 * arithmetic can be tested without a browser database.
 */
export interface SyncCursorStore {
  load(matchId: string): Promise<MatchSyncState | undefined>;
  save(state: MatchSyncState): Promise<void>;
}

export const indexedDbCursors: SyncCursorStore = { load: loadSyncState, save: saveSyncState };

export type SyncOutcome = "disabled" | "offline" | "up-to-date" | "pushed" | "failed";

export interface SyncReport {
  matchId: string;
  outcome: SyncOutcome;
  pushed: number;
  pending: number;
  error?: string;
  state?: MatchSyncState;
}

/** Events saved locally but not yet acknowledged by the hosted store. */
export function pendingEventCount(match: MatchRecord, state?: MatchSyncState): number {
  return Math.max(0, match.events.length - (state?.syncedCount ?? 0));
}

/**
 * `credentials: "include"` so the session cookie travels even when the endpoint
 * is configured as an absolute same-origin URL. The bearer header is added only
 * when a token was explicitly configured for a cross-origin endpoint.
 */
function authHeaders(settings: SyncSettings, extra: Record<string, string> = {}): Record<string, string> {
  return settings.token ? { ...extra, authorization: `Bearer ${settings.token}` } : extra;
}

export interface SessionStatus {
  configured: boolean;
  authenticated: boolean;
}

/** Whether this deployment has a password set, and whether this browser is signed in. */
export async function sessionStatus(settings: SyncSettings = loadSyncSettings()): Promise<SessionStatus> {
  try {
    const response = await fetch(`${settings.endpoint}/api/v1/session`, { credentials: "include" });
    if (!response.ok) return { configured: false, authenticated: false };
    return (await response.json()) as SessionStatus;
  } catch {
    return { configured: false, authenticated: false };
  }
}

export async function signIn(password: string, settings: SyncSettings = loadSyncSettings()): Promise<void> {
  const response = await fetch(`${settings.endpoint}/api/v1/session`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (response.ok) return;
  const detail = await response.json().catch(() => ({})) as { error?: string };
  throw new Error(detail.error ?? "Could not sign in.");
}

export async function signOut(settings: SyncSettings = loadSyncSettings()): Promise<void> {
  await fetch(`${settings.endpoint}/api/v1/session`, { method: "DELETE", credentials: "include" }).catch(() => undefined);
}

function profilesForMatch(match: MatchRecord, players: PlayerProfile[]) {
  const ids = new Set([match.config.myPlayerId, match.config.opponentId].filter(Boolean));
  return players
    .filter((player) => ids.has(player.id))
    .map((player) => ({
      id: player.id,
      displayName: player.displayName,
      role: player.role,
      aliases: player.aliases,
      createdAt: player.createdAt,
      updatedAt: player.updatedAt,
      previousVersionId: player.previousVersionId,
      handedness: player.handedness,
      ustaId: player.ustaId,
      ustaUrl: player.ustaUrl,
      notes: player.notes,
    }));
}

function mappingsForPlayers(mappings: IdentityMapping[], playerIds: Set<string>) {
  return mappings.filter((mapping) => playerIds.has(mapping.fromPlayerId) || playerIds.has(mapping.toPlayerId));
}

export async function pushMatch(
  match: MatchRecord,
  players: PlayerProfile[] = [],
  mappings: IdentityMapping[] = [],
  settings: SyncSettings = loadSyncSettings(),
  cursors: SyncCursorStore = indexedDbCursors,
): Promise<SyncReport> {
  if (!settings.enabled) {
    return { matchId: match.id, outcome: "disabled", pushed: 0, pending: 0 };
  }
  const state = await cursors.load(match.id);
  const cursor = state?.syncedCount ?? 0;
  const pendingEvents = match.events.slice(cursor);
  if (!pendingEvents.length && cursor === match.events.length && state?.lastSyncedAt) {
    return { matchId: match.id, outcome: "up-to-date", pushed: 0, pending: 0, state };
  }
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    return { matchId: match.id, outcome: "offline", pushed: 0, pending: pendingEvents.length, state };
  }

  const profiles = profilesForMatch(match, players);
  const body = {
    match: {
      id: match.id,
      createdAt: match.createdAt,
      updatedAt: match.updatedAt,
      config: match.config,
      authorized: match.authorized !== false,
    },
    events: pendingEvents,
    players: profiles,
    identityMappings: mappingsForPlayers(mappings, new Set(profiles.map((player) => player.id))),
  };

  try {
    const response = await fetch(`${settings.endpoint}/api/v1/sync`, {
      method: "POST",
      credentials: "include",
      headers: authHeaders(settings, { "content-type": "application/json" }),
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const error = response.status === 401
        ? "Signed out. Sign in again to resume syncing."
        : response.status === 503
          ? "Cloud sync is not enabled on the server."
          : `The server returned ${response.status}.`;
      const failed: MatchSyncState = { matchId: match.id, syncedCount: cursor, lastSyncedAt: state?.lastSyncedAt, lastError: error };
      await cursors.save(failed);
      return { matchId: match.id, outcome: "failed", pushed: 0, pending: pendingEvents.length, error, state: failed };
    }
    // The cursor advances to the length that was pushed, not the current length:
    // a point saved while this request was in flight stays pending for the next push.
    const next: MatchSyncState = {
      matchId: match.id,
      syncedCount: cursor + pendingEvents.length,
      lastSyncedAt: new Date().toISOString(),
    };
    await cursors.save(next);
    return { matchId: match.id, outcome: "pushed", pushed: pendingEvents.length, pending: 0, state: next };
  } catch {
    // A dropped connection is the expected case courtside, not an error worth
    // surfacing on the tracking screen. The events stay queued.
    const error = "No connection to the sync endpoint.";
    return { matchId: match.id, outcome: "failed", pushed: 0, pending: pendingEvents.length, error };
  }
}

/**
 * Pushes every match with queued events, oldest first.
 *
 * Serial rather than parallel: the server assigns arrival order per match, and a
 * courtside phone on a weak connection does better with one request at a time.
 */
export async function flushOutbox(
  matches: MatchRecord[],
  players: PlayerProfile[] = [],
  mappings: IdentityMapping[] = [],
  settings: SyncSettings = loadSyncSettings(),
  cursors: SyncCursorStore = indexedDbCursors,
): Promise<SyncReport[]> {
  if (!settings.enabled) return [];
  const reports: SyncReport[] = [];
  const ordered = [...matches].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  for (const match of ordered) {
    const report = await pushMatch(match, players, mappings, settings, cursors);
    reports.push(report);
    if (report.outcome === "offline") break;
  }
  return reports;
}

export interface ShareLinkRequest {
  kind?: "live" | "report";
  expiresInHours?: number;
  includeMentalStates?: boolean;
  includeTimeline?: boolean;
  opponentDisplay?: "full" | "initials" | "hidden";
  /** Report links only. The link's own privacy flags still overrule these. */
  reportOptions?: Partial<CoachReportOptions>;
  label?: string;
}

export interface ShareLinkResponse {
  id: string;
  token: string;
  url: string;
  kind: string;
  expiresAt: string | null;
  opponentDisplay: string;
  includeMentalStates: boolean;
  includeTimeline: boolean;
}

export async function createShareLink(
  matchId: string,
  request: ShareLinkRequest,
  settings: SyncSettings = loadSyncSettings(),
): Promise<ShareLinkResponse> {
  const response = await fetch(`${settings.endpoint}/api/v1/matches/${matchId}/share`, {
    method: "POST",
    credentials: "include",
    headers: authHeaders(settings, { "content-type": "application/json" }),
    body: JSON.stringify(request),
  });
  if (!response.ok) throw new Error(`Could not create the link (${response.status}).`);
  return (await response.json()) as ShareLinkResponse;
}

export interface ShareLink {
  id: string;
  kind: string;
  active: boolean;
  expiresAt: string | null;
  opponentDisplay: string;
  createdAt: string;
}

export async function listShareLinks(matchId: string, settings: SyncSettings = loadSyncSettings()): Promise<ShareLink[]> {
  const response = await fetch(`${settings.endpoint}/api/v1/matches/${matchId}/share`, {
    credentials: "include",
    headers: authHeaders(settings),
  });
  if (!response.ok) throw new Error(`Could not list links (${response.status}).`);
  const body = (await response.json()) as { links: ShareLink[] };
  return body.links;
}

export async function revokeShareLink(id: string, settings: SyncSettings = loadSyncSettings()): Promise<void> {
  const response = await fetch(`${settings.endpoint}/api/v1/share/${id}`, {
    method: "DELETE",
    credentials: "include",
    headers: authHeaders(settings),
  });
  if (!response.ok) throw new Error(`Could not revoke the link (${response.status}).`);
}
