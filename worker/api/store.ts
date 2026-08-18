/**
 * D1 access for the hosted event store.
 *
 * Queries use D1's prepared-statement API directly. `db/schema.ts` remains the
 * schema authority — it generates the migrations in `drizzle/` — but the Worker
 * does not carry an ORM at runtime.
 */
import type { MatchConfig, MatchEvent, MatchRecord } from "@/lib/tennis/model.ts";
import type { ShareLinkRow } from "./share.ts";

export type { ShareLinkRow };

export interface MatchRow {
  id: string;
  schema_version: number;
  created_at: string;
  updated_at: string;
  config: string;
  my_player_id: string | null;
  opponent_id: string | null;
  tournament_key: string | null;
  authorized: number;
  synced_at: string;
}

export interface EventRow {
  id: string;
  match_id: string;
  server_seq: number;
  sequence: number;
  type: string;
  timestamp: string;
  source: string;
  point_group_id: string | null;
  corrects_event_id: string | null;
  payload: string;
  received_at: string;
}

export interface PlayerRow {
  id: string;
  display_name: string;
  role: string;
  aliases: string;
  created_at: string;
  updated_at: string;
  previous_version_id: string | null;
  handedness: string | null;
  usta_id: string | null;
  usta_url: string | null;
  notes: string | null;
}

/** Tournament grouping key (requirements section 4): normalized URL, else name. */
export function tournamentKey(config: MatchConfig): string | null {
  const raw = config.tournamentUrl?.trim() || config.tournamentName?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return (url.host + url.pathname).replace(/\/$/, "").toLowerCase();
  } catch {
    return raw.toLowerCase().replace(/\s+/g, " ");
  }
}

export function eventFromRow(row: EventRow): MatchEvent {
  const event: Record<string, unknown> = {
    id: row.id,
    matchId: row.match_id,
    schemaVersion: 1,
    sequence: row.sequence,
    type: row.type,
    timestamp: row.timestamp,
    source: row.source,
    payload: JSON.parse(row.payload) as unknown,
  };
  if (row.point_group_id) event.pointGroupId = row.point_group_id;
  if (row.corrects_event_id) event.correctsEventId = row.corrects_event_id;
  return event as unknown as MatchEvent;
}

export function matchFromRows(match: MatchRow, events: EventRow[]): MatchRecord {
  return {
    id: match.id,
    schemaVersion: 1,
    createdAt: match.created_at,
    updatedAt: match.updated_at,
    config: JSON.parse(match.config) as MatchConfig,
    authorized: match.authorized === 1,
    events: events.map(eventFromRow),
  };
}

export async function upsertMatch(db: D1Database, record: {
  id: string;
  createdAt: string;
  updatedAt: string;
  config: MatchConfig;
  authorized?: boolean;
}): Promise<void> {
  await db
    .prepare(
      "INSERT INTO matches (id, schema_version, created_at, updated_at, config, my_player_id, opponent_id, tournament_key, authorized, synced_at)" +
      " VALUES (?1, 1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)" +
      " ON CONFLICT(id) DO UPDATE SET" +
      "   updated_at = excluded.updated_at," +
      "   config = excluded.config," +
      "   my_player_id = excluded.my_player_id," +
      "   opponent_id = excluded.opponent_id," +
      "   tournament_key = excluded.tournament_key," +
      "   authorized = excluded.authorized," +
      "   synced_at = excluded.synced_at" +
      " WHERE excluded.updated_at >= matches.updated_at",
    )
    .bind(
      record.id,
      record.createdAt,
      record.updatedAt,
      JSON.stringify(record.config),
      record.config.myPlayerId ?? null,
      record.config.opponentId ?? null,
      tournamentKey(record.config),
      record.authorized === false ? 0 : 1,
      new Date().toISOString(),
    )
    .run();
}

export interface AppendResult {
  accepted: number;
  duplicates: number;
  latestServerSeq: number;
}

/**
 * Appends events idempotently and returns the new server cursor.
 *
 * Event ids are client-generated UUIDs, so re-pushing an outbox after a dropped
 * connection inserts nothing. Server sequence numbers are assigned on arrival
 * and are unique per match; a concurrent append loses the unique-index race and
 * is retried once. With the per-match Durable Object in front of this call the
 * race cannot happen at all.
 */
export async function appendEvents(db: D1Database, matchId: string, events: MatchEvent[]): Promise<AppendResult> {
  if (!events.length) {
    return { accepted: 0, duplicates: 0, latestServerSeq: await latestServerSeq(db, matchId) };
  }

  // Scoped to the ids being pushed rather than the whole match: this runs after
  // every point, and a three-hour match holds well over a thousand events.
  const placeholders = events.map((_, index) => "?" + (index + 2)).join(", ");
  const existing = await db
    .prepare("SELECT id FROM match_events WHERE match_id = ?1 AND id IN (" + placeholders + ")")
    .bind(matchId, ...events.map((event) => event.id))
    .all<{ id: string }>();
  const known = new Set(existing.results.map((row) => row.id));
  const fresh = events.filter((event) => !known.has(event.id));
  const duplicates = events.length - fresh.length;
  if (!fresh.length) {
    return { accepted: 0, duplicates, latestServerSeq: await latestServerSeq(db, matchId) };
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const base = await latestServerSeq(db, matchId);
    const statements = fresh.map((event, index) =>
      db
        .prepare(
          "INSERT OR IGNORE INTO match_events" +
          " (id, match_id, server_seq, sequence, type, timestamp, source, point_group_id, corrects_event_id, payload, received_at)" +
          " VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        )
        .bind(
          event.id,
          matchId,
          base + index + 1,
          event.sequence,
          event.type,
          event.timestamp,
          event.source,
          "pointGroupId" in event ? event.pointGroupId ?? null : null,
          event.correctsEventId ?? null,
          JSON.stringify(event.payload),
          new Date().toISOString(),
        ),
    );
    try {
      await db.batch(statements);
      return { accepted: fresh.length, duplicates, latestServerSeq: base + fresh.length };
    } catch (error) {
      if (attempt === 1) throw error;
    }
  }
  return { accepted: 0, duplicates, latestServerSeq: await latestServerSeq(db, matchId) };
}

export async function latestServerSeq(db: D1Database, matchId: string): Promise<number> {
  const row = await db
    .prepare("SELECT COALESCE(MAX(server_seq), 0) AS seq FROM match_events WHERE match_id = ?1")
    .bind(matchId)
    .first<{ seq: number }>();
  return row?.seq ?? 0;
}

export async function getMatchRow(db: D1Database, matchId: string): Promise<MatchRow | null> {
  return await db.prepare("SELECT * FROM matches WHERE id = ?1").bind(matchId).first<MatchRow>();
}

export async function listEventRows(
  db: D1Database,
  matchId: string,
  { sinceSeq = 0, limit = 5000 }: { sinceSeq?: number; limit?: number } = {},
): Promise<EventRow[]> {
  const rows = await db
    .prepare("SELECT * FROM match_events WHERE match_id = ?1 AND server_seq > ?2 ORDER BY server_seq ASC LIMIT ?3")
    .bind(matchId, sinceSeq, limit)
    .all<EventRow>();
  return rows.results;
}

export async function listMatchRows(
  db: D1Database,
  { limit = 50, updatedSince, tournament }: { limit?: number; updatedSince?: string; tournament?: string } = {},
): Promise<MatchRow[]> {
  const clauses = ["authorized = 1"];
  const bindings: unknown[] = [];
  if (updatedSince) {
    bindings.push(updatedSince);
    clauses.push("updated_at > ?" + bindings.length);
  }
  if (tournament) {
    bindings.push(tournament);
    clauses.push("tournament_key = ?" + bindings.length);
  }
  bindings.push(limit);
  const rows = await db
    .prepare("SELECT * FROM matches WHERE " + clauses.join(" AND ") + " ORDER BY updated_at DESC LIMIT ?" + bindings.length)
    .bind(...bindings)
    .all<MatchRow>();
  return rows.results;
}

export async function loadMatch(db: D1Database, matchId: string): Promise<MatchRecord | null> {
  const row = await getMatchRow(db, matchId);
  if (!row) return null;
  return matchFromRows(row, await listEventRows(db, matchId));
}

export async function upsertPlayers(db: D1Database, players: {
  id: string;
  displayName: string;
  role: string;
  aliases?: string[];
  createdAt: string;
  updatedAt: string;
  previousVersionId?: string;
  handedness?: string;
  ustaId?: string;
  ustaUrl?: string;
  notes?: string;
}[]): Promise<number> {
  if (!players.length) return 0;
  await db.batch(players.map((player) =>
    db
      .prepare(
        "INSERT INTO players (id, display_name, role, aliases, created_at, updated_at, previous_version_id, handedness, usta_id, usta_url, notes)" +
        " VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)" +
        " ON CONFLICT(id) DO UPDATE SET" +
        "   display_name = excluded.display_name, role = excluded.role, aliases = excluded.aliases," +
        "   updated_at = excluded.updated_at, previous_version_id = excluded.previous_version_id," +
        "   handedness = excluded.handedness, usta_id = excluded.usta_id, usta_url = excluded.usta_url, notes = excluded.notes",
      )
      .bind(
        player.id,
        player.displayName,
        player.role,
        JSON.stringify(player.aliases ?? []),
        player.createdAt,
        player.updatedAt,
        player.previousVersionId ?? null,
        player.handedness ?? null,
        player.ustaId ?? null,
        player.ustaUrl ?? null,
        player.notes ?? null,
      ),
  ));
  return players.length;
}

export async function upsertIdentityMappings(db: D1Database, mappings: {
  id: string;
  fromPlayerId: string;
  toPlayerId: string;
  kind: string;
  createdAt: string;
}[]): Promise<number> {
  if (!mappings.length) return 0;
  await db.batch(mappings.map((mapping) =>
    db
      .prepare("INSERT OR IGNORE INTO identity_mappings (id, from_player_id, to_player_id, kind, created_at) VALUES (?1, ?2, ?3, ?4, ?5)")
      .bind(mapping.id, mapping.fromPlayerId, mapping.toPlayerId, mapping.kind, mapping.createdAt),
  ));
  return mappings.length;
}

export async function listPlayerRows(db: D1Database): Promise<PlayerRow[]> {
  const rows = await db.prepare("SELECT * FROM players ORDER BY display_name ASC").all<PlayerRow>();
  return rows.results;
}

export async function listIdentityMappingRows(db: D1Database) {
  const rows = await db.prepare("SELECT * FROM identity_mappings").all<{
    id: string;
    from_player_id: string;
    to_player_id: string;
    kind: string;
    created_at: string;
  }>();
  return rows.results;
}

export async function insertShareLink(db: D1Database, link: ShareLinkRow): Promise<void> {
  await db
    .prepare(
      "INSERT INTO share_links (id, token_hash, match_id, kind, created_at, expires_at, revoked_at, include_mental_states, opponent_display, include_timeline, label)" +
      " VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?8, ?9, ?10)",
    )
    .bind(
      link.id,
      link.token_hash,
      link.match_id,
      link.kind,
      link.created_at,
      link.expires_at,
      link.include_mental_states,
      link.opponent_display,
      link.include_timeline,
      link.label,
    )
    .run();
}

export async function findShareLinkByHash(db: D1Database, tokenHash: string): Promise<ShareLinkRow | null> {
  return await db.prepare("SELECT * FROM share_links WHERE token_hash = ?1").bind(tokenHash).first<ShareLinkRow>();
}

export async function listShareLinks(db: D1Database, matchId: string): Promise<ShareLinkRow[]> {
  const rows = await db
    .prepare("SELECT * FROM share_links WHERE match_id = ?1 ORDER BY created_at DESC")
    .bind(matchId)
    .all<ShareLinkRow>();
  return rows.results;
}

/** Revocation is a timestamp, never a delete: a revoked link stays auditable. */
export async function revokeShareLink(db: D1Database, id: string): Promise<boolean> {
  const result = await db
    .prepare("UPDATE share_links SET revoked_at = ?2 WHERE id = ?1 AND revoked_at IS NULL")
    .bind(id, new Date().toISOString())
    .run();
  return (result.meta.changes ?? 0) > 0;
}
