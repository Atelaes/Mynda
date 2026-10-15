// Exercise the real desktop transport, Worker and SQLite coordinator together.
// All credentials and provider replies are synthetic; no live provider is called.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {createRequire} = require('module');
const esbuild = require('esbuild');
const axios = require('axios');
const {createMetadataServerClient} = require('../src/tagging/MetadataServerClient');
const {createCatalogClient} = require('../src/tagging/CatalogClient');
const {createTaggingEngine} = require('../src/tagging/TaggingEngine');
const {createTagApplier} = require('../src/tagging/TagApplier');
const {createAutoTagRunner} = require('../src/tagging/AutoTagRunner');

const root = path.resolve(__dirname, '..');
const serverRoot = path.resolve(process.argv[2] || path.join(root, '../mynda-server'));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mynda-capacity-contract-'));
const log = {debug(){}, info(){}, warn(){}, error(){}};
const tokens = {alice:'synthetic-alice-token-0123456789abcdef', bob:'synthetic-bob-token-0123456789abcdef'};
let runtime, deadline, batchState, timedOut = false, providerCalls = 0;
const controllers = new Set();

async function main() {
  if (!fs.existsSync(path.join(serverRoot, 'src/capacity/coordinator.ts'))) {
    throw new Error('Pass the updated server checkout: npm run test:capacity-server -- /path/to/mynda-server');
  }
  const serverRequire = createRequire(path.join(serverRoot, 'package.json'));
  let miniflare;
  try { miniflare = serverRequire('miniflare'); } catch (_) {
    throw new Error('Run npm ci in the mynda-server checkout before running this test.');
  }
  const {Miniflare, Response, Log, LogLevel, convertV4MiniflareOptions} = miniflare;
  const bundle = path.join(temporary, 'worker.mjs');
  esbuild.buildSync({entryPoints:[path.join(serverRoot, 'src/index.ts')], bundle:true,
    platform:'neutral', format:'esm', target:'es2022', external:['cloudflare:workers'], outfile:bundle});
  const options = {
    name:'mynda-capacity-contract', rootPath:temporary, modulesRoot:temporary,
    scriptPath:bundle, modules:true, compatibilityDate:'2026-10-01',
    host:'127.0.0.1', port:0, cf:false, logRequests:false, log:new Log(LogLevel.ERROR),
    telemetry:{enabled:false}, resourcePersistencePath:path.join(temporary, 'storage'),
    // Miniflare 4 uses this option; version 5 uses resourcePersistencePath.
    durableObjectsPersist:path.join(temporary, 'storage'),
    durableObjects:{CAPACITY:{className:'CapacityCoordinator', useSQLite:true}},
    bindings:{METADATA_PROVIDER:'omdb', OMDB_API_KEY:'synthetic-key', OMDB_PLAN:'basic',
      DEV_CLIENT_TOKENS:JSON.stringify(tokens), CAPACITY_ACCOUNT_ID:'http-test',
      CAPACITY_DAILY_LIMIT:'3', CAPACITY_RATE_LIMIT:'1', CAPACITY_RATE_WINDOW_SECONDS:'1'},
    outboundService:async request => {
      const url = new URL(request.url);
      assert.strictEqual(url.hostname, 'www.omdbapi.com', 'Unexpected outbound request');
      providerCalls++;
      return Response.json({Response:'True', Title:'Synthetic Film', Type:'movie',
        imdbID:url.searchParams.get('i'), Runtime:'90 min'});
    },
  };
  const start = async () => {
    runtime = new Miniflare(convertV4MiniflareOptions ? convertV4MiniflareOptions(options) : options);
    return (await runtime.ready).origin;
  };
  const clientAt = (url, token) => createMetadataServerClient({axios, server:{url, token}});
  deadline = setTimeout(() => {
    timedOut = true;
    for (const controller of controllers) controller.abort();
    if (batchState) {
      batchState.cancelRequested = true;
      if (batchState.cancelCapacityWait) batchState.cancelCapacityWait();
    }
  }, 30000);

  const url = await start();
  const transport = clientAt(url, tokens.alice);
  assert.strictEqual((await transport({id:'tt1234567'})).data.imdbID, 'tt1234567');
  assert.strictEqual(providerCalls, 1);
  console.log('PASS desktop lookup through the real Worker and SQLite coordinator');

  const catalog = createCatalogClient({transport, log});
  const engine = createTaggingEngine({client:catalog, log, withEpisodeDuration:async value => value,
    applier:createTagApplier({log, downloadArtworkWithSeriesFallback:async () => ''})});
  const videos = ['tt1234568', 'tt1234569'].map((imdbID, index) => ({id:String(index), imdbID,
    kind:'movie', title:'Original', ratings:{user:4}, new:true, autotag_tried:false}));
  const saved = [], statuses = [];
  batchState = {};
  const run = createAutoTagRunner({state:batchState, catalog:engine, log, preferences:{},
    getCandidates:() => videos, getLibraryVideos:() => videos, chooseSeries:async () => null,
    whenIdle:async () => {}, save:async rows => saved.push(...JSON.parse(JSON.stringify(rows))),
    notifyStatus:status => statuses.push(status)});
  const result = await run();
  assert.strictEqual(result.statistics.Success, 2);
  assert.deepStrictEqual(saved.map(video => video.imdbID), ['tt1234568', 'tt1234569']);
  assert(saved.every(video => video.ratings.user === 4 && video.autotag_tried));
  assert(statuses.some(status => status.capacityWait), 'Expected a real timed capacity pause');
  assert.strictEqual(providerCalls, 3);
  console.log('PASS Auto-Tag waits, resumes and saves both videos over real HTTP');

  async function exhausted(origin) {
    const controller = new AbortController();
    controllers.add(controller);
    let waiting = false;
    try {
      await assert.rejects(clientAt(origin, tokens.bob)({id:'tt1234570'}, {
        signal:controller.signal, onCapacityWait:status => {
          if (!status.waiting) return;
          waiting = true;
          assert.strictEqual(status.reason, 'budget');
          assert(status.retryAfterSeconds > 3600, 'The daily allowance should be exhausted');
          controller.abort();
        },
      }), {code:'METADATA_CANCELED'});
      assert(waiting);
      assert.strictEqual(providerCalls, 3, 'Waiting must not consume provider requests');
    } finally { controllers.delete(controller); }
  }
  await exhausted(url);
  console.log('PASS a second client shares the allowance and can cancel immediately');
  await runtime.dispose();
  runtime = null;
  await exhausted(await start());
  assert(!timedOut, 'The capacity integration test exceeded 30 seconds');
  console.log('PASS the spent allowance survives a complete Worker runtime restart');
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}).finally(async () => {
  clearTimeout(deadline);
  for (const controller of controllers) controller.abort();
  try { if (runtime) await runtime.dispose(); }
  catch (error) { console.error('Worker cleanup failed:', error.message); process.exitCode = 1; }
  finally { fs.rmSync(temporary, {recursive:true, force:true}); }
});
