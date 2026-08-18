# Baseline Tennis Tracker — Requirements

**Status:** MVP delivered and deployed; cloud sync, hosted API, and sharing delivered beyond MVP  
**Requirements version:** 1.3
**Experience reference:** `baseline-clickthrough.html` (MVP Experience v1.0)  
**Product type:** Mobile-first installable web application (PWA)  
**Deployment:** Cloudflare Workers at `baseline.jamesvibecode.com`

## 0. Implementation status

Sections 1–20 describe the MVP and are implemented unless noted here. This section records what changed since version 1.2 and what remains open. Where the build deviates from a stated requirement, the deviation is named rather than quietly folded into the text.

### Delivered beyond the MVP

Three items were promoted out of section 21 and built:

- **Cloud storage and cross-device backup.** Match events are mirrored to Cloudflare D1. Push-only by design — see the open items.
- **Live sharing with another spectator.** A revocable, expiring link shows the score, statistics, and timeline as the match is tracked, updating over a WebSocket.
- **Hosted API access.** Section 17's read-only contract is live at `/api/v1`, no longer contingent on future work.

Additionally:

- **Account authentication.** A single account password, stored only as a PBKDF2 hash, exchanged at sign-in for an HttpOnly session cookie. Section 17 required hosted access to be authenticated and revocable but did not say how. Failed logins are throttled per IP.
- **Hosted coach reports.** The report is published as a private page rather than produced as a file.
- **Derived match-structure events.** `game_completed`, `set_completed`, `match_completed`, `player_retired`, `strategy_requested`, and `event_corrected` complete the section 15 event list.
- **Set and game numbers on every point**, as section 13 requires.
- **A one-command dataset download** for a second machine, so analysis does not require the tracking device.

### Corrections to earlier requirements

- **Offline-first is for connectivity resilience, not privacy.** Version 1.2 framed offline capture as a privacy measure. That was wrong: courts frequently have no usable cellular service, and tracking must survive it. Privacy is enforced separately, by keeping hosted access off by default and redacting shared data server-side.
- **Shot impact is a net figure.** Section 12's forehand and backhand impact were implemented as raw counts of observed point-endings, so errors incremented the same total as winners. They are now point-endings that won the point minus those that lost it.
- **Net conversion is defined.** Section 12 named the metric without defining it. It now means points ended at the net, by volley or overhead; a drop shot is usually struck from the baseline and is excluded.

### Accepted deviations

- **The standalone coach-report download was removed** from the Reports screen at the product owner's request. Section 18 asks for both a hosted page and a self-contained download. The download form survives inside the analysis bundle as `match-report.html`, but there is no longer a one-tap way to produce a coach report without cloud sync configured.
- **Password hashing runs at 100,000 PBKDF2 iterations**, the maximum Cloudflare Workers will execute and below the current OWASP recommendation for PBKDF2-HMAC-SHA256. The per-IP login throttle and a 12-character minimum compensate. Raising it needs a KDF the platform does not expose.

### Open items

Deferred deliberately, pending more collected data:

1. **Cross-match export endpoint.** Every data route is scoped to one match. Bulk retrieval loops per match; the download script does that client-side.
2. **Tournament, season, and opponent trend analysis.** A tournament key is stored and filterable, but nothing aggregates across matches.

Known gaps, not yet scheduled:

3. **Synchronization is push-only.** A second device never receives matches. This is intentional for a phone-first workflow; the dataset reaches a laptop through the download script instead.
4. **`player_retired` has no user interface.** The event type, projection, timeline entry, and export are implemented, but nothing emits it, because adding a courtside control would change a frozen interface. Section 4 expects retirement to be recordable.
5. **`event_corrected` is never emitted.** Score synchronization and point undo are the concrete corrections; the generic type exists for imported and future data.
6. **A stale strategy review is computed but not shown in the app.** Section 14 requires a review to be marked stale once a point it analyzed is undone. The flag reaches exports and the API only.
7. **A report link renders the match as it stands when opened**, not as it stood when the link was created. Section 18 requires a shared report to be an immutable snapshot, with corrections producing a new version rather than silently changing what a coach already reviewed. Storing the event cutoff on the link would close this.
8. **Sign-in has no automated browser test.** The API flow is covered end to end; the browser path is verified by hand.

## 1. Product purpose

Baseline helps a parent track a junior tennis match from courtside with extremely fast, one-handed input. It records both players symmetrically, works without reliable cellular service, shows useful live statistics, preserves a complete point-by-point record, and makes the dataset portable for future analysis by Codex, Claude, or other tools.

The interface must prioritize accurate score capture. Optional details must never block entry of the next point.

## 2. MVP goals

- Record a match accurately with minimal taps.
- Track both players' serves, returns, point outcomes, final-shot details, rally ranges, and observable mental states.
- Recover cleanly when the parent misses one or more points.
- Show the complete match score and useful two-player live statistics.
- Preserve an append-only event history for undo, corrections, timelines, exports, and analysis.
- Operate offline during match tracking.
- Provide an on-demand LLM strategy review using the cumulative dataset for both players.
- Export lossless, vendor-neutral data.
- Preserve an API-ready, versioned dataset that can later be downloaded or explicitly shared with Codex, Claude, or another analysis tool.
- Correlate results and trends across matches through stable player profiles.
- Generate a privacy-controlled match report that can be shared with a coach.

## 3. Platform and technical direction

- React and TypeScript mobile-first PWA.
- IndexedDB for device-local match storage and offline recovery.
- Service worker and installable web-app manifest.
- Event-sourced match model: saved events are authoritative; scores and statistics are projections.
- Cloudflare-based hosting for the web application. Delivered as a Vite and React SPA on Workers Assets, with a Worker serving `/api/*` and `/report/*`.
- Cloudflare D1 as the hosted event store, mirroring the device's log. One Durable Object per match orders appends and fans new events out to live spectators.
- Each hosted capability degrades independently: with no database binding the API answers 503 and tracking is unaffected; with no Durable Object binding live updates stop and everything else keeps working; with no credential configured hosted access stays off entirely.
- Vendor-neutral analysis interface so an approved LLM provider can be changed later.
- Automated scoring-engine tests covering all supported formats, tiebreaks, undo, and score synchronization.

## 4. Player and match setup

Required setup fields:

- My player profile
- Opponent profile, new opponent, or guest opponent name
- Match format
- First server
- Ad scoring switch

Optional setup fields:

- USTA tournament URL
- Tournament name and round
- Match date, court, location, and notes
- My Player Starting State
- Opponent Starting State

The tournament URL is stored with the match. Matches sharing a normalized tournament identifier or URL can be grouped for tournament analysis. Automated USTA-page import is not part of the MVP.

### Player profiles and match identity

The app maintains stable player profiles so results can be correlated across matches even if a display name changes.

- At least one persistent **My Player** profile is supported for the tracked child/player.
- Match setup selects the My Player profile rather than creating a new free-text identity for every match.
- An opponent can be selected from an existing profile, created as a new profile, or entered as a temporary guest and linked to a profile later.
- Every profile has a stable player ID, display name, role, created and updated timestamps, and optional aliases, handedness, USTA player identifier or profile URL, and notes.
- Each match stores stable profile IDs plus a snapshot of the display names used on match day, preserving historical reports when a profile is renamed.
- Profile merge and guest-link operations preserve original match and event IDs and create an auditable identity-mapping record.
- A match cannot reference the same profile as both players.

Profile views aggregate authorized matches by player, opponent, tournament, date range, match format, serve and return performance, shot outcomes, pressure situations, mental-state observations, and win/loss result. Every aggregate discloses match count, tracked-point count, and data coverage. Profiles and longitudinal comparisons remain private by default.

### Mental-state choices

- Positive
- Focused
- Tense
- Frustrated
- Disengaged
- Not observed

“Retired / stopped match” is stored separately as a match-status event, not as a mental state.

## 5. Supported match formats

### Best of 3 · Tiebreak sets

- First to 6 games, win by 2.
- A 7-point tiebreak is played at 6–6 in every set.
- Tiebreak winner must win by 2 points.

### Best of 3 · 10-point match tiebreak in the third

- First two sets are first to 6 games, win by 2.
- A 7-point tiebreak is played at 6–6.
- A deciding third set is replaced by a 10-point match tiebreak, win by 2.

### Best of 3 · Short sets to 4

- First to 4 games.
- A 7-point tiebreak is played at 3–3.
- Tiebreak winner must win by 2 points.

### Best of 3 · Short sets plus match tiebreak

- First two sets are short sets to 4.
- A 7-point tiebreak is played at 3–3.
- A deciding third set is replaced by a 10-point match tiebreak, win by 2.

### Pro 8

- One set, first to 8 games and always win by 2 games.
- No tiebreak.
- Play continues until one player leads by 2 games.

## 6. Game and tiebreak scoring

The **Ad scoring** switch controls game scoring:

- On: Love, 15, 30, 40, deuce, advantage, game. A player must win two consecutive points from deuce.
- Off: Love, 15, 30, 40; the next point at 40–40 wins the game.

At 5–5 in a standard set, play continues to 7–5 or 6–6. At 6–6, the configured tiebreak begins.

In a tiebreak:

- Points are numeric.
- The first server serves one point.
- The opponent serves the next two points.
- Service then alternates every two points.
- Players change ends after every six points.
- A 7-point or 10-point tiebreak must be won by 2.

The engine automatically determines games, sets, serving order, tiebreak mode, break points, holds, breaks, and match completion.

## 7. Live scoreboard

The tracking screen must always show:

- Both player names
- Serving player
- All completed-set scores
- Current-set game score
- Current-game point score or numeric tiebreak score
- Undo control
- Mental-state indicator for my player
- Access to score synchronization

Two ball indicators represent the server's available serve attempts:

- New point: two balls visible.
- First fault: one ball is removed and the app moves to second serve.
- Second fault: the final ball is removed, a double fault is recorded, and the receiver wins the point.
- The next point restores both balls.

## 8. Point-entry workflow

### Stage A — Serve

Choices:

- Serve In
- Fault
- Ace

Rules:

- Serve In advances to point-winner entry.
- Ace records a successful serve and awards the point to the server.
- First Fault records a fault and advances to second serve.
- Second Fault automatically records a double fault and awards the point to the receiver.

### Stage B — Point winner

Two large controls:

- Point to my player
- Point to opponent

The score updates and saves immediately.

### Stage C — Optional point ending

No option is preselected.

Row 1:

- Return Winner
- Return Error

Row 2:

- Winner
- Forced Error
- Unforced Error

Selecting an outcome opens the optional details tray beneath **Skip details**.

### Outcome eligibility and validation

Return outcomes must agree with the server, receiver, and recorded point winner:

- **Return Winner** is available only when the receiver won the point after a serve was put in. If the server won the point, Return Winner is unavailable.
- **Return Error** is available only when the server won the point because the receiver made the point-ending return error. If the server lost the point, Return Error is unavailable.
- An ace is recorded automatically as an Ace and cannot also receive a return outcome.
- A double fault is recorded automatically as a Double Fault and cannot also receive a return outcome.
- The point-entry interface hides or disables outcomes that contradict the saved serve and point-winner context.
- Domain validation applies the same rules to tracked, corrected, imported, and re-imported data. Contradictory events are rejected or explicitly flagged for correction; they are never silently included in statistics.

### Outcome attribution

- Winner: final-stroke, shot-type, and advanced shot-type details belong to the point winner.
- Return Winner: details belong to the point winner.
- Return Error: details belong to the point loser.
- Forced Error: details belong to the point loser.
- Unforced Error: details belong to the point loser.

The stored event separately identifies the point winner, point loser, server, receiver, outcome, responsible player, and benefiting player.

### Rally length

Ranges:

- 1–5
- 6–10
- 11–20
- 21+

For Return Winner or Return Error, 1–5 is selected automatically. For all other outcomes, rally length starts unselected.

### Final stroke

No default:

- Forehand
- Backhand
- Neither

Final Stroke is presented on one line in the mobile experience.

### Shot type

No default.

Row 1:

- Groundstroke
- Slice
- Volley

Row 2:

- Drop Shot
- Lob
- Overhead

### Shot type — Advanced

Advanced shot type is optional and has no default.

Row 1:

- Passing Shot
- Cross-Court

Row 2:

- Inside-Out
- Inside-In

Advanced options appear two per line.

### Detail completion behavior

The details tray contains four independent sections:

1. Rally Length
2. Final Stroke
3. Shot Type
4. Shot Type — Advanced

If all four sections have selections, the app saves the details and automatically advances to the next point. If any section is incomplete, a clear **Continue to next point** action saves the available selections and advances without requiring the remaining optional values.

## 9. Mental-state events

Mental state is optional and can be recorded:

- After any point
- At the end of a game
- At the end of a set
- Manually whenever an observable change occurs

The current state remains active until changed. End-of-game reminders are non-blocking.

Each mental-state event stores:

- Player ID
- Observed state
- Previous state
- Timestamp and event sequence
- Set, game, and point context
- Current server
- Linked most-recent point
- Capture moment: after point, game end, set end, or manual
- Optional reason and note

These are parent observations, not psychological diagnoses.

## 10. Missed-point recovery and corrections

The parent can set:

- The current live set's game score for each player
- The current game's point score for each player, separately from games
- Current server
- Tiebreak score when applicable

The score editor opens the current live set and shows completed sets as read-only context. Its game controls and point controls mirror the live scoreboard.

If a corrected current-set score is a legal completed-set score, such as 6–4 or 7–5, the app marks the set complete, clears the current-game point score, saves the corrected set, and updates the live scoreboard. It then determines from the configured match format whether the match is complete or a new set should begin.

If the corrected set score is 7–6, the app requires the final numeric tiebreak score before confirmation. The tiebreak winner must match the set winner and the tiebreak must be won by at least 2 points. The scoreboard preserves both the 7–6 set score and its tiebreak score.

When the current live set is at 6–6 and its tiebreak is still in progress, the point editor switches from tennis points to numeric tiebreak points and applies the configured tiebreak target and win-by-2 rule.

The app records a `score_sync` event rather than inventing missing points. The event contains the prior score snapshot, corrected score snapshot, current server, completed-set state, optional tiebreak score, format validation result, timestamp, and tracking-coverage impact. Unknown points are excluded from detailed statistics. The app displays estimated tracking coverage.

### Point undo

Undo operates on the latest saved point as one atomic group, not on the latest individual tap.

- One tap undoes the most recently saved point.
- The parent can undo up to five consecutive saved points.
- There is no redo operation.
- Each undo removes the point and every event linked to that point from active match projections, including serve attempts, point outcome, rally range, final stroke, shot type, advanced shot type, point-linked mental-state observation, and automatically derived game or set completion.
- The live score, serving context, statistics, shot quality, tracking coverage, and point-by-point timeline are recomputed immediately after each undo.
- After five available point groups have been consumed, no older point can be undone from the courtside Undo control.

For event-log integrity, the implementation appends a `point_undone` event referencing the point group and marks its linked events voided. Voided events disappear from active views and ordinary statistics but remain identifiable in the lossless audit export. A later strategy request excludes them. A previously generated strategy review is marked stale if its dataset included an undone point.

Corrections create compensating events that reference the affected event.

## 11. Live statistics

Live statistics compare both players and update after every event.

### Score and points

- Full match score
- Total points won
- Service points won
- Return points won
- Longest point-winning streak
- Break points earned, converted, faced, and saved
- Holds and breaks

### Service

- Aces
- Double faults
- First serves in
- First-serve percentage
- First-serve points won
- Second-serve points won
- Service games held and broken

### Return

- First-serve return points won
- Second-serve return points won
- Return winners
- Return errors
- Break points won

### Shot statistics

- Winners
- Forced errors
- Unforced errors
- Forehand and backhand outcomes
- Shot-type and advanced shot-type outcomes
- Points won by rally-length range

### Pressure situations and points won

Pressure context is derived from the score snapshot immediately before each point and the active match-format rules. The app reports, separately for both players:

- Pressure points played, won, and win percentage
- Pressure points won while serving and while returning
- Points won at 30–30 or later in a standard game
- Deuce and advantage points won
- No-ad deciding points won
- Break points created, converted, faced, and saved
- Game points, set points, and match points won and lost
- Tiebreak points won, including points at 5–5 or later in a 7-point tiebreak and 8–8 or later in a 10-point match tiebreak
- Points won by first serve, second serve, return, rally-length range, and active mental-state observation

A point can belong to more than one named pressure category, such as both a break point and a set point. The overall pressure-points total counts each point only once. Every rate displays its numerator, denominator, sample size, and tracking coverage; the interface does not use unsupported labels such as “clutch.” Points added only through score synchronization are excluded when their point-level score context is unknown.

### Data quality

- Estimated total points
- Directly tracked points
- Points with complete shot details
- Number of score synchronizations

## 12. Shot-quality metrics

Shot quality is shown separately for each player using a player dropdown.

Initial derived metrics:

- **Forehand impact** — forehand point-endings that won the point minus those that lost it
- **Backhand impact** — the same, for backhands
- **Net conversion** — points ended at the net, by volley or overhead, won as a share of those observed. A drop shot is usually struck from the baseline and is not counted as net play.
- **Return quality** — return winners minus return errors
- **Outcomes by rally range** — points won within each rally-length band

An impact metric is a net figure, never a count of observations: three forehand winners against five forehand unforced errors is −2 over a sample of eight, not +8.

Which side of an impact figure a shot lands on follows the attribution rules in section 8. A winner, return winner, or forced error belongs to the point winner and counts toward their winning total; an unforced error or return error belongs to the point loser and counts against them. The owner's winning bucket is therefore exactly the point-endings that owner won.

Shot quality is based only on observed point-ending shots. It must not imply that every stroke in the rally was evaluated. Each metric displays its sample size and supporting calculation.

## 13. Point-by-point match timeline

Every recorded point appears in sequence and stores or derives:

- Stable point ID and sequence number
- Match timestamp
- Set and game number
- Score before and after
- Server and receiver
- Serve attempts and result
- Point winner and loser
- Point-ending outcome
- Responsible player
- Rally-length range
- Final-stroke player and selection
- Shot-type player and selection
- Advanced shot-type player and optional selection
- Active mental-state context for both players
- Whether the point was tracked, corrected, imported, or reconstructed

Mental-state changes, score synchronizations, game completion, set completion, corrections, and retirements also appear in the timeline.

## 14. On-demand LLM strategy review

The strategy review can be requested at any point in the match or afterward. It is not limited to set completion. Its usefulness should improve as data coverage grows.

Canonical analysis question:

> Given the collected dataset for both my player and the opponent through the current point, what is the recommended strategy for my player?

The request includes:

- Score context and match format
- Service and return statistics for both players
- Point outcomes and rally ranges
- Final-stroke, shot-type, and optional advanced shot-type data
- Shot-quality metrics
- Mental-state observations
- Momentum and score-pressure context
- Missing-data and coverage information

Every recommendation must:

- Be supported by visible statistics or event evidence.
- Distinguish observation from inference.
- State material data limitations.
- Avoid psychological or medical diagnoses.
- Include a reminder to follow applicable tournament coaching rules.

Every generated review stores:

- Review ID and match ID
- Data cutoff event sequence
- Included event IDs or deterministic dataset version
- Model provider and model identifier
- Prompt-template version
- Request timestamp and response timestamp
- Generated response
- Evidence references
- Coverage summary

Match tracking remains offline. Strategy requests require connectivity and can be queued until a connection is available. No child or match data is sent to an LLM without explicit user action.

## 15. Authoritative event model

The app uses immutable, ordered events. Minimum event types:

- `match_created`
- `match_started`
- `serve_attempted`
- `point_completed`
- `mental_state_changed`
- `score_synced`
- `event_corrected`
- `point_undone`
- `game_completed`
- `set_completed`
- `match_completed`
- `player_retired`
- `strategy_requested`
- `strategy_generated`

Every event contains:

- Event ID
- Match ID
- Schema version
- Monotonic sequence number
- Event type
- Timestamp
- Source: tracked, automatic, corrected, imported, or analysis
- Actor or subject player IDs when applicable
- Payload specific to the event
- Reference to a corrected or preceding event when applicable

The point-completion event contains a score snapshot before and after the point plus all observed point details. Derived projections can always be rebuilt from the event log.

Match records reference stable player-profile IDs while retaining match-day display-name snapshots. Profile merges change identity projections, not the immutable historical point events.

## 16. Offline persistence and recovery

Offline capture exists for connectivity resilience, not privacy: courts frequently have no usable cellular service, and tracking must never be interrupted by a dropped connection. Privacy is enforced separately, in sections 17 and 19.

- Every action is saved immediately to IndexedDB.
- An unfinished match resumes after refresh, browser termination, or device restart.
- Match tracking works without network access.
- The UI clearly shows local-save and analysis-connectivity state.
- Background synchronization cannot change the local event order.

## 17. Data portability and analysis API

The MVP exports one match or all matches as a portable bundle containing:

- `matches.csv`
- `players.csv`
- `points.csv`
- `serves.csv`
- `shots.csv`
- `mental_states.csv`
- `score_syncs.csv`
- `events.json`
- `schema.json`
- `manifest.json`
- `match-report.html` when a coach report is included

Requirements:

- Lossless JSON event history
- Analysis-friendly CSV tables
- Stable IDs and schema versioning
- Re-import support
- Optional anonymization of player and opponent names
- No vendor lock-in
- A one-tap analysis-bundle download suitable for upload to Codex, Claude, or another analysis system

### API-ready access

The authoritative event model must also support a documented, versioned, read-only API contract for future direct analysis access. The contract includes:

- List matches available to the authenticated user
- Retrieve match metadata, players, tournament grouping, score projections, and calculated statistics
- Retrieve the ordered, lossless event log for a match
- Retrieve point, serve, shot, mental-state, score-correction, and strategy-review records
- Download one match, one tournament, or all authorized data in JSON or CSV bundle form
- Filter or paginate by match, tournament, event sequence, and update timestamp
- Return schema version, dataset version, generation timestamp, coverage, and anonymization status with every export

Device-local records are not exposed to a hosted API unless the user explicitly enables an upload or cloud-sync capability. Hosted API access is disabled by default, authenticated, read-only, user-scoped, and revocable. A Codex, Claude, or other third-party analysis session receives data only through an explicit user download or an explicitly granted API credential. The API representation must match the downloadable event schema so analyses remain reproducible and vendor-neutral.

**Status: delivered.** The contract is served at `/api/v1` and `GET /api/v1/schema` documents it without credentials. Two credentials are accepted: a session cookie obtained by signing in with the account password, for the app; and a bearer token, for scripts and analysis tooling where no browser holds a cookie. With neither configured every route answers 503, which is how "disabled by default" is enforced rather than merely stated.

Every response carries the schema version, dataset version, generation timestamp, coverage, and anonymization status.

Retrieval is per match. A single call returning every match's tables is an open item, so bulk retrieval currently loops; `npm run pull` does that and writes a combined dataset to a second machine without that machine syncing matches into its own store.

## 18. Shareable coach match report

After a match, the user can create a read-only match-result report designed for review with a coach. The report is published as a private, mobile-friendly web page at `/report/<token>`, rendered server-side.

The report includes shot analytics for both players — stroke impact, net conversion, return quality, per-shot-type impact, points won by rally length, and winner patterns — alongside the service, return, point, and pressure statistics.

**Deviation:** the standalone self-contained HTML download was removed from the Reports screen at the product owner's request. The download form survives inside the analysis bundle as `match-report.html`. A coach report therefore now requires cloud sync to be configured.

The report includes:

- Player names, tournament context, date, match format, winner, and complete final score
- Two-player service, return, point, pressure, and shot statistics with numerator, denominator, sample size, and tracking coverage
- Evidence-based match analysis derived from the displayed statistics, clearly separating observations from recommendations
- Set-by-set and point-by-point match timeline, including score progression, breaks, holds, tiebreaks, corrections, and important momentum changes
- Mental-state progression for the tracked player, and for the opponent when observed, aligned to points, games, and sets
- Data-quality disclosures for missed points, score synchronizations, incomplete shot details, and subjective mental-state observations
- Generation timestamp, dataset version, match event cutoff, and report version

Before generating or sharing, the user can include or exclude opponent identity, tournament link, detailed point timeline, mental-state graph, mental-state notes, and coaching recommendations. The default coach report excludes free-form private notes.

The self-contained HTML report can be created from device-local data without uploading the full match. Creating a hosted share link requires connectivity and an explicit user action. Hosted reports are private by default, use an unguessable read-only link or named-recipient access, are excluded from search indexing, and can be revoked. Optional link expiration is supported. Sharing one report never grants access to other matches, player profiles, raw API endpoints, or future profile data.

A shared report is an immutable snapshot of the selected dataset and privacy choices. Regenerating analysis or correcting the match creates a new report version and marks older versions as out of date; it does not silently change what a coach previously reviewed.

**Open item:** a report link currently renders the match as it stands when the page is opened, not as it stood when the link was created. Privacy choices are frozen with the link and enforced server-side — the link's own flags overrule the stored report options, so a link can never disclose more than it was created with — but the dataset is not yet frozen. Storing the event cutoff on the link would close this.

## 19. Privacy

- Match and mental-state data remain on the device by default. Offline capture is for connectivity resilience; privacy comes from hosted access being off until enabled, and from server-side redaction of anything shared.
- Live and report links exclude mental-state observations unless explicitly included, and exclude free-form notes even then. The opponent is shown as initials by default and can be hidden entirely.
- Redaction happens in the Worker before data leaves it, so a shared page cannot opt back in to what its link excludes.
- External analysis is always user initiated.
- Exports can be anonymized.
- Observed mental states are labeled as subjective observations.
- The product does not make psychological, medical, or diagnostic claims.
- Player profiles and cross-match history are private by default.
- Mental-state details are excluded from coach reports unless the user explicitly includes them.
- Share links are user initiated, read-only, scoped to one report, and revocable.

## 20. MVP acceptance criteria

The MVP is complete when:

1. All supported formats score correctly through match completion.
2. Advantage, no-ad, 7-point tiebreak, and 10-point match-tiebreak behavior pass automated tests.
3. First and second faults update the two-ball indicator and double faults award the point automatically.
4. Either player can win a point and receive correct serve, return, outcome, shot, and error attribution.
5. Optional details can be skipped without delaying the next point.
6. Mental state can be recorded after a point or at game/set boundaries for either player.
7. A missed-score synchronization resumes tracking without inventing point details.
8. Undo removes the latest point and all linked events, supports up to five consecutive point undos, offers no redo, immediately recomputes the live match, and preserves an auditable void record.
9. The scoreboard shows all completed sets, the current set, and current point score.
10. Live statistics update for both players and disclose data coverage.
11. Shot-quality metrics can be viewed separately for either player.
12. Every tracked point appears in a point-by-point timeline.
13. An interrupted match resumes offline from its last saved event.
14. JSON and CSV exports reproduce the complete event history.
15. An on-demand strategy request uses both players' data and records its model, prompt, cutoff, evidence, and coverage.
16. Primary courtside controls meet a minimum 44 × 44 CSS-pixel touch target.
17. Return Winner and Return Error choices are limited by server, receiver, serve result, and point winner, and contradictory events fail validation.
18. Pressure analytics show points won, points played, percentage, sample size, and coverage for both players using score-before-point context.
19. A user can download a complete, versioned analysis bundle, and the documented future API contract preserves the same authoritative dataset for explicit Codex or Claude access.
20. Stable player profiles associate the same player with multiple matches and support opponent reuse or later guest linking without rewriting historical events.
21. Profile analytics aggregate only authorized matches and disclose match count, tracked-point count, and coverage.
22. A user can generate a mobile-friendly, self-contained coach report containing the selected result, statistics, evidence-based analysis, timeline, and mental-state progression.
23. A hosted coach-report link requires explicit sharing, exposes only the selected report, and can be revoked without affecting the underlying match.

## 21. Future enhancements

Delivered since version 1.2:

- ~~Encrypted cloud backup and cross-device synchronization~~ — delivered as push-only synchronization to Cloudflare D1. Matches are never synchronized back down to a second device, by choice; a laptop obtains the dataset through the download script.
- ~~Live sharing with another spectator~~ — delivered as revocable, expiring, server-redacted live links.

Outstanding, in the order they are likely to matter:

- Cross-match export in a single request
- Tournament, season, and opponent trend analysis
- Advanced profile merge suggestions and duplicate-player detection
- Automated USTA tournament metadata import when permitted — **blocked, see section 23**
- Apple Watch input
- Native iOS packaging or SwiftUI client
- Video synchronization and court-placement diagrams
- Advanced coaching and practice-plan generation

## 22. Experience reference

`baseline-clickthrough.html` is the canonical MVP experience reference for layout, terminology, control grouping, point-entry order, mobile touch sizing, live-stat presentation, timeline presentation, and on-demand strategy review.

The click-through contains illustrative data and does not persist matches. The production implementation must follow this specification when prototype behavior and underlying data integrity differ.

## 23. USTA data import

**Requested:** pull tournament, match, and opponent data for the tracked player from USTA, using the account holder's credentials and the player's USTA ID, so match setup is populated rather than retyped.

**Status: analysed, not scheduled.** `docs/usta-data-integration.md` holds the full analysis. Summary:

- **The data is needed before a match, not after.** What setup wants is the draw — who the player is about to face, in which round. That rules out every downstream source, including Universal Tennis, which receives completed results after a tournament posts them and holds no draws at all.
- A USTA API exists (USTA Connect) and carries the required data, but access is a vetted commercial partnership, not available to individuals, and its documentation is behind a login.
- Scraping the draw page is prohibited by USTA's Terms of Use.
- Driving the site with the account holder's own credentials is also automated access, would reintroduce third-party credential storage that the authentication design deliberately removed, and may not reach the data at all — USTA displays results only for players thirteen or older with their own profile.
- The only option aligned with the moment of need is a **user-supplied import**: the parent is already viewing the draw when the data is required, so Baseline parses what they share or paste and never contacts USTA. Available today, no permission needed, but brittle and name-matched rather than ID-matched.

If access is ever granted, the integration must satisfy:

- Imports run server-side; no USTA credential is ever stored on the device.
- Imported events carry `source: "imported"`, so imported and courtside-tracked data remain distinguishable in every projection, statistic, and export.
- Imported opponents map to existing `PlayerProfile` records, or create guest profiles linked later through identity-mapping records. Import never rewrites historical events or match IDs.
- The importer sits behind an interface with at least two implementations, so a user-supplied paste importer and a hosted API importer are interchangeable and neither is assumed.
- Import is user-initiated and its coverage contribution is disclosed like any other data source.

A user-supplied import — the user shares or pastes a draw they are already looking at, and Baseline parses it without contacting USTA — is the only form available today, and the only one that delivers data at the moment setup needs it. It is a separate requirement and should be scoped on its own merits.
