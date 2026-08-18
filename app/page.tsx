"use client";
/* eslint-disable jsx-a11y/label-has-associated-control */

import { useEffect, useMemo, useState } from "react";
import { buildStats, percentage, strategyReview } from "@/lib/tennis/analytics";
import { buildExportBundle, downloadExport, zipFiles } from "@/lib/tennis/export";
import {
  AdvancedShotType, BallLanding, deepCloneScore, eligiblePointOutcomes, FinalStroke, FORMAT_RULES, MatchConfig,
  IdentityMapping, isErrorOutcome, MatchEvent, MatchRecord, MentalState, otherPlayer, PlayerKey, PlayerProfile, PointDetails,
  PointOutcome, RallyRange, ScoreState, ShotType,
} from "@/lib/tennis/model";
import { createPlayerProfile, linkPlayerIdentity, playerProfileAnalytics, versionPlayerProfile } from "@/lib/tennis/profiles";
import { buildPressureAnalytics } from "@/lib/tennis/pressure";
import { buildCoachReport, DEFAULT_REPORT_OPTIONS, type CoachReportOptions } from "@/lib/tennis/report";
import {
  activePointEvents, applyPoint, initialScore, pointDetailsMap, pointScoreLabel,
  projectScore, scoreSummary, voidedPointIds,
} from "@/lib/tennis/scoring";
import { deleteMatch, loadIdentityMappings, loadMatches, loadPlayers, saveIdentityMapping, saveMatch, savePlayer } from "@/lib/tennis/storage";

type Tab = "track" | "stats" | "timeline" | "match";
type TrackStage = "serve" | "winner" | "outcome" | "details";

const mentalLabels: Record<MentalState, string> = {
  positive: "Positive", focused: "Focused", tense: "Tense", frustrated: "Frustrated",
  disengaged: "Disengaged", not_observed: "Not observed",
};
const outcomeLabels: Record<PointOutcome, string> = {
  return_winner: "Return Winner", return_error: "Return Error", winner: "Winner",
  forced_error: "Forced Error", unforced_error: "Unforced Error", ace: "Ace",
  double_fault: "Double Fault",
};
const shotLabels: Record<string, string> = {
  groundstroke: "Groundstroke", slice: "Slice", volley: "Volley", drop_shot: "Drop Shot",
  lob: "Lob", overhead: "Overhead", passing_shot: "Passing Shot", cross_court: "Cross-Court",
  inside_out: "Inside-Out", inside_in: "Inside-In", forehand: "Forehand",
  backhand: "Backhand", neither: "Neither", net: "Net", long: "Long", side: "Side",
};
const defaultConfig: MatchConfig = {
  myPlayerName: "Ethan", opponentName: "", format: "best_of_3_tiebreak", firstServer: "my",
  adScoring: true, date: new Date().toISOString().slice(0, 10),
  startingMentalState: { my: "focused", opponent: "not_observed" },
};

const makeId = () => crypto.randomUUID();
const playerName = (config: MatchConfig, player: PlayerKey) => player === "my" ? config.myPlayerName : config.opponentName;
function currentMentalState(match: MatchRecord): Record<PlayerKey, MentalState> {
  const state = { ...match.config.startingMentalState };
  for (const event of match.events) if (event.type === "mental_state_changed") state[event.payload.player] = event.payload.state;
  return state;
}
function eventBase(match: MatchRecord, offset = 1) {
  return { id: makeId(), matchId: match.id, schemaVersion: 1 as const, sequence: match.events.length + offset, timestamp: new Date().toISOString() };
}

export default function Home() {
  const [matches, setMatches] = useState<MatchRecord[]>([]);
  const [players, setPlayers] = useState<PlayerProfile[]>([]);
  const [mappings, setMappings] = useState<IdentityMapping[]>([]);
  const [match, setMatch] = useState<MatchRecord | null>(null);
  const [screen, setScreen] = useState<"home" | "setup" | "match">("home");
  const [config, setConfig] = useState<MatchConfig>(defaultConfig);
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState(true);
  const [homeView, setHomeView] = useState<"matches" | "profiles" | "export" | "reports">("matches");

  useEffect(() => {
    Promise.all([loadMatches(), loadPlayers(), loadIdentityMappings()]).then(([records, savedPlayers, savedMappings]) => { setMatches(records); setPlayers(savedPlayers); setMappings(savedMappings); setLoaded(true); }).catch(() => setLoaded(true));
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!match) return;
    const timer = window.setTimeout(() => {
      setSaved(false);
      saveMatch(match).then(() => { setSaved(true); setMatches((existing) => [match, ...existing.filter((item) => item.id !== match.id)]); });
    }, 80);
    return () => window.clearTimeout(timer);
  }, [match]);

  function startMatch() {
    if (!config.myPlayerName.trim() || !config.opponentName.trim()) return;
    const now = new Date().toISOString(); const matchId = makeId(); const score = initialScore(config.firstServer);
    let myProfile = players.find((p) => p.id === config.myPlayerId); let opponentProfile = players.find((p) => p.id === config.opponentId);
    if (!myProfile) myProfile = createPlayerProfile(config.myPlayerName, "my_player");
    if (!opponentProfile) opponentProfile = createPlayerProfile(config.opponentName, "opponent");
    if (myProfile.id === opponentProfile.id) return;
    for (const profile of [myProfile, opponentProfile]) { savePlayer(profile); if (!players.some((p) => p.id === profile.id)) setPlayers((rows) => [...rows, profile]); }
    const cleanConfig = { ...config, myPlayerId: myProfile.id, opponentId: opponentProfile.id, myPlayerName: myProfile.displayName, opponentName: opponentProfile.displayName };
    const next: MatchRecord = { id: matchId, schemaVersion: 1, createdAt: now, updatedAt: now, config: cleanConfig, events: [
      { id: makeId(), matchId, schemaVersion: 1, sequence: 1, timestamp: now, source: "tracked", type: "match_created", payload: { config: cleanConfig } },
      { id: makeId(), matchId, schemaVersion: 1, sequence: 2, timestamp: now, source: "tracked", type: "match_started", payload: { score } },
    ] };
    setMatch(next); setScreen("match");
  }

  if (!loaded) return <main className="loading"><span className="brand-mark">B</span><p>Opening Baseline…</p></main>;
  function saveNewVersion(profile: PlayerProfile, displayName: string, key: "my" | "opponent") { const { player, mapping } = versionPlayerProfile(profile, displayName); setPlayers((rows) => [...rows, player]); setMappings((rows) => [...rows, mapping]); savePlayer(player); saveIdentityMapping(mapping); setConfig((current) => ({ ...current, [`${key}PlayerId`]: player.id, [`${key}PlayerName`]: player.displayName })); }
  if (screen === "setup") return <Setup config={config} setConfig={setConfig} players={players} onVersion={saveNewVersion} onCancel={() => setScreen("home")} onStart={startMatch} />;
  if (screen === "match" && match) return <MatchTracker match={match} setMatch={setMatch} players={players} mappings={mappings} saved={saved} onExit={() => setScreen("home")} />;
  if (homeView !== "matches") return <DataHub view={homeView} setView={setHomeView} players={players} matches={matches} mappings={mappings} onMap={(mapping) => { setMappings((rows) => [...rows, mapping]); saveIdentityMapping(mapping); }} />;
  return <main className="app-shell home-screen">
    <header className="brand-header"><span className="brand-mark">B</span><div><strong>Baseline</strong><small>Tennis match tracker</small></div></header>
    <section className="hero-card"><p className="eyebrow">COURTSIDE · OFFLINE READY</p><h1>Track the match.<br />See the patterns.</h1><p>Fast, one-handed scoring with both-player stats, a complete timeline, and portable match data.</p><button className="primary-button" onClick={() => { setConfig({ ...defaultConfig, date: new Date().toISOString().slice(0, 10) }); setScreen("setup"); }}>Start a new match <span>→</span></button></section>
    <section className="saved-matches"><div className="section-heading"><div><p className="eyebrow">ON THIS DEVICE</p><h2>Recent matches</h2></div><span className="local-badge">● Saved locally</span></div>
      {!matches.length ? <div className="empty-card"><strong>No matches yet</strong><p>Your unfinished and completed matches will appear here.</p></div> : matches.map((item) => { const score = projectScore(item.events, item.config); return <div className="match-list-wrap" key={item.id}><button className="match-list-card" onClick={() => { setMatch(item); setScreen("match"); }}><span><strong>{item.config.myPlayerName}</strong><small>vs. {item.config.opponentName}</small></span><span className="match-list-score"><strong>{scoreSummary(score, item.config)}</strong><small>{score.matchComplete ? "Complete" : "Resume match"} · {new Date(item.updatedAt).toLocaleDateString()}</small></span><b>›</b></button>{!score.matchComplete && <button className="delete-match" aria-label={`Delete unfinished match against ${item.config.opponentName}`} onClick={() => { if (window.confirm(`Delete the unfinished match against ${item.config.opponentName}? This cannot be undone.`)) { deleteMatch(item.id).then(() => setMatches((rows) => rows.filter((row) => row.id !== item.id))); } }}>Delete</button>}</div>; })}
    </section><HomeNav view={homeView} setView={setHomeView} />
  </main>;
}

function Setup({ config, setConfig, players, onVersion, onCancel, onStart }: { config: MatchConfig; setConfig: (value: MatchConfig) => void; players: PlayerProfile[]; onVersion: (profile: PlayerProfile, displayName: string, key: "my" | "opponent") => void; onCancel: () => void; onStart: () => void }) {
  const set = <K extends keyof MatchConfig,>(key: K, value: MatchConfig[K]) => setConfig({ ...config, [key]: value });
  return <main className="app-shell setup-screen"><header className="simple-header"><button onClick={onCancel}>‹</button><div><p className="eyebrow">NEW MATCH</p><strong>Match setup</strong></div><span /></header><div className="form-scroll">
    <section className="form-section"><h2>Players</h2><ProfilePicker label="My player" profiles={players.filter((p) => p.role === "my_player")} selectedId={config.myPlayerId} name={config.myPlayerName} onSelect={(profile) => setConfig({ ...config, myPlayerId: profile?.id, myPlayerName: profile?.displayName ?? "" })} onName={(name) => set("myPlayerName", name)} onVersion={(profile, name) => onVersion(profile, name, "my")} /><ProfilePicker label="Opponent" profiles={players.filter((p) => p.role !== "my_player")} selectedId={config.opponentId} name={config.opponentName} onSelect={(profile) => setConfig({ ...config, opponentId: profile?.id, opponentName: profile?.displayName ?? "" })} onName={(name) => set("opponentName", name)} onVersion={(profile, name) => onVersion(profile, name, "opponent")} /></section>
    <section className="form-section"><h2>Match format</h2><div className="format-list">{Object.values(FORMAT_RULES).map((format) => <button className={config.format === format.id ? "selected" : ""} key={format.id} onClick={() => set("format", format.id)}><span><strong>{format.label}</strong><small>{format.description}</small></span><i>{config.format === format.id ? "✓" : ""}</i></button>)}</div><label className="switch-row"><span><strong>Ad scoring</strong><small>Turn on advantage scoring after deuce</small></span><input type="checkbox" checked={config.adScoring} onChange={(event) => set("adScoring", event.target.checked)} /></label></section>
    <section className="form-section"><h2>First server</h2><div className="segmented"><button className={config.firstServer === "my" ? "selected" : ""} onClick={() => set("firstServer", "my")}>{config.myPlayerName || "My player"}</button><button className={config.firstServer === "opponent" ? "selected" : ""} onClick={() => set("firstServer", "opponent")}>{config.opponentName || "Opponent"}</button></div></section>
    <section className="form-section"><h2>Starting state <em>Optional</em></h2><MentalSelect label="My Player Starting State" value={config.startingMentalState.my} onChange={(value) => set("startingMentalState", { ...config.startingMentalState, my: value })} /><MentalSelect label="Opponent Starting State" value={config.startingMentalState.opponent} onChange={(value) => set("startingMentalState", { ...config.startingMentalState, opponent: value })} /></section>
    <section className="form-section"><h2>Tournament details <em>Optional</em></h2><label>USTA tournament link<input type="url" value={config.tournamentUrl ?? ""} onChange={(event) => set("tournamentUrl", event.target.value)} placeholder="https://playtennis.usta.com/…" /></label><div className="form-pair"><label>Tournament<input value={config.tournamentName ?? ""} onChange={(event) => set("tournamentName", event.target.value)} /></label><label>Round<input value={config.round ?? ""} onChange={(event) => set("round", event.target.value)} placeholder="Quarterfinal" /></label></div><div className="form-pair"><label>Date<input type="date" value={config.date ?? ""} onChange={(event) => set("date", event.target.value)} /></label><label>Court<input value={config.court ?? ""} onChange={(event) => set("court", event.target.value)} /></label></div><label>Location<input value={config.location ?? ""} onChange={(event) => set("location", event.target.value)} /></label></section>
  </div><div className="sticky-action"><button className="primary-button" disabled={!config.myPlayerName.trim() || !config.opponentName.trim()} onClick={onStart}>Start tracking <span>→</span></button></div></main>;
}

function ProfilePicker({ label, profiles, selectedId, name, onSelect, onName, onVersion }: { label: string; profiles: PlayerProfile[]; selectedId?: string; name: string; onSelect: (profile?: PlayerProfile) => void; onName: (name: string) => void; onVersion: (profile: PlayerProfile, name: string) => void }) {
  const selected = profiles.find((profile) => profile.id === selectedId); const edited = !!selected && selected.displayName.trim() !== name.trim();
  return <div className="profile-field"><label>{label}<select value={selectedId ?? "new"} onChange={(event) => onSelect(profiles.find((profile) => profile.id === event.target.value))}><option value="new">+ Create new player</option>{profiles.map((profile) => <option value={profile.id} key={profile.id}>{profile.displayName}</option>)}</select></label><label>{selected ? "Name for a new profile version" : "Player name"}<input value={name} onChange={(event) => onName(event.target.value)} placeholder="Player name" /></label>{edited && <button className="version-button" onClick={() => onVersion(selected, name)}>Save edit as new profile</button>}{selected && <p className="profile-note">Existing matches keep “{selected.displayName}.” Saving this edit creates a new stable profile for future matches.</p>}</div>;
}

function HomeNav({ view, setView }: { view: "matches" | "profiles" | "export" | "reports"; setView: (view: "matches" | "profiles" | "export" | "reports") => void }) { return <nav className="home-nav">{([['matches','Matches'],['profiles','Profiles'],['export','Export'],['reports','Reports']] as const).map(([id,label]) => <button className={view===id?"active":""} key={id} onClick={() => setView(id)}>{label}</button>)}</nav>; }

function DataHub({ view, setView, players, matches, mappings, onMap }: { view: "profiles" | "export" | "reports"; setView: (view: "matches" | "profiles" | "export" | "reports") => void; players: PlayerProfile[]; matches: MatchRecord[]; mappings: IdentityMapping[]; onMap: (mapping: IdentityMapping) => void }) {
  const [playerId,setPlayerId]=useState(players[0]?.id??""); const [matchId,setMatchId]=useState(matches[0]?.id??""); const [fromId,setFromId]=useState(""); const [anonymize,setAnonymize]=useState(false); const [options,setOptions]=useState<CoachReportOptions>(DEFAULT_REPORT_OPTIONS);
  const selectedMatch=matches.find((match)=>match.id===matchId)??matches[0]; const selectedPlayer=players.find((player)=>player.id===playerId)??players[0]; const profileStats=selectedPlayer?playerProfileAnalytics(selectedPlayer.id,matches):undefined; const pressure=selectedMatch?buildPressureAnalytics(selectedMatch):undefined;
  const saveBlob=(name:string,blob:Blob)=>{const url=URL.createObjectURL(blob);const link=document.createElement("a");link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000)};
  return <main className="app-shell data-screen"><header className="simple-header"><button onClick={()=>setView("matches")}>‹</button><div><p className="eyebrow">BASELINE DATA</p><strong>{view === "profiles" ? "Player profiles" : view === "export" ? "Analysis export" : "Coach reports"}</strong></div><span /></header><div className="data-scroll">
    {view==="profiles"&&<><section className="data-intro"><h1>Player profiles</h1><p>Stable identities connect authorized matches without rewriting history.</p></section>{players.length?<><label className="data-select">Player<select value={selectedPlayer?.id} onChange={(e)=>setPlayerId(e.target.value)}>{players.map((p)=><option value={p.id} key={p.id}>{p.displayName}</option>)}</select></label>{profileStats&&<div className="profile-metrics"><span><b>{profileStats.matchCount}</b><small>matches</small></span><span><b>{profileStats.trackedPoints}</b><small>tracked points</small></span><span><b>{profileStats.coverage}%</b><small>coverage</small></span><span><b>{profileStats.pointsWon}</b><small>points won</small></span></div>}<section className="data-card"><h2>Auditable identity link</h2><select value={fromId} onChange={(e)=>setFromId(e.target.value)}><option value="">Choose guest or duplicate</option>{players.filter((p)=>p.id!==selectedPlayer?.id).map((p)=><option value={p.id} key={p.id}>{p.displayName}</option>)}</select><button disabled={!fromId||!selectedPlayer} onClick={()=>{if(selectedPlayer){onMap(linkPlayerIdentity(fromId,selectedPlayer.id));setFromId("")}}}>Link to {selectedPlayer?.displayName}</button><p>Creates a mapping record; original match and event IDs remain unchanged.</p></section><section className="data-card"><h2>Pressure samples across selected match</h2>{pressure&&(["my","opponent"] as PlayerKey[]).map((key)=><p key={key}><strong>{playerName(selectedMatch.config,key)}</strong> · {pressure[key].won}/{pressure[key].played} won · coverage {pressure[key].trackedPoints}/{pressure[key].estimatedPoints} ({pressure[key].coverage}%)</p>)}</section></>:<div className="empty-card">Create profiles from New Match setup.</div>}</>}
    {view==="export"&&<><section className="data-intro"><h1>Codex / Claude export</h1><p>One ZIP containing portable CSV tables, lossless events, schema, manifest, API contract, and a coach report.</p></section><label className="data-select">Scope<select value={matchId} onChange={(e)=>setMatchId(e.target.value)}><option value="">All authorized matches</option>{matches.map((m)=><option value={m.id} key={m.id}>{m.config.myPlayerName} vs. {m.config.opponentName}</option>)}</select></label><label className="check-row"><input type="checkbox" checked={anonymize} onChange={(e)=>setAnonymize(e.target.checked)}/>Anonymize names and private profile fields</label><div className="file-grid">{["matches.csv","players.csv","identity_mappings.csv","points.csv","serves.csv","shots.csv","mental_states.csv","score_syncs.csv","events.json","schema.json","manifest.json","match-report.html"].map((name)=><span key={name}>✓ {name}</span>)}</div><button className="primary-button" disabled={!matches.length} onClick={()=>{const scope=matchId&&selectedMatch?[selectedMatch]:matches.filter((m)=>m.authorized!==false);const bundle=buildExportBundle(scope,players,mappings,anonymize,selectedMatch?{match:selectedMatch,options}:undefined);saveBlob("baseline-analysis.zip",zipFiles(bundle.files))}}>Download complete ZIP</button></>}
    {view==="reports"&&<><section className="data-intro"><h1>Coach report</h1><p>Create a private, self-contained HTML snapshot. Free-form notes stay excluded unless selected.</p></section><label className="data-select">Match<select value={matchId} onChange={(e)=>setMatchId(e.target.value)}>{matches.map((m)=><option value={m.id} key={m.id}>{m.config.myPlayerName} vs. {m.config.opponentName}</option>)}</select></label><section className="data-card report-options">{Object.entries({opponentIdentity:"Opponent identity",tournamentLink:"Tournament link",timeline:"Point timeline",mentalStates:"Mental-state progression",mentalNotes:"Mental-state notes",recommendations:"Coaching recommendations"}).map(([key,label])=><label key={key}><input type="checkbox" checked={options[key as keyof CoachReportOptions]} onChange={(e)=>setOptions((current)=>({...current,[key]:e.target.checked}))}/>{label}</label>)}</section><button className="primary-button" disabled={!selectedMatch} onClick={()=>selectedMatch&&saveBlob("baseline-coach-report.html",new Blob([buildCoachReport(selectedMatch,options)],{type:"text/html"}))}>Download self-contained HTML</button></>}
  </div><HomeNav view={view} setView={setView}/></main>;
}

function MentalSelect({ label, value, onChange }: { label: string; value: MentalState; onChange: (value: MentalState) => void }) { return <label>{label}<select value={value} onChange={(event) => onChange(event.target.value as MentalState)}>{Object.entries(mentalLabels).map(([key, text]) => <option key={key} value={key}>{text}</option>)}</select></label>; }

function MatchTracker({ match, setMatch, players, mappings, saved, onExit }: { match: MatchRecord; setMatch: (match: MatchRecord) => void; players: PlayerProfile[]; mappings: IdentityMapping[]; saved: boolean; onExit: () => void }) {
  const [tab, setTab] = useState<Tab>("track"); const [stage, setStage] = useState<TrackStage>("serve");
  const [serveAttempt, setServeAttempt] = useState<1 | 2>(1); const [pendingPointId, setPendingPointId] = useState<string>();
  const [details, setDetails] = useState<PointDetails>({}); const [scoreModal, setScoreModal] = useState(false);
  const [mentalModal, setMentalModal] = useState<PlayerKey>(); const [undoCount, setUndoCount] = useState(0);
  const [online, setOnline] = useState(typeof navigator === "undefined" ? true : navigator.onLine);
  const score = useMemo(() => projectScore(match.events, match.config), [match]);
  const stats = useMemo(() => buildStats(match.events, match.config), [match]);
  const points = useMemo(() => activePointEvents(match.events), [match]);
  const pendingPoint = useMemo(() => points.find((item) => item.pointGroupId === pendingPointId), [pendingPointId, points]);
  const detailMap = useMemo(() => pointDetailsMap(match.events), [match]);
  const mental = useMemo(() => currentMentalState(match), [match]);
  useEffect(() => { const update = () => setOnline(navigator.onLine); window.addEventListener("online", update); window.addEventListener("offline", update); return () => { window.removeEventListener("online", update); window.removeEventListener("offline", update); }; }, []);
  useEffect(() => { if (stage === "details" && details.rallyRange && details.finalStroke && (!isErrorOutcome(details.outcome) || details.ballLanding) && details.shotType && details.advancedShotType) { const timer = window.setTimeout(() => finishDetails(), 180); return () => window.clearTimeout(timer); } }, [details, stage]); // eslint-disable-line react-hooks/exhaustive-deps

  function append(events: MatchEvent[]) { setMatch({ ...match, updatedAt: new Date().toISOString(), events: [...match.events, ...events] }); }
  function makeServeEvent(pointGroupId: string, result: "in" | "fault" | "ace", attempt: 1 | 2, offset = 1): MatchEvent { return { ...eventBase(match, offset), source: "tracked", type: "serve_attempted", pointGroupId, payload: { server: score.server, attempt, result } }; }
  function resetPointEntry() { setStage("serve"); setServeAttempt(1); setPendingPointId(undefined); setDetails({}); }
  function completePoint(winner: PlayerKey, serveResult: "in" | "ace" | "double_fault", faults: 0 | 1 | 2, pointGroupId: string, preceding: MatchEvent[]) {
    const after = applyPoint(score, winner, match.config.format, match.config.adScoring);
    const pointEvent: MatchEvent = { ...eventBase(match, preceding.length + 1), source: serveResult === "double_fault" ? "automatic" : "tracked", type: "point_completed", pointGroupId, payload: { winner, loser: otherPlayer(winner), server: score.server, receiver: otherPlayer(score.server), serveAttempt, serveResult, faults, scoreBefore: score, scoreAfter: after, mentalContext: mental } };
    append([...preceding, pointEvent]); setUndoCount(0); if (serveResult === "ace" || serveResult === "double_fault") resetPointEntry(); else { setPendingPointId(pointGroupId); setStage("outcome"); }
  }
  function onServe(result: "in" | "fault" | "ace") {
    const pointGroupId = pendingPointId ?? makeId(); const serveEvent = makeServeEvent(pointGroupId, result, serveAttempt);
    if (result === "fault") { if (serveAttempt === 1) { append([serveEvent]); setPendingPointId(pointGroupId); setServeAttempt(2); } else completePoint(otherPlayer(score.server), "double_fault", 2, pointGroupId, [serveEvent]); return; }
    if (result === "ace") { completePoint(score.server, "ace", serveAttempt === 1 ? 0 : 1, pointGroupId, [serveEvent]); return; }
    append([serveEvent]); setPendingPointId(pointGroupId); setStage("winner");
  }
  function chooseWinner(winner: PlayerKey) { completePoint(winner, "in", serveAttempt === 1 ? 0 : 1, pendingPointId ?? makeId(), []); }
  function chooseOutcome(outcome: PointOutcome) {
    const point = points.find((item) => item.pointGroupId === pendingPointId); if (!point) return;
    if (!eligiblePointOutcomes(point).includes(outcome)) return;
    const winnerOutcome = outcome === "winner" || outcome === "return_winner"; const owner = winnerOutcome ? point.payload.winner : point.payload.loser;
    setDetails({ outcome, rallyRange: outcome.startsWith("return_") ? "1-5" : undefined, responsiblePlayer: owner, benefitingPlayer: point.payload.winner, finalStrokePlayer: owner }); setStage("details");
  }
  function finishDetails() { if (pendingPointId && Object.keys(details).length) append([{ ...eventBase(match), source: "tracked", type: "point_annotated", pointGroupId: pendingPointId, payload: details }]); resetPointEntry(); }
  function undoPoint() {
    if (undoCount >= 5) return; const voided = voidedPointIds(match.events); const target = [...match.events].reverse().find((event) => event.type === "point_completed" && !voided.has(event.pointGroupId));
    if (!target || target.type !== "point_completed") return; const linked = match.events.filter((event) => "pointGroupId" in event && event.pointGroupId === target.pointGroupId).map((event) => event.id);
    append([{ ...eventBase(match), source: "corrected", type: "point_undone", payload: { pointGroupId: target.pointGroupId, voidedEventIds: linked } }]); setUndoCount((count) => count + 1); resetPointEntry();
  }
  async function generateStrategy() {
    const fallback = strategyReview(stats, match.config);
    let result = { ...fallback, provider: "on-device", model: "evidence-engine-v1" };
    try {
      const response = await fetch("/api/strategy", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        question: "Given the collected dataset for both my player and the opponent through the current point, what is the recommended strategy for my player?",
        dataset: { config: match.config, score, stats, mentalStates: mental, points: points.map((point) => ({ ...point.payload, details: detailMap.get(point.pointGroupId) })) },
      }) });
      if (response.ok) {
        const payload = await response.json() as { response: string; provider: string; model: string };
        result = { response: payload.response, evidence: fallback.evidence, provider: payload.provider, model: payload.model };
      }
    } catch { /* Offline and unconfigured deployments use the transparent local fallback. */ }
    append([{ ...eventBase(match), source: "analysis", type: "strategy_generated", payload: { cutoffSequence: match.events.length, provider: result.provider, model: result.model, promptVersion: "strategy-v1", response: result.response, evidence: result.evidence, coverage: stats.coverage } }]);
    return result;
  }
  if (score.matchComplete && tab === "track") return <CompletedView match={match} score={score} stats={stats} saved={saved} onTab={setTab} onExit={onExit} />;
  return <main className="app-shell tracker-shell"><header className="match-bar"><button className="icon-button" aria-label="Exit match" onClick={onExit}>×</button><div><span>SET {score.sets.length + 1} · {score.inTiebreak ? (score.tiebreakTarget === 10 ? "MATCH TIEBREAK" : "TIEBREAK") : "LIVE"}</span><strong>{match.config.myPlayerName} vs. {match.config.opponentName}</strong><small className={saved ? "save-state saved" : "save-state"}>● {saved ? "Saved on device" : "Saving…"}</small></div><button className="undo icon-button" disabled={!points.length || undoCount >= 5} onClick={undoPoint}>↶<small>Undo</small></button></header>
    <Scoreboard match={match} score={score} onSync={() => setScoreModal(true)} /><section className="tracker-content">{stage === "serve" && <ServeStage score={score} config={match.config} serveAttempt={serveAttempt} onServe={onServe} />}{stage === "winner" && <WinnerStage config={match.config} onWinner={chooseWinner} />}{stage === "outcome" && <OutcomeStage allowedOutcomes={pendingPoint ? eligiblePointOutcomes(pendingPoint) : []} onOutcome={chooseOutcome} onSkip={resetPointEntry} />}{stage === "details" && <DetailsTray details={details} setDetails={setDetails} onContinue={finishDetails} />}</section>
    <button className="mental-pill" onClick={() => setMentalModal("my")}><span className={`mental-dot ${mental.my}`} /> {match.config.myPlayerName} is {mentalLabels[mental.my].toLowerCase()} <b>Change</b></button><div className="connection-strip"><span>● {online ? "Online" : "Offline tracking"}</span><span>{stats.coverage}% tracked</span></div><BottomNav tab={tab} onTab={setTab} />
    {tab !== "track" && <div className="overlay-page"><button className="overlay-close" onClick={() => setTab("track")}>×</button>{tab === "stats" && <StatsView match={match} stats={stats} />}{tab === "timeline" && <TimelineView match={match} points={points} details={detailMap} />}{tab === "match" && <MatchView match={match} stats={stats} score={score} onExport={() => downloadExport(match, players, mappings)} onGenerate={generateStrategy} />}</div>}
    {scoreModal && <ScoreSyncModal match={match} score={score} onClose={() => setScoreModal(false)} onSave={(corrected, reason) => { append([{ ...eventBase(match), source: "corrected", type: "score_synced", payload: { previous: score, corrected, reason, valid: true } }]); setScoreModal(false); resetPointEntry(); }} />}
    {mentalModal && <MentalModal key={mentalModal} player={mentalModal} current={mental[mentalModal]} config={match.config} onClose={() => setMentalModal(undefined)} onSave={(state, note) => { append([{ ...eventBase(match), source: "tracked", type: "mental_state_changed", payload: { player: mentalModal, state, previousState: mental[mentalModal], captureMoment: pendingPointId ? "after_point" : "manual", linkedPointGroupId: pendingPointId, score, note } }]); setMentalModal(undefined); }} onSwitch={setMentalModal} />}
  </main>;
}

function Scoreboard({ match, score, onSync }: { match: MatchRecord; score: ScoreState; onSync: () => void }) {
  const names: Record<PlayerKey, string> = { my: match.config.myPlayerName, opponent: match.config.opponentName };
  const columns = `minmax(105px, 1fr) repeat(${score.sets.length}, 31px) 40px 52px`;
  return <section className="scoreboard" aria-label="Live match score"><div className="set-head" style={{ gridTemplateColumns: columns }}><span>PLAYER</span>{score.sets.map((_, index) => <span key={index}>S{index + 1}</span>)}<span>G</span><span>PTS</span></div>{(["my", "opponent"] as PlayerKey[]).map((player) => { const index = player === "my" ? 0 : 1; return <div className={`score-row ${score.server === player ? "serving" : ""}`} style={{ gridTemplateColumns: columns }} key={player}><span className="score-name">{score.server === player && <i />} {names[player]}</span>{score.sets.map((set, setIndex) => <span key={setIndex}>{set.isMatchTiebreak ? set.tiebreak?.[index] : set.games[index]}{set.tiebreak && !set.isMatchTiebreak && <sup>{set.tiebreak[index]}</sup>}</span>)}<strong>{score.games[index]}</strong><b>{pointScoreLabel(score, player, match.config.adScoring)}</b></div>; })}<button className="sync-link" onClick={onSync}>Set current score</button></section>;
}
function ServeStage({ score, config, serveAttempt, onServe }: { score: ScoreState; config: MatchConfig; serveAttempt: 1 | 2; onServe: (result: "in" | "fault" | "ace") => void }) { return <><div className="point-prompt"><p className="eyebrow">POINT · {playerName(config, score.server).toUpperCase()} SERVING</p><div className="serve-title"><h1>{serveAttempt === 1 ? "First serve" : "Second serve"}</h1><div className="serve-balls" aria-label={`${3 - serveAttempt} serves available`}><i className="ball" />{serveAttempt === 1 ? <i className="ball" /> : <i className="ball spent" />}</div></div></div><div className="serve-grid"><button className="big-action serve-in" onClick={() => onServe("in")}><small>{serveAttempt === 1 ? "1ST" : "2ND"} SERVE</small><strong>In</strong><span>Continue point</span></button><button className="big-action fault" onClick={() => onServe("fault")}><small>{serveAttempt === 1 ? "1ST" : "2ND"} SERVE</small><strong>Fault</strong><span>{serveAttempt === 1 ? "One ball left" : "Double fault"}</span></button><button className="wide-action ace" onClick={() => onServe("ace")}><small>POINT WON</small><strong>Ace</strong><span>Finish point</span></button></div></>; }
function WinnerStage({ config, onWinner }: { config: MatchConfig; onWinner: (player: PlayerKey) => void }) { return <><div className="point-prompt"><p className="eyebrow">SERVE IS IN</p><h1>Who won the point?</h1></div><div className="winner-grid"><button onClick={() => onWinner("my")}><small>POINT TO</small><strong>{config.myPlayerName}</strong></button><button onClick={() => onWinner("opponent")}><small>POINT TO</small><strong>{config.opponentName}</strong></button></div></>; }
function OutcomeStage({ allowedOutcomes, onOutcome, onSkip }: { allowedOutcomes: PointOutcome[]; onOutcome: (outcome: PointOutcome) => void; onSkip: () => void }) { const returnOutcome = (["return_winner", "return_error"] as PointOutcome[]).find((outcome) => allowedOutcomes.includes(outcome)); const outcomes = [returnOutcome, "winner", "forced_error", "unforced_error"].filter(Boolean) as PointOutcome[]; return <><div className="point-prompt compact"><p className="eyebrow">POINT SAVED</p><h1>How did the point end?</h1><p>Optional—choose one, or keep moving.</p></div><div className="outcome-grid">{outcomes.map((outcome) => <button className="outcome" key={outcome} onClick={() => onOutcome(outcome)}>{outcomeLabels[outcome]}</button>)}</div><button className="skip-button" onClick={onSkip}>Skip details <span>→</span></button></>; }
function DetailsTray({ details, setDetails, onContinue }: { details: PointDetails; setDetails: (details: PointDetails) => void; onContinue: () => void }) {
  const section = <T extends string>(title: string, key: keyof PointDetails, values: T[], labels?: Record<string, string>, className = "") => <div className={`detail-section ${className}`}><p>{title}</p><div>{values.map((value) => <button key={value} className={details[key] === value ? "selected" : ""} onClick={() => setDetails({ ...details, [key]: value })}>{labels?.[value] ?? value}</button>)}</div></div>;
  const showBallLanding = isErrorOutcome(details.outcome);
  return <><div className="point-prompt compact"><p className="eyebrow">{details.outcome ? outcomeLabels[details.outcome] : "POINT DETAILS"}</p><h1>Add shot details</h1><p>Everything below is optional.</p></div><div className="details-tray">{section<RallyRange>("Rally length", "rallyRange", ["1-5", "6-10", "11-20", "21+"])}{section<FinalStroke>("Final stroke", "finalStroke", ["forehand", "backhand", "neither"], shotLabels, "single-line")}{showBallLanding && section<BallLanding>("Ball landed", "ballLanding", ["net", "long", "side"], shotLabels, "single-line")}{section<ShotType>("Shot type", "shotType", ["groundstroke", "slice", "volley", "drop_shot", "lob", "overhead"], shotLabels, "three-column")}{section<AdvancedShotType>("Shot type — Advanced", "advancedShotType", ["passing_shot", "cross_court", "inside_out", "inside_in"], shotLabels, "two-column")}<button className="continue-button" onClick={onContinue}>Continue to next point <span>→</span></button></div></>;
}
function BottomNav({ tab, onTab }: { tab: Tab; onTab: (tab: Tab) => void }) { return <nav className="bottom-nav"><button className={tab === "track" ? "active" : ""} onClick={() => onTab("track")}><i>●</i><span>Track</span></button><button className={tab === "stats" ? "active" : ""} onClick={() => onTab("stats")}><i>▥</i><span>Stats</span></button><button className={tab === "timeline" ? "active" : ""} onClick={() => onTab("timeline")}><i>≡</i><span>Timeline</span></button><button className={tab === "match" ? "active" : ""} onClick={() => onTab("match")}><i>◇</i><span>Match</span></button></nav>; }

function StatsView({ match, stats }: { match: MatchRecord; stats: ReturnType<typeof buildStats> }) {
  const [shotPlayer, setShotPlayer] = useState<PlayerKey>("my"); const rows = [
    ["Total points won", stats.my.pointsWon, stats.opponent.pointsWon], ["Aces", stats.my.aces, stats.opponent.aces], ["Double faults", stats.my.doubleFaults, stats.opponent.doubleFaults],
    ["1st serve in", percentage(stats.my.firstServesIn, stats.my.servicePoints), percentage(stats.opponent.firstServesIn, stats.opponent.servicePoints)], ["1st serve points won", percentage(stats.my.firstServePointsWon, stats.my.firstServesIn), percentage(stats.opponent.firstServePointsWon, stats.opponent.firstServesIn)],
    ["2nd serve points won", percentage(stats.my.secondServePointsWon, stats.my.secondServePoints), percentage(stats.opponent.secondServePointsWon, stats.opponent.secondServePoints)], ["Return points won", stats.my.returnPointsWon, stats.opponent.returnPointsWon],
    ["Return winners", stats.my.returnWinners, stats.opponent.returnWinners], ["Return errors", stats.my.returnErrors, stats.opponent.returnErrors], ["Winners", stats.my.winners, stats.opponent.winners], ["Forced errors", stats.my.forcedErrors, stats.opponent.forcedErrors],
    ["Unforced errors", stats.my.unforcedErrors, stats.opponent.unforcedErrors], ["Break points", `${stats.my.breakPointsConverted}/${stats.my.breakPointsEarned}`, `${stats.opponent.breakPointsConverted}/${stats.opponent.breakPointsEarned}`], ["Longest streak", stats.my.longestStreak, stats.opponent.longestStreak],
  ]; const shot = stats[shotPlayer];
  return <section className="full-view"><p className="eyebrow">LIVE MATCH DATA</p><h1>Live stats</h1><div className="coverage-card"><span><strong>{stats.coverage}%</strong><small>tracking coverage</small></span><span><strong>{stats.directlyTrackedPoints}</strong><small>points captured</small></span><span><strong>{stats.completeShotDetails}</strong><small>complete shots</small></span></div><div className="stats-table"><div className="stats-head"><strong>{match.config.myPlayerName}</strong><span>STAT</span><strong>{match.config.opponentName}</strong></div>{rows.map(([label, left, right]) => <div className="stat-row" key={String(label)}><b>{left}</b><span>{label}</span><b>{right}</b></div>)}</div><div className="shot-quality"><div className="section-heading"><div><p className="eyebrow">OBSERVED POINT ENDINGS</p><h2>Shot quality</h2></div><select value={shotPlayer} onChange={(event) => setShotPlayer(event.target.value as PlayerKey)}><option value="my">{match.config.myPlayerName}</option><option value="opponent">{match.config.opponentName}</option></select></div><div className="quality-grid"><Metric label="Forehand impact" value={shot.forehandOutcomes} sample={shot.forehandOutcomes} /><Metric label="Backhand impact" value={shot.backhandOutcomes} sample={shot.backhandOutcomes} /><Metric label="Return quality" value={shot.returnWinners - shot.returnErrors} sample={shot.returnWinners + shot.returnErrors} /><Metric label="Short-rally wins" value={shot.rallyWins["1-5"]} sample={Object.values(shot.rallyWins).reduce((a, b) => a + b, 0)} /></div><p className="fine-print">Based only on observed point-ending shots—not every stroke in the rally.</p></div></section>;
}
function Metric({ label, value, sample }: { label: string; value: number; sample: number }) { return <div><span>{label}</span><strong>{value >= 0 ? "+" : ""}{value}</strong><small>n={sample}</small></div>; }
function TimelineView({ match, points, details }: { match: MatchRecord; points: ReturnType<typeof activePointEvents>; details: Map<string, PointDetails> }) { return <section className="full-view"><p className="eyebrow">EVERY SAVED POINT</p><h1>Match timeline</h1>{!points.length ? <div className="empty-card"><strong>No points yet</strong><p>Each completed point will appear here with its score context.</p></div> : <div className="timeline">{[...points].reverse().map((point) => { const detail = details.get(point.pointGroupId); return <article key={point.id}><div className={`timeline-dot ${point.payload.winner}`} /><div><p>Point {point.sequence} · {new Date(point.timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</p><h3>{playerName(match.config, point.payload.winner)} won · {detail?.outcome ? outcomeLabels[detail.outcome] : point.payload.serveResult === "in" ? "Outcome not added" : outcomeLabels[point.payload.serveResult]}</h3><span>{playerName(match.config, point.payload.server)} serving · {scoreSummary(point.payload.scoreAfter, match.config)}</span>{detail && <small>{[detail.rallyRange, detail.finalStroke && shotLabels[detail.finalStroke], detail.ballLanding && `Landed ${shotLabels[detail.ballLanding]}`, detail.shotType && shotLabels[detail.shotType], detail.advancedShotType && shotLabels[detail.advancedShotType]].filter(Boolean).join(" · ")}</small>}</div></article>; })}</div>}</section>; }
function MatchView({ match, stats, score, onExport, onGenerate }: { match: MatchRecord; stats: ReturnType<typeof buildStats>; score: ScoreState; onExport: () => void; onGenerate: () => Promise<{ response: string; evidence: string[]; provider: string; model: string }> }) {
  const [review, setReview] = useState<{ response: string; evidence: string[]; provider: string; model: string }>(); const [loading, setLoading] = useState(false);
  async function askForReview() { setLoading(true); const next = await onGenerate(); setReview(next); setLoading(false); }
  return <section className="full-view"><p className="eyebrow">MATCH CENTER</p><h1>Review & strategy</h1><div className="match-summary"><span><small>FORMAT</small><strong>{FORMAT_RULES[match.config.format].shortLabel}</strong></span><span><small>SCORE</small><strong>{scoreSummary(score, match.config)}</strong></span><span><small>DATA</small><strong>{stats.coverage}% tracked</strong></span></div><div className="strategy-card"><span className="strategy-icon">✦</span><p className="eyebrow">ON-DEMAND REVIEW</p><h2>What should {match.config.myPlayerName} do next?</h2><p>Uses the cumulative score, service, return, shot, rally, and mental-state observations for both players. Match data is sent for analysis only when you tap below.</p><button disabled={loading} onClick={askForReview}>{loading ? "Reviewing the match…" : "Ask AI for strategy"}</button>{review && <div className="strategy-response"><p className="pre-line">{review.response}</p><h3>Evidence used</h3>{review.evidence.length ? <ul>{review.evidence.map((item) => <li key={item}>{item}</li>)}</ul> : <p>More tracked points will produce stronger evidence.</p>}<small>{review.provider === "on-device" ? "On-device evidence review · The hosted model is unavailable or not configured." : `${review.provider} · ${review.model}`} · Dataset cutoff saved in the event log.</small></div>}</div><div className="data-card"><div><h2>Your match data</h2><p>Download a lossless event log plus analysis-ready CSV tables for Codex, Claude, or another tool.</p></div><button onClick={onExport}>Export data ↓</button></div>{match.config.tournamentUrl && <a className="tournament-link" href={match.config.tournamentUrl} target="_blank" rel="noreferrer"><span><small>USTA TOURNAMENT</small><strong>{match.config.tournamentName || "Open tournament page"}</strong></span><b>↗</b></a>}</section>;
}
function CompletedView({ match, score, stats, saved, onTab, onExit }: { match: MatchRecord; score: ScoreState; stats: ReturnType<typeof buildStats>; saved: boolean; onTab: (tab: Tab) => void; onExit: () => void }) { return <main className="app-shell completed-screen"><header className="match-bar"><button className="icon-button" onClick={onExit}>×</button><div><span>MATCH COMPLETE</span><strong>{match.config.myPlayerName} vs. {match.config.opponentName}</strong><small className="save-state saved">● {saved ? "Saved on device" : "Saving…"}</small></div><span /></header><section className="completed-hero"><span className="trophy">✓</span><p className="eyebrow">FINAL</p><h1>{playerName(match.config, score.winner ?? "my")} wins</h1><strong>{scoreSummary(score, match.config)}</strong><p>{stats.directlyTrackedPoints} points captured · {stats.coverage}% coverage</p></section><div className="completed-actions"><button onClick={() => onTab("stats")}>View match stats</button><button onClick={() => onTab("match")}>Review strategy</button><button onClick={() => downloadExport(match)}>Export match data</button></div><button className="text-button" onClick={onExit}>Return to matches</button></main>; }

function MentalModal({ player, current, config, onClose, onSave, onSwitch }: { player: PlayerKey; current: MentalState; config: MatchConfig; onClose: () => void; onSave: (state: MentalState, note?: string) => void; onSwitch: (player: PlayerKey) => void }) {
  const [value, setValue] = useState(current); const [note, setNote] = useState("");
  return <div className="modal-backdrop"><section className="modal"><div className="modal-head"><div><p className="eyebrow">OBSERVED STATE</p><h2>Mental state</h2></div><button onClick={onClose}>×</button></div><div className="segmented"><button className={player === "my" ? "selected" : ""} onClick={() => onSwitch("my")}>{config.myPlayerName}</button><button className={player === "opponent" ? "selected" : ""} onClick={() => onSwitch("opponent")}>{config.opponentName}</button></div><div className="mental-grid">{(Object.keys(mentalLabels) as MentalState[]).map((state) => <button className={`${state} ${value === state ? "selected" : ""}`} key={state} onClick={() => setValue(state)}><i />{mentalLabels[state]}</button>)}</div><label>Optional note<textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="What did you observe?" /></label><p className="fine-print">A subjective courtside observation—not a diagnosis.</p><button className="primary-button" onClick={() => onSave(value, note || undefined)}>Save observation</button></section></div>;
}
function ScoreSyncModal({ match, score, onClose, onSave }: { match: MatchRecord; score: ScoreState; onClose: () => void; onSave: (score: ScoreState, reason: string) => void }) {
  const [games, setGames] = useState<[number, number]>([...score.games]);
  const [points, setPoints] = useState<[number, number]>([...score.points]);
  const [server, setServer] = useState<PlayerKey>(score.server);
  const [reason, setReason] = useState("Missed one or more points");
  const [tiebreak, setTiebreak] = useState<[number, number]>([7, 5]);
  const [finishMatch, setFinishMatch] = useState(false);
  const [finishWinner, setFinishWinner] = useState<PlayerKey>(score.winner ?? "my");
  const rule = FORMAT_RULES[match.config.format];
  const isTiebreakSet = rule.tiebreakAt !== undefined && ((games[0] === rule.tiebreakAt + 1 && games[1] === rule.tiebreakAt) || (games[1] === rule.tiebreakAt + 1 && games[0] === rule.tiebreakAt));
  const editingTiebreak = rule.tiebreakAt !== undefined && games[0] === rule.tiebreakAt && games[1] === rule.tiebreakAt;
  const regularSetComplete = rule.id === "pro_8"
    ? Math.max(...games) >= 8 && Math.abs(games[0] - games[1]) >= 2
    : Math.max(...games) >= rule.gamesToWin && Math.abs(games[0] - games[1]) >= 2;
  const tiebreakWinner = tiebreak[0] > tiebreak[1] ? 0 : 1;
  const setWinner = games[0] > games[1] ? 0 : 1;
  const validFinalTiebreak = !isTiebreakSet || (Math.max(...tiebreak) >= 7 && Math.abs(tiebreak[0] - tiebreak[1]) >= 2 && tiebreakWinner === setWinner);
  function changePair(setter: (value: [number, number]) => void, value: [number, number], index: 0 | 1, next: number) { const copy: [number, number] = [...value]; copy[index] = Math.max(0, next); setter(copy); }
  function save() {
    const corrected = deepCloneScore(score); corrected.games = games; corrected.points = points; corrected.server = server; corrected.inTiebreak = editingTiebreak;
    if (!finishMatch && (isTiebreakSet || regularSetComplete)) {
      const winnerIndex = games[0] > games[1] ? 0 : 1;
      corrected.sets.push(isTiebreakSet ? { games, tiebreak } : { games });
      corrected.setsWon[winnerIndex] += 1; corrected.games = [0, 0]; corrected.points = [0, 0]; corrected.inTiebreak = false;
      const needed = rule.bestOfSets === 1 ? 1 : 2;
      if (corrected.setsWon[winnerIndex] >= needed) { corrected.matchComplete = true; corrected.winner = winnerIndex === 0 ? "my" : "opponent"; }
      else if (rule.matchTiebreakThird && corrected.sets.length === 2 && corrected.setsWon[0] === 1 && corrected.setsWon[1] === 1) { corrected.inTiebreak = true; corrected.tiebreakTarget = 10; corrected.tiebreakStartServer = server; }
    }
    if (finishMatch) {
      if (games[0] || games[1] || points[0] || points[1]) corrected.sets.push({ games: [...games] });
      corrected.games = [0, 0]; corrected.points = [0, 0]; corrected.inTiebreak = false;
      corrected.matchComplete = true; corrected.winner = finishWinner;
    }
    onSave(corrected, finishMatch ? "Match completed with partially tracked data" : reason);
  }
  const pointLabel = (value: number) => editingTiebreak ? String(value) : (["0", "15", "30", "40", "AD"][value] ?? String(value));
  const pairEditor = (label: string, values: [number, number], setter: (value: [number, number]) => void, display: (value: number) => string = String) => <div className="pair-editor"><p>{label}</p>{([0, 1] as const).map((index) => <div key={index}><span>{index === 0 ? match.config.myPlayerName : match.config.opponentName}</span><button onClick={() => changePair(setter, values, index, values[index] - 1)}>−</button><strong>{display(values[index])}</strong><button onClick={() => changePair(setter, values, index, values[index] + 1)}>+</button></div>)}</div>;
  return <div className="modal-backdrop"><section className="modal score-modal">
    <div className="modal-head"><div><p className="eyebrow">MISSED POINTS</p><h2>Set current score</h2></div><button onClick={onClose}>×</button></div>
    {score.sets.length > 0 && <div className="previous-sets"><small>COMPLETED SETS</small>{score.sets.map((set, index) => <span key={index}>Set {index + 1}: {set.games[0]}–{set.games[1]}</span>)}</div>}
    {pairEditor("Current-set games", games, setGames)}{pairEditor(editingTiebreak ? "Tiebreak points" : "Current-game points", points, setPoints, pointLabel)}
    {isTiebreakSet && pairEditor("Final tiebreak score", tiebreak, setTiebreak)}{!validFinalTiebreak && <p className="validation-error">Enter a tiebreak won by at least two points, matching the set winner.</p>}
    <div className="form-section inset"><h3>Current server</h3><div className="segmented"><button className={server === "my" ? "selected" : ""} onClick={() => setServer("my")}>{match.config.myPlayerName}</button><button className={server === "opponent" ? "selected" : ""} onClick={() => setServer("opponent")}>{match.config.opponentName}</button></div><label>Reason<input value={reason} onChange={(event) => setReason(event.target.value)} /></label></div>
    <label className="finish-toggle"><input type="checkbox" checked={finishMatch} onChange={(event) => setFinishMatch(event.target.checked)} /><span><strong>Complete this match now</strong><small>Use the score above and preserve partial tracking coverage.</small></span></label>
    {finishMatch && <div className="form-section inset"><h3>Match winner</h3><div className="segmented"><button className={finishWinner === "my" ? "selected" : ""} onClick={() => setFinishWinner("my")}>{match.config.myPlayerName}</button><button className={finishWinner === "opponent" ? "selected" : ""} onClick={() => setFinishWinner("opponent")}>{match.config.opponentName}</button></div></div>}
    <p className="fine-print">Unknown points are excluded from detailed statistics and lower the displayed tracking coverage.</p><button className="primary-button" disabled={!validFinalTiebreak} onClick={save}>{finishMatch ? "Complete match" : "Update live score"}</button>
  </section></div>;
}
