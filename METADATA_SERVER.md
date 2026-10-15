# Local metadata server integration

This development milestone connects the desktop application's central catalog request layer to `mynda-server`. It supports movie/series search, title lookup, IMDb record lookup, season listings, and episode details through the authenticated `/v1/` API.

## Set up on your Mac

Start the already-configured server and leave its terminal open:

```bash
cd /Volumes/2TB-SSD/Coding/mynda-server
npm run dev
```

In a second terminal, change into your **Mynda desktop checkout**, then run:

```bash
npm run metadata:setup -- /Volumes/2TB-SSD/Coding/mynda-server torgo
npm start
```

The setup command reads your individual development token from the server's `.dev.vars` and writes `metadata-server.local.json` beside Mynda's `package.json`. It copies only the token and local server URL, never the OMDb key. It does not print credentials and refuses to overwrite existing settings. Atelaes can use `atelaes` instead of `torgo` after setting up the server locally.

The file is ignored by Git and excluded from application builds. Keep it out of diagnostic uploads, library exports, and shared ZIPs. The main process reads it at startup; the renderer and library never receive its token. Restart Mynda after changing it. Only a local HTTP server address is accepted in this milestone.

All metadata queries use the server. Missing or malformed connection settings are reported on lookup, while Mynda can still open and use the library. Server failures leave tagging retryable; there is no direct-provider fallback. The old desktop `omdb.js` is unused and excluded from application builds. Provider credentials belong only in the server configuration.

The provider-neutral cleanup requires the server's `seriesExternalIds` addition. Apply that server update first and restart the server, then update Mynda. Existing connection settings do not need to change.

## What to test

Use a copy of your library for the first comparison. Start with a movie search, a manual IMDb selection, and a small set of episodes with a known parent. Confirm titles, ratings, artwork, and episode identities, then compare a controlled Auto-Tag run with the previous results. A full re-tag can consume substantial provider requests; the smoke test already confirms basic live provider access.

Mynda continues to own matching, ambiguity, numbering corrections, operation budgets, response reuse, and saves. The new adapter translates the service contract for existing callers and retains native catalog references separately from IMDb IDs. Unknown parent identity is not filled from the request. Season completeness remains explicit, and the existing season reasoning retains its own incomplete-list checks.

`src/tagging/TaggingService.js` assembles those desktop responsibilities. `CatalogClient.js` accepts structured queries, manages budgets and reuse, and calls `MetadataServerClient.js` for HTTP requests. The latter converts the public server data into the existing internal catalog record shape (`Title`, `Runtime`, and related fields) to preserve the matching engine's behavior. Those internal field names do not select a provider. Parent IMDb identity comes only from `seriesExternalIds.imdb`; native references remain opaque. Saved reports from before this rename still render correctly.

The desktop candidate budget counts logical catalog lookups. Each admitted server lookup can cause up to two OMDb attempts under the server's bounded retry policy; the server charges each attempt against its shared allowance. Each desktop HTTP request has a 30-second timeout. Successful responses and definitive missing records are reused within the existing session; service failures are evicted. Artwork URLs are still downloaded by Mynda.

An explicit HTTP 429 `CAPACITY_WAIT` response pauses the pending lookup. Mynda validates and honors its `Retry-After`, carries the queue ticket forward, displays a capacity message, and retries the same input. These polls do not consume the candidate-search budget or produce unmatched reports. Auto-Tag saves completed videos before waiting. Cancel stops a capacity wait immediately and leaves the pending video unchanged; canceling ordinary active tagging keeps the established finish-current-video behavior. Search and result selection now have Cancel controls too. Changing the editor selection or closing it cancels its pending lookup and ignores late responses.

Long allowance/provider pauses display a retry time. The app must remain open to resume automatically; already saved results survive closing and unprocessed videos remain eligible for another run. Generic failures still follow the normal error path. This milestone adds no shared server metadata cache.

Server downtime, access failures, invalid data, and timeouts remain service outcomes in the tagging workflow. An older server's quota error also retains that behavior; automatic capacity pauses require updating both repositories. Only the explicit `NOT_FOUND` error becomes a missing record; `TOO_MANY_RESULTS` remains an ambiguous search. Neither a generic HTTP 404 nor a provider failure is treated as a missing movie or empty season.

## Diagnostics and automated checks

Request logs identify the metadata server and include its request ID, allowing comparison with the terminal running `npm run dev`. Error messages are fixed client messages; Axios configuration, response bodies, and the Authorization header are not attached to errors or saved evidence.

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
