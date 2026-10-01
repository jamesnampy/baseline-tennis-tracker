/**
 * Self-contained coach report (requirements section 18).
 *
 * The same builder produces the downloadable HTML file and the hosted share
 * link, so a coach reading a link and a coach reading a saved file see the same
 * report. Privacy choices are applied by the caller before this runs — for a
 * hosted link that happens in the Worker — and this file only renders what it
 * is given.
 *
 * Every rate prints its numerator and denominator alongside the percentage,
 * because section 18 requires the sample behind each number to be visible.
 */
import { buildStats, filterEventsForStatsScope, statsScopeOptions, strategyReview, type StatsScope } from "./analytics.ts";
import {
  landingRows, matchRows, pressureRows, rallyRows, shotRows, SHOT_LABELS,
  type StatCell, type StatRow,
} from "./stattables.ts";
import { DATASET_VERSION } from "./model.ts";
import type { MatchRecord, PlayerKey } from "./model.ts";
import { buildPressureAnalytics } from "./pressure.ts";
import { activePointEvents, pointDetailsMap, projectScore, scoreSummary } from "./scoring.ts";

export interface CoachReportOptions {
  opponentIdentity: boolean;
  matchStats: boolean;
  shotAnalytics: boolean;
  timeline: boolean;
  mentalStates: boolean;
  mentalNotes: boolean;
  recommendations: boolean;
}

export const DEFAULT_REPORT_OPTIONS: CoachReportOptions = {
  opponentIdentity: true,
  matchStats: true,
  shotAnalytics: true,
  timeline: true,
  mentalStates: false,
  mentalNotes: false,
  recommendations: true,
};

const esc = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** A cell keeps its sample beside it, muted, rather than losing it. */
const cell = (value: StatCell) =>
  `${esc(value.value)}${value.detail ? ` <span class="muted">(${esc(value.detail)})</span>` : ""}`;

const table = (left: string, right: string, rows: StatRow[]) =>
  `<table><thead><tr><th>Statistic</th><th>${esc(left)}</th><th>${esc(right)}</th></tr></thead><tbody>${
    rows.map((entry) => `<tr><td>${esc(entry.label)}</td><td>${cell(entry.my)}</td><td>${cell(entry.opponent)}</td></tr>`).join("")
  }</tbody></table>`;

export function buildCoachReport(match: MatchRecord, options: CoachReportOptions = DEFAULT_REPORT_OPTIONS) {
  const stats = buildStats(match.events, match.config);
  const score = projectScore(match.events, match.config);
  const points = activePointEvents(match.events);
  const details = pointDetailsMap(match.events);
  const opponent = options.opponentIdentity ? match.config.opponentName : "Opponent";
  const names: Record<PlayerKey, string> = { my: match.config.myPlayerName, opponent };
  const review = strategyReview(stats, { ...match.config, opponentName: opponent });

  const setSummary = score.sets.map((set, index) => {
    const winner = set.isMatchTiebreak
      ? (set.tiebreak?.[0] ?? 0) > (set.tiebreak?.[1] ?? 0) ? "my" : "opponent"
      : set.games[0] > set.games[1] ? "my" : "opponent";
    const label = set.isMatchTiebreak
      ? `Match tiebreak ${set.tiebreak?.[0] ?? 0}–${set.tiebreak?.[1] ?? 0}`
      : `${set.games[0]}–${set.games[1]}${set.tiebreak ? ` (${set.tiebreak[0]}–${set.tiebreak[1]})` : ""}`;
    return `<tr><td>Set ${index + 1}</td><td>${esc(label)}</td><td>${esc(names[winner as PlayerKey])}</td></tr>`;
  }).join("");

  const timeline = points.map((point, index) => {
    const detail = details.get(point.pointGroupId);
    const shot = [detail?.rallyRange && `${detail.rallyRange} shots`, detail?.finalStroke, detail?.shotType && SHOT_LABELS[detail.shotType]]
      .filter(Boolean).join(" · ");
    return `<tr><td>${index + 1}</td><td>${esc(names[point.payload.winner])}</td><td>${esc(detail?.outcome?.replaceAll("_", " ") ?? point.payload.serveResult.replaceAll("_", " "))}</td><td>${esc(shot || "—")}</td><td>${esc(scoreSummary(point.payload.scoreAfter, match.config))}</td></tr>`;
  }).join("");

  const mental = match.events
    .filter((event) => event.type === "mental_state_changed")
    .map((event) => `<li>Event ${event.sequence}: ${esc(names[event.payload.player])} — ${esc(event.payload.state.replaceAll("_", " "))}${options.mentalNotes && event.payload.note ? ` · ${esc(event.payload.note)}` : ""}</li>`)
    .join("");

  // Scoped statistics (roadmap item, sections 11 and 18). The Stats screen offers
  // the whole match, each set, and a deciding match tiebreak; the report now
  // carries the same scopes, from the same shared helper, so the two cannot
  // disagree about which scopes a match has. `false` keeps empty scopes out.
  const scopes = options.matchStats || options.shotAnalytics
    ? statsScopeOptions(match.events, match.config, false)
    : [];

  const scopePanel = (scope: StatsScope, index: number) => {
    const scoped = scope === "total" ? match.events : filterEventsForStatsScope(match.events, match.config, scope);
    const scopeStats = buildStats(scoped, match.config);
    const scopePressure = buildPressureAnalytics({ ...match, events: scoped });
    return `<div class="scope-panel${index === 0 ? " on" : ""}" id="scope-${String(scope).replaceAll("_", "-")}">`
      + (options.matchStats ? `<section class="card"><h2>Match statistics</h2><div class="scroll">${table(match.config.myPlayerName, opponent, matchRows(scopeStats))}</div>
<h3>Pressure points</h3><div class="scroll">${table(match.config.myPlayerName, opponent, pressureRows(scopePressure))}</div>
<p class="muted small">Pressure context is derived from the score immediately before each tracked point. A point can belong to more than one pressure category; the total counts it once.</p></section>` : "")
      + (options.shotAnalytics ? `<section class="card"><h2>Shot analytics</h2><div class="scroll">${table(match.config.myPlayerName, opponent, shotRows(scopeStats))}</div>
<h3>Points won by rally length</h3><div class="scroll">${table(match.config.myPlayerName, opponent, rallyRows(scopeStats))}</div>
<h3>Where errors landed</h3><div class="scroll">${table(match.config.myPlayerName, opponent, landingRows(scopeStats))}</div>
<p class="muted small">Impact is the point endings that won the point minus the ones that lost it, shown as +/− with wins, errors, and sample size. A winner, return winner, or forced error is credited to the point winner; an unforced error or return error to the point loser. Based only on observed point-ending shots—not every stroke in the rally.</p></section>` : "")
      + `</div>`;
  };

  const scopeTabs = scopes.length > 1
    ? `<div class="tabs scope-tabs" role="tablist" aria-label="Statistics scope">${scopes.map((scope, index) =>
        `<button role="tab" aria-selected="${index === 0}" class="${index === 0 ? "on" : ""}" data-scope="scope-${String(scope.id).replaceAll("_", "-")}">${esc(scope.label)}</button>`).join("")}</div>`
    : "";

  const statisticsPanel = scopes.length
    ? `<section class="panel on" id="panel-statistics">${scopeTabs}${scopes.map((scope, index) => scopePanel(scope.id, index)).join("")}</section>`
    : "";

  // Top-level tabs, so the timeline is separable from the statistics rather than
  // continuing the same page.
  const tabs: { key: string; label: string }[] = [];
  if (scopes.length) tabs.push({ key: "statistics", label: "Statistics" });
  if (options.timeline) tabs.push({ key: "timeline", label: "Timeline" });
  if (options.mentalStates) tabs.push({ key: "mental", label: "Mental state" });
  tabs.push({ key: "analysis", label: "Analysis" });
  const tabBar = tabs.length > 1
    ? `<div class="tabs" role="tablist" aria-label="Report sections">${tabs.map((tab, index) =>
        `<button role="tab" aria-selected="${index === 0}" class="${index === 0 && !scopes.length ? "on" : index === 0 ? "on" : ""}" data-panel="panel-${tab.key}">${esc(tab.label)}</button>`).join("")}</div>`
    : "";
  const firstPanel = tabs[0]?.key;

  const winnerLine = score.matchComplete && score.winner ? `${esc(names[score.winner])} won` : "In progress";

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Baseline coach report</title><style>
body{font:15px/1.5 system-ui,-apple-system,sans-serif;color:#102c2c;background:#fbf9f3;max-width:900px;margin:auto;padding:24px 18px 60px}
h1{font-size:30px;letter-spacing:-.02em;margin:4px 0 6px}h2{font-size:18px;margin:0 0 10px}h3{font-size:13px;margin:16px 0 6px;color:#42615a}
.card{background:#fff;border:1px solid #e6e2d6;border-radius:14px;padding:16px;margin:14px 0}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{padding:7px 6px;border-bottom:1px solid #ece8dc;text-align:left;vertical-align:top}
th{font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:#687976}
td:nth-child(2),td:nth-child(3),th:nth-child(2),th:nth-child(3){text-align:right}
.timeline-table td,.timeline-table th{text-align:left}
.muted{color:#687976}.small{font-size:11px}
.scoreline{font-size:17px;font-weight:700}
ul{margin:6px 0;padding-left:18px}li{margin:4px 0}
.pre-line{white-space:pre-line}
.scroll{overflow-x:auto}
.tabs{display:flex;flex-wrap:wrap;gap:6px;margin:16px 0 4px}
.tabs button{border:1px solid #ddd8c9;background:#fff;border-radius:11px;min-height:44px;padding:0 14px;font:800 12px system-ui;color:#42615a;cursor:pointer}
.tabs button.on{background:#102c2c;border-color:#102c2c;color:#dfff5b}
.scope-tabs button.on{background:#9dbb2d;border-color:#9dbb2d;color:#102c2c}
.panel,.scope-panel{display:none}.panel.on,.scope-panel.on{display:block}
@media print{body{background:#fff;padding:0}.card{break-inside:avoid;border-color:#ccc}
.tabs{display:none}.panel,.scope-panel{display:block!important}
.scope-panel{border-top:2px solid #102c2c;margin-top:18px;padding-top:6px}}
</style></head><body>
<p class="muted small">BASELINE · READ-ONLY COACH REPORT</p>
<h1>${esc(match.config.myPlayerName)} vs. ${esc(opponent)}</h1>
<p class="scoreline">${esc(scoreSummary(score, match.config))} · ${winnerLine}</p>
<p class="muted small">${esc(match.config.date ?? "")}${match.config.tournamentName ? ` · ${esc(match.config.tournamentName)}` : ""}${match.config.round ? ` · ${esc(match.config.round)}` : ""}${match.config.location ? ` · ${esc(match.config.location)}` : ""} · ${esc(match.config.format.replaceAll("_", " "))} · ${match.config.adScoring ? "ad" : "no-ad"} scoring</p>

${score.sets.length ? `<section class="card"><h2>Set by set</h2><div class="scroll"><table class="timeline-table"><thead><tr><th>Set</th><th>Score</th><th>Won by</th></tr></thead><tbody>${setSummary}</tbody></table></div></section>` : ""}

${tabBar}

${statisticsPanel}

<section class="panel${firstPanel === "analysis" ? " on" : ""}" id="panel-analysis"><section class="card"><h2>Observations</h2>${review.evidence.length ? `<ul>${review.evidence.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>` : "<p class=\"muted\">Not enough tracked points yet to support an observation.</p>"}
<p class="muted small">Observations restate what the statistics above show. They are not inferences.</p>
${options.recommendations ? `<h2>Recommendations</h2><p class="pre-line">${esc(review.response)}</p>` : ""}</section></section>

${options.timeline ? `<section class="panel${firstPanel === "timeline" ? " on" : ""}" id="panel-timeline"><section class="card"><h2>Point timeline</h2><div class="scroll"><table class="timeline-table"><thead><tr><th>#</th><th>Won by</th><th>Outcome</th><th>Shot</th><th>Score</th></tr></thead><tbody>${timeline || "<tr><td colspan=\"5\" class=\"muted\">No points recorded.</td></tr>"}</tbody></table></div></section></section>` : ""}

${options.mentalStates ? `<section class="panel${firstPanel === "mental" ? " on" : ""}" id="panel-mental"><section class="card"><h2>Mental-state progression</h2><p class="muted small">Subjective courtside observations—not psychological, medical, or diagnostic claims.</p><ul>${mental || "<li>Not observed</li>"}</ul></section></section>` : ""}

<section class="card"><h2>Data quality</h2>
<p>${stats.directlyTrackedPoints} of an estimated ${stats.estimatedTotalPoints} points were tracked directly (${stats.coverage}% coverage). ${stats.completeShotDetails} points carry complete shot details. ${stats.scoreSyncs} score synchronization${stats.scoreSyncs === 1 ? "" : "s"} recorded.</p>
<p class="muted small">Points added only through score synchronization are excluded from detailed statistics, so shot samples can be smaller than the point count. Optional shot data may be incomplete.</p></section>

<footer class="muted small">Generated ${new Date().toISOString()} · dataset ${DATASET_VERSION} · event cutoff ${match.events.length} · report v2${options.opponentIdentity ? "" : " · opponent identity withheld"}${options.mentalStates ? "" : " · mental-state observations withheld"}</footer>
<script>
(function(){
  function pick(bar, target, attr){
    bar.querySelectorAll("button").forEach(function(b){
      var on = b === target;
      b.classList.toggle("on", on);
      b.setAttribute("aria-selected", String(on));
    });
    var wanted = target.getAttribute(attr);
    var selector = attr === "data-scope" ? ".scope-panel" : ".panel";
    document.querySelectorAll(selector).forEach(function(p){ p.classList.toggle("on", p.id === wanted); });
  }
  document.querySelectorAll(".tabs").forEach(function(bar){
    var attr = bar.classList.contains("scope-tabs") ? "data-scope" : "data-panel";
    bar.addEventListener("click", function(e){ var b = e.target.closest("button"); if (b) pick(bar, b, attr); });
    var first = bar.querySelector("button.on") || bar.querySelector("button");
    if (first) pick(bar, first, attr);
  });
})();
</script>
</body></html>`;
}
