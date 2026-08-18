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
import { buildStats, percentage, shotImpact, strategyReview, type MatchStats, type ShotBreakdown } from "./analytics.ts";
import { DATASET_VERSION } from "./model.ts";
import type { MatchRecord, PlayerKey, ShotType } from "./model.ts";
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

/** Section 18: a rate is never shown without the sample it came from. */
const rate = (numerator: number, denominator: number) =>
  denominator ? `${numerator}/${denominator} (${percentage(numerator, denominator)})` : "— (n=0)";

const signed = (value: number) => `${value >= 0 ? "+" : ""}${value}`;
const impactCell = (breakdown: ShotBreakdown) =>
  breakdown.total ? `${signed(shotImpact(breakdown))} <span class="muted">(${breakdown.winners}W−${breakdown.errors}E, n=${breakdown.total})</span>` : `— <span class="muted">(n=0)</span>`;

const SHOT_TYPES: ShotType[] = ["groundstroke", "slice", "volley", "drop_shot", "lob", "overhead"];
const SHOT_LABELS: Record<string, string> = {
  groundstroke: "Groundstroke", slice: "Slice", volley: "Volley", drop_shot: "Drop shot",
  lob: "Lob", overhead: "Overhead", approach_shot: "Approach shot", passing_shot: "Passing shot",
  cross_court: "Cross-court", inside_out: "Inside-out", inside_in: "Inside-in",
};
const RALLY_RANGES = ["1-5", "6-10", "11-20", "21+"] as const;
const WINNER_PATTERNS = ["approach_shot", "passing_shot", "cross_court", "inside_out", "inside_in"] as const;

function statRows(stats: MatchStats): [string, string, string][] {
  const side = (key: PlayerKey) => stats[key];
  return [
    ["Points won", String(side("my").pointsWon), String(side("opponent").pointsWon)],
    ["Service points won", rate(side("my").servicePointsWon, side("my").servicePoints), rate(side("opponent").servicePointsWon, side("opponent").servicePoints)],
    ["Return points won", rate(side("my").returnPointsWon, side("opponent").servicePoints), rate(side("opponent").returnPointsWon, side("my").servicePoints)],
    ["First serves in", rate(side("my").firstServesIn, side("my").servicePoints), rate(side("opponent").firstServesIn, side("opponent").servicePoints)],
    ["First-serve points won", rate(side("my").firstServePointsWon, side("my").firstServesIn), rate(side("opponent").firstServePointsWon, side("opponent").firstServesIn)],
    ["Second-serve points won", rate(side("my").secondServePointsWon, side("my").secondServePoints), rate(side("opponent").secondServePointsWon, side("opponent").secondServePoints)],
    ["Aces", String(side("my").aces), String(side("opponent").aces)],
    ["Double faults", String(side("my").doubleFaults), String(side("opponent").doubleFaults)],
    ["Break points converted", rate(side("my").breakPointsConverted, side("my").breakPointsEarned), rate(side("opponent").breakPointsConverted, side("opponent").breakPointsEarned)],
    ["Break points saved", rate(side("my").breakPointsSaved, side("my").breakPointsFaced), rate(side("opponent").breakPointsSaved, side("opponent").breakPointsFaced)],
    ["Longest point streak", String(side("my").longestStreak), String(side("opponent").longestStreak)],
  ];
}

function shotRows(stats: MatchStats): [string, string, string][] {
  const side = (key: PlayerKey) => stats[key];
  return [
    ["Forehand impact", impactCell(side("my").strokeOutcomes.forehand), impactCell(side("opponent").strokeOutcomes.forehand)],
    ["Backhand impact", impactCell(side("my").strokeOutcomes.backhand), impactCell(side("opponent").strokeOutcomes.backhand)],
    ["Net conversion", rate(side("my").netPlay.winners, side("my").netPlay.total), rate(side("opponent").netPlay.winners, side("opponent").netPlay.total)],
    ["Return quality", `${signed(side("my").returnWinners - side("my").returnErrors)} (${side("my").returnWinners}W−${side("my").returnErrors}E)`, `${signed(side("opponent").returnWinners - side("opponent").returnErrors)} (${side("opponent").returnWinners}W−${side("opponent").returnErrors}E)`],
    ["Winners", String(side("my").winners), String(side("opponent").winners)],
    ["Errors forced", String(side("my").forcedErrors), String(side("opponent").forcedErrors)],
    ["Unforced errors", String(side("my").unforcedErrors), String(side("opponent").unforcedErrors)],
    ...SHOT_TYPES.map((type): [string, string, string] => [
      SHOT_LABELS[type]!,
      impactCell(side("my").shotTypeOutcomes[type]),
      impactCell(side("opponent").shotTypeOutcomes[type]),
    ]),
    ...RALLY_RANGES.map((range): [string, string, string] => [
      `Points won · ${range} shots`,
      String(side("my").rallyWins[range] ?? 0),
      String(side("opponent").rallyWins[range] ?? 0),
    ]),
    ...WINNER_PATTERNS.map((pattern): [string, string, string] => [
      `${SHOT_LABELS[pattern]} winners`,
      String(side("my").winnerPatterns[pattern]),
      String(side("opponent").winnerPatterns[pattern]),
    ]),
  ];
}

const table = (left: string, right: string, rows: [string, string, string][]) =>
  `<table><thead><tr><th>Statistic</th><th>${esc(left)}</th><th>${esc(right)}</th></tr></thead><tbody>${
    rows.map(([label, a, b]) => `<tr><td>${esc(label)}</td><td>${a}</td><td>${b}</td></tr>`).join("")
  }</tbody></table>`;

export function buildCoachReport(match: MatchRecord, options: CoachReportOptions = DEFAULT_REPORT_OPTIONS) {
  const stats = buildStats(match.events, match.config);
  const pressure = buildPressureAnalytics(match);
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

  const pressureRow = (key: PlayerKey) => rate(pressure[key].won, pressure[key].played);
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
@media print{body{background:#fff;padding:0}.card{break-inside:avoid;border-color:#ccc}}
</style></head><body>
<p class="muted small">BASELINE · READ-ONLY COACH REPORT</p>
<h1>${esc(match.config.myPlayerName)} vs. ${esc(opponent)}</h1>
<p class="scoreline">${esc(scoreSummary(score, match.config))} · ${winnerLine}</p>
<p class="muted small">${esc(match.config.date ?? "")}${match.config.tournamentName ? ` · ${esc(match.config.tournamentName)}` : ""}${match.config.round ? ` · ${esc(match.config.round)}` : ""}${match.config.location ? ` · ${esc(match.config.location)}` : ""} · ${esc(match.config.format.replaceAll("_", " "))} · ${match.config.adScoring ? "ad" : "no-ad"} scoring</p>

${score.sets.length ? `<section class="card"><h2>Set by set</h2><div class="scroll"><table class="timeline-table"><thead><tr><th>Set</th><th>Score</th><th>Won by</th></tr></thead><tbody>${setSummary}</tbody></table></div></section>` : ""}

${options.matchStats ? `<section class="card"><h2>Match statistics</h2><div class="scroll">${table(match.config.myPlayerName, opponent, statRows(stats))}</div>
<h3>Pressure points</h3><div class="scroll">${table(match.config.myPlayerName, opponent, [["Pressure points won", pressureRow("my"), pressureRow("opponent")]])}</div>
<p class="muted small">Pressure context is derived from the score immediately before each tracked point. A point can belong to more than one pressure category; the total counts it once.</p></section>` : ""}

${options.shotAnalytics ? `<section class="card"><h2>Shot analytics</h2><div class="scroll">${table(match.config.myPlayerName, opponent, shotRows(stats))}</div>
<p class="muted small">Impact is the point endings that won the point minus the ones that lost it, shown as +/− with wins, errors, and sample size. A winner, return winner, or forced error is credited to the point winner; an unforced error or return error to the point loser. Based only on observed point-ending shots—not every stroke in the rally.</p></section>` : ""}

<section class="card"><h2>Observations</h2>${review.evidence.length ? `<ul>${review.evidence.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>` : "<p class=\"muted\">Not enough tracked points yet to support an observation.</p>"}
<p class="muted small">Observations restate what the statistics above show. They are not inferences.</p>
${options.recommendations ? `<h2>Recommendations</h2><p class="pre-line">${esc(review.response)}</p>` : ""}</section>

${options.timeline ? `<section class="card"><h2>Point timeline</h2><div class="scroll"><table class="timeline-table"><thead><tr><th>#</th><th>Won by</th><th>Outcome</th><th>Shot</th><th>Score</th></tr></thead><tbody>${timeline || "<tr><td colspan=\"5\" class=\"muted\">No points recorded.</td></tr>"}</tbody></table></div></section>` : ""}

${options.mentalStates ? `<section class="card"><h2>Mental-state progression</h2><p class="muted small">Subjective courtside observations—not psychological, medical, or diagnostic claims.</p><ul>${mental || "<li>Not observed</li>"}</ul></section>` : ""}

<section class="card"><h2>Data quality</h2>
<p>${stats.directlyTrackedPoints} of an estimated ${stats.estimatedTotalPoints} points were tracked directly (${stats.coverage}% coverage). ${stats.completeShotDetails} points carry complete shot details. ${stats.scoreSyncs} score synchronization${stats.scoreSyncs === 1 ? "" : "s"} recorded.</p>
<p class="muted small">Points added only through score synchronization are excluded from detailed statistics, so shot samples can be smaller than the point count. Optional shot data may be incomplete.</p></section>

<footer class="muted small">Generated ${new Date().toISOString()} · dataset ${DATASET_VERSION} · event cutoff ${match.events.length} · report v2${options.opponentIdentity ? "" : " · opponent identity withheld"}${options.mentalStates ? "" : " · mental-state observations withheld"}</footer>
</body></html>`;
}
