# Baseline Tennis Tracker

Baseline is a functional, mobile-first tennis match tracker designed for fast, one-handed courtside input. It tracks both players, works offline, rebuilds every score and statistic from an auditable event history, and keeps match data portable.

## MVP status

The functional MVP is implemented. The finalized product definition and approved prototype remain the canonical references:

- [MVP requirements](baseline-mvp-requirements.md)
- [Interactive click-through](baseline-clickthrough.html)

## What the app does

- Runs as an installable mobile web app and saves matches to IndexedDB.
- Supports best-of-three tiebreak sets, 10-point deciding match tiebreaks, short sets, short sets with a deciding match tiebreak, and Pro 8.
- Handles advantage/no-ad games, 7- and 10-point tiebreaks, serving rotation, and win-by-two rules.
- Uses two visible serve balls; a second fault automatically records a double fault.
- Tracks either player as point winner, plus return winners/errors, winners, forced errors, and unforced errors with correct attribution.
- Captures rally range, final stroke, shot type, optional advanced shot type, and observed mental state.
- Shows the full multi-set scoreboard, both-player live statistics, shot-quality samples, tracking coverage, and a point timeline.
- Supports legal score synchronization after missed points and up to five consecutive point-level undos with no redo.
- Exports a lossless event log and analysis-ready CSV content in one portable JSON bundle.
- Offers an explicit, on-demand AI strategy review when a server API key is configured, with an evidence-based on-device fallback.
- Optionally mirrors saved events to Cloudflare D1 and shares a revocable, redacted live link with another spectator.

## Offline behavior

Baseline is offline-first for **resilience**, not isolation: courts frequently have no usable cellular service, and tracking must never be interrupted by a dropped connection. Every action is written to IndexedDB immediately, and scoring, tracking, statistics, timeline, undo, recovery, and export all work with no network at all.

Data is sent for strategy analysis only after the user taps **Ask AI for strategy**. No API key is exposed to the browser.

Observed mental states are subjective courtside observations, not diagnoses.

## Development

Requires Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

Validation:

```bash
npm test
npm run build
```

## Optional hosted strategy review

Copy `.env.example` to `.env`, add a server-side `ANTHROPIC_API_KEY`, and optionally set `STRATEGY_MODEL` (default `claude-opus-4-8`). Without a key, the app transparently returns its on-device evidence review.

The analysis layer is vendor-neutral per the MVP requirements: `worker/strategy/types.ts` defines the provider interface, and adding a vendor means implementing it and registering it in `resolveProvider`. Nothing above that seam knows which model answered.

## Deploying to Cloudflare

Three commands. The first opens a browser and has to be run by hand; the other two are scripted.

```bash
npx wrangler login          # interactive, once per machine
npm run setup:cloudflare    # creates D1, writes its id, migrates, generates SYNC_TOKEN
npm run deploy              # builds and publishes to baseline.jamesvibecode.com
```

You will be asked to choose a password. That password is the only credential you keep, and you keep it in your head — Cloudflare stores a PBKDF2 hash of it, never the password, and the device stores nothing at all. Signing in exchanges it for an HttpOnly session cookie the browser holds and no script can read.

`setup:cloudflare` is safe to re-run — every step checks for its own result first, so a half-finished setup resumes rather than restarting. It never deploys, and it will not overwrite a `SYNC_TOKEN` it cannot first confirm is absent, because replacing a live one would silently stop every device already syncing. Pass `--dry-run` to see what it would do.

A bearer token is offered separately and is optional. It exists for scripts and the read-only analysis API, where there is no browser to hold a cookie. The app never needs one.

### Why a password rather than a stored token

A Worker secret cannot be read by a browser, so the app has to present something of its own. Handing it a long random token means keeping that token somewhere — which is a secret you now have to manage. A password moves the burden to something memorable, and leaves the server holding only a hash.

Consequences worth knowing:

- Changing the password signs out every device, because the session signing key is derived from the stored hash.
- Failed logins are throttled per IP (8 per 15 minutes) in D1, since the endpoint is reachable from anywhere.
- Sessions last 30 days, then require signing in again.

`deploy` bakes the public origin into the build so social-preview images resolve to absolute URLs. It resolves that origin from `VITE_PUBLIC_ORIGIN`, then `.env.production`, then the custom domain in `wrangler.jsonc` — which is how this project runs, so a fresh clone deploys correctly on the first pass with nothing to remember. With none of those, it falls back to deploying once, reading the workers.dev URL back, and rebuilding.

### Custom domain

The app is served from `baseline.jamesvibecode.com`, declared in `wrangler.jsonc`:

```jsonc
"routes": [{ "pattern": "baseline.jamesvibecode.com", "custom_domain": true }],
"workers_dev": false
```

Because the zone is already on Cloudflare, `custom_domain: true` makes wrangler create the DNS record and provision the certificate on the first deploy — nothing to add in the dashboard. Certificate issuance takes a few minutes, so the first request can fail TLS before it succeeds.

`workers_dev` is off deliberately: the workers.dev URL would serve the same app from a second public hostname, which is a needless extra surface for a child's match data and would split the share links people are holding. Turn it back on if you want a staging URL.

If a DNS record for the subdomain already exists, wrangler stops and asks rather than overwriting it — delete the record first, then deploy.

For the hosted AI strategy review, add the key any time:

```bash
npx wrangler secret put ANTHROPIC_API_KEY
```

### What deploying does and does not expose

Publishing puts the tracker at a public URL, but not the data. Matches live in the browser's IndexedDB and never leave the device until cloud sync is switched on with the token. Every `/api/v1` route refuses a request without the bearer token, and answers 503 outright when `SYNC_TOKEN` is unset. Share links are the only public path to match data, and each one is scoped to a single match, redacted server-side, expiring, and revocable.

To take a deployment down: `npx wrangler delete`. To cut off hosted access while leaving it up, delete both secrets with `npx wrangler secret delete AUTH_PASSWORD_HASH` and `npx wrangler secret delete SYNC_TOKEN` — every API route reverts to 503 and the tracker keeps working offline. To sign every device out without disabling anything, set a new password.

## Cloud sync and the analysis API

Hosted access is **off by default**. With neither a password nor a bearer token configured, every `/api/v1` route answers 503, no device data is reachable, and the tracker behaves exactly as it does today: IndexedDB is authoritative and everything works offline.

The Worker then exposes the versioned, read-only contract from requirements section 17 at `/api/v1`, plus the one write route sync needs. `GET /api/v1/schema` documents every route and needs no credentials. Reads require `Authorization: Bearer <SYNC_TOKEN>`.

`POST /api/v1/sync` is idempotent: events are keyed by their client-generated UUID, so replaying a queued outbox after a dropped connection inserts nothing new. The server assigns its own arrival sequence for cursors and never reorders the device's log.

`db/schema.ts` is the schema authority and generates the migrations in `drizzle/`; the Worker itself uses D1's prepared-statement API and carries no ORM.

## Getting the data onto another machine

Matches are tracked on one device and pushed to D1. To pull the whole dataset down somewhere else — a laptop, for analysis — without that machine syncing matches into its own app:

```bash
BASELINE_TOKEN=<SYNC_TOKEN> npm run pull
```

This is what the bearer token is for: the app signs in with a password, scripts authenticate with the token. It writes to `./baseline-data` (gitignored):

- `matches.json` — every match's metadata, final score, and coverage
- `combined/*.csv` — every match stitched into one table per topic, each row carrying its `match_id`, joinable against `combined/matches.csv` for tournament and opponent
- `matches/<date>-<opponent>/` — each match's full bundle, including the lossless `events.json`

The combined tables are plain concatenation of identical-header CSVs, not a summary, so nothing is lost on the way. Re-running overwrites: the event log is append-only, so the newest download is always the complete one.

`BASELINE_URL` overrides the deployment (it defaults to the custom domain in `wrangler.jsonc`), and `BASELINE_OUT` overrides the output directory.

## Share links

`POST /api/v1/matches/:id/share` mints an unguessable read-only link scoped to one match. Links expire in 24 hours unless another window is requested, can be revoked at any time, and return their token exactly once — only a SHA-256 of it is stored.

Redaction happens in the Worker, before anything leaves it:

- Mental-state observations are excluded unless explicitly included, and their free-form notes are excluded even then.
- The opponent shows as initials by default, or can be hidden entirely.
- Private match notes and strategy reviews never travel on a link.
- Revoked, expired, and unknown tokens are all answered identically.

Spectators replay the same `lib/tennis/` projections the tracker uses, so there is no second scoring engine to keep in step.

## Coach reports

A coach report is sent as a link. `POST /api/v1/matches/:id/share` with `kind: "report"` mints `/report/<token>`, a private page the coach opens on any device, rendered server-side by the Worker — no app bundle, no sign-in.

The standalone HTML download was removed from the Reports screen at the product owner's request. Requirements section 18 asks for both a hosted page and a self-contained download; the download form survives inside the analysis bundle as `match-report.html`, but there is no longer a one-tap way to produce a coach report without cloud sync configured.

The report carries a two-player statistics table with numerator, denominator, sample size, and tracking coverage on every rate; **shot analytics** (stroke impact, net conversion, return quality, per-shot-type impact, points by rally length, winner patterns); set-by-set and point-by-point timelines; evidence-based observations kept separate from recommendations; and data-quality disclosures.

The link's own privacy flags overrule the report options it was created with, so a report link can never disclose the opponent's name, mental-state observations, or the timeline when it was created without them. Report pages are served `no-store` with `X-Robots-Tag: noindex, nofollow, noarchive`, and revoked or expired links stop resolving immediately.

A report link is a snapshot of the match as it stands when the page loads. After correcting a match, mint a new link rather than assuming the coach re-reads the old one.

## Live spectator view

`/live/<token>` is a read-only page that follows a match as it is tracked: scoreboard, both-player statistics, and the point timeline, all projected from the redacted event stream.

One Durable Object per match serializes appends and fans new points out over a WebSocket, so a spectator sees a point about as fast as the parent taps it. If the socket cannot be established the page falls back to polling `/api/v1/live/<token>/events` and stays a few seconds behind instead of failing. Each socket carries its own link's privacy settings, so two people watching the same match through differently-configured links see different things and neither can widen what they receive.

Removing the Durable Object binding degrades cleanly: sync, the API, and share-link snapshots keep working, and only live push stops.

## Architecture

The app is a client-side SPA served from Cloudflare Workers Assets. The Worker handles `/api/*` and `/report/*`; everything else is served straight from assets, with unknown paths falling back to `index.html` so deep links and the installed PWA resolve.

| Binding | Purpose | Missing it means |
|---|---|---|
| `ASSETS` | The SPA bundle | Nothing is served |
| `DB` (D1) | Event store behind sync, the API, and share links | `/api/v1` answers 503; tracking is unaffected |
| `MATCH_ROOM` (Durable Object) | Per-match append ordering and live WebSocket fanout | Live push stops; sync, the API, and share snapshots keep working |
| `AUTH_PASSWORD_HASH` (secret) | Password login for the app | The app cannot sign in |
| `SYNC_TOKEN` (secret) | Bearer credential for scripts and the API | Scripts cannot authenticate |
| `ANTHROPIC_API_KEY` (secret) | Hosted strategy review | The on-device evidence review answers instead |

Each degradation is deliberate, so a partial deployment is a reduced app rather than a broken one.

## Project structure

- `index.html` / `src/` — mobile experience (SPA entry point, tracker UI, and the read-only spectator view)
- `worker/` — Cloudflare Worker: the versioned analysis API, share-link redaction, and the pluggable strategy provider
- `lib/tennis/` — scoring engine, event projections, analytics, storage, and export
- `db/` — Drizzle schema for the D1 event store; `drizzle/` holds its generated migrations
- `public/` — PWA manifest and offline service worker
- `scripts/` — Cloudflare provisioning and deploy helpers
- `tests/` — automated scoring-format and edge-case coverage
- `baseline-mvp-requirements.md` — canonical functional requirements
- `docs/` — analyses behind requirement decisions
- `baseline-clickthrough.html` — canonical interaction reference

## Data principles

- Raw observations remain distinct from derived analytics.
- Undo creates a voiding event while preserving the audit trail.
- Missed points create score-sync events rather than fabricated shot data.
- Strategy reviews store their dataset cutoff, provider, model, evidence, and coverage.
- Exports use stable IDs and vendor-neutral JSON/CSV representations.

## License

No license has been selected. Public repository visibility does not grant permission to reuse the code.
