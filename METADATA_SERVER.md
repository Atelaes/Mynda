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

The desktop budget counts requests to the local server. Each metadata request can cause up to two OMDb attempts under the server's bounded retry policy. The desktop waits up to 30 seconds and adds no transport retries. It reuses successful responses and definitive missing-record responses within the existing session, and evicts service failures. Artwork URLs are still downloaded by Mynda.

Server downtime, access failures, quota exhaustion, invalid data, and timeouts remain retryable service outcomes in the tagging workflow. Only the explicit `NOT_FOUND` error becomes a missing record; `TOO_MANY_RESULTS` remains an ambiguous search. Neither a generic HTTP 404 nor a provider failure is treated as a missing movie or empty season.

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
