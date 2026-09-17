const {assert,createSuite,runSuite} = require('./helpers/TestHarness');
const {createCatalogClient,createRequestSession} = require('../src/tagging/CatalogClient');
const {show,series,episode,loadSearch,catalog} = require('./helpers/OmdbFixtures');
const suite = createSuite('Catalog request reuse','unit',
  'Exercises concurrent reuse, failure eviction, session boundaries and real episode probes without network access.');
const log = {debug(){},error(){}};
suite.test('concurrent identical requests share one response; sessions remain independent',async()=>{
  let calls=0;
  const client=createCatalogClient({omdb:{key:'fixture'},log,axios:async()=>{
    calls++; return {status:200,data:series()};
  }});
  const url=client.createURLParts({id:'tt1000001'}), context={requestSession:createRequestSession()};
  await Promise.all([client.pollOMDB(url,context),client.pollOMDB(url,context)]);
  assert.strictEqual(calls,1);
  await client.pollOMDB(url,{requestSession:createRequestSession()});
  assert.strictEqual(calls,2);
});
suite.test('transport and provider errors remain retryable; definitive misses are reused',async()=>{
  let calls=0;
  const answers=[Error('offline'),{Response:'False',Error:'Request limit reached!'},
    {Response:'False',Error:'Movie not found!'}];
  const client=createCatalogClient({omdb:{key:'fixture'},log,axios:async()=>{
    calls++;const data=answers.shift();if(data instanceof Error)throw data;return {status:200,data};
  }});
  const url=client.createURLParts({id:'tt1000001'}), context={requestSession:createRequestSession()};
  await assert.rejects(client.pollOMDB(url,context));
  await client.pollOMDB(url,context);await client.pollOMDB(url,context);await client.pollOMDB(url,context);
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
runSuite(suite);
