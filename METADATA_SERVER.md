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

When this file is absent, Mynda uses its existing direct OMDb configuration. When it is present, all metadata queries use the server; server errors do not trigger a direct-provider fallback. Mynda can start without `omdb.js` in server mode. A malformed connection file is reported on lookup instead of preventing the app from opening.

To opt out, move `metadata-server.local.json` out of the project folder and restart Mynda with its existing `omdb.js` configuration.

## What to test

Use a copy of your library for the first comparison. Start with a movie search, a manual IMDb selection, and a small set of episodes with a known parent. Confirm titles, ratings, artwork, and episode identities, then compare a controlled Auto-Tag run with the previous results. A full re-tag can consume substantial provider requests; the smoke test already confirms basic live provider access.

Mynda continues to own matching, ambiguity, numbering corrections, operation budgets, response reuse, and saves. The new adapter translates the service contract for existing callers and retains native catalog references separately from IMDb IDs. Unknown parent identity is not filled from the request. Season completeness remains explicit, and the existing season reasoning retains its own incomplete-list checks.

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
