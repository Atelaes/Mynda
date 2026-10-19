const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const {spawnSync} = require('child_process');
const axios = require('axios');
const {assert, createSuite, runSuite, withTemporaryDirectory} = require('./helpers/TestHarness');
const {loadFreshWithMocks} = require('./helpers/ModuleMocks');
const {createCatalogClient, createRequestSession} = require('../src/tagging/CatalogClient');
const {createRequestBudget} = require('../src/tagging/RequestBudget');
const {createTaggingEngine} = require('../src/tagging/TaggingEngine');
const {createTagApplier} = require('../src/tagging/TagApplier');
const {loadMetadataServerConfig, validateServerConfig} = require('../src/tagging/MetadataServerConfig');
const suite = createSuite('Metadata server integration', 'integration',
  'Exercises the real HTTP/HTTPS client, tagging engine, private settings and service failures against loopback fixtures; no provider access.');
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

suite.test('provider aliases survive HTTP translation and final movie acceptance', async () => {
  const data = record({ref:{provider:'tvdb',id:'movie:1'},externalIds:{},title:'Appleseed α',aliases:['Appleseed Alpha'],
    year:{text:'2014',start:2014,end:null},runtimeMinutes:90,artwork:[],ratings:[],votes:[],
    provenance:{provider:'tvdb',fetchedAt:'2026-10-18T00:00:00.000Z'}});
  await withServer(()=>({data}),async client=>{
    const result = await engine(client).tag({id:'alias',kind:'movie',filename:'/Movies/Appleseed Alpha (2014).mkv',
      title:'Appleseed Alpha',year:'2014',metadata:{duration:90*60}});
    assert.strictEqual(result.status,'matched',JSON.stringify(result));
    assert.strictEqual(result.video.title,'Appleseed α');
    assert.strictEqual(result.evidence.movieAssessment.providerAlias,'Appleseed Alpha');
  });
});

suite.test('malformed provider aliases fail validation', async () => {
  await withServer(()=>({data:record({aliases:[{name:'Not a normalized alias'}]})}),async client=>{
    await assert.rejects(()=>client.requestCatalog(client.createCatalogQuery({id:'tt0034583'})),{code:'METADATA_INVALID_RESPONSE'});
  });
});

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
  assert.strictEqual(response.data.seriesID, 'other:native-parent'); assert.strictEqual(response.data.seriesImdbID, ''); assert.strictEqual(response.data.imdbID, 'tt0034583');
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
    await assert.rejects(client.requestCatalog({id:parent,season:1,episode:2}),{code:'METADATA_INVALID_RESPONSE'});
    const response = await client.requestCatalog({id:'another-catalog:'+parent,season:1,episode:2});
    assert.strictEqual(response.data.seriesImdbID,'','An IMDb-looking native ID is still opaque');
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

suite.test('configuration accepts hosted HTTPS and retains local HTTP development', () => {
  for (const url of ['https://mynda-server-dev.example.workers.dev', 'https://metadata.example.org:8443/',
    'http://127.0.0.1:8787', 'http://localhost:8787', 'http://[::1]:8787']) {
    assert.deepStrictEqual(validateServerConfig({url, token}), {url:new URL(url).origin, token});
  }
});

suite.test('configuration rejects remote HTTP, credential-bearing URLs and malformed files without silently disabling server mode', async () => {
  for (const url of ['http://example.com', 'http://localhost.example.com', 'https:example.com',
    'http://127.0.0.1/path', 'http://user:password@localhost', 'http://localhost/?token=secret',
    'https://example.org/path', 'https://user:secret@example.org', 'https://example.org/?token=secret',
    'https://example.org/#secret', 'ftp://example.org', null]) {
    assert.throws(() => validateServerConfig({url, token}));
  }
  assert.strictEqual(loadMetadataServerConfig({readFile:() => { const error = new Error('missing'); error.code = 'ENOENT'; throw error; }}), null);
  const broken = loadMetadataServerConfig({readFile:() => 'invalid ' + token});
  assert.deepStrictEqual(broken, {configurationError:true});
  const client = createCatalogClient({server:broken, log, axios:async () => { throw new Error('Must not request'); }});
  await assert.rejects(client.requestCatalog(client.createCatalogQuery({id:'tt0034583'})), {code:'METADATA_CONFIGURATION_ERROR'});
});

suite.test('HTTPS uses certificate verification and translates a response from a trusted TLS endpoint', async () => {
  const certificate = fs.readFileSync(path.join(__dirname, 'fixtures/metadata-tls/cert.pem'));
  const key = fs.readFileSync(path.join(__dirname, 'fixtures/metadata-tls/key.pem'));
  const received = [];
  const server = https.createServer({cert:certificate, key}, (req, res) => {
    received.push({url:req.url, authorization:req.headers.authorization, encrypted:req.socket.encrypted});
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({requestId, data:record()}));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const connection = {url:`https://127.0.0.1:${server.address().port}`, token};
  const agent = new https.Agent({ca:certificate});
  try {
    const untrusted = createCatalogClient({axios, server:connection, log});
    await assert.rejects(untrusted.requestCatalog(untrusted.createCatalogQuery({id:'tt0034583'})), {code:'METADATA_UNAVAILABLE'});
    assert.strictEqual(received.length, 0, 'An untrusted certificate must fail before sending credentials');
    // Trust only this disposable test certificate; production does not supply
    // a custom agent or turn off the operating runtime's TLS verification.
    const trusted = createCatalogClient({axios:options => axios({...options, httpsAgent:agent}), server:connection, log});
    const response = await trusted.requestCatalog(trusted.createCatalogQuery({id:'tt0034583'}));
    assert.strictEqual(response.data.Title, 'Casablanca');
    assert.deepStrictEqual(received, [{url:'/v1/record', authorization:`Bearer ${token}`, encrypted:true}]);
  } finally {
    agent.destroy(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

suite.test('main composition in server mode does not load the direct provider key', async () => {
  const api = loadFreshWithMocks(path.join(__dirname, '../src/tagging/TaggingService.js'), {
    electron:{app:{getPath:() => '/unused-fixture-directory'}},
    '../main/MetadataConnection':{getConfig:async () => ({url:'http://127.0.0.1:8787', token})},
    '../main/FeatureAccess':require('./helpers/ActivatedFeatureAccess'),
    '../../omdb':new Proxy({}, {get:() => { throw new Error('Direct key accessed'); }}),
    axios:async () => ({status:200, data:{requestId, data:record()}}),
    '../platform/Logger.js':{child:() => log}
  });
  const result = await api.resolve({id:'movie', kind:'movie', imdbID:'tt0034583'});
  assert.strictEqual(result.status, 'candidate');
});

suite.test('missing and unreadable activation blocks tagging before any HTTP requests', async () => {
  for (const server of [null,undefined,{configurationError:true}]) {
    let requests = 0;
    const api = loadFreshWithMocks(path.join(__dirname,'../src/tagging/TaggingService.js'),{
      electron:{app:{getPath:() => '/unused-fixture-directory'}},
      '../main/MetadataConnection':{getConfig:async () => server},
      '../main/FeatureAccess':require('../src/platform/FeatureAccess').createFeatureAccess({requireActivation:async()=>{
        throw Object.assign(new Error('Unavailable credentials'),{code:server ? 'STORAGE_READ' : 'ACCESS_MISSING'});
      }}),
      axios:async () => { requests++; throw Error('Unexpected request'); },
      '../platform/Logger.js':{child:() => log}
    });
    await assert.rejects(api.tag({id:'movie',kind:'movie',imdbID:'tt0034583'}),
      {code:server ? 'ACTIVATION_UNAVAILABLE' : 'ACTIVATION_REQUIRED'});
    assert.strictEqual(requests,0);
  }
});

suite.test('setup sends only the selected token to encrypted storage without writing a plaintext file', () =>
  withTemporaryDirectory('metadata-setup', async directory => {
    const other = 'second-development-token-for-tests-only', apiKey = 'provider-secret-not-to-be-copied';
    fs.writeFileSync(path.join(directory, '.dev.vars'), `OMDB_API_KEY=${apiKey}\nDEV_CLIENT_TOKENS='${JSON.stringify({torgo:token, atelaes:other})}'\n`);
    const calls = [];
    const {setup} = require('../scripts/setup-metadata-server');
    await setup(directory, 'atelaes', {execute:async command=>{calls.push(command);}});
    assert.deepStrictEqual(calls,[{action:'setup',config:{url:'http://127.0.0.1:8787',token:other}}]);
    assert(!JSON.stringify(calls).includes(apiKey));
    assert(!fs.existsSync(path.join(directory,'metadata-server.local.json')));
    await assert.rejects(setup(directory, 'missing', {execute:()=>assert.fail('must not execute')}), /Could not read a valid/);
  }));

suite.test('connect validates the destination before invoking encrypted storage and sends no token in the command', async () => {
  const {connect} = require('../scripts/connect-metadata-server');
  const calls = [], execute=async command=>{calls.push(command);return {url:command.url};};
  for (const url of ['http://example.org','https://example.org/path','https://example.org/?token='+token]) {
    await assert.rejects(connect(url,{execute}), /Use an HTTPS/);
  }
  assert.strictEqual(calls.length,0);
  for (const url of ['https://mynda-server-dev.example.workers.dev','http://127.0.0.1:8787']) await connect(url,{execute});
  assert(calls.every(command=>Object.keys(command).sort().join(',')==='action,url'));
});

suite.test('request clients pick up credential changes and removal without restarting', async () => {
  let current={url:'https://first.example',token};
  const calls=[];
  const client=createCatalogClient({server:async()=>current,log,axios:async options=>{
    calls.push(options);return {status:200,data:{requestId,data:record()}};
  }});
  await client.requestCatalog({id:'tt0034583'});
  current={url:'https://second.example',token:'a-different-synthetic-token-for-test'};
  await client.requestCatalog({id:'tt0034583'});
  current=null;
  await assert.rejects(client.requestCatalog({id:'tt0034583'}),{code:'METADATA_CONFIGURATION_ERROR'});
  assert.strictEqual(calls.length,2);
  assert.strictEqual(calls[0].url,'https://first.example/v1/record');
  assert.strictEqual(calls[1].headers.Authorization,'Bearer a-different-synthetic-token-for-test');
});

suite.test('the actual application file filter excludes current, temporary and obsolete local credential files', () =>
  withTemporaryDirectory('metadata-package', directory => {
    const {FileMatcher} = require('app-builder-lib/out/fileMatcher');
    const rules = require('../package.json').build.files;
    const include = new FileMatcher(directory, path.join(directory, 'package'), value => value, rules).createFilter();
    for (const name of ['metadata-server.local.json','.metadata-server-synthetic.tmp','metadata-credentials.json','.metadata-credentials-synthetic.tmp','omdb.js']) {
      const file = path.join(directory,name);
      fs.writeFileSync(file,'synthetic credentials');
      assert.strictEqual(include(file, fs.statSync(file)), false,name);
    }
  }));

const Identity=require('../src/tagging/CatalogIdentity');
const Evidence=require('../src/tagging/TaggingEvidence');
const nativeRef=id=>({provider:'fixture',id});
const nativeRecord=overrides=>record({ref:nativeRef('movie:42'),externalIds:{},artwork:[],ratings:[],votes:[],
  provenance:{...provenance,provider:'fixture'},...overrides});

suite.test('native-only records survive all five operations, including season zero and missing ratings',async()=>{
  const parent=nativeRef('series:42'), movie=nativeRecord(), ep=nativeRecord({ref:nativeRef('episode:42'),kind:'episode',
    series:parent,season:0,episode:0,episodeOrder:'provider'});
  await withServer((route)=>({data:route==='/v1/search'?search([movie]):route==='/v1/episode'?ep:
    route==='/v1/season'?{series:parent,seriesExternalIds:{},season:0,order:'provider',totalSeasons:null,
      completeness:'partial',provenance,episodes:[{ref:ep.ref,externalIds:{},title:'Special',episode:0,released:null}]}:movie}),async(client,calls)=>{
    const queries=[{title:'Casablanca',type:'movie'},{exactTitle:'Casablanca',type:'movie'},
      {id:'fixture:movie:42'},{id:'fixture:series:42',season:0},{id:'fixture:series:42',season:0,episode:0}];
    const replies=[];for(const q of queries)replies.push((await client.requestCatalog(q)).data);
    assert.strictEqual(replies[0].Search[0].imdbID,'');
    for(const r of [replies[1],replies[2],replies[4]])assert.strictEqual(r.imdbID,'');
    assert.strictEqual(replies[4].seriesImdbID,'');assert.deepStrictEqual(replies[4].catalogSeriesRef,parent);
    assert.deepStrictEqual(calls[2].body.ref,movie.ref);assert.deepStrictEqual(calls[4].body.series,parent);
    assert.strictEqual(replies[3].catalogCompleteness,'partial');
    assert.strictEqual(replies[3].Episodes[0].imdbID,'');
  });
});

suite.test('native movie selection, serialized refresh and reports work without an IMDb ID',async()=>{
  const data=nativeRecord();
  await withServer(route=>({data:route==='/v1/search'?search([data]):data}),async(client,calls)=>{
    const api=engine(client);
    const original={id:'movie',kind:'movie',filename:'/Movies/Casablanca.1943.mkv',title:'Casablanca',year:1943,
      ratings:{user:0,imdb:9,rt:98,mc:90},metadata:{duration:102*60}};
    const library={media:[original]};
    const editor=require('../src/main/EditorService').createEditorService({library,catalog:api,app:{getPath:()=>'/tmp'},dialog:{}});
    const proposal=await editor.search(original,'native-window');assert.strictEqual(proposal.status,'candidate');
    const result=await editor.select({draft:original,choice:{myndaProposalID:proposal.proposalID}},'native-window');
    assert.strictEqual(result.status,'matched');assert.deepStrictEqual(result.video.catalogRef,data.ref);
    assert.deepStrictEqual(result.video.ratings,{user:0,imdb:'',rt:'',mc:''});assert.strictEqual(result.video.imdbID,'');
    const saved=JSON.parse(JSON.stringify(result.video));
    const refreshed=await api.tag(saved);assert.strictEqual(refreshed.status,'matched');
    assert.strictEqual(refreshed.evidence.identities.record.origin,'user');
    assert.strictEqual(refreshed.evidence.recordID,'fixture:movie:42');
    assert.strictEqual(require('../src/tagging/TaggingReport').buildTaggingReport(refreshed.video).status,'matched');
    assert.deepStrictEqual(calls.at(-1).body.ref,data.ref);assert.strictEqual(library.media[0],original);
  });
});

suite.test('choosing a native-only row uses the stored choice and clears ratings from the previous work',async()=>{
  const a=nativeRecord(),b=nativeRecord({ref:nativeRef('movie:43')});
  await withServer((route,body)=>route==='/v1/title'?{status:404,error:{code:'NOT_FOUND'}}:
    {data:route==='/v1/search'?search([a,b]):body.ref.id===a.ref.id?a:b},async client=>{
    const original={id:'choice',kind:'movie',title:'Casablanca',year:1943,filename:'/Movies/Casablanca.1943.mkv',
      metadata:{duration:6120},ratings:{user:0,imdb:9,rt:99,mc:99}};
    const editor=require('../src/main/EditorService').createEditorService({library:{media:[original]},catalog:engine(client),app:{getPath:()=>'/tmp'},dialog:{}});
    const proposal=await editor.search(original,'window');assert.strictEqual(proposal.status,'ambiguous');
    const choice=proposal.choices.find(row=>row.catalogRef.id==='movie:43');assert(choice);
    const result=await editor.select({draft:original,choice:{...choice,catalogRef:nativeRef('movie:forged')}},'window');
    assert.strictEqual(result.status,'matched');assert.deepStrictEqual(result.video.catalogRef,b.ref);
    assert.deepStrictEqual(result.video.ratings,{user:0,imdb:'',rt:'',mc:''});
  });
});

suite.test('native episode batches retain parent references and independent numbering evidence',async()=>{
  const parent=nativeRef('series:42');
  const titles=['First Story','Second Story','Third Story'];
  await withServer((route,body)=>({data:route==='/v1/search'?search([nativeRecord({ref:parent,kind:'series',title:'Native Show'})]):
    nativeRecord({ref:nativeRef('episode:'+body.episode),kind:'episode',title:titles[body.episode-1],runtimeMinutes:45,
      series:parent,season:1,episode:body.episode,episodeOrder:'provider'})}),async client=>{
    const videos=titles.map((title,i)=>({id:'ep'+i,filename:'/Shows/Native Show/Season 1/'+title+'.mkv',kind:'show',
      title:i===2?'Native Show S01E03':title,series:'Native Show',season:'1',episode:String(i+1),metadata:{duration:2700},ratings:{user:0}}));
    const saved=new Map();
    const run=require('../src/tagging/AutoTagRunner').createAutoTagRunner({state:{running:false},catalog:engine(client),log,
      getCandidates:()=>videos,getLibraryVideos:()=>videos,save:async batch=>batch.forEach(v=>saved.set(v.id,v)),
      notifyStatus(){},chooseSeries:async()=>null,preferences:{},whenIdle:async()=>{}});
    await run({videos});assert.strictEqual(saved.size,3);
    for(const v of saved.values()){
      assert.deepStrictEqual(v.catalogSeriesRef,parent);assert.strictEqual(v.seriesImdbID,'');
      assert.strictEqual(v.imdbID,'');assert(Identity.recordKey(v).startsWith('fixture:episode:'));
      assert(!v.taggingDecision || v.taggingDecision.status==='matched');
    }
  });
});

suite.test('native season-list fallback verifies the retrieved episode identity and parent',async()=>{
  const parent=nativeRef('series:42'),ep=nativeRecord({ref:nativeRef('episode:7'),kind:'episode',title:'Story',
    series:parent,season:1,episode:1,episodeOrder:'provider',runtimeMinutes:45});
  for(const wrongParent of [false,true]) await withServer(route=>route==='/v1/episode'?
    {status:404,error:{code:'NOT_FOUND'}}:{data:route==='/v1/season'?{
      series:parent,seriesExternalIds:{},season:1,order:'provider',totalSeasons:1,completeness:'complete',provenance,
      episodes:[{ref:ep.ref,externalIds:{},title:'Story',episode:1,released:null}]}:
      {...ep,series:wrongParent?nativeRef('series:99'):parent}},async client=>{
    const result=await engine(client).tag({id:'show',kind:'show',title:'Story',series:'Native Show',season:'1',episode:'1',
      catalogSeriesRef:parent,metadata:{duration:2700},ratings:{}});
    if(wrongParent)assert.notStrictEqual(result.status,'matched');
    else assert.strictEqual(result.status,'matched');
    if(!wrongParent)assert.deepStrictEqual(result.video.catalogRef,ep.ref);
  });
});

suite.test('native IDs cannot collide across providers or be manufactured as IMDb cross-references',async()=>{
  assert.notStrictEqual(Identity.recordKey({catalogRef:{provider:'one',id:'42'}}),Identity.recordKey({catalogRef:{provider:'two',id:'42'}}));
  assert.deepStrictEqual(Identity.lookup('fixture:episode:42'),nativeRef('episode:42'));
  assert.deepStrictEqual(Identity.parentKeys([{seriesImdbID:'tt1234567'},{catalogSeriesRef:nativeRef('series:1'),seriesImdbID:'tt1234567'}]),['fixture:series:1']);
  assert.strictEqual(Identity.parentKeys([{catalogSeriesRef:nativeRef('series:1'),seriesImdbID:'tt1234567'},
    {catalogSeriesRef:nativeRef('series:2'),seriesImdbID:'tt1234567'}]).length,2);
  for(const ref of [{provider:'',id:'42'},{provider:'fixture',id:'../unsafe'},{provider:'fixture',id:'x',extra:true}])assert.strictEqual(Identity.native(ref),null);
  await withServer(()=>({data:nativeRecord({ref:nativeRef('tt0034583')})}),async client=>{
    await assert.rejects(client.requestCatalog({id:'tt0034583'}),{code:'METADATA_INVALID_RESPONSE'});
    const reply=await client.requestCatalog({id:'fixture:tt0034583'});assert.strictEqual(reply.data.imdbID,'');
    await assert.rejects(client.requestCatalog({id:'other:tt0034583'}),{code:'METADATA_INVALID_RESPONSE'});
  });
});

suite.test('legacy saved IMDb authorship survives upgrading to native references',async()=>{
  const prior={id:'legacy',kind:'movie',title:'Old title',imdbID:'tt0034583',ratings:{user:0,imdb:7},
    taggingEvidence:{kind:'movie',imdbID:'tt0034583',original:{title:'Original filename'},
      identities:{record:{value:'tt0034583',origin:'automatic',basis:'movie'}}}};
  await withServer(()=>({data:record({ratings:[]})}),async client=>{
    const api=engine(client);const first=await api.tag(prior);assert.strictEqual(first.status,'matched');
    assert.deepStrictEqual(first.video.catalogRef,ref('tt0034583'));assert.strictEqual(first.video.ratings.imdb,7);
    const next=await api.tag(JSON.parse(JSON.stringify(first.video)));
    assert.strictEqual(next.evidence.identities.record.origin,'automatic');
    assert.deepStrictEqual(next.evidence.original,prior.taggingEvidence.original);
  });
});

suite.test('manual IMDb and parent edits clear stale native references while preserving personal ratings',()=>{
  const base={kind:'show',catalogRef:nativeRef('episode:1'),catalogSeriesRef:nativeRef('series:1'),
    imdbID:'tt0034583',seriesImdbID:'tt1234567',ratings:{user:0,imdb:9},series:'Original'};
  const edited=Evidence.markUserEdit({...base,imdbID:'tt9999999'},{imdbID:'tt9999999'});
  assert.strictEqual(edited.catalogRef,null);assert.strictEqual(edited.ratings.user,0);assert.strictEqual(edited.ratings.imdb,'');
  for(const changes of [{series:'New show'},{kind:'movie'}]){
    const result=Evidence.markUserEdit({...base,...changes},changes);
    assert.strictEqual(result.catalogSeriesRef,null);assert.strictEqual(result.seriesImdbID,'');
  }
});

suite.test('partial and unknown season lists cannot establish complete episode counts',()=>{
  const season={Response:'True',Season:'1',catalogSeriesRef:nativeRef('series:1'),Episodes:[1,2].map(n=>({Episode:String(n),catalogRef:nativeRef('episode:'+n)}))};
  const assess=require('../src/tagging/SeriesStructure').seasonEvidence;
  for(const catalogCompleteness of ['partial','unknown'])assert.strictEqual(assess({...season,catalogCompleteness},1,'fixture:series:1').count,null);
  assert.strictEqual(assess({...season,catalogCompleteness:'complete'},1,'fixture:series:1').count,2);
});

suite.test('complete-title proof survives the actual decoder with all competing rows',async()=>{
  const data=nativeRecord({ref:nativeRef('series:1'),kind:'series',title:'Test Series'});
  data.titleSearch={query:'Test Series',complete:true,items:[data,{...data,ref:nativeRef('series:2'),title:'Test Series (US)'}].map(row=>({...row}))};
  await withServer(()=>({data}),async client=>{
    const result=(await client.requestCatalog({exactTitle:'Test Series',type:'series'})).data;
    assert.strictEqual(result.catalogTitleSearch.complete,true);
    assert.strictEqual(result.catalogTitleSearch.items.length,2);
    assert.deepStrictEqual(result.catalogTitleSearch.items[1].catalogRef,nativeRef('series:2'));
  });
});
suite.test('complete-title proof accepts the bounded 500-row series result set',async()=>{
  const data=nativeRecord({ref:nativeRef('series:1'),kind:'series',title:'Test Series'});
  data.titleSearch={query:'Test Series',complete:true,items:Array.from({length:500},(_,i)=>
    ({...data,ref:nativeRef('series:'+(i+1)),title:i?'Unrelated '+i:'Test Series'}))};
  await withServer(()=>({data}),async client=>{
    const result=(await client.requestCatalog({exactTitle:'Test Series',type:'series'})).data;
    assert.strictEqual(result.catalogTitleSearch.items.length,500);
  });
});
suite.test('the decoder rejects incomplete, duplicate, unrelated or mismatched complete-title proof',async()=>{
  const data=nativeRecord({ref:nativeRef('series:1'),kind:'series',title:'Test Series'});
  const good={query:'Test Series',complete:true,items:[data]};
  const bad=[{...good,query:'Other'},{...good,complete:false},{...good,items:[]},
    {...good,items:[data,data]}, {...good,items:[{...data,kind:'movie'}]},
    {...good,items:[{...data,ref:{provider:'other',id:'series:1'}}]},
    {...good,items:[{...data,ref:nativeRef('series:2')}]},
    {...good,items:Array.from({length:501},(_,i)=>({...data,ref:nativeRef('series:'+i)}))}];
  for(const titleSearch of bad) await withServer(()=>({data:{...data,titleSearch}}),async client=>{
    await assert.rejects(client.requestCatalog({exactTitle:'Test Series',type:'series'}),{code:'METADATA_INVALID_RESPONSE'});
  });
  await withServer(()=>({data:{...data,titleSearch:good}}),async client=>{
    await assert.rejects(client.requestCatalog({id:'fixture:series:1'}),{code:'METADATA_INVALID_RESPONSE'});
  });
});

runSuite(suite);
