/* eslint-disable jsx-a11y/label-has-associated-control */

import { useEffect, useMemo, useRef, useState } from "react";
import { buildStats, filterEventsForStatsScope, percentage, pointStatsScope, shotImpact, strategyReview, type StatsScope } from "@/lib/tennis/analytics";
import { buildExportBundle, downloadExport, zipFiles } from "@/lib/tennis/export";
import {
  AdvancedShotType, BallLanding, deepCloneScore, eligiblePointOutcomes, FinalStroke, FORMAT_RULES, hasCompleteShotDetails, MatchConfig,
  IdentityMapping, MatchEvent, MatchRecord, MentalState, otherPlayer, PlayerKey, PlayerProfile, PointDetails,
  pointDetailsPlayer, PointOutcome, RallyRange, ScoreState, ShotSituation, ShotType, usesAdvancedShotOptions, usesBallLandingOptions,
} from "@/lib/tennis/model";
import { createPlayerProfile, linkPlayerIdentity, playerProfileAnalytics, versionPlayerProfile } from "@/lib/tennis/profiles";
import { buildPressureAnalytics } from "@/lib/tennis/pressure";
import { buildCoachReport, DEFAULT_REPORT_OPTIONS, type CoachReportOptions } from "@/lib/tennis/report";
import {
  activePointEvents, applyPoint, derivedCompletions, initialScore, numberedPointEvents, pointDetailsMap, pointGameNumber,
  pointScoreLabel, pointSetNumber, projectScore, scoreSummary, voidedPointIds,
} from "@/lib/tennis/scoring";
import { deleteMatch, loadIdentityMappings, loadMatches, loadPlayers, loadSyncStates, saveIdentityMapping, saveMatch, savePlayer, type MatchSyncState } from "@/lib/tennis/storage";
import {
  createShareLink, flushOutbox, listShareLinks, loadSyncSettings, pendingEventCount,
  pushMatch, revokeShareLink, saveSyncSettings, type ShareLinkResponse, type SyncSettings,
} from "@/lib/tennis/sync";

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
  approach_shot: "Approach Shot", inside_out: "Inside-Out", inside_in: "Inside-In", forehand: "Forehand",
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
  // Read by the sync effects without widening their dependencies: adding a
  // profile must not re-trigger a match save.
  const syncInputs = useRef({ matches, players, mappings });
  useEffect(() => { syncInputs.current = { matches, players, mappings }; }, [matches, players, mappings]);

  useEffect(() => {
    Promise.all([loadMatches(), loadPlayers(), loadIdentityMappings()]).then(([records, savedPlayers, savedMappings]) => {
      setMatches(records); setPlayers(savedPlayers); setMappings(savedMappings); setLoaded(true);
      // Anything queued while the last session was offline goes out now. Sync is
      // opt-in and this is a no-op until the user turns it on.
      flushOutbox(records, savedPlayers, savedMappings).catch(() => undefined);
    }).catch(() => setLoaded(true));
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!match) return;
    const timer = window.setTimeout(() => {
      setSaved(false);
      // IndexedDB first, always. The cloud push happens after the local write has
      // succeeded and can never delay or reorder it.
      saveMatch(match).then(() => { setSaved(true); setMatches((existing) => [match, ...existing.filter((item) => item.id !== match.id)]); return pushMatch(match, syncInputs.current.players, syncInputs.current.mappings); }).catch(() => undefined);
    }, 80);
    return () => window.clearTimeout(timer);
  }, [match]);
  useEffect(() => {
    const flush = () => { const current = syncInputs.current; flushOutbox(current.matches, current.players, current.mappings).catch(() => undefined); };
    window.addEventListener("online", flush);
    return () => window.removeEventListener("online", flush);
  }, []);

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
    {view==="export"&&<><section className="data-intro"><h1>Codex / Claude export</h1><p>One ZIP containing portable CSV tables, lossless events, schema, manifest, API contract, and a coach report.</p></section><label className="data-select">Scope<select value={matchId} onChange={(e)=>setMatchId(e.target.value)}><option value="">All authorized matches</option>{matches.map((m)=><option value={m.id} key={m.id}>{m.config.myPlayerName} vs. {m.config.opponentName}</option>)}</select></label><label className="check-row"><input type="checkbox" checked={anonymize} onChange={(e)=>setAnonymize(e.target.checked)}/>Anonymize names and private profile fields</label><div className="file-grid">{["matches.csv","players.csv","identity_mappings.csv","points.csv","serves.csv","shots.csv","mental_states.csv","score_syncs.csv","events.json","schema.json","manifest.json","match-report.html"].map((name)=><span key={name}>✓ {name}</span>)}</div><button className="primary-button" disabled={!matches.length} onClick={()=>{const scope=matchId&&selectedMatch?[selectedMatch]:matches.filter((m)=>m.authorized!==false);const bundle=buildExportBundle(scope,players,mappings,anonymize,selectedMatch?{match:selectedMatch,options}:undefined);saveBlob("baseline-analysis.zip",zipFiles(bundle.files))}}>Download complete ZIP</button><CloudSyncCard matches={matches} players={players} mappings={mappings} /></>}
    {view==="reports"&&<><section className="data-intro"><h1>Coach report</h1><p>Create a private, self-contained HTML snapshot. Free-form notes stay excluded unless selected.</p></section><label className="data-select">Match<select value={matchId} onChange={(e)=>setMatchId(e.target.value)}>{matches.map((m)=><option value={m.id} key={m.id}>{m.config.myPlayerName} vs. {m.config.opponentName}</option>)}</select></label><section className="data-card report-options">{Object.entries({opponentIdentity:"Opponent identity",matchStats:"Match stats",timeline:"Timelines",mentalStates:"Mental-state progression",mentalNotes:"Mental-state notes",recommendations:"Coaching recommendations"}).map(([key,label])=><label key={key}><input type="checkbox" checked={options[key as keyof CoachReportOptions]} onChange={(e)=>setOptions((current)=>({...current,[key]:e.target.checked}))}/>{label}</label>)}</section><button className="primary-button" disabled={!selectedMatch} onClick={()=>selectedMatch&&saveBlob("baseline-coach-report.html",new Blob([buildCoachReport(selectedMatch,options)],{type:"text/html"}))}>Download self-contained HTML</button>{selectedMatch&&<ShareLinkCard match={selectedMatch} />}</>}
  </div><HomeNav view={view} setView={setView}/></main>;
}

/**
 * Cloud sync is opt-in, and this is where the user opts in. It lives on the data
 * screen rather than the tracking screen on purpose: the courtside surface is
 * for scoring, and nothing here should ever compete with the next point.
 */
function CloudSyncCard({ matches, players, mappings }: { matches: MatchRecord[]; players: PlayerProfile[]; mappings: IdentityMapping[] }) {
  // Settings live in localStorage, which reads synchronously, so they are the
  // initial state rather than something an effect fills in one render later.
  const [settings, setSettings] = useState<SyncSettings>(loadSyncSettings);
  const [states, setStates] = useState<MatchSyncState[]>([]);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { loadSyncStates().then(setStates).catch(() => undefined); }, []);
  const stateFor = (id: string) => states.find((state) => state.matchId === id);
  const pending = matches.reduce((total, item) => total + pendingEventCount(item, stateFor(item.id)), 0);
  const lastSyncedAt = states.map((state) => state.lastSyncedAt).filter(Boolean).sort().at(-1);
  const lastError = states.map((state) => state.lastError).filter(Boolean).at(-1);
  function persist(next: SyncSettings) { const saved = saveSyncSettings(next); setSettings(saved); setStatus(saved.enabled ? "Cloud sync is on." : "Cloud sync is off. Matches stay on this device."); }
  async function syncNow() {
    setBusy(true); setStatus("Pushing queued events…");
    const reports = await flushOutbox(matches, players, mappings);
    const pushed = reports.reduce((total, report) => total + report.pushed, 0);
    const failure = reports.find((report) => report.outcome === "failed");
    setStates(await loadSyncStates());
    setStatus(failure?.error ?? (reports.some((report) => report.outcome === "offline") ? "Offline. Events stay queued." : `Synced ${pushed} event${pushed === 1 ? "" : "s"}.`));
    setBusy(false);
  }
  return <section className="data-card"><h2>Cloud sync</h2><p>Off by default. When on, saved events are copied to your Cloudflare deployment after they are written to this device&mdash;never before. Tracking, undo, stats, and export keep working with no connection at all.</p>
    <label className="check-row"><input type="checkbox" checked={settings.enabled} onChange={(event) => persist({ ...settings, enabled: event.target.checked })} />Enable cloud sync for this device</label>
    <label>Access token<input type="password" value={settings.token} onChange={(event) => setSettings({ ...settings, token: event.target.value })} onBlur={() => persist(settings)} placeholder="SYNC_TOKEN" autoComplete="off" /></label>
    <label>Endpoint (optional)<input value={settings.endpoint} onChange={(event) => setSettings({ ...settings, endpoint: event.target.value })} onBlur={() => persist(settings)} placeholder="Same origin" /></label>
    <p>{pending} event{pending === 1 ? "" : "s"} queued{lastSyncedAt ? ` · last synced ${new Date(lastSyncedAt).toLocaleString()}` : " · never synced"}</p>
    {lastError && <p className="validation-error">{lastError}</p>}
    <button disabled={busy || !settings.enabled || !matches.length} onClick={syncNow}>{busy ? "Syncing…" : "Sync now"}</button>
    {status && <p>{status}</p>}
  </section>;
}

/**
 * Live and report links (requirements sections 18 and 19). Every privacy choice
 * here is enforced in the Worker, not in the page the recipient loads, so a link
 * cannot be made to reveal more than it was created with.
 */
function ShareLinkCard({ match }: { match: MatchRecord }) {
  const [links, setLinks] = useState<{ id: string; active: boolean; expiresAt: string | null; opponentDisplay: string; createdAt: string }[]>([]);
  const [created, setCreated] = useState<ShareLinkResponse>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [opponentDisplay, setOpponentDisplay] = useState<"full" | "initials" | "hidden">("initials");
  const [includeMentalStates, setIncludeMentalStates] = useState(false);
  const [includeTimeline, setIncludeTimeline] = useState(true);
  const [expiresInHours, setExpiresInHours] = useState(24);
  const enabled = loadSyncSettings().enabled;
  const refresh = () => { listShareLinks(match.id).then(setLinks).catch(() => setLinks([])); };
  useEffect(() => { if (enabled) refresh(); }, [match.id, enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  async function create() {
    setBusy(true); setError(""); setCreated(undefined);
    try { setCreated(await createShareLink(match.id, { kind: "live", opponentDisplay, includeMentalStates, includeTimeline, expiresInHours })); refresh(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Could not create the link."); }
    setBusy(false);
  }
  if (!enabled) return <section className="data-card"><h2>Live spectator link</h2><p>Turn on cloud sync in Export to create a read-only link someone else can follow while the match is being tracked.</p></section>;
  return <section className="data-card"><h2>Live spectator link</h2><p>A read-only link to this match only. It expires, can be revoked at any time, and is excluded from search indexing. Mental-state observations are withheld unless you include them, and free-form notes never travel.</p>
    <label className="data-select">Opponent shown as<select value={opponentDisplay} onChange={(event) => setOpponentDisplay(event.target.value as "full" | "initials" | "hidden")}><option value="initials">Initials only</option><option value="hidden">Hidden</option><option value="full">Full name</option></select></label>
    <label className="data-select">Link expires after<select value={expiresInHours} onChange={(event) => setExpiresInHours(Number(event.target.value))}><option value={4}>4 hours</option><option value={24}>24 hours</option><option value={72}>3 days</option><option value={168}>7 days</option></select></label>
    <label className="check-row"><input type="checkbox" checked={includeTimeline} onChange={(event) => setIncludeTimeline(event.target.checked)} />Include the point timeline</label>
    <label className="check-row"><input type="checkbox" checked={includeMentalStates} onChange={(event) => setIncludeMentalStates(event.target.checked)} />Include mental-state observations</label>
    <button disabled={busy} onClick={create}>{busy ? "Creating…" : "Create live link"}</button>
    {error && <p className="validation-error">{error}</p>}
    {created && <p className="share-url">{created.url}<small>Copy it now&mdash;the link is shown once.</small></p>}
    {links.length > 0 && <div className="link-list">{links.map((link) => <span key={link.id}>{link.active ? "● " : "○ "}{new Date(link.createdAt).toLocaleString()} · {link.opponentDisplay}{link.active && <button className="text-button" onClick={() => revokeShareLink(link.id).then(refresh).catch(() => undefined)}>Revoke</button>}</span>)}</div>}
  </section>;
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
  useEffect(() => { if (stage === "details" && hasCompleteShotDetails(details)) { const timer = window.setTimeout(() => finishDetails(), 180); return () => window.clearTimeout(timer); } }, [details, stage]); // eslint-disable-line react-hooks/exhaustive-deps

  function append(events: MatchEvent[]) { setMatch({ ...match, updatedAt: new Date().toISOString(), events: [...match.events, ...events] }); }
  function makeServeEvent(pointGroupId: string, result: "in" | "fault" | "ace", attempt: 1 | 2, offset = 1): MatchEvent { return { ...eventBase(match, offset), source: "tracked", type: "serve_attempted", pointGroupId, payload: { server: score.server, attempt, result } }; }
  function resetPointEntry() { setStage("serve"); setServeAttempt(1); setPendingPointId(undefined); setDetails({}); }
  function completePoint(winner: PlayerKey, serveResult: "in" | "ace" | "double_fault", faults: 0 | 1 | 2, pointGroupId: string, preceding: MatchEvent[]) {
    const after = applyPoint(score, winner, match.config.format, match.config.adScoring);
    const pointEvent: MatchEvent = { ...eventBase(match, preceding.length + 1), source: serveResult === "double_fault" ? "automatic" : "tracked", type: "point_completed", pointGroupId, payload: { winner, loser: otherPlayer(winner), server: score.server, receiver: otherPlayer(score.server), serveAttempt, serveResult, faults, scoreBefore: score, scoreAfter: after, mentalContext: mental } };
    // Game, set, and match completions carry the point group so a single undo voids them with the point.
    const completions: MatchEvent[] = derivedCompletions(score, after).map((completion, index) => ({ ...eventBase(match, preceding.length + 2 + index), source: "automatic", pointGroupId, ...completion }));
    append([...preceding, pointEvent, ...completions]); setUndoCount(0); if (serveResult === "ace" || serveResult === "double_fault") resetPointEntry(); else { setPendingPointId(pointGroupId); setStage("outcome"); }
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
    const owner = pointDetailsPlayer(point, outcome);
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
    const question = "Given the collected dataset for both my player and the opponent through the current point, what is the recommended strategy for my player?";
    // Requirements section 15 pairs every review with its request. Both events are
    // appended together after the round trip so a single setMatch keeps them ordered.
    const requestId = makeId(); const requestedAt = new Date().toISOString(); const cutoffSequence = match.events.length;
    try {
      const response = await fetch("/api/strategy", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        question,
        dataset: { config: match.config, score, stats, mentalStates: mental, points: points.map((point) => ({ ...point.payload, details: detailMap.get(point.pointGroupId) })) },
      }) });
      if (response.ok) {
        const payload = await response.json() as { response: string; provider: string; model: string };
        result = { response: payload.response, evidence: fallback.evidence, provider: payload.provider, model: payload.model };
      }
    } catch { /* Offline and unconfigured deployments use the transparent local fallback. */ }
    append([
      { ...eventBase(match), timestamp: requestedAt, source: "analysis", type: "strategy_requested", payload: { requestId, cutoffSequence, question, promptVersion: "strategy-v1", coverage: stats.coverage } },
      { ...eventBase(match, 2), source: "analysis", type: "strategy_generated", payload: { cutoffSequence, provider: result.provider, model: result.model, promptVersion: "strategy-v1", response: result.response, evidence: result.evidence, coverage: stats.coverage, requestId, requestedAt } },
    ]);
    return result;
  }
  if (score.matchComplete && tab === "track") return <CompletedView match={match} score={score} stats={stats} saved={saved} onTab={setTab} onExit={onExit} />;
  return <main className="app-shell tracker-shell"><header className="match-bar"><button className="icon-button" aria-label="Exit match" onClick={onExit}>×</button><div><span>SET {score.sets.length + 1} · {score.inTiebreak ? (score.tiebreakTarget === 10 ? "MATCH TIEBREAK" : "TIEBREAK") : "LIVE"}</span><strong>{match.config.myPlayerName} vs. {match.config.opponentName}</strong><small className={saved ? "save-state saved" : "save-state"}>● {saved ? "Saved on device" : "Saving…"}</small></div><button className="undo icon-button" disabled={!points.length || undoCount >= 5} onClick={undoPoint}>↶<small>Undo</small></button></header>
    <Scoreboard match={match} score={score} onSync={() => setScoreModal(true)} /><section className="tracker-content">{stage === "serve" && <ServeStage score={score} config={match.config} serveAttempt={serveAttempt} onServe={onServe} />}{stage === "winner" && <WinnerStage config={match.config} onWinner={chooseWinner} />}{stage === "outcome" && <OutcomeStage allowedOutcomes={pendingPoint ? eligiblePointOutcomes(pendingPoint) : []} onOutcome={chooseOutcome} onSkip={resetPointEntry} />}{stage === "details" && <DetailsTray details={details} setDetails={setDetails} onContinue={finishDetails} />}</section>
    <button className="mental-pill" onClick={() => setMentalModal("my")}><span className={`mental-dot ${mental.my}`} /> {match.config.myPlayerName} is {mentalLabels[mental.my].toLowerCase()} <b>Change</b></button><div className="connection-strip"><span>● {online ? "Online" : "Offline tracking"}</span><span>{stats.coverage}% tracked</span></div><BottomNav tab={tab} onTab={setTab} />
    {tab !== "track" && <div className="overlay-page"><button className="overlay-close" onClick={() => setTab("track")}>×</button>{tab === "stats" && <StatsView match={match} stats={stats} />}{tab === "timeline" && <TimelineView match={match} points={points} details={detailMap} />}{tab === "match" && <MatchView match={match} stats={stats} score={score} onExport={() => downloadExport(match, players, mappings)} onGenerate={generateStrategy} />}</div>}
    {scoreModal && <ScoreSyncModal match={match} score={score} onClose={() => setScoreModal(false)} onSave={(corrected, reason) => { const completions: MatchEvent[] = derivedCompletions(score, corrected, { includeGames: false }).map((completion, index) => ({ ...eventBase(match, index + 2), source: "corrected", ...completion })); append([{ ...eventBase(match), source: "corrected", type: "score_synced", payload: { previous: score, corrected, reason, valid: true } }, ...completions]); setScoreModal(false); resetPointEntry(); }} />}
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
  const showBallLanding = usesBallLandingOptions(details.outcome);
  const showAdvanced = usesAdvancedShotOptions(details.outcome);
  return <><div className="point-prompt compact"><p className="eyebrow">{details.outcome ? outcomeLabels[details.outcome] : "POINT DETAILS"}</p><h1>Add shot details</h1><p>Everything below is optional.</p></div><div className="details-tray">{section<RallyRange>("Rally length", "rallyRange", ["1-5", "6-10", "11-20", "21+"])}{section<FinalStroke>("Final stroke", "finalStroke", ["forehand", "backhand", "neither"], shotLabels, "single-line")}{showBallLanding && section<BallLanding>("Ball landed", "ballLanding", ["net", "long", "side"], shotLabels, "single-line")}{section<ShotType>("Shot type", "shotType", ["groundstroke", "slice", "volley", "drop_shot", "lob", "overhead"], shotLabels, "three-column")}{showAdvanced && section<ShotSituation>("Advanced shot · Row 1", "shotSituation", ["approach_shot", "passing_shot"], shotLabels, "two-column")}{showAdvanced && section<AdvancedShotType>("Advanced shot · Row 2", "advancedShotType", ["cross_court", "inside_out", "inside_in"], shotLabels, "single-line")}<button className="continue-button" onClick={onContinue}>Continue to next point <span>→</span></button></div></>;
}
function BottomNav({ tab, onTab }: { tab: Tab; onTab: (tab: Tab) => void }) { return <nav className="bottom-nav"><button className={tab === "track" ? "active" : ""} onClick={() => onTab("track")}><i>●</i><span>Track</span></button><button className={tab === "stats" ? "active" : ""} onClick={() => onTab("stats")}><i>▥</i><span>Stats</span></button><button className={tab === "timeline" ? "active" : ""} onClick={() => onTab("timeline")}><i>≡</i><span>Timeline</span></button><button className={tab === "match" ? "active" : ""} onClick={() => onTab("match")}><i>◇</i><span>Match</span></button></nav>; }

function StatsView({ match, stats }: { match: MatchRecord; stats: ReturnType<typeof buildStats> }) {
  const [shotPlayer, setShotPlayer] = useState<PlayerKey>("my");
  const [scope, setScope] = useState<StatsScope>("total");
  const scopeOptions = useMemo(() => {
    const setNumbers = new Set<number>();
    for (const point of activePointEvents(match.events)) { const pointScope = pointStatsScope(point, match.config); if (pointScope.startsWith("set_")) setNumbers.add(Number(pointScope.slice(4))); }
    const current = projectScore(match.events, match.config);
    const currentIsMatchTiebreak = FORMAT_RULES[match.config.format].matchTiebreakThird && current.inTiebreak && current.tiebreakTarget === 10 && current.sets.length >= 2;
    if (!current.matchComplete && !currentIsMatchTiebreak) setNumbers.add(current.sets.length + 1);
    if (!setNumbers.size) setNumbers.add(1);
    const options: { id: StatsScope; label: string }[] = [{ id: "total", label: "Total" }, ...[...setNumbers].sort((a,b)=>a-b).map((number) => ({ id: `set_${number}` as StatsScope, label: `Set ${number}` }))];
    if (FORMAT_RULES[match.config.format].matchTiebreakThird) options.push({ id: "match_tiebreak", label: "Match TB" });
    return options;
  }, [match]);
  const viewStats = useMemo(() => scope === "total" ? stats : buildStats(filterEventsForStatsScope(match.events, match.config, scope), match.config), [match, scope, stats]);
  const rows = [
    ["Total points won", viewStats.my.pointsWon, viewStats.opponent.pointsWon], ["Aces", viewStats.my.aces, viewStats.opponent.aces], ["Double faults", viewStats.my.doubleFaults, viewStats.opponent.doubleFaults],
    ["1st serve in", percentage(viewStats.my.firstServesIn, viewStats.my.servicePoints), percentage(viewStats.opponent.firstServesIn, viewStats.opponent.servicePoints)], ["1st serve points won", percentage(viewStats.my.firstServePointsWon, viewStats.my.firstServesIn), percentage(viewStats.opponent.firstServePointsWon, viewStats.opponent.firstServesIn)],
    ["2nd serve points won", percentage(viewStats.my.secondServePointsWon, viewStats.my.secondServePoints), percentage(viewStats.opponent.secondServePointsWon, viewStats.opponent.secondServePoints)], ["Return points won", viewStats.my.returnPointsWon, viewStats.opponent.returnPointsWon],
    ["Return winners", viewStats.my.returnWinners, viewStats.opponent.returnWinners], ["Return errors", viewStats.my.returnErrors, viewStats.opponent.returnErrors], ["Winners", viewStats.my.winners, viewStats.opponent.winners], ["Forced errors", viewStats.my.forcedErrors, viewStats.opponent.forcedErrors],
    ["Unforced errors", viewStats.my.unforcedErrors, viewStats.opponent.unforcedErrors], ["Break points", `${viewStats.my.breakPointsConverted}/${viewStats.my.breakPointsEarned}`, `${viewStats.opponent.breakPointsConverted}/${viewStats.opponent.breakPointsEarned}`], ["Longest streak", viewStats.my.longestStreak, viewStats.opponent.longestStreak],
  ]; const shot = viewStats[shotPlayer];
  const shotTypes: ShotType[] = ["groundstroke", "slice", "volley", "drop_shot", "lob", "overhead"];
  const winnerPatterns = ["approach_shot", "passing_shot", "cross_court", "inside_out", "inside_in"] as const;
  return <section className="full-view"><p className="eyebrow">LIVE MATCH DATA</p><h1>Live stats</h1><div className="stats-scope-tabs" role="group" aria-label="Stats scope">{scopeOptions.map((option)=><button className={scope===option.id?"selected":""} key={option.id} onClick={()=>setScope(option.id)}>{option.label}</button>)}</div><div className="coverage-card"><span><strong>{viewStats.coverage}%</strong><small>tracking coverage</small></span><span><strong>{viewStats.directlyTrackedPoints}</strong><small>points captured</small></span><span><strong>{viewStats.completeShotDetails}</strong><small>complete shots</small></span></div><div className="stats-table"><div className="stats-head"><strong>{match.config.myPlayerName}</strong><span>STAT</span><strong>{match.config.opponentName}</strong></div>{rows.map(([label, left, right]) => <div className="stat-row" key={String(label)}><b>{left}</b><span>{label}</span><b>{right}</b></div>)}</div><div className="shot-quality"><div className="section-heading"><div><p className="eyebrow">OBSERVED POINT ENDINGS</p><h2>Shot quality</h2></div><select value={shotPlayer} onChange={(event) => setShotPlayer(event.target.value as PlayerKey)}><option value="my">{match.config.myPlayerName}</option><option value="opponent">{match.config.opponentName}</option></select></div><div className="quality-grid"><Metric label="Forehand impact" value={shotImpact(shot.strokeOutcomes.forehand)} sample={shot.strokeOutcomes.forehand.total} detail={`${shot.strokeOutcomes.forehand.winners} won − ${shot.strokeOutcomes.forehand.errors} lost`} /><Metric label="Backhand impact" value={shotImpact(shot.strokeOutcomes.backhand)} sample={shot.strokeOutcomes.backhand.total} detail={`${shot.strokeOutcomes.backhand.winners} won − ${shot.strokeOutcomes.backhand.errors} lost`} /><Metric label="Net conversion" value={shotImpact(shot.netPlay)} sample={shot.netPlay.total} text={percentage(shot.netPlay.winners, shot.netPlay.total)} detail={`${shot.netPlay.winners} of ${shot.netPlay.total} volleys and overheads`} /><Metric label="Return quality" value={shot.returnWinners - shot.returnErrors} sample={shot.returnWinners + shot.returnErrors} detail={`${shot.returnWinners} winners − ${shot.returnErrors} errors`} /></div><p className="fine-print">Based only on observed point-ending shots—not every stroke in the rally. Impact counts endings that won the point (winners, return winners, and errors this player forced) minus the endings that lost it (return and unforced errors).</p></div><div className="shot-quality advanced-quality"><div className="section-heading"><div><p className="eyebrow">SELECTED SHOT DETAILS</p><h2>Shot quality — Advanced</h2></div></div><section className="advanced-stat-card"><h3>Shot type outcomes</h3><div className="advanced-stat-head"><span>SHOT</span><span>WON</span><span>ERRORS</span><span>OBSERVED</span></div>{shotTypes.map((type) => { const result = shot.shotTypeOutcomes[type]; return <div className="advanced-stat-row" key={type}><strong>{shotLabels[type]}</strong><b>{result.winners}</b><b>{result.errors}</b><small>n={result.total}</small></div>; })}</section><section className="advanced-stat-card"><h3>Winner patterns</h3><div className="winner-pattern-grid">{winnerPatterns.map((pattern) => <span key={pattern}><strong>{shot.winnerPatterns[pattern]}</strong><small>{shotLabels[pattern]}</small></span>)}</div></section><section className="advanced-stat-card"><h3>Points won by rally length</h3><div className="winner-pattern-grid">{(["1-5", "6-10", "11-20", "21+"] as RallyRange[]).map((range) => <span key={range}><strong>{shot.rallyWins[range]}</strong><small>{range} shots</small></span>)}</div></section><p className="fine-print">Won includes observed winners, return winners, and forced errors credited to the point winner. Errors include return and unforced errors. Winner patterns count only Winner and Return Winner points.</p></div></section>;
}
/**
 * Requirements section 12: every metric shows its sample size and supporting
 * calculation. `text` overrides the signed default for rate-shaped metrics.
 */
function Metric({ label, value, sample, text, detail }: { label: string; value: number; sample: number; text?: string; detail?: string }) { return <div><span>{label}</span><strong>{text ?? `${value >= 0 ? "+" : ""}${value}`}</strong><small>n={sample}{detail && sample > 0 ? ` · ${detail}` : ""}</small></div>; }
interface TimelineEntry { id: string; dot: string; eyebrow: string; title: string; context: string; detail?: string }

/**
 * Requirements section 13: mental-state changes, score synchronizations, game and
 * set completion, corrections, and retirements share the point timeline. Voided
 * point groups are excluded from this active view but remain in the audit export.
 */
function timelineEntries(match: MatchRecord, details: Map<string, PointDetails>): TimelineEntry[] {
  const voided = voidedPointIds(match.events);
  const numbers = new Map(numberedPointEvents(match.events).map(({ point, pointNumber }) => [point.pointGroupId, pointNumber]));
  const time = (value: string) => new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const name = (player: PlayerKey) => playerName(match.config, player);
  const entries: TimelineEntry[] = [];
  for (const event of match.events) {
    if ("pointGroupId" in event && event.pointGroupId && voided.has(event.pointGroupId)) continue;
    if (event.type === "point_completed") {
      const detail = details.get(event.pointGroupId);
      entries.push({
        id: event.id, dot: event.payload.winner,
        eyebrow: `Point ${numbers.get(event.pointGroupId) ?? "—"} · Set ${pointSetNumber(event)} · Game ${pointGameNumber(event)} · ${time(event.timestamp)}`,
        title: `${name(event.payload.winner)} won · ${detail?.outcome ? outcomeLabels[detail.outcome] : event.payload.serveResult === "in" ? "Outcome not added" : outcomeLabels[event.payload.serveResult]}`,
        context: `${name(event.payload.server)} serving · ${scoreSummary(event.payload.scoreAfter, match.config)}`,
        detail: detail && [detail.rallyRange, detail.finalStroke && shotLabels[detail.finalStroke], detail.ballLanding && `Landed ${shotLabels[detail.ballLanding]}`, detail.shotType && shotLabels[detail.shotType], detail.shotSituation && shotLabels[detail.shotSituation], detail.advancedShotType && shotLabels[detail.advancedShotType]].filter(Boolean).join(" · "),
      });
    } else if (event.type === "game_completed") {
      entries.push({ id: event.id, dot: "event", eyebrow: `Game · Set ${event.payload.setNumber} · Game ${event.payload.gameNumber}`, title: `${name(event.payload.winner)} ${event.payload.tiebreak ? "wins the tiebreak" : event.payload.hold ? "holds" : "breaks"}`, context: `Games ${event.payload.games[0]}–${event.payload.games[1]}${event.payload.tiebreak ? ` · tiebreak ${event.payload.tiebreak[0]}–${event.payload.tiebreak[1]}` : ""}` });
    } else if (event.type === "set_completed") {
      entries.push({ id: event.id, dot: "event", eyebrow: `Set ${event.payload.setNumber} complete`, title: `${name(event.payload.winner)} takes the ${event.payload.isMatchTiebreak ? "match tiebreak" : `set ${event.payload.games[0]}–${event.payload.games[1]}`}`, context: `Sets ${event.payload.setsWon[0]}–${event.payload.setsWon[1]}${event.payload.tiebreak ? ` · tiebreak ${event.payload.tiebreak[0]}–${event.payload.tiebreak[1]}` : ""}` });
    } else if (event.type === "match_completed") {
      entries.push({ id: event.id, dot: "event", eyebrow: "Match complete", title: `${name(event.payload.winner)} wins`, context: `${scoreSummary(event.payload.score, match.config)}${event.payload.reason === "retirement" ? " · opponent retired" : ""}` });
    } else if (event.type === "player_retired") {
      entries.push({ id: event.id, dot: "event", eyebrow: "Retirement", title: `${name(event.payload.player)} retired`, context: `${name(event.payload.winner)} advances · ${scoreSummary(event.payload.score, match.config)}`, detail: event.payload.note });
    } else if (event.type === "mental_state_changed") {
      entries.push({ id: event.id, dot: "event", eyebrow: `Observed state · ${time(event.timestamp)}`, title: `${name(event.payload.player)} — ${mentalLabels[event.payload.state].toLowerCase()}`, context: `Was ${mentalLabels[event.payload.previousState].toLowerCase()} · captured at ${event.payload.captureMoment.replaceAll("_", " ")}`, detail: event.payload.note });
    } else if (event.type === "score_synced") {
      entries.push({ id: event.id, dot: "event", eyebrow: `Score synchronized · ${time(event.timestamp)}`, title: event.payload.reason, context: `${scoreSummary(event.payload.previous, match.config)} → ${scoreSummary(event.payload.corrected, match.config)}`, detail: "Unknown points are excluded from detailed statistics." });
    } else if (event.type === "point_undone") {
      entries.push({ id: event.id, dot: "event", eyebrow: `Undo · ${time(event.timestamp)}`, title: "Point undone", context: `${event.payload.voidedEventIds.length} linked events voided and kept in the audit export.` });
    } else if (event.type === "event_corrected") {
      entries.push({ id: event.id, dot: "event", eyebrow: `Correction · ${time(event.timestamp)}`, title: event.payload.reason, context: `Corrects event ${event.correctsEventId}` });
    }
  }
  return entries;
}

function TimelineView({ match, points, details }: { match: MatchRecord; points: ReturnType<typeof activePointEvents>; details: Map<string, PointDetails> }) { const entries = useMemo(() => timelineEntries(match, details), [match, details]); return <section className="full-view"><p className="eyebrow">EVERY SAVED POINT</p><h1>Match timeline</h1>{!points.length ? <div className="empty-card"><strong>No points yet</strong><p>Each completed point will appear here with its score context.</p></div> : <div className="timeline">{[...entries].reverse().map((entry) => <article key={entry.id}><div className={`timeline-dot ${entry.dot}`} /><div><p>{entry.eyebrow}</p><h3>{entry.title}</h3><span>{entry.context}</span>{entry.detail && <small>{entry.detail}</small>}</div></article>)}</div>}</section>; }
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
