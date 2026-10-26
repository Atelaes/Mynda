# Metadata server integration

Mynda uses the same encrypted, per-user connection store when launched from
source or as a packaged application. Its public default server is
`https://mynda-server-dev.torvor-dev.workers.dev`.

## Existing installations

Quit Mynda, apply this update on the desktop `dev` branch, and run `npm start`
once from the checkout that contains your existing `metadata-server.local.json`.
Mynda migrates that URL and token to encrypted storage, verifies the saved
ciphertext can be decrypted, and then removes the old plaintext file. A failed
migration preserves the source file. Existing encrypted settings take precedence;
removing saved access leaves a marker so an old file cannot reconnect silently.

Open **Settings → License**; the saved key is checked automatically. A system Keychain
prompt can appear on macOS. After migration, newly built copies use the same
saved connection. There is no server redeployment for this change.

## Activate through Settings

**Settings → License** is Mynda's single activation interface. Paste a **license
key** and choose **Activate Mynda**. The currently issued development access token
serves as that key; an existing saved connection does not need to be replaced.
Mynda checks authenticated capabilities before saving it. A rejected replacement
or failed write preserves the previous key. The input clears immediately, and
saved keys are never sent back to the renderer.

Opening the tab checks a saved key automatically. These checks call
`/v1/capabilities` and do not use provider lookup allowance. The badge is:

- Green **Activated** only after the key has been verified.
- Amber **Not activated** when no key is saved.
- Amber **Unable to verify** when a check cannot reach or validate the service;
  the saved key remains in place.
- Red **Not activated** when the service explicitly rejects the saved key.
- Amber **Activation unavailable** when the saved state cannot be read.

**Check activation** retries verification. **Change license key** opens the
replacement form. **Deactivate this computer** removes the saved key locally.
These changes take effect without restarting: an HTTP request already in flight
may finish, while a capacity retry stops if its credentials have changed.

**Activation details** explains the service address, encrypted storage, and the
scope of local deactivation. Source builds also have **Developer options** in
the key form. Changing its server address requires activating with a key for
that server. Packaged builds use the saved origin or built-in default and do not
expose arbitrary server overrides. TLS verification is enabled; remote HTTP is
rejected, and redirects never forward keys to another endpoint.

The interface is ready to present app-wide activation. The current verification
still authenticates the existing server token; this update does not implement
payment processing, a purchased-license exchange, an entitlement policy, offline
license grants, or server-side device revocation. Those remain separate server
work. Local deactivation does not cancel a purchase or revoke a key elsewhere.

## Restricted features

Tagging requires activation before work starts. This includes editor Search
(also exact IMDb IDs), applying search results, Auto-Tag Selected, and library
Auto-Tag. A missing key produces “Activate Mynda to use tagging” with directions
to Settings → License, before catalog discovery, artwork downloads, batch
confirmation, or library changes. Manual editing and Reset from Filename do not
require activation.

The feature registry and shared error contract live in
`src/platform/FeatureAccess.js`. Main-process code calls
`requireFeature('tagging')` from `src/main/FeatureAccess.js` before starting an
operation. The tagging service guards discovery and application too, so cached
results cannot bypass the policy. Future restricted features should register a
policy there and use the same entry-point check.

Activation uses the credential store's shared session state. Activating,
replacing a key, or successfully checking activation immediately permits
restricted features without restarting or reopening a panel. Removing the key
or receiving an explicit service rejection immediately blocks new work. Saved
keys are verified against `/v1/capabilities` before their first restricted use
after launch; successful verification is reused for the session, including
large batches. That check consumes no provider lookup budget. This is not a
persistent offline license grant; the server still authorizes each request.

If activation cannot be verified because of a connection failure, the message
says so and keeps the key. Keychain failures have their own explanation.
Ordinary catalog/network failures after successful activation remain catalog
errors. If activation is lost during a batch, Mynda stops once, saves results
already completed, and leaves blocked/unprocessed videos' tags and attempt
status unchanged.

The preload rejects named API calls with a plain `{code, message}` error record.
Native `Error` objects lose custom properties across Electron's context bridge;
the plain contract preserves the code used by activation messages and status.

## Storage and protection

The file is `connection/metadata-credentials.json` under Electron's
`app.getPath('userData')`. With the current application name, macOS uses:

```text
~/Library/Application Support/Mynda/connection/metadata-credentials.json
```

Electron's `safeStorage` encrypts the URL and token together. The encryption key
is managed by macOS Keychain, Windows DPAPI, or an available Linux desktop keyring.
The file and temporary replacements use owner-only permissions on Unix; writes
are atomic. Credentials are separate from the library, library exports and logs,
and excluded from application builds and Git. Copying the encrypted file to a
new machine is not a supported activation method; enter a token there instead.

There is no plaintext fallback. A locked or unavailable keychain/keyring produces
an actionable settings message; Mynda still opens its library. Linux `basic_text`
is explicitly rejected. Unsigned macOS development and packaged builds may prompt
separately for Keychain access; stable code signing is needed for release behavior.

## Terminal helpers for developers

Quit Mynda before using these commands. Both launch the pinned Electron runtime
so they use the same OS encryption and user-data location as the application.
Tokens are transferred through a private stdin pipe, never command arguments.

For a new developer installation, import the selected identity from the server:

```bash
npm run metadata:setup -- /Volumes/2TB-SSD/Coding/mynda-server torgo
npm run metadata:connect -- https://mynda-server-dev.torvor-dev.workers.dev
```

Setup selects only that identity's token, never the provider key, and refuses to
overwrite an existing connection. Atelaes selects `atelaes`. The connect command
preserves the encrypted token and changes its origin. For local development:

```bash
npm run metadata:connect -- http://127.0.0.1:8787
```

Start the local server separately. Terminal setup/connect saves settings without
requiring that server to be online; use **Check activation** after launching Mynda.

## Automated credential checks

```bash
npm run test:core
npm run test:credentials
```

The credential tests use disposable data and synthetic tokens. They exercise real
Electron UI/preload/IPC, encrypted persistence across fresh processes, HTTP lookup,
removal, and a real ASAR archive with the application's exclusion rules. They use
the native OS key provider when available. Where no protected provider exists,
they verify the production rejection and use an explicit test-only AES provider
to exercise persistence; production never uses that replacement.

For environments that cannot create windows, the storage portion also runs with:

```bash
node test/electron/run-credentials.js --storage-only
node test/electron/run-credentials.js --storage-only --asar
```

The normal credential UI suites are also included in `npm run test:all`.

All metadata queries use the server. Missing or malformed connection settings are reported on lookup, while Mynda can still open and use the library. Server failures leave tagging retryable; there is no direct-provider fallback. The old desktop `omdb.js` is unused and excluded from application builds. Provider credentials belong only in the server configuration.

The provider-neutral cleanup requires the server's `seriesExternalIds` addition. Apply that server update first and restart the server, then update Mynda. Existing connection settings do not need to change.

## What to test

Use a copy of your library for the first comparison. Start with a movie search, a manual IMDb selection, and a small set of episodes with a known parent. Confirm titles, ratings, artwork, and episode identities, then compare a controlled Auto-Tag run with the previous results. A full re-tag can consume substantial provider requests; the smoke test already confirms basic live provider access.

Mynda continues to own matching, ambiguity, numbering corrections, operation budgets, response reuse, and saves. The new adapter translates the service contract for existing callers and retains native catalog references separately from IMDb IDs. Unknown parent identity is not filled from the request. Season completeness remains explicit, and the existing season reasoning retains its own incomplete-list checks.

`src/tagging/TaggingService.js` assembles those desktop responsibilities. `CatalogClient.js` accepts structured queries, manages budgets and reuse, and calls `MetadataServerClient.js` for HTTP requests. The latter converts the public server data into the existing internal catalog record shape (`Title`, `Runtime`, and related fields) to preserve the matching engine's behavior. Those internal field names do not select a provider. Parent IMDb identity comes only from `seriesExternalIds.imdb`; native references remain opaque. Saved reports from before this rename still render correctly.

The desktop candidate budget counts logical catalog lookups. Each admitted server lookup can cause up to two OMDb attempts under the server's bounded retry policy; the server charges each attempt against its shared allowance. Each desktop HTTP request has a 30-second timeout. Successful responses and definitive missing records are reused within the existing session; service failures are evicted. Artwork URLs are still downloaded by Mynda.

An explicit HTTP 429 `CAPACITY_WAIT` response pauses the pending lookup. Mynda validates and honors its `Retry-After`, carries the queue ticket forward, displays a capacity message, and retries the same input. These polls do not consume the candidate-search budget or produce unmatched reports. Auto-Tag saves completed videos before waiting. Cancel stops a capacity wait immediately and leaves the pending video unchanged; canceling ordinary active tagging keeps the established finish-current-video behavior. Search and result selection now have Cancel controls too. Changing the editor selection or closing it cancels its pending lookup and ignores late responses.

Long allowance/provider pauses display a retry time. The app must remain open to resume automatically; already saved results survive closing and unprocessed videos remain eligible for another run. Generic failures still follow the normal error path. The server's separate shared cache serves cached results without spending provider allowance, including while fresh lookups are waiting for capacity.

Server downtime, access failures, invalid data, and timeouts remain service outcomes in the tagging workflow. An older server's quota error also retains that behavior; automatic capacity pauses require updating both repositories. Only the explicit `NOT_FOUND` error becomes a missing record; `TOO_MANY_RESULTS` remains an ambiguous search. Neither a generic HTTP 404 nor a provider failure is treated as a missing movie or empty season.

## Diagnostics and automated checks

Request logs identify the metadata server and include its request ID, allowing comparison with the terminal running `npm run dev`, or `npx wrangler tail` in the server checkout for Cloudflare. Error messages are fixed client messages; Axios configuration, response bodies, and the Authorization header are not attached to errors or saved evidence.

```bash
npm run test:core
```

The connection/translation tests use synthetic credentials and local fixtures. Existing tagging regression suites remain available and consume no provider quota. Full native Electron and real-library verification are separate from the portable tests.

With both checkouts available, replay the recorded tagging, movie-discovery, numbering-correction, and historical artwork-fallback cases through the real server code:

```bash
npm run test:metadata-server -- /Volumes/2TB-SSD/Coding/mynda-server
```

This compiles the server's router and OMDb adapter into a temporary test bundle, routes the original recorded responses through both contracts, and checks the original expected identities. Network access is disabled. The server does not need to be running and no real API key or development token is used.

Run the capacity contract through a temporary local Worker, real SQLite storage and the desktop HTTP client:

```bash
npm run test:capacity-server -- /Volumes/2TB-SSD/Coding/mynda-server
```

Install the server's dependencies first (`npm ci` in its checkout). This test gives a synthetic provider three daily requests and one request per second. It checks automatic batch waiting/resuming, saved results, a second client's shared allowance, immediate cancellation, and persistence across a complete Worker runtime restart. Provider traffic is intercepted locally; the test does not read your credentials, use provider quota, or alter your normal local server storage.

## Provider-native identities

Mynda saves `catalogRef: {provider, id}` for the selected movie or episode and
`catalogSeriesRef: {provider, id}` for its parent series. These references drive
search choices, refreshes, request reuse, batch recovery, episode numbering,
artwork fallback and saved explanations. The adapter owns the opaque `id`; if
its catalog reuses numbers across kinds, it must namespace them (for example,
`movie:42` and `series:42`). Mynda does not parse the adapter's namespace.

`imdbID` and `seriesImdbID` remain optional, real IMDb cross-references, used for
IMDb links and existing libraries. Old records continue to resolve by IMDb;
a successful refresh adds the returned native reference. Native IDs are never
put into IMDb fields. Provider-supplied cross-references can bridge old and new
saved evidence; conflicting identities remain separate. Reset from Filename
clears both kinds of identity. Manual IMDb or series changes invalidate the
corresponding native reference. Native references are saved atomically and
included in concurrent-edit and stale-search checks.

IMDb vote counts no longer affect acceptance. Relaxed title/year searches need
comparable runtimes within `max(8 minutes, 10% of catalog runtime)`, in addition
to the existing title, kind, ambiguity and episode checks. Exact title/year
matches keep their existing broader edition tolerance. Ratings are optional:
existing scores can survive a verified same-work refresh, but selecting another
work clears old provider scores while preserving the user's rating. Unknown
cast/languages remain empty, rather than becoming a literal `N/A` entry.

Partial or explicitly unknown season coverage cannot establish an episode total.
The three deliberately changed historical movie outcomes are recorded separately
in `test/fixtures/NativeIdentityPolicyChanges.json`; their original recordings
and correct selectable identities remain intact.

This step keeps OMDb as the deployed provider. It does not add a TheTVDB adapter,
change activation or capacity settings, choose alternate episode orders, or
mirror a provider database. Native-only test fixtures exercise the groundwork
without provider credentials or live requests. Reviewed aliases that explicitly
name an IMDb identity still require that cross-reference; they do not silently
apply to an unrelated native-only record.

## TVDB matching update (evidence version 86)

The server may include `aliases` in search and record responses. Mynda keeps
these as `catalogAliases` while matching and records the actual matched alias
in the saved report. Older servers and OMDb may omit them. Search-row names may
be combined with a full record only when their native identities agree.

Series discovery compares numeric spellings, provider aliases and unqualified
versus region/year-qualified peers before choosing a parent. It checks up to
three search pages; a still-incomplete result set cannot establish uniqueness.
Explicit years and regions remain constraints. A filename acronym qualified by
a matching, dated folder can retain a specific series branch (for example,
S.A.C. / Stand Alone Complex), without rewriting the editable series tag.

Exact title recovery can search a complete season after the nearby-number
window fails. The title must be unique in that list, and the full episode must
confirm the same native identity, parent, season and position. Partial or
ambiguous lists do not authorize a correction. The local numbering stays as
entered; the saved report records the catalog position.

Serial title comparisons retain the story and part number, including explicit
`Pt N` and catalog `(N)` formats. A missing catalog episode zero can flag a
numbering-origin conflict for numbered-only siblings in the same physical
release and season. A complete ordinary local season or a directly verified
positive position can establish alignment. Other seasons/releases stay separate.

Movie safeguards reject unsafe franchise-prefix and descriptive child-to-parent
fallbacks, two-or-more-year discrepancies without independent release evidence,
and very short titles without a catalog runtime. These cases remain available
for review. Popularity/vote counts are still not used as identity evidence.

Combined/split files remain subject to the existing coverage check. This update
does not add multi-episode library records, change TVDB's default season order,
or silently alter already-tagged videos. Fresh tests or explicit retries are
needed to assess the new behavior against a real library.

## Bounded discovery follow-up (evidence version 87)

A known result total now takes precedence over a stale continuation flag. A
search that still has more pages after the discovery limit is a candidate list,
not proof of uniqueness. Unknown pagination is also kept distinct from a
confirmed end. A single candidate can proceed when supported by:

- The server's optional `titleSearch` evidence from a complete exact-title lookup.
  Every returned summary remains available to the matching rules, including
  regional, numeric-title and alias peers beyond the first three pages.
- A distinctive matching episode title, or an explicit premiere year confirmed
  against full parent metadata. “Pilot” alone is insufficient for an incomplete
  search. Each episode still passes its final title, runtime and numbering checks.
- Batch evidence from at least two fully represented local seasons with complete,
  agreeing catalog totals and verified parent metadata. Holes, duplicates, separate
  physical collections, known competing matches and contradictory seasons do not
  supply this evidence. Named sibling evidence is considered first.

An unresolved result uses `series-search-incomplete`, even if only one plausible
candidate was found. Reports include the discovery boundary and supporting
season evidence. New records use evidence version 87. Existing tagged records
and permanent-attempt flags are not reset automatically; use an explicit retry
or a fresh test library to compare results.

Responses indicating “too many results” are reused for the same query within a
request session. Changing the query/year or starting another session performs a
new lookup. Provider/transport errors remain retryable and are not retained.

The normal core/full test catalog includes `SeriesSearchLimits.integration.test.js`.
From the server checkout, `npm run test:tvdb-desktop -- /path/to/Mynda` runs captured
and synthetic TVDB responses through both real implementations and batch saving
into a test-only in-memory map. `npm run test:metadata-server -- /path/to/server`
continues to replay the historical OMDb matching cases. Those historical response
summaries omitted pagination; the replay supplies explicitly synthetic totals
for their saved result sets. This checks record/matching compatibility, not live
OMDb search coverage. Separate tests retain conservative unknown-pagination behavior.

## Collection and small-library recovery (evidence version 88)

Recognized season folders may include a series premiere year, repeated matching
season marker, COMPLETE / + Extras annotations and known technical release text.
For example, `Friends Season 1 COMPLETE 720p.BRrip.sujaidr (pimprg)` now shares
parent identity evidence with other seasons beneath the same Friends root.
Unknown edition/region text and conflicting years remain boundaries or conflicts;
episode order evidence stays specific to each directory and season.

Episode-title verification now covers up to ten plausible candidates. Above
three, existing verified parent/season bounds narrow contradictions before title
probes. Missing metadata does not eliminate a competitor. All queries still use
the shared request session and 96-request per-operation budget; no top-N candidate
is silently selected when the verifier limit is exceeded. Saved reports include
the bounds checks and alternatives compared.

With the matching server update, TVDB series title lookup can complete up to five
100-row pages. Every returned summary remains available to desktop identity
checks. This can establish a parent for one numbered-only episode or an incomplete
local season without any season-count requirement. Genuine ambiguity, unknown
pagination and larger result sets remain unresolved unless independent episode,
year or collection evidence is sufficient. The existing two-complete-season rule
remains only an optional fallback when discovery is incomplete.

Apply both repository patches before deploying the updated server: older desktop
versions reject complete-title proofs larger than 100 rows. No dependency changes,
manual cache reset, stored metadata edits or automatic retry-flag resets are needed.
The library run may be repeated with a fresh test library or explicitly retried.
