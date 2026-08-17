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

## Privacy and offline behavior

Match data remains on the device by default. Scoring, tracking, statistics, timeline, undo, recovery, and export do not require a network connection. Data is sent for strategy analysis only after the user taps **Ask AI for strategy**. Hosted model requests use `store: false`; no API key is exposed to the browser.

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

Copy `.env.example` to `.env.local`, add a server-side `OPENAI_API_KEY`, and optionally change `OPENAI_STRATEGY_MODEL`. Without a key, the app transparently returns its on-device evidence review.

## Project structure

- `app/` — mobile experience and server-side strategy endpoint
- `lib/tennis/` — scoring engine, event projections, analytics, storage, and export
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
