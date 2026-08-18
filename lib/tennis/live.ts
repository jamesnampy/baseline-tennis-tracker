/**
 * Pure helpers for the read-only spectator view.
 *
 * They live outside the component so they can be tested directly, and because
 * neither is a rendering concern: one decides whether a URL is a share link at
 * all, the other keeps a spectator's event list correct across reconnects.
 */
import type { MatchEvent } from "./model.ts";

/**
 * Extracts a share token from `/live/<token>`, or null for any other path.
 *
 * The pattern is deliberately strict. Tokens are base64url, so anything else is
 * a normal application route and must fall through to the tracker rather than
 * being sent to the server as a credential.
 */
export function shareTokenFromPath(pathname: string): string | null {
  const match = /^\/live\/([A-Za-z0-9_-]{16,})\/?$/.exec(pathname);
  return match ? match[1]! : null;
}

/**
 * Merges incoming events by id.
 *
 * A spectator can receive the same event twice: the socket reconnects, or the
 * polling fallback overlaps a live frame. Event ids are stable and
 * client-generated, so deduplicating by id makes replay harmless and keeps the
 * projection correct without tracking which delivery path produced what.
 */
export function mergeEvents(existing: MatchEvent[], incoming: MatchEvent[]): MatchEvent[] {
  if (!incoming.length) return existing;
  const known = new Set(existing.map((event) => event.id));
  const fresh = incoming.filter((event) => !known.has(event.id));
  return fresh.length ? [...existing, ...fresh] : existing;
}
