/**
 * Read-only share links (requirements sections 18 and 19).
 *
 * A link is an unguessable random token, revocable, optionally expiring, and
 * scoped to exactly one match. The token itself is never stored — only its
 * SHA-256 — so a database dump does not hand out working links.
 *
 * Redaction happens here, on the server, before anything leaves the Worker. The
 * spectator page cannot opt back in to data the link excludes, which is the
 * point: mental-state observations are subjective notes about a child and are
 * withheld unless the person who recorded them explicitly includes them.
 */
import type { MatchConfig, MatchEvent, MatchRecord } from "@/lib/tennis/model.ts";
/** Persisted share-link row. Defined here because redaction, not storage, owns its meaning. */
export interface ShareLinkRow {
  id: string;
  token_hash: string;
  match_id: string;
  kind: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  include_mental_states: number;
  opponent_display: string;
  include_timeline: number;
  label: string | null;
}

export type OpponentDisplay = "full" | "initials" | "hidden";

export interface ShareLinkOptions {
  kind: "live" | "report";
  expiresAt?: string;
  includeMentalStates?: boolean;
  includeTimeline?: boolean;
  opponentDisplay?: OpponentDisplay;
  label?: string;
}

export interface CreatedShareLink {
  id: string;
  token: string;
  matchId: string;
  kind: string;
  createdAt: string;
  expiresAt: string | null;
  includeMentalStates: boolean;
  includeTimeline: boolean;
  opponentDisplay: OpponentDisplay;
}

const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function newShareToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function hashShareToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function isLinkUsable(link: ShareLinkRow, now = new Date()): boolean {
  if (link.revoked_at) return false;
  if (link.expires_at && new Date(link.expires_at) <= now) return false;
  return true;
}

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "Opponent";
  return parts.map((part) => part[0]!.toUpperCase()).join(".") + ".";
}

export function displayedOpponentName(name: string, display: OpponentDisplay): string {
  if (display === "full") return name;
  if (display === "hidden") return "Opponent";
  return initialsOf(name);
}

/** Free-form fields never travel on a share link; they are private notes, not results. */
function redactConfig(config: MatchConfig, link: ShareLinkRow): MatchConfig {
  const display = link.opponent_display as OpponentDisplay;
  return {
    ...config,
    opponentName: displayedOpponentName(config.opponentName, display),
    opponentId: display === "full" ? config.opponentId : undefined,
    notes: undefined,
    startingMentalState: link.include_mental_states
      ? config.startingMentalState
      : { my: "not_observed", opponent: "not_observed" },
  };
}

/**
 * Types a spectator needs to rebuild the score and the score alone. Everything
 * the live view shows is projected from these by the same `lib/tennis/` code
 * the tracker uses, so no scoring logic is duplicated for spectators.
 */
const SCORE_EVENT_TYPES = new Set([
  "match_created",
  "match_started",
  "point_completed",
  "score_synced",
  "point_undone",
  "game_completed",
  "set_completed",
  "match_completed",
  "player_retired",
]);

const TIMELINE_EVENT_TYPES = new Set(["serve_attempted", "point_annotated"]);

export function redactEvents(events: MatchEvent[], link: ShareLinkRow): MatchEvent[] {
  const output: MatchEvent[] = [];
  for (const event of events) {
    if (event.type === "mental_state_changed") {
      if (!link.include_mental_states) continue;
      // Even when included, the free-form note stays behind.
      output.push({ ...event, payload: { ...event.payload, note: undefined } });
      continue;
    }
    // Strategy reviews quote the dataset back and are never part of a share link.
    if (event.type === "strategy_generated" || event.type === "strategy_requested") continue;
    if (event.type === "event_corrected") continue;
    if (TIMELINE_EVENT_TYPES.has(event.type)) {
      if (!link.include_timeline) continue;
      output.push(event);
      continue;
    }
    if (!SCORE_EVENT_TYPES.has(event.type)) continue;
    if (event.type === "match_created") {
      output.push({ ...event, payload: { config: redactConfig(event.payload.config, link) } });
      continue;
    }
    if (event.type === "point_completed") {
      const payload = { ...event.payload };
      if (!link.include_mental_states) {
        payload.mentalContext = { my: "not_observed", opponent: "not_observed" };
      }
      output.push({ ...event, payload });
      continue;
    }
    output.push(event);
  }
  return output;
}

export function redactMatch(match: MatchRecord, link: ShareLinkRow): MatchRecord {
  return {
    id: match.id,
    schemaVersion: 1,
    createdAt: match.createdAt,
    updatedAt: match.updatedAt,
    config: redactConfig(match.config, link),
    events: redactEvents(match.events, link),
  };
}

export function shareLinkSummary(link: ShareLinkRow) {
  return {
    id: link.id,
    matchId: link.match_id,
    kind: link.kind,
    createdAt: link.created_at,
    expiresAt: link.expires_at,
    revokedAt: link.revoked_at,
    active: isLinkUsable(link),
    includeMentalStates: link.include_mental_states === 1,
    includeTimeline: link.include_timeline === 1,
    opponentDisplay: link.opponent_display,
    label: link.label,
  };
}
