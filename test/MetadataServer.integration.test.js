const fs = require('fs');
const path = require('path');
const http = require('http');
const {spawnSync} = require('child_process');
const axios = require('axios');
const {assert, createSuite, runSuite, withTemporaryDirectory} = require('./helpers/TestHarness');
const {loadFreshWithMocks} = require('./helpers/ModuleMocks');
const {createCatalogClient, createRequestSession} = require('../src/tagging/CatalogClient');
const {createRequestBudget} = require('../src/tagging/RequestBudget');
const {createTaggingEngine} = require('../src/tagging/TaggingEngine');
const {createTagApplier} = require('../src/tagging/TagApplier');
const {loadMetadataServerConfig, validateServerConfig} = require('../src/tagging/MetadataServerConfig');
const suite = createSuite('Local metadata server integration', 'integration',
  'Exercises the real HTTP client, tagging engine, private settings and service failures against loopback fixtures; no provider access.');
const token = 'synthetic-development-token-for-tests-only';
const requestId = '12345678-1234-4123-8123-123456789abc';
const log = {debug(){}, info(){}, warn(){}, error(){}};
const ref = id => ({provider:'omdb', id});
const provenance = {provider:'omdb', fetchedAt:'2026-10-14T00:00:00.000Z'};
function record(overrides = {}) {
  return {ref:ref('tt0034583'), externalIds:{imdb:'tt0034583'}, title:'Casablanca', kind:'movie',
    year:{text:'1943', start:1943, end:null}, artwork:[{type:'poster', url:'https://example.invalid/poster.jpg', provider:'omdb'}],
    released:'23 Jan 1943', runtimeMinutes:102, genres:['Drama', 'Romance'], plot:'Fixture description',
    contentRating:'PG', directors:['Michael Curtiz'], actors:['Humphrey Bogart', 'Ingrid Bergman'],
    countries:['United States'], languages:['English', 'French'], boxOffice:'$4,219,709',
    ratings:[{source:'Internet Movie Database', value:'8.5/10', provider:'omdb'},
      {source:'Rotten Tomatoes', value:'99%', provider:'omdb'}, {source:'Metacritic', value:'100/100', provider:'omdb'}],
    votes:[{source:'imdb', count:662325, provider:'omdb'}], seriesExternalIds:{}, series:null, season:null, episode:null,
    episodeOrder:null, totalSeasons:null, provenance, ...overrides};
}
function search(items = [record()], overrides = {}) {
  return {items, page:1, totalResults:items.length, hasMore:false, provenance, ...overrides};
}
function engine(client) {
  return createTaggingEngine({client, log, withEpisodeDuration:async video => video,
    applier:createTagApplier({log, downloadArtworkWithSeriesFallback:async () => ''})});
}
async function withServer(responder, operation) {
  const calls = [], failures = [];
  const server = http.createServer(async (req, res) => {
    try {
      assert.strictEqual(req.method, 'POST');
      assert.strictEqual(req.headers.authorization, `Bearer ${token}`);
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      calls.push({route:req.url, body});
      const answer = await responder(req.url, body, calls.length);
      res.writeHead(answer.status || 200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({requestId, ...answer}));
    } catch (error) {
      failures.push(error);
      res.writeHead(500); res.end('{}');
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const connection = {url:`http://127.0.0.1:${server.address().port}`, token};
  try {
    const result = await operation(createCatalogClient({axios, server:connection, log}), calls, connection);
    assert.deepStrictEqual(failures, []);
    return result;
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

suite.test('all five operations send authenticated POSTs with the intended filters and preserve metadata fields', async () => {
  const parent = 'tt4574334';
  await withServer((route, body) => ({data:route === '/v1/search' ? search([record()], {page:body.page, totalResults:31, hasMore:true}) :
    route === '/v1/season' ? {series:ref(parent), seriesExternalIds:{imdb:parent}, season:0, order:'provider', totalSeasons:null,
      completeness:'unknown', provenance, episodes:[{ref:ref('tt7654321'), externalIds:{imdb:'tt7654321'}, title:'Special', episode:0, released:null}]} :
    route === '/v1/episode' ? record({ref:ref('tt7654321'), externalIds:{imdb:'tt7654321'}, kind:'episode',
      series:ref(parent), seriesExternalIds:{imdb:parent}, season:0, episode:0, episodeOrder:'provider'}) : record()}), async (client, calls) => {
    const requests = [{title:'Casablanca & Co', type:'movie', year:1943, page:3}, {exactTitle:'Casablanca', type:'movie'},
      {id:'tt0034583'}, {id:parent, season:0}, {id:parent, season:0, episode:0}];
    const replies = [];
    for (const query of requests) replies.push(await client.requestCatalog(client.createCatalogQuery(query)));
    assert.deepStrictEqual(calls, [
      {route:'/v1/search', body:{title:'Casablanca & Co', kind:'movie', year:1943, page:3}},
      {route:'/v1/title', body:{title:'Casablanca', kind:'movie'}},
      {route:'/v1/record', body:{ref:{externalSource:'imdb', id:'tt0034583'}}},
      {route:'/v1/season', body:{series:{externalSource:'imdb', id:parent}, season:0, order:'provider'}},
      {route:'/v1/episode', body:{series:{externalSource:'imdb', id:parent}, season:0, order:'provider', episode:0}}
    ]);
    const data = replies[2].data;
    assert.strictEqual(data.Year, '1943'); assert.strictEqual(data.Runtime, '102 min');
    assert.strictEqual(data.imdbVotes, '662325'); assert.strictEqual(data.Actors, 'Humphrey Bogart, Ingrid Bergman');
    assert.strictEqual(data.Country, 'United States'); assert.strictEqual(data.Language, 'English, French');
    assert.strictEqual(data.BoxOffice, '$4,219,709'); assert.strictEqual(data.seriesID, undefined);
    assert.deepStrictEqual(data.catalogRef, ref('tt0034583'));
    assert.deepStrictEqual(data.Ratings.map(item => item.Source), ['Internet Movie Database', 'Rotten Tomatoes', 'Metacritic']);
    assert.strictEqual(replies[0].data.totalResults, '31'); assert.strictEqual(replies[0].data.catalogHasMore, true);
    assert.strictEqual(replies[3].data.catalogCompleteness, 'unknown');
    assert.strictEqual(replies[3].data.Episodes[0].Episode, '0');
    assert.strictEqual(replies[4].data.Season, '0'); assert.strictEqual(replies[4].data.Episode, '0');
    assert.strictEqual(replies[4].data.seriesID, parent);
  });
});

suite.test('the real tag applier retains ratings, credits, year and IMDb identity from server responses', async () => {
  await withServer(() => ({data:record()}), async client => {
    const result = await engine(client).tag({id:'movie', kind:'movie', title:'Old title', imdbID:'tt0034583', ratings:{}});
    assert.strictEqual(result.status, 'matched');
    assert.strictEqual(result.video.title, 'Casablanca'); assert.strictEqual(result.video.year, '1943');
    assert.strictEqual(result.video.imdbID, 'tt0034583');
    assert.deepStrictEqual(result.video.cast, ['Humphrey Bogart', 'Ingrid Bergman']);
    assert.deepStrictEqual(result.video.ratings, {imdb:8.5, rt:99, mc:100});
    assert.strictEqual(result.evidence.requests[0].requestId, requestId);
  });
});

suite.test('unknown values and year ranges survive translation; native provider IDs are never invented as IMDb IDs', async () => {
  const client = createCatalogClient({log, server:{url:'http://127.0.0.1:8787', token}, axios:async () => ({status:200, data:{requestId,
    data:record({year:{text:'2020–', start:2020, end:null}, artwork:[], runtimeMinutes:null, genres:null,
      ratings:[], votes:[], series:{provider:'other', id:'native-parent'}, ref:{provider:'other', id:'native-record'}})}})});
  const response = await client.requestCatalog(client.createCatalogQuery({id:'tt0034583'}));
  assert.strictEqual(response.data.Year, '2020–'); assert.strictEqual(response.data.Runtime, 'N/A');
  assert.strictEqual(response.data.Poster, 'N/A'); assert.strictEqual(response.data.imdbVotes, 'N/A');
  assert.strictEqual(response.data.seriesID, undefined); assert.strictEqual(response.data.imdbID, 'tt0034583');
  assert.deepStrictEqual(response.data.catalogSeriesRef, {provider:'other', id:'native-parent'});
});

suite.test('explicit parent cross-references work with opaque native IDs and reject conflicting or malformed evidence', async () => {
  const parent = 'tt4574334';
  const series = {provider:'another-catalog',id:'parent-42'};
  const episode = record({ref:{provider:'another-catalog',id:'episode-42'},kind:'episode',series,
    seriesExternalIds:{imdb:parent},season:1,episode:2});
  await withServer(() => ({data:episode}), async client => {
    const response = await client.requestCatalog({id:parent,season:1,episode:2});
    assert.strictEqual(response.data.seriesID,parent);
    assert.deepStrictEqual(response.data.catalogSeriesRef,series);
  });
  for (const seriesExternalIds of [{imdb:'tt1111111'},{imdb:'native-parent'},null,undefined]) {
    await withServer(() => ({data:{...episode,seriesExternalIds}}), async client => {
      await assert.rejects(client.requestCatalog({id:parent,season:1,episode:2}),{code:'METADATA_INVALID_RESPONSE'});
    });
  }
  await withServer(() => ({data:{...episode,series:{provider:'another-catalog',id:parent},seriesExternalIds:{}}}), async client => {
    const response = await client.requestCatalog({id:parent,season:1,episode:2});
    assert.strictEqual(response.data.seriesID,undefined,'An IMDb-looking native ID is still opaque');
  });
  await withServer(() => ({data:{series,seriesExternalIds:{imdb:'tt1111111'},season:1,order:'provider',
    totalSeasons:null,episodes:[],completeness:'unknown',provenance}}), async client => {
    await assert.rejects(client.requestCatalog({id:parent,season:1}),{code:'METADATA_INVALID_RESPONSE'});
  });
});

suite.test('concurrent and cached requests reuse one result and one budget charge, with separate queries remaining separate', async () => {
  await withServer((route, body) => ({data:search([], {page:body.page || 1, totalResults:null})}), async (client, calls) => {
    const context = {requestSession:createRequestSession(), requestBudget:createRequestBudget(2), requestTrace:[]};
    const query = client.createCatalogQuery({title:'Missing'});
    await Promise.all([client.requestCatalog(query, context), client.requestCatalog(query, context)]);
    await client.requestCatalog(query, context);
    await client.requestCatalog(client.createCatalogQuery({title:'Missing', page:2}), context);
    await assert.rejects(client.requestCatalog(client.createCatalogQuery({title:'Other'}), context), {code:'request-budget-exhausted'});
    assert.strictEqual(calls.length, 2); assert.strictEqual(context.requestBudget.used, 2);
    assert(context.requestTrace.slice(0, 4).every(row => row.requestId === requestId));
  });
});

suite.test('only an explicit missing-record code is unmatched; route errors, quota, auth and malformed data are service failures', async () => {
  for (const [status, code, expected] of [[404,'NOT_FOUND','unmatched'], [404,'ROUTE_NOT_FOUND','service-error'],
    [401,'UNAUTHORIZED','service-error'], [503,'PROVIDER_QUOTA_EXCEEDED','service-error'],
    [504,'PROVIDER_TIMEOUT','service-error'], [502,'PROVIDER_INVALID_RESPONSE','service-error']]) {
    await withServer(() => ({status, error:{code, message:token, retryable:false}}), async client => {
      const result = await engine(client).tag({id:'movie', kind:'movie', imdbID:'tt0034583'});
      assert.strictEqual(result.status, expected, code); assert.strictEqual(result.retryable, expected === 'service-error');
      assert(!JSON.stringify(result).includes(token));
      assert.strictEqual(result.evidence.requests[0].requestId, requestId);
    });
  }
});

suite.test('too-many-results remains ambiguous while failed requests are evicted for a later retry', async () => {
  await withServer((route, body, count) => count === 1 ?
    {status:503, error:{code:'PROVIDER_QUOTA_EXCEEDED'}} : {status:422, error:{code:'TOO_MANY_RESULTS'}}, async (client, calls) => {
    const context = {requestSession:createRequestSession()}, query = client.createCatalogQuery({title:'Broad search'});
    await assert.rejects(client.requestCatalog(query, context), {code:'PROVIDER_QUOTA_EXCEEDED'});
    const response = await client.requestCatalog(query, context);
    assert.strictEqual(require('../src/tagging/CatalogResponse').requestFailure(response).failure, 'Ambiguous results');
    assert.strictEqual(calls.length, 2);
  });
});

suite.test('a configured server never falls back to OMDb, and transport errors cannot retain credentials', async () => {
  const logs = [], logger = {debug:(...args) => logs.push(args), error:(...args) => logs.push(args)};
  let calls = 0;
  const client = createCatalogClient({server:{url:'http://127.0.0.1:8787', token}, log:logger, axios:async config => {
    calls++; assert(!config.url.includes('omdbapi')); assert.strictEqual(config.timeout, 30000);
    assert.strictEqual(config.maxRedirects, 0); assert.strictEqual(config.proxy, false);
    const error = new Error(`offline ${token}`); error.config = config; throw error;
  }});
  const result = await engine(client).tag({id:'movie', kind:'movie', imdbID:'tt0034583'});
  assert.strictEqual(result.status, 'service-error'); assert.strictEqual(calls, 1);
  assert.strictEqual(result.reason.code, 'METADATA_UNAVAILABLE');
  assert(!JSON.stringify({result, logs}).includes(token));
});

suite.test('malformed records, missing IMDb IDs, and contradictory episode evidence fail before matching', async () => {
  for (const data of [{}, record({externalIds:{}}), record({externalIds:{imdb:'tt0000001'}}),
    record({runtimeMinutes:'102'}), record({ratings:null})]) {
    await withServer(() => ({data}), async client => {
      const result = await engine(client).tag({id:'movie', kind:'movie', imdbID:'tt0034583'});
      assert.strictEqual(result.status, 'service-error'); assert.strictEqual(result.reason.code, 'METADATA_INVALID_RESPONSE');
    });
  }
  await withServer(() => ({data:record({kind:'episode', series:ref('tt1111111'), season:1, episode:2})}), async client => {
    await assert.rejects(client.requestCatalog(client.createCatalogQuery({id:'tt4574334', season:1, episode:1})), {code:'METADATA_INVALID_RESPONSE'});
  });
});

suite.test('redirects are rejected without contacting their destination', async () => {
  let destinationCalls = 0;
  const destination = http.createServer((req, res) => { destinationCalls++; res.end('{}'); });
  await new Promise(resolve => destination.listen(0, '127.0.0.1', resolve));
  const redirect = http.createServer((req, res) => {
    res.writeHead(302, {Location:`http://127.0.0.1:${destination.address().port}/leak`}); res.end('{}');
  });
  await new Promise(resolve => redirect.listen(0, '127.0.0.1', resolve));
  try {
    const client = createCatalogClient({axios, log, server:{url:`http://127.0.0.1:${redirect.address().port}`, token}});
    await assert.rejects(client.requestCatalog(client.createCatalogQuery({id:'tt0034583'})), {code:'METADATA_INVALID_RESPONSE'});
    assert.strictEqual(destinationCalls, 0);
  } finally {
    destination.closeAllConnections(); redirect.closeAllConnections();
    await Promise.all([new Promise(resolve => destination.close(resolve)), new Promise(resolve => redirect.close(resolve))]);
  }
});

suite.test('local configuration rejects remote or credential-bearing URLs and malformed files without silently disabling server mode', async () => {
  for (const url of ['https://example.com', 'http://127.0.0.1/path', 'http://user:password@localhost', 'http://localhost/?token=secret']) {
    assert.throws(() => validateServerConfig({url, token}));
  }
  assert.strictEqual(loadMetadataServerConfig({readFile:() => { const error = new Error('missing'); error.code = 'ENOENT'; throw error; }}), null);
  const broken = loadMetadataServerConfig({readFile:() => 'invalid ' + token});
  assert.deepStrictEqual(broken, {configurationError:true});
  const client = createCatalogClient({server:broken, log, axios:async () => { throw new Error('Must not request'); }});
  await assert.rejects(client.requestCatalog(client.createCatalogQuery({id:'tt0034583'})), {code:'METADATA_CONFIGURATION_ERROR'});
});

suite.test('main composition in server mode does not load the direct provider key', async () => {
  const api = loadFreshWithMocks(path.join(__dirname, '../src/tagging/TaggingService.js'), {
    electron:{app:{getPath:() => '/unused-fixture-directory'}},
    './MetadataServerConfig':{...require('../src/tagging/MetadataServerConfig'), loadMetadataServerConfig:() => ({url:'http://127.0.0.1:8787', token})},
    '../../omdb':new Proxy({}, {get:() => { throw new Error('Direct key accessed'); }}),
    axios:async () => ({status:200, data:{requestId, data:record()}}),
    '../platform/Logger.js':{child:() => log}
  });
  const result = await api.resolve({id:'movie', kind:'movie', imdbID:'tt0034583'});
  assert.strictEqual(result.status, 'candidate');
});

suite.test('missing and invalid connection settings leave tagging retryable without issuing any HTTP requests', async () => {
  for (const server of [null,undefined,{configurationError:true}]) {
    let requests = 0;
    const api = loadFreshWithMocks(path.join(__dirname,'../src/tagging/TaggingService.js'),{
      electron:{app:{getPath:() => '/unused-fixture-directory'}},
      './MetadataServerConfig':{loadMetadataServerConfig:() => server},
      axios:async () => { requests++; throw Error('Unexpected request'); },
      '../platform/Logger.js':{child:() => log}
    });
    const result = await api.tag({id:'movie',kind:'movie',imdbID:'tt0034583'});
    assert.strictEqual(result.status,'service-error');
    assert.strictEqual(result.retryable,true);
    assert.strictEqual(result.reason.code,'METADATA_CONFIGURATION_ERROR');
    assert.strictEqual(requests,0);
  }
});

suite.test('setup copies only the selected token, uses private permissions, and never overwrites existing settings', () =>
  withTemporaryDirectory('metadata-setup', directory => {
    const root = path.resolve(__dirname, '..'), server = path.join(directory, 'server');
    fs.mkdirSync(server);
    for (const file of ['scripts/setup-metadata-server.js', 'src/tagging/MetadataServerConfig.js']) {
      fs.mkdirSync(path.dirname(path.join(directory, file)), {recursive:true});
      fs.copyFileSync(path.join(root, file), path.join(directory, file));
    }
    const other = 'second-development-token-for-tests-only', apiKey = 'provider-secret-not-to-be-copied';
    fs.writeFileSync(path.join(server, '.dev.vars'), `OMDB_API_KEY=${apiKey}\nDEV_CLIENT_TOKENS='${JSON.stringify({torgo:token, atelaes:other})}'\n`);
    const args = [path.join(directory, 'scripts/setup-metadata-server.js'), server, 'atelaes'];
    const result = spawnSync(process.execPath, args, {encoding:'utf8'});
    assert.strictEqual(result.status, 0, result.stderr);
    const file = path.join(directory, 'metadata-server.local.json'), contents = fs.readFileSync(file, 'utf8');
    assert.deepStrictEqual(JSON.parse(contents), {url:'http://127.0.0.1:8787', token:other});
    assert(!contents.includes(apiKey)); assert(!contents.includes(token));
    assert(!`${result.stdout}${result.stderr}`.includes(other));
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
    assert.strictEqual(spawnSync(process.execPath, args, {encoding:'utf8'}).status, 1);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), contents);
  }));

suite.test('the actual application file filter excludes current and obsolete local credential files', () =>
  withTemporaryDirectory('metadata-package', directory => {
    const {FileMatcher} = require('app-builder-lib/out/fileMatcher');
    const rules = require('../package.json').build.files;
    const include = new FileMatcher(directory, path.join(directory, 'package'), value => value, rules).createFilter();
    for (const name of ['metadata-server.local.json','omdb.js']) {
      const file = path.join(directory,name);
      fs.writeFileSync(file,'synthetic credentials');
      assert.strictEqual(include(file, fs.statSync(file)), false,name);
    }
  }));

runSuite(suite);
