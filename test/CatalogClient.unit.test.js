const {assert,createSuite,runSuite} = require('./helpers/TestHarness');
const {createCatalogClient,createRequestSession} = require('../src/tagging/CatalogClient');
const {show,series,episode,loadSearch,catalog} = require('./helpers/OmdbFixtures');
const suite = createSuite('Catalog request reuse','unit',
  'Exercises concurrent reuse, failure eviction, session boundaries and real episode probes without network access.');
const log = {debug(){},error(){}};
suite.test('catalog queries keep neutral inputs, canonicalize values, and omit credentials from transport and evidence',async()=>{
  const received=[];
  const client=createCatalogClient({log,transport:async query=>{
    received.push(query);return {status:200,data:series()};
  }});
  const context={requestSession:createRequestSession(),requestTrace:[]};
  await client.requestCatalog({id:'tt1000001',season:0,episode:2,token:'private-token',apikey:'private-key'},context);
  await client.requestCatalog({id:'tt1000001',season:'0',episode:'2'},context);
  assert.deepStrictEqual(received,[{id:'tt1000001',season:'0',episode:'2'}]);
  assert.strictEqual(context.requestSession.reused,1);
  assert(!JSON.stringify(context.requestTrace).includes('private-'));
});
suite.test('concurrent identical requests share one response; sessions remain independent',async()=>{
  let calls=0;
  const client=createCatalogClient({log,transport:async()=>{
    calls++; return {status:200,data:series()};
  }});
  const url=client.createCatalogQuery({id:'tt1000001'}), context={requestSession:createRequestSession()};
  await Promise.all([client.requestCatalog(url,context),client.requestCatalog(url,context)]);
  assert.strictEqual(calls,1);
  await client.requestCatalog(url,{requestSession:createRequestSession()});
  assert.strictEqual(calls,2);
});
suite.test('transport and provider errors remain retryable; definitive misses are reused',async()=>{
  let calls=0;
  const answers=[Error('offline'),{Response:'False',Error:'Request limit reached!'},
    {Response:'False',Error:'Movie not found!'}];
  const client=createCatalogClient({log,transport:async()=>{
    calls++;const data=answers.shift();if(data instanceof Error)throw data;return {status:200,data};
  }});
  const url=client.createCatalogQuery({id:'tt1000001'}), context={requestSession:createRequestSession()};
  await assert.rejects(client.requestCatalog(url,context));
  await client.requestCatalog(url,context);await client.requestCatalog(url,context);await client.requestCatalog(url,context);
  assert.strictEqual(calls,3);
});
suite.test('different episode queries remain distinct while neighboring corrections reuse probes',async()=>{
  const parent=series();const {api,requests}=loadSearch(catalog([
    episode('Alpha Story',1,1),episode('Beta Story',1,2),episode('Gamma Story',1,3)
  ],parent));
  const session=api.createSeriesSearchSession();
  for(const [n,title] of [[2,'Alpha Story'],[3,'Beta Story']]){
    const result=await api.search(show({seriesImdbID:parent.imdbID,season:'1',episode:String(n),title}),
      {seriesSearchSession:session});
    assert(result.success);
  }
  const keys=requests.map(q=>JSON.stringify(q));
  assert.strictEqual(keys.length,new Set(keys).size,'a probe must not be fetched again for the next file');
  assert(session.catalog.reused>=2);
});
suite.test('an unsuccessful season hint is not fetched again by the correction fallback',async()=>{
  const parent=series();const {api,requests}=loadSearch(catalog([
    episode('Zebras',2,3),episode('Tornado',1,3)
  ],parent));
  const result=await api.search(show({seriesImdbID:parent.imdbID,season:'2',episode:'3',title:'Aardvark'}),
    {seasonOffsetHints:new Map([[parent.imdbID,-1]])});
  assert.strictEqual(result.success,false);
  assert.strictEqual(requests.filter(q=>q.Season==='1'&&q.Episode==='3').length,1);
});
suite.test('too-many-results reuses the exact query only within its request session',async()=>{
  let calls=0;
  const client=createCatalogClient({log,transport:async()=>{
    calls++;return {status:200,data:{Response:'False',Error:'Too many results.'}};
  }});
  const context={requestSession:createRequestSession(),requestTrace:[]};
  await client.requestCatalog({exactTitle:'Broad series',type:'series'},context);
  await client.requestCatalog({exactTitle:'Broad series',type:'series'},context);
  assert.strictEqual(calls,1);
  assert.strictEqual(context.requestTrace[1].outcome,'ambiguous');
  await client.requestCatalog({exactTitle:'Broad series',type:'series',year:2000},context);
  await client.requestCatalog({exactTitle:'Broad series',type:'series'},{requestSession:createRequestSession()});
  assert.strictEqual(calls,3);
});

runSuite(suite);
