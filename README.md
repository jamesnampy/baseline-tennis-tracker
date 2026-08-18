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

## Deployment

The app is a client-side SPA served from Cloudflare Workers Assets, with an API Worker handling `/api/*`.

```bash
npm run deploy
```

Set `VITE_PUBLIC_ORIGIN` at build time (for example `https://baseline.example.com`) so social-preview images resolve to absolute URLs.

## Project structure

- `index.html` / `src/` — mobile experience (SPA entry point and UI)
- `worker/` — Cloudflare Worker API and the pluggable strategy provider
- `lib/tennis/` — scoring engine, event projections, analytics, storage, and export
- `db/` — Drizzle scaffolding for the planned D1 event store (not yet wired up)
- `public/` — PWA manifest and offline service worker
- `tests/` — automated scoring-format and edge-case coverage
- `baseline-mvp-requirements.md` — canonical functional requirements
- `baseline-clickthrough.html` — canonical interaction reference

## Data principles

- Raw observations remain distinct from derived analytics.
- Undo creates a voiding event while preserving the audit trail.
- Missed points create score-sync events rather than fabricated shot data.
- Strategy reviews store their dataset cutoff, provider, model, evidence, and coverage.
- Exports use stable IDs and vendor-neutral JSON/CSV representations.

## License

No license has been selected. Public repository visibility does not grant permission to reuse the code.
