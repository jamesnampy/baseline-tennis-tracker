/**
 * Cloudflare D1 schema for the hosted event store.
 *
 * The device remains authoritative during a match (requirements section 16):
 * every action is written to IndexedDB first and pushed here afterwards. D1 is
 * a durable mirror plus the backing store for the read-only API contract in
 * section 17 and for live spectator links.
 *
 * Events are immutable and identified by their client-generated UUID, so an
 * append is idempotent: replaying an outbox after a dropped connection inserts
 * nothing new. `serverSeq` is assigned on arrival and is the cursor spectators
 * and incremental readers page by; the client's own `sequence` is preserved
 * untouched because background synchronization must never reorder the local log.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const matches = sqliteTable("matches", {
  id: text("id").primaryKey(),
  schemaVersion: integer("schema_version").notNull().default(1),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  /** MatchConfig as stored on the device, verbatim. */
  config: text("config").notNull(),
  myPlayerId: text("my_player_id"),
  opponentId: text("opponent_id"),
  tournamentKey: text("tournament_key"),
  /** Section 17: profile data is private by default and never auto-published. */
  authorized: integer("authorized").notNull().default(1),
  syncedAt: text("synced_at").notNull().default(sql`(current_timestamp)`),
}, (table) => [
  index("matches_updated_at_idx").on(table.updatedAt),
  index("matches_tournament_idx").on(table.tournamentKey),
]);

export const matchEvents = sqliteTable("match_events", {
  /** Client-generated UUID. Doubles as the idempotency key for re-pushed events. */
  id: text("id").primaryKey(),
  matchId: text("match_id").notNull(),
  /** Server arrival order. Monotonic per match; the spectator and sync cursor. */
  serverSeq: integer("server_seq").notNull(),
  /** The device's own monotonic sequence, preserved exactly as recorded. */
  sequence: integer("sequence").notNull(),
  type: text("type").notNull(),
  timestamp: text("timestamp").notNull(),
  source: text("source").notNull(),
  pointGroupId: text("point_group_id"),
  correctsEventId: text("corrects_event_id"),
  payload: text("payload").notNull(),
  receivedAt: text("received_at").notNull().default(sql`(current_timestamp)`),
}, (table) => [
  uniqueIndex("match_events_seq_idx").on(table.matchId, table.serverSeq),
  index("match_events_match_idx").on(table.matchId, table.sequence),
  index("match_events_group_idx").on(table.matchId, table.pointGroupId),
]);

export const players = sqliteTable("players", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  role: text("role").notNull(),
  aliases: text("aliases").notNull().default("[]"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  previousVersionId: text("previous_version_id"),
  handedness: text("handedness"),
  ustaId: text("usta_id"),
  ustaUrl: text("usta_url"),
  notes: text("notes"),
});

export const identityMappings = sqliteTable("identity_mappings", {
  id: text("id").primaryKey(),
  fromPlayerId: text("from_player_id").notNull(),
  toPlayerId: text("to_player_id").notNull(),
  kind: text("kind").notNull(),
  createdAt: text("created_at").notNull(),
});

/**
 * Revocable, expiring, unguessable read-only links (requirements sections 18
 * and 19). `tokenHash` is stored rather than the token so a database dump does
 * not hand out working links. Privacy choices are stored with the link and
 * enforced server-side, not by the page that renders it.
 */
export const shareLinks = sqliteTable("share_links", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull(),
  matchId: text("match_id").notNull(),
  kind: text("kind").notNull(),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at"),
  revokedAt: text("revoked_at"),
  /** Mental-state observations about a minor are excluded unless explicitly included. */
  includeMentalStates: integer("include_mental_states").notNull().default(0),
  /** `full`, `initials`, or `hidden`. */
  opponentDisplay: text("opponent_display").notNull().default("initials"),
  includeTimeline: integer("include_timeline").notNull().default(1),
  /** Serialized CoachReportOptions for `report` links. Null for live links. */
  reportOptions: text("report_options"),
  label: text("label"),
}, (table) => [
  uniqueIndex("share_links_token_idx").on(table.tokenHash),
  index("share_links_match_idx").on(table.matchId),
]);
