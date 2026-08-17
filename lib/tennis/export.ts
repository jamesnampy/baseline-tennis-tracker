import type { MatchEvent, MatchRecord } from "./model.ts";
import { activePointEvents, pointDetailsMap, voidedPointIds } from "./scoring.ts";

function csvEscape(value: unknown): string {
  const text = value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function csv(headers: string[], rows: unknown[][]): string {
  return [headers.map(csvEscape).join(","), ...rows.map((row) => row.map(csvEscape).join(","))].join("\n");
}

export function buildExportBundle(match: MatchRecord) {
  const points = activePointEvents(match.events);
  const details = pointDetailsMap(match.events);
  const voided = voidedPointIds(match.events);
  const mental = match.events.filter((event) => event.type === "mental_state_changed");
  const syncs = match.events.filter((event) => event.type === "score_synced");

  const files: Record<string, string> = {
    "matches.csv": csv(
      ["match_id", "created_at", "updated_at", "my_player", "opponent", "format", "ad_scoring", "tournament_url"],
      [[match.id, match.createdAt, match.updatedAt, match.config.myPlayerName, match.config.opponentName, match.config.format, match.config.adScoring, match.config.tournamentUrl]],
    ),
    "points.csv": csv(
      ["point_id", "sequence", "timestamp", "server", "winner", "serve_result", "score_before", "score_after", "outcome", "rally_range"],
      points.map((point) => [point.pointGroupId, point.sequence, point.timestamp, point.payload.server, point.payload.winner, point.payload.serveResult, point.payload.scoreBefore, point.payload.scoreAfter, details.get(point.pointGroupId)?.outcome, details.get(point.pointGroupId)?.rallyRange]),
    ),
    "serves.csv": csv(
      ["event_id", "point_id", "sequence", "server", "attempt", "result", "voided"],
      match.events.filter((event) => event.type === "serve_attempted").map((event) => [event.id, event.pointGroupId, event.sequence, event.payload.server, event.payload.attempt, event.payload.result, voided.has(event.pointGroupId)]),
    ),
    "shots.csv": csv(
      ["point_id", "outcome", "responsible_player", "final_stroke_player", "final_stroke", "shot_type", "advanced_shot_type"],
      points.map((point) => {
        const detail = details.get(point.pointGroupId);
        return [point.pointGroupId, detail?.outcome, detail?.responsiblePlayer, detail?.finalStrokePlayer, detail?.finalStroke, detail?.shotType, detail?.advancedShotType];
      }),
    ),
    "mental_states.csv": csv(
      ["event_id", "sequence", "timestamp", "player", "state", "previous_state", "capture_moment", "point_id", "note"],
      mental.map((event) => [event.id, event.sequence, event.timestamp, event.payload.player, event.payload.state, event.payload.previousState, event.payload.captureMoment, event.payload.linkedPointGroupId, event.payload.note]),
    ),
    "score_syncs.csv": csv(
      ["event_id", "sequence", "timestamp", "previous_score", "corrected_score", "reason", "valid"],
      syncs.map((event) => [event.id, event.sequence, event.timestamp, event.payload.previous, event.payload.corrected, event.payload.reason, event.payload.valid]),
    ),
    "events.json": JSON.stringify(match.events, null, 2),
    "schema.json": JSON.stringify({ name: "Baseline tennis event bundle", schemaVersion: 1, generatedAt: new Date().toISOString(), files: ["matches.csv", "points.csv", "serves.csv", "shots.csv", "mental_states.csv", "score_syncs.csv", "events.json"] }, null, 2),
  };
  return { schemaVersion: 1, matchId: match.id, generatedAt: new Date().toISOString(), files };
}

export function downloadExport(match: MatchRecord) {
  const bundle = buildExportBundle(match);
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `baseline-${match.config.myPlayerName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${match.createdAt.slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
}

export function eventLabel(event: MatchEvent): string {
  return event.type.replaceAll("_", " ");
}
