import type { IdentityMapping, MatchRecord, PlayerProfile, PlayerRole } from "./model.ts";
import { activePointEvents } from "./scoring.ts";
import { buildStats } from "./analytics.ts";

const id = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;
export function createPlayerProfile(displayName: string, role: PlayerRole, previousVersionId?: string): PlayerProfile {
  const now = new Date().toISOString();
  return { id: id("player"), displayName: displayName.trim(), role, aliases: [], createdAt: now, updatedAt: now, previousVersionId };
}
export function versionPlayerProfile(profile: PlayerProfile, displayName: string) {
  const player = createPlayerProfile(displayName, profile.role, profile.id);
  const mapping: IdentityMapping = { id: id("identity"), fromPlayerId: profile.id, toPlayerId: player.id, kind: "profile_version", createdAt: player.createdAt };
  return { player, mapping };
}
export function linkPlayerIdentity(fromPlayerId: string, toPlayerId: string, kind: IdentityMapping["kind"] = "guest_link"): IdentityMapping {
  if (fromPlayerId === toPlayerId) throw new Error("Choose two different profiles.");
  return { id: id("identity"), fromPlayerId, toPlayerId, kind, createdAt: new Date().toISOString() };
}
export function playerProfileAnalytics(profileId: string, matches: MatchRecord[]) {
  const authorized = matches.filter((m) => m.authorized !== false && [m.config.myPlayerId, m.config.opponentId].includes(profileId));
  let trackedPoints = 0, pointsWon = 0, serviceWon = 0, servicePlayed = 0, returnWon = 0, returnPlayed = 0;
  for (const match of authorized) {
    const key = match.config.myPlayerId === profileId ? "my" : "opponent";
    const stats = buildStats(match.events, match.config)[key];
    trackedPoints += activePointEvents(match.events).length; pointsWon += stats.pointsWon;
    serviceWon += stats.servicePointsWon; servicePlayed += stats.servicePoints;
    returnWon += stats.returnPointsWon; returnPlayed += buildStats(match.events, match.config)[key === "my" ? "opponent" : "my"].servicePoints;
  }
  return { matchCount: authorized.length, trackedPoints, pointsWon, serviceWon, servicePlayed, returnWon, returnPlayed, coverage: authorized.length ? Math.round(authorized.reduce((n, m) => n + buildStats(m.events, m.config).coverage, 0) / authorized.length) : 100 };
}
