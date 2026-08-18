# Tournament data integration — feasibility analysis

Covers USTA and Universal Tennis (UTR) as routes to the same junior tournament data.

**Status:** Analysis only. Nothing is built, and nothing should be built until the decisions at the end are made.
**Date:** 2026-08-18
**Requested capability:** pull tournament, match, and opponent data for a tracked player from USTA using the parent's credentials and the player's USTA ID, so match setup is populated rather than retyped.

## 1. The finding in one paragraph

A USTA API exists and carries exactly the data this would need. It is not available to individuals: access is a vetted commercial partnership, the documentation is behind a login, and the two obvious workarounds — scraping the public site, or driving it with the parent's own credentials — are both prohibited by USTA's Terms of Use. The more promising route is not USTA at all but Universal Tennis, which holds much of the same junior tournament data, publishes an application path with a stated fee, and authorises through the player linking their own account rather than through stored credentials. Either way this starts with an application, not with code.

## 2. What USTA actually offers

**USTA Connect** is the official programme. Publicly documented characteristics:

- REST, organised around OAuth 2, with both single-sign-on and machine-to-machine modes.
- Bulk interchange over S3 for partners who prefer files to calls.
- Data described as the tennis ecosystem, participants, play activity, World Tennis Number and NTRP ratings, rankings, and statistics.
- Production IP ranges must be whitelisted by USTA before go-live.

That data description covers what we want: participants (opponent identity), play activity (matches and results), and tournament context.

**Access is gated.** USTA states plainly that Connect is not an open API programme for the general public, and describes it as a vetted partnership for companies with established user bases actively serving the tennis community. Requests go to `ustaconnect@usta.com`, and API access specifically to `worldtennisnumber@usta.com`.

Baseline is a personal application used by one family. On the published criteria it does not resemble the partner profile, and the honest expectation is a decline.

**The documentation is itself gated.** The developer portal redirects to an Atlassian login, so the endpoint list, schemas, and rate limits cannot be evaluated before access is granted. Any estimate of integration effort is therefore guesswork until USTA responds.

## 3. Two approaches that are closed

### Scraping the public site

USTA's Terms of Use prohibit using the site in a manner that results in the scraping or copying of information, data, or content, and separately prohibit robots and data-extraction mechanisms.

This is unambiguous. It is not a grey area to be managed with polite rate limiting.

### Automating the site with the parent's credentials

This is the shape the request imagined: store the USTA login, sign in as the user, read the pages the user is entitled to see.

It should not be built, for three independent reasons.

**It is still automated access.** Being entitled to see a page as a human does not convert a script into a permitted client. The prohibition is on the means, not the audience.

**It is a serious security escalation.** Baseline currently stores no third-party credentials anywhere — the whole authentication design was deliberately moved *away* from holding secrets, to a password exchanged for a session cookie. Storing a working USTA username and password would reintroduce exactly the liability that design removed, and a USTA account is not a low-value credential: it carries a minor's registration data and, depending on the account, payment history.

**The account may not expose the data anyway.** USTA's help centre states that results are displayed only for players thirteen or older who have their own profile. If the tracked player is under that threshold, the pages a parent login can reach may not contain the match history at all.

## 4. The other door: Universal Tennis (UTR)

USTA is not the only holder of this data. UTR imports tournament results at scale — its database is described as over eight million matches across 200+ countries, growing weekly — and that intake includes junior tournament results. If the tracked player has a UTR profile, the same matches may be reachable without going through USTA at all.

UTR is a materially better prospect than USTA Connect for four reasons.

**There is a published application path, with a price.** A developer application, agreement to API terms, and an API key on approval. Applicants without the stated prerequisites pay a $250 non-refundable application fee. A number with a form attached is a very different proposition from an invitation-only programme reached by email.

**The stated criteria are closer to what Baseline is.** UTR asks for a recognised club, academy, software platform, governing body, or match-play application with a stable user base. Baseline is plausibly a match-play application. "Stable user base" remains the same hurdle it is at USTA, and should not be glossed over — but the category fits.

**The authorisation model is the right one.** The Engage API works by the player linking their own UTR account to the third-party platform, after which the platform may call endpoints on their behalf. That is delegated consent, not credential sharing: Baseline would never see or store a UTR password, which is the same principle the session-cookie design already follows. This is the single most important difference from the credential-automation idea, and it is what makes UTR worth pursuing where that idea was not.

**It is documented.** Swagger documentation is published, and partners are rate limited to 1,000 requests per minute — a figure far beyond anything this application would need.

### The open question

Public descriptions of the Engage API consistently mention retrieving **player ratings and extended profile information**, and **posting** results — both unverified and verified — so that off-platform matches contribute to a player's rating. Whether the read side returns full **match history** is not confirmed by any public description found.

That single question determines whether UTR solves the stated problem or only part of it:

- If match history is readable, this is the answer, and it likely covers USTA-sanctioned junior results by way of UTR's import pipeline.
- If only ratings and profile are readable, UTR gives opponent identity and strength but not the draw or the match record, and the setup-population problem is only half solved.

It is answerable without applying: the Swagger documentation is public. That check should happen before the fee is paid.

### A note on direction

The Engage API's emphasis on *posting* results is worth noticing, because it points at a capability Baseline is unusually well placed to offer. Baseline already holds a lossless, auditable event log of every match it tracks. Contributing verified results back to a player's UTR rating is a natural fit, and a partner application that offers to *contribute* data is a stronger application than one that only asks to consume it.

## 5. Paths that remain open

**A. Apply for USTA Connect.** One email to `ustaconnect@usta.com` describing the application and what data is needed. Cost is minutes. Expected outcome is a decline, but a decline is itself valuable: it converts an open question into a settled one, and USTA may describe a lighter-weight option that is not publicly documented.

**B. The USTA Connect Innovation Challenge.** An open call to startups and engineers, where selected participants are given access to USTA and US Open datasets. The 2026 cycle closed on 3 July 2026, with finalists presenting on 3 September 2026 during the US Open. Worth watching for a 2027 cycle; not actionable now.

**C. A personal data request.** Separate from any API. State privacy law may entitle the account holder to a copy of their own and their dependant's data. That yields a one-time export rather than a live feed, but for a season's history it may be enough, and it is a request USTA is obliged to consider rather than one it may decline commercially.

**D. User-supplied import.** The user pastes what they already have — a tournament URL, a draw, a results page they are looking at — and Baseline parses the pasted content. Baseline never contacts USTA, so no term is engaged. This is the only option available today with no external dependency.

## 6. What is already solved

Some of the stated pain is smaller than it appears.

- **Opponent re-entry is already handled.** Player profiles are stable and reusable: an opponent entered once is selected from a list thereafter, and profile identity survives a display-name change. The retyping cost is per new opponent, not per match.
- **Tournament context is already stored.** `MatchConfig` carries `tournamentUrl`, `tournamentName`, `round`, `date`, `location`, and `court`, and matches sharing a normalised tournament key can be grouped. `PlayerProfile` carries `ustaId` and `ustaUrl`.

So the data model already anticipates this integration. What is missing is population, not structure.

## 7. If access is ever granted

The work would be a provider behind a seam, mirroring how the strategy provider is isolated:

- An importer interface — `searchPlayer`, `listTournaments`, `listMatches`, `getDraw` — with USTA as one implementation and user-supplied paste as another.
- A mapping layer from USTA identifiers to Baseline `PlayerProfile` records, creating guest profiles for unmatched opponents and linking them later through the existing identity-mapping records, so imported data never rewrites history.
- Imported events recorded with `source: "imported"`, which the event model already defines, so imported and tracked data stay distinguishable in every projection and export.
- Credentials held as Worker secrets, never on the device, with the import running server-side.

None of this should be built speculatively. The interface shape depends on the schemas, and the schemas are behind the login.

## 8. Decisions needed before any build

1. **Send the partnership email?** Recommended, because it is cheap and it resolves the question.
2. **Is the tracked player thirteen or older with their own USTA profile?** Determines whether any credential-based path could have worked, and whether a personal data request would return match history.
3. **Is option D worth building on its own?** A paste-and-parse importer has real value and no external dependency, but it is a different feature from what was asked for, and it should be scoped separately rather than treated as a consolation version of the API.

## 9. Recommendation

Do not build automated USTA access, and do not build anything that stores a USTA or UTR password.

In order:

1. **Read the UTR Swagger documentation** and settle whether match history is readable. Costs nothing, and decides whether the rest is worth pursuing.
2. **If it is, apply to UTR.** The $250 fee is the real decision point; the application is more credible if it offers to contribute tracked results back, which Baseline is well placed to do.
3. **Send the USTA partnership email in parallel.** Costs minutes, and a decline settles the question.
4. **Keep entering matches manually meanwhile.** Profile reuse already means an opponent is typed once, not once per match.

If setup is still the friction point after a few tournaments, scope the user-supplied paste importer as its own requirement. It is the only version available today with no external dependency, and it should be judged on its own merits rather than as a consolation for access not granted.

## Sources

- [USTA Connect](https://www.usta.com/en/home/about-usta/usta-connect.html)
- [USTA Connect API Portal (login required)](https://ustadigital.atlassian.net/wiki/spaces/DEV/overview)
- [USTA Terms of Use](https://www.usta.com/en/home/about-usta/who-we-are/national/usta-terms-of-use.html)
- [The USTA Connect Innovation Challenge](https://www.usta.com/en/home/about-usta/usta-connect/the-usta-connect-innovation-challenge.html)
- [The Player Profile Results and Rankings Tab](https://customercare.usta.com/hc/en-us/articles/10039302404756-The-Player-Profile-Results-and-Rankings-Tab)
- [UTR Sports API Developer Application](https://www.utrsports.net/pages/api-developer-application)
- [UTR Sports Engage API](https://www.utrsports.net/pages/engage-api)
- [UTR Sports Engage API Documentation](https://www.utrsports.net/pages/engage-api-documentation)
- [UTR Sports launches Engage API](https://finance.yahoo.com/news/utr-sports-launches-engage-api-203800174.html)
