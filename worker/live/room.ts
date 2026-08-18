/**
 * One Durable Object per match.
 *
 * It does two things: it serializes appends for its match, and it fans new
 * events out to whoever is watching. D1 remains the single store — the room
 * writes through to it rather than keeping a second copy — so a spectator, the
 * analysis API, and the device all read the same rows.
 *
 * Serializing appends here removes the server-sequence race that `appendEvents`
 * otherwise has to retry: every write for a match arrives at exactly one object.
 *
 * Each socket carries its own share link's privacy settings, so redaction is per
 * connection. Two spectators watching the same match through links with
 * different settings see different things, and neither can widen what they get
 * by anything they send.
 */
import type { MatchEvent } from "@/lib/tennis/model.ts";
import { redactEvents, type ShareLinkRow } from "../api/share.ts";
import { appendEvents, latestServerSeq, type AppendResult } from "../api/store.ts";

export interface RoomEnv {
  DB: D1Database;
}

/** What each socket is allowed to see. Stored on the connection, never sent by it. */
interface Viewer {
  linkId: string;
  includeMentalStates: number;
  includeTimeline: number;
  opponentDisplay: string;
}

const viewerLink = (viewer: Viewer): ShareLinkRow => ({
  id: viewer.linkId,
  token_hash: "",
  match_id: "",
  kind: "live",
  created_at: "",
  expires_at: null,
  revoked_at: null,
  include_mental_states: viewer.includeMentalStates,
  opponent_display: viewer.opponentDisplay,
  include_timeline: viewer.includeTimeline,
  label: null,
});

export class MatchRoom implements DurableObject {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: RoomEnv,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/socket") {
      if (request.headers.get("upgrade") !== "websocket") {
        return new Response("Expected a WebSocket upgrade.", { status: 426 });
      }
      const pair = new WebSocketPair();
      const viewer: Viewer = {
        linkId: url.searchParams.get("linkId") ?? "",
        includeMentalStates: url.searchParams.get("mental") === "1" ? 1 : 0,
        includeTimeline: url.searchParams.get("timeline") === "1" ? 1 : 0,
        opponentDisplay: url.searchParams.get("opponent") ?? "initials",
      };
      // Hibernation: the room can be evicted between points and the socket
      // survives, so a long match costs nothing while nobody is scoring.
      this.state.acceptWebSocket(pair[1]);
      pair[1].serializeAttachment(viewer);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    if (url.pathname === "/append" && request.method === "POST") {
      const body = (await request.json()) as { matchId: string; events: MatchEvent[] };
      const result = await appendEvents(this.env.DB, body.matchId, body.events);
      if (result.accepted > 0) this.broadcast(body.events, result.latestServerSeq);
      return Response.json(result satisfies AppendResult);
    }

    if (url.pathname === "/cursor") {
      const matchId = url.searchParams.get("matchId") ?? "";
      return Response.json({ latestServerSeq: await latestServerSeq(this.env.DB, matchId) });
    }

    return new Response("Not found.", { status: 404 });
  }

  private broadcast(events: MatchEvent[], latestServerSeq: number): void {
    for (const socket of this.state.getWebSockets()) {
      const viewer = socket.deserializeAttachment() as Viewer | null;
      if (!viewer) continue;
      const visible = redactEvents(events, viewerLink(viewer));
      if (!visible.length) continue;
      try {
        socket.send(JSON.stringify({ type: "events", events: visible, latestServerSeq }));
      } catch {
        // A socket that has gone away is closed on the next hibernation callback.
      }
    }
  }

  /** Spectators are read-only. The only message accepted is a liveness ping. */
  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message === "string" && message === "ping") socket.send(JSON.stringify({ type: "pong" }));
  }

  webSocketClose(socket: WebSocket, code: number, reason: string): void {
    // 1005 means "no status received" and must not be echoed back.
    socket.close(code === 1005 ? 1000 : code, reason);
  }
}
