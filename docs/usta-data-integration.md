# Tournament data integration — feasibility analysis

**Status:** Analysis only. Nothing is built, and nothing should be built until the decisions at the end are made.
**Date:** 2026-08-18
**Requested capability:** populate match setup — tournament, round, and opponent — from USTA rather than retyping it courtside.

## 1. The finding in one paragraph

The data is needed *before* a match, not after, and that single fact decides the analysis. What Baseline needs is the draw: who the player is about to face, in which round, at what time. Draws live on the tournament's Serve Tennis page and are published by the tournament director before play. USTA's own API carries this but is closed to individuals; scraping the page is prohibited; and every downstream source — Universal Tennis included — carries completed results after the fact, which is the wrong data at the wrong time. The only option aligned with the actual moment of need is to parse what the parent is already looking at.

## 2. What is needed, and when

This was the mistake in the first version of this analysis: it treated "match and opponent data" as a historical dataset. It is not. The moment of need is the ninety seconds before a match starts, standing at the court.

At that moment Baseline's setup screen wants:

- Opponent name — and ideally their USTA identifier, so the profile links to the right person
- Round
- Tournament name, date, location, court

All of it exists in the draw. USTA's own guidance describes the workflow directly: a player views the draws to know when they are due on court and who their opponent is, and the tournament desk updates scores live through the day.

So the parent is **already on that page** when they need the data. That is the single most important fact in this analysis, and it points somewhere different from where the first version pointed.

Post-match sources solve a different problem — backfilling a season's history — which is worth something but is not what was asked for.

## 3. Why Universal Tennis does not fit

UTR was proposed in the first version of this analysis as the more promising route. That was wrong, for two reasons.

**It is downstream.** UTR receives results after a tournament posts them. Anything sourced from UTR arrives after the match Baseline wanted to pre-fill has already been played.

**It is the wrong shape.** UTR holds completed match results. It does not hold draws. Even with zero lag it would not answer "who is on court next".

UTR remains interesting for one unrelated thing: its Engage API accepts posted results, and Baseline holds a lossless event log of every match it tracks, so contributing verified results to a player's rating is a natural fit. That is a *feature Baseline could offer*, not a source of setup data. It should not be confused with the requirement in this document.

## 4. What USTA offers, and why it is closed

**USTA Connect** is the official programme: REST over OAuth 2 with S3 bulk interchange, covering participants, play activity, ratings, rankings, and statistics. Play activity and participants would cover draws and opponents.

It is not available here. USTA states that Connect is not an open API programme for the general public, describing it as a vetted partnership for companies with established user bases actively serving the tennis community. Requests go to `ustaconnect@usta.com`; API access specifically to `worldtennisnumber@usta.com`. Production IPs must be whitelisted before go-live.

The developer documentation is itself behind an Atlassian login, so endpoints, schemas, and rate limits cannot be evaluated before access is granted. Any effort estimate is guesswork until USTA replies.

Baseline is a personal application used by one family. On the published criteria the honest expectation is a decline — but the email costs minutes and converts an open question into a settled one.

## 5. Two approaches that are closed

### Scraping the draw page

USTA's Terms of Use prohibit use that results in the scraping or copying of information, data, or content, and separately prohibit robots and data-extraction mechanisms. Unambiguous, and not a grey area to be managed with polite rate limiting.

### Automating the site with the parent's credentials

Three independent reasons not to build it:

**It is still automated access.** Being entitled to see a page as a human does not convert a script into a permitted client. The prohibition is on the means, not the audience.

**It is a serious security escalation.** Baseline stores no third-party credentials anywhere — the authentication design deliberately moved away from holding secrets, to a password exchanged for a session cookie. A USTA account carries a minor's registration data and possibly payment history.

**It may not reach the data.** USTA's help centre states results are displayed only for players thirteen or older with their own profile.

## 6. The option that actually fits: user-supplied draw import

The parent is already viewing the draw when the data is needed. Baseline can accept what they hand it, and never contact USTA at all:

- **Share or paste a tournament URL.** Baseline stores it — it already has `tournamentUrl` — and derives what it can from the URL itself.
- **Paste the draw text.** Select-all on the draw page, paste into Baseline, parse names, rounds, and times into a pick-list for the next match.
- **Share sheet on mobile**, so the flow is share-from-browser rather than copy-switch-paste.

No term of use is engaged, because Baseline performs no access: the user moves the data, exactly as they would by reading it and typing it. It requires no permission from anyone and no external dependency, and it works at the only moment that matters.

Its weaknesses should be stated plainly. Parsing pasted markup is brittle and will break when the page changes. It cannot verify that a pasted name corresponds to a real USTA identifier, so opponent profiles stay name-matched rather than ID-matched until a sanctioned source is available. And it is manual — less manual than typing, but not automatic.

This is the leading option not because it is elegant but because it is the only one aligned with when the data is needed and available today.

## 7. What is already solved

Some of the stated pain is smaller than it appears.

- **Opponent re-entry is already handled.** Player profiles are stable and reusable: an opponent entered once is selected from a list thereafter, and identity survives a display-name change. The retyping cost is per new opponent, not per match — and in a junior circuit the same opponents recur.
- **Tournament context is already stored.** `MatchConfig` carries `tournamentUrl`, `tournamentName`, `round`, `date`, `location`, and `court`, and matches sharing a normalised tournament key group together. `PlayerProfile` carries `ustaId` and `ustaUrl`.

The data model already anticipates this integration. What is missing is population, not structure.

## 8. If sanctioned access is ever granted

The work would sit behind a seam, mirroring how the strategy provider is isolated:

- An importer interface — `searchPlayer`, `listTournaments`, `getDraw` — with a user-supplied paste implementation and a hosted API implementation, neither assumed.
- A mapping layer from external identifiers to `PlayerProfile` records, creating guest profiles for unmatched opponents and linking them later through existing identity-mapping records, so import never rewrites history.
- Imported events recorded with `source: "imported"`, which the event model already defines, keeping imported and tracked data distinguishable in every projection and export.
- Credentials as Worker secrets, never on the device, with import running server-side.

Building the interface now, with only the paste implementation behind it, is cheap and means a future grant of access is an addition rather than a rewrite.

## 9. Decisions needed

1. **Send the USTA partnership email?** Recommended. Cheap, and settles the question.
2. **Scope the paste importer as its own requirement?** It is the only option available today. It should be judged on its own merits — the question is whether parsing a pasted draw saves enough over typing two fields to be worth the brittleness.
3. **Is the tracked player thirteen or older with their own USTA profile?** Determines whether any account-based path could ever have worked.
4. **Separately: contribute results to UTR?** Unrelated to setup population, but a real capability Baseline is well placed to offer.

## 10. Recommendation

Do not build automated USTA access, and do not store a USTA password.

Send the partnership email. In parallel, if courtside setup is genuinely the friction point, scope the paste importer — starting with the cheapest version, which is accepting a shared tournament URL and remembering it, before attempting to parse draw markup.

Keep expectations honest about the size of the prize: profile reuse already means a returning opponent is one tap, so the saving is on first encounters and on tournament metadata, not on every match.

## Sources

- [USTA Connect](https://www.usta.com/en/home/about-usta/usta-connect.html)
- [USTA Connect API Portal (login required)](https://ustadigital.atlassian.net/wiki/spaces/DEV/overview)
- [USTA Terms of Use](https://www.usta.com/en/home/about-usta/who-we-are/national/usta-terms-of-use.html)
- [Viewing Tournaments, Draws, and Match Information](https://customercare.usta.com/hc/en-us/articles/4418181692308-Viewing-Tournaments-Draws-and-Match-Information)
- [Serve Tennis tournaments](https://playtennis.usta.com/tournaments)
- [The Player Profile Results and Rankings Tab](https://customercare.usta.com/hc/en-us/articles/10039302404756-The-Player-Profile-Results-and-Rankings-Tab)
- [The USTA Connect Innovation Challenge](https://www.usta.com/en/home/about-usta/usta-connect/the-usta-connect-innovation-challenge.html)
- [UTR Sports Engage API](https://www.utrsports.net/pages/engage-api)
