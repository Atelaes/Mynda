const {assert, createSuite, runSuite} = require('./helpers/TestHarness.js');
const {show, series, episode, loadSearch, catalog} = require('./helpers/OmdbFixtures.js');
const suite=createSuite('OMDb series discovery and batch reuse','integration',
  'Runs the complete search and tagging workflow against deterministic catalog responses, including rejected candidates.');

const rows = items => ({Response:'True',Search:items,totalResults:String(items.length)});
function onlyQuery(title, parent, data) {
  const existing=catalog(data,parent);
  return q => q.s || q.t ? (q.s && q.s.toLowerCase() === title.toLowerCase() ? rows([parent]) : undefined) : existing(q);
}

for (const [input,query,title,id,year] of [
  ['News Radio','NewsRadio','NewsRadio','tt0112095','1995'],
  ['SATC','Sex and the City','Sex and the City','tt0159206','1998'],
  ['House MD','House','House','tt0412142','2004'],
  ['The Office US','The Office','The Office','tt0386676','2005'],
  ['DanMachi','Is It Wrong to Try to Pick Up Girls in a Dungeon?','Is It Wrong to Try to Pick Up Girls in a Dungeon?','tt4728568','2015'],
  ['Generation War','Unsere Mütter, unsere Väter','Unsere Mütter, unsere Väter','tt1883092','2013'],
  ["Family Guy - season's 1-9",'Family Guy','Family Guy','tt0182576','1999'],
  ['Wonder Showzen Complete (640x480)','Wonder Showzen','Wonder Showzen','tt0450357','2005'],
  ['The Sopranos - The Complete Series + Extras','The Sopranos','The Sopranos','tt0141842','1999'],
  ['AEON FLUX','Æon Flux','Æon Flux','tt0111873','1991'],
  ['Seaquest DSV','Seaquest','seaQuest DSV','tt0106126','1993']
]) suite.test(`discovers ${input} while retaining the user's series label`,async()=>{
  const parent=series(id,title,year), target=episode('A Real Episode',1,1,id);
  const {api,logs,requests}=loadSearch(onlyQuery(query,parent,[target]));
  const result=await api.search(show({series:input}));
  assert(result.success,JSON.stringify(result));
  assert.strictEqual(result.data.seriesImdbID,id);
  assert.strictEqual(result.data.series,input);
  assert.strictEqual(result.data.imdbID,target.imdbID);
  assert(requests.length<=22);
  assert(logs.some(l=>l.level==='info' && l.message==='Series discovery diagnostics'));
});

suite.test('leaves an existing exact match on its original request path',async()=>{
  const {api,requests}=loadSearch(catalog([episode('A Real Episode')]));
  const result=await api.search(show());assert(result.success);
  assert.strictEqual(requests.filter(q=>q.s || q.t).length,1);
});

suite.test('DanMachi release-only title tags can acquire an actual episode title',async()=>{
  const parent=series('tt4728568','Is It Wrong to Try to Pick Up Girls in a Dungeon?','2015');
  const target=episode('Adventurer: Bell Cranel',1,1,parent.imdbID);
  const {api}=loadSearch(onlyQuery(parent.Title,parent,[target]));
  const result=await api.search(show({series:'DanMachi',
    title:'[DiabloTripleA] Is It Wrong To Try To Pick Up Girls In A Dungeon - S01E01'}));
  assert(result.success,JSON.stringify(result));assert.strictEqual(result.data.title,target.Title);
});

suite.test('an original search cannot erase an explicit US Office constraint',async()=>{
  const uk=series('tt0290978','The Office','2001');
  const {api}=loadSearch(q=>q.s?rows([uk]):q.t?uk:episode('Pilot',1,1,uk.imdbID));
  assert.strictEqual((await api.search(show({series:'The Office US',title:'Pilot'}))).success,false);
});

suite.test('circular transport errors are reported without breaking the diagnostics',async()=>{
  const error=new Error('Network unavailable');error.request=error;
  const {api,logs}=loadSearch(()=>error);
  const result=await api.search(show());assert.strictEqual(result.success,false);assert(!result.permanentFailure);
  assert(logs.some(row=>row.message==='Series discovery diagnostics' && row.data.queries[0].failure==='Error'));
});

suite.test('rejects the UK Office and spin-offs even if episode titles agree',async()=>{
  for (const [input,title,id,year] of [['The Office US','The Office','tt0290978','2001'],
    ['SATC','And Just Like That...','tt13819960','2021'],['News Radio','NewsRadio: Reunion','tt9999999','1995']]) {
    const parent=series(id,title,year);
    const {api}=loadSearch(q => q.s === input || q.t === input ? undefined :
      q.s ? rows([parent]) : q.t ? parent : episode('A Real Episode',1,1,id));
    assert.strictEqual((await api.search(show({series:input}))).success,false,input);
  }
});

suite.test('preserves episode-title and runtime rejection after discovering an alias',async()=>{
  for (const target of [episode('Totally Different Subject',1,1,'tt0412142'),
    episode('A Real Episode',1,1,'tt0412142',{Runtime:'2 min'})]) {
    const {api,downloads}=loadSearch(onlyQuery('House',series('tt0412142','House','2004'),[target]));
    const result=await api.search(show({series:'House MD'}));
    assert.strictEqual(result.failure,'Episode mismatch');assert.strictEqual(downloads.length,0);
  }
});

suite.test('reads later result pages without choosing a same-name remake prematurely',async()=>{
  const parent=series('tt0112095','NewsRadio','1995');
  const {api}=loadSearch(q=>{
    if(q.s==='News Radio') return q.page==='2' ? rows([parent]) : {
      Response:'True',totalResults:'11',Search:Array.from({length:10},(_,i)=>series(`tt9${i}`,'Unrelated News','2000'))};
    if(q.i===parent.imdbID) return q.Episode ? episode('A Real Episode',1,1,parent.imdbID) : parent;
  });
  assert((await api.search(show({series:'News Radio'}))).success);
});

suite.test('caps additional pages and refuses uniqueness when results are incomplete',async()=>{
  const parent=series('tt0112095','NewsRadio','1995');
  const {api,requests}=loadSearch(q=>q.s ? {Response:'True',totalResults:'1000',Search:q.page ? [parent] : [series('tt123','Wrong Title')]} : undefined);
  const result=await api.search(show({series:'News Radio'}));
  assert.strictEqual(result.failure,'Ambiguous series');
  assert(!requests.some(q=>Number(q.page)>3));
});

suite.test('MST3K abbreviation still permits the title-proven adjacent-season correction',async()=>{
  const classic=series('tt0094517','Mystery Science Theater 3000','1988–1999');
  const reboot=series('tt6782014','Mystery Science Theater 3000','2017–2022');
  const target=episode('The Crawling Eye',2,1,classic.imdbID,{imdbID:'tt0756960'});
  const {api}=loadSearch(q=>{
    if(q.s==='Mystery Science Theater 3000') return rows([classic,reboot]);
    if(q.i===classic.imdbID) return !q.Season ? classic : q.Episode==='1' && q.Season==='2' ? target : undefined;
    if(q.i===reboot.imdbID) return q.Episode ? episode('Reptilicus',q.Season,q.Episode,reboot.imdbID) : reboot;
  });
  const result=await api.search(show({series:'MST3K',title:'The Crawling Eye (1958)'}));
  assert(result.success,JSON.stringify(result));
  assert.strictEqual(result.data.imdbID,'tt0756960');assert.strictEqual(result.data.season,'1');
});

suite.test('shares definitive failed series queries only within the supplied batch',async()=>{
  const {api,requests,logs}=loadSearch(()=>undefined);
  const session=api.createSeriesSearchSession();
  await api.search(show({series:'Unknown Show'}),{seriesSearchSession:session});
  const first=requests.length;
  await api.search(show({series:'Unknown Show',episode:'2'}),{seriesSearchSession:session});
  assert.strictEqual(requests.length,first);
  assert.strictEqual(logs.filter(l=>l.message==='Series discovery diagnostics').length,1);
  await api.search(show({series:'Unknown Show'}),{seriesSearchSession:api.createSeriesSearchSession()});
  assert.strictEqual(requests.length,first*2);
});

suite.test('network and quota errors remain retryable and are never memoized',async()=>{
  for (const error of [new Error('timeout'),{Response:'False',Error:'Request limit reached!'}]) {
    let fail=true;
    const lookup=catalog([episode('A Real Episode')]);
    const {api}=loadSearch(q=>fail?error:lookup(q));
    const session=api.createSeriesSearchSession();
    const first=await api.search(show(),{seriesSearchSession:session});
    assert.strictEqual(first.success,false);assert(!first.permanentFailure);
    fail=false;assert((await api.search(show(),{seriesSearchSession:session})).success);
  }
});

suite.test('a wrong representative cannot poison subsequent episode decisions',async()=>{
  const parent=series('tt0412142','House','2004');
  const {api}=loadSearch(onlyQuery('House',parent,[episode('Wrong Content',1,1,parent.imdbID),episode('A Real Episode',1,2,parent.imdbID)]));
  const session=api.createSeriesSearchSession();
  assert.strictEqual((await api.search(show({series:'House MD',title:'Loglady'}),{seriesSearchSession:session})).success,false);
  assert((await api.search(show({series:'House MD',episode:'2'}),{seriesSearchSession:session})).success);
  assert.strictEqual(api.seriesSearchSummary(session).recoveredSeries.length,1);
});

runSuite(suite);
