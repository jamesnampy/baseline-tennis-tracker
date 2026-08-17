# Baseline Tennis Tracker

Baseline is a mobile-first tennis match tracker designed for fast, one-handed courtside input. It records both players, works offline, preserves a point-by-point event history, shows live statistics, and supports evidence-based match analysis.

## Current status

The project is at the finalized MVP requirements and interactive experience stage.

- [MVP requirements](outputs/baseline-mvp-requirements.md)
- [Interactive click-through](outputs/baseline-clickthrough.html)

The click-through uses illustrative data and resets when closed. The functional application, scoring engine, offline database, exports, and LLM analysis integration are the next implementation phase.

## MVP highlights

- Five supported match formats
- Advantage and no-ad scoring
- First- and second-serve tracking with automatic double faults
- Symmetric tracking for both players
- Winner, error, return, rally-length, stroke, and shot-detail capture
- Optional mental-state observations
- Full multi-set live scoreboard
- Missed-point score synchronization
- Up to five point-level undos with no redo
- Two-player live statistics and per-player shot quality
- Point-by-point match timeline
- On-demand strategy review using both players' cumulative data
- Offline-first event log with portable JSON and CSV exports

## Planned stack

- React and TypeScript
- Mobile-first Progressive Web App
- IndexedDB for offline device storage
- Service worker for offline operation
- Event-sourced scoring and analytics model
- Cloudflare deployment

## Repository layout

- `outputs/baseline-mvp-requirements.md` — canonical product specification
- `outputs/baseline-clickthrough.html` — canonical MVP experience reference
- `app/` — application implementation surface
- `tests/` — scoring and behavior tests

## Development

The application starter requires Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

The standalone click-through can also be opened directly in a browser.

## Data principles

- Raw match observations remain distinct from derived analytics.
- Undo voids a point group from active projections while preserving an auditable record.
- Missing points are represented by score-sync events rather than fabricated details.
- LLM analysis is user initiated and includes data coverage and supporting evidence.
- Exports use vendor-neutral JSON and CSV formats.

## License

No license has been selected yet. Public repository visibility does not grant permission to reuse the code.
