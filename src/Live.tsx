/**
 * Read-only spectator view for one share link (requirements sections 18/19,
 * and the "live sharing with another spectator" item promoted out of section 21).
 *
 * The link token in the URL is the only credential. Everything shown here has
 * already been redacted in the Worker, so this file makes no privacy decisions
 * of its own — it cannot show what the payload does not contain.
 *
 * The score, statistics, and timeline are projected with the same `lib/tennis/`
 * code the tracker uses. There is no second scoring engine to keep in step.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildStats, percentage } from "@/lib/tennis/analytics";
import { mergeEvents } from "@/lib/tennis/live";
import type { MatchConfig, MatchEvent, PlayerKey } from "@/lib/tennis/model";
import {
  activePointEvents, numberedPointEvents, pointGameNumber, pointScoreLabel, pointSetNumber,
  projectScore, scoreSummary,
} from "@/lib/tennis/scoring";

interface LinkSettings {
  kind: string;
  expiresAt: string | null;
  includeMentalStates: boolean;
  includeTimeline: boolean;
  opponentDisplay: string;
}

interface LiveSnapshot {
  link: LinkSettings;
  match: { id: string; config: MatchConfig; createdAt: string; updatedAt: string };
  events: MatchEvent[];
  latestServerSeq: number;
}

type Connection = "connecting" | "live" | "polling" | "closed";

export default function Live({ token }: { token: string }) {
  const [snapshot, setSnapshot] = useState<LiveSnapshot>();
  const [events, setEvents] = useState<MatchEvent[]>([]);
  const [cursor, setCursor] = useState(0);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [error, setError] = useState("");
  const cursorRef = useRef(0);
  useEffect(() => { cursorRef.current = cursor; }, [cursor]);

  const applyEvents = useCallback((incoming: MatchEvent[], latestServerSeq: number) => {
    setEvents((current) => mergeEvents(current, incoming));
    setCursor((current) => Math.max(current, latestServerSeq));
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/v1/live/${token}`)
      .then(async (response) => {
        if (!response.ok) throw new Error("This link is no longer available.");
        return (await response.json()) as LiveSnapshot;
      })
      .then((payload) => {
        if (cancelled) return;
        setSnapshot(payload);
        setEvents(payload.events);
        setCursor(payload.latestServerSeq);
      })
      .catch((failure: Error) => { if (!cancelled) { setError(failure.message); setConnection("closed"); } });
    return () => { cancelled = true; };
  }, [token]);

  // Live updates arrive over the match's Durable Object socket. Polling is the
  // fallback for a deployment without the binding, or a network that blocks
  // WebSockets — the spectator still keeps up, just a few seconds behind.
  useEffect(() => {
    if (!snapshot || error) return;
    let socket: WebSocket | undefined;
    let poll: number | undefined;
    let closed = false;

    const startPolling = () => {
      if (poll !== undefined || closed) return;
      setConnection("polling");
      poll = window.setInterval(async () => {
        try {
          const response = await fetch(`/api/v1/live/${token}/events?sinceSeq=${cursorRef.current}`);
          if (!response.ok) return;
          const payload = (await response.json()) as { events: MatchEvent[]; latestServerSeq: number };
          applyEvents(payload.events, payload.latestServerSeq);
        } catch { /* Keep polling; a spectator's connection is not the tracker's problem. */ }
      }, 5000);
    };

    try {
      const url = new URL(`/api/v1/live/${token}/socket`, window.location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(url);
      socket.onopen = () => setConnection("live");
      socket.onmessage = (message) => {
        const payload = JSON.parse(message.data as string) as { type: string; events?: MatchEvent[]; latestServerSeq?: number };
        if (payload.type === "events" && payload.events) applyEvents(payload.events, payload.latestServerSeq ?? cursorRef.current);
      };
      socket.onerror = () => startPolling();
      socket.onclose = () => { if (!closed) startPolling(); };
    } catch {
      startPolling();
    }

    return () => {
      closed = true;
      socket?.close();
      if (poll !== undefined) window.clearInterval(poll);
    };
  }, [snapshot, token, error, applyEvents]);

  const config = snapshot?.match.config;
  const score = useMemo(() => (config ? projectScore(events, config) : undefined), [events, config]);
  const stats = useMemo(() => (config ? buildStats(events, config) : undefined), [events, config]);
  const points = useMemo(() => numberedPointEvents(events), [events]);

  if (error) {
    return <main className="app-shell live-shell"><section className="live-empty"><span className="brand-mark">B</span><h1>Link unavailable</h1><p>{error} It may have expired or been revoked.</p></section></main>;
  }
  if (!snapshot || !config || !score || !stats) {
    return <main className="loading"><span className="brand-mark">B</span><p>Opening the match…</p></main>;
  }

  const names: Record<PlayerKey, string> = { my: config.myPlayerName, opponent: config.opponentName };
  const columns = `minmax(105px, 1fr) repeat(${score.sets.length}, 31px) 40px 52px`;
  const statusLabel = connection === "live" ? "Live" : connection === "polling" ? "Updating" : connection === "connecting" ? "Connecting" : "Disconnected";

  return <main className="app-shell live-shell">
    <header className="brand-header"><span className="brand-mark">B</span><div><strong>{names.my} vs. {names.opponent}</strong><small>{score.matchComplete ? "Final" : "Following live"} · read-only</small></div></header>

    <section className="scoreboard" aria-label="Live match score">
      <div className="set-head" style={{ gridTemplateColumns: columns }}><span>PLAYER</span>{score.sets.map((_, index) => <span key={index}>S{index + 1}</span>)}<span>G</span><span>PTS</span></div>
      {(["my", "opponent"] as PlayerKey[]).map((player) => { const index = player === "my" ? 0 : 1; return <div className={`score-row ${score.server === player ? "serving" : ""}`} style={{ gridTemplateColumns: columns }} key={player}><span className="score-name">{score.server === player && <i />} {names[player]}</span>{score.sets.map((set, setIndex) => <span key={setIndex}>{set.isMatchTiebreak ? set.tiebreak?.[index] : set.games[index]}{set.tiebreak && !set.isMatchTiebreak && <sup>{set.tiebreak[index]}</sup>}</span>)}<strong>{score.games[index]}</strong><b>{pointScoreLabel(score, player, config.adScoring)}</b></div>; })}
    </section>

    <div className="connection-strip"><span className={`live-status ${connection}`}>● {statusLabel}</span><span>{scoreSummary(score, config)}</span></div>

    <section className="full-view">
      <p className="eyebrow">BOTH PLAYERS</p>
      <h1>Match stats</h1>
      <div className="coverage-card"><span><strong>{stats.coverage}%</strong><small>tracking coverage</small></span><span><strong>{activePointEvents(events).length}</strong><small>points captured</small></span><span><strong>{score.sets.length + (score.matchComplete ? 0 : 1)}</strong><small>sets</small></span></div>
      <div className="stats-table">
        <div className="stats-head"><strong>{names.my}</strong><span>STAT</span><strong>{names.opponent}</strong></div>
        {([
          ["Total points won", stats.my.pointsWon, stats.opponent.pointsWon],
          ["Aces", stats.my.aces, stats.opponent.aces],
          ["Double faults", stats.my.doubleFaults, stats.opponent.doubleFaults],
          ["1st serve in", percentage(stats.my.firstServesIn, stats.my.servicePoints), percentage(stats.opponent.firstServesIn, stats.opponent.servicePoints)],
          ["Service points won", percentage(stats.my.servicePointsWon, stats.my.servicePoints), percentage(stats.opponent.servicePointsWon, stats.opponent.servicePoints)],
          ["Return points won", stats.my.returnPointsWon, stats.opponent.returnPointsWon],
          ["Break points", `${stats.my.breakPointsConverted}/${stats.my.breakPointsEarned}`, `${stats.opponent.breakPointsConverted}/${stats.opponent.breakPointsEarned}`],
          ["Longest streak", stats.my.longestStreak, stats.opponent.longestStreak],
        ] as [string, string | number, string | number][]).map(([label, left, right]) => <div className="stat-row" key={label}><b>{left}</b><span>{label}</span><b>{right}</b></div>)}
      </div>

      {snapshot.link.includeTimeline && <>
        <p className="eyebrow live-section-gap">EVERY SAVED POINT</p>
        <h1>Timeline</h1>
        {!points.length ? <div className="empty-card"><strong>No points yet</strong><p>Points appear here as they are recorded courtside.</p></div> : <div className="timeline">{[...points].reverse().map(({ point, pointNumber }) => <article key={point.id}><div className={`timeline-dot ${point.payload.winner}`} /><div><p>Point {pointNumber} · Set {pointSetNumber(point)} · Game {pointGameNumber(point)}</p><h3>{names[point.payload.winner]} won</h3><span>{names[point.payload.server]} serving · {scoreSummary(point.payload.scoreAfter, config)}</span></div></article>)}</div>}
      </>}

      <p className="fine-print">Read-only view of one shared match. {snapshot.link.opponentDisplay === "full" ? "" : "The opponent is not fully identified on this link. "}{snapshot.link.includeMentalStates ? "Mental-state observations are subjective courtside notes, not diagnoses." : "Mental-state observations are excluded from this link."} {snapshot.link.expiresAt ? `This link expires ${new Date(snapshot.link.expiresAt).toLocaleString()}.` : "This link does not expire until it is revoked."}</p>
    </section>
  </main>;
}
