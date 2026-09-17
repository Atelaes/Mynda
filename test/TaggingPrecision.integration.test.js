const {assert,createSuite,runSuite} = require('./helpers/TestHarness');
const {show,series,episode,loadSearch,catalog,notFound} = require('./helpers/OmdbFixtures');
const {runAutoTag} = require('./helpers/AutoTagFixture');
const suite = createSuite('Tagging precision and evidence provenance','integration',
  'Exercises real resolution, delayed acceptance and saves against independent titles, conflicting order, ambiguity and cancellation.');
const parent = series();
const input = (season,number,title,extra={}) => show({id:`s${season}e${number}`,
  title:title || `S${season}E${number}`,season:String(season),episode:String(number),
  filename:`/Shows/Test Series/s${season}e${number}.mkv`,...extra});
const rows = items => ({Response:'True',Search:items});

suite.test('retains Q2 and 11:59 as identity evidence and corrects the nearby number',async () => {
  for (const [local,title] of [['Q2','Q2'],['11 59','11:59']]) {
    const target = episode(title,5,22);
    const fixture = loadSearch(catalog([episode('Unrelated Story',5,23),target]));
    const original = input(5,23,local), before = JSON.stringify(original);
    const result = await fixture.api.search(original);
    assert(result.success,JSON.stringify(result));
    assert.strictEqual(result.data.imdbID,target.imdbID);
    assert.strictEqual(result.data.episode,'23');
    assert.strictEqual(result.evidence.matched.episode,'22');
    assert.strictEqual(JSON.stringify(original),before);
  }
});

suite.test('a short meaningful title without a verified correction remains unmatched',async () => {
  const fixture = loadSearch(catalog([episode('Author Author')]));
  const result = await fixture.api.search(input(1,1,'Q2'));
  assert.strictEqual(result.success,false);
  assert.strictEqual(result.failure,'Episode mismatch');
  assert.strictEqual(fixture.downloads.length,0);
});

suite.test('a missing catalog episode cannot decide between same-name series',async () => {
  const other = series('tt9000001','Test Series','2020');
  const fixture = loadSearch(query => query.s ? rows([parent,other]) :
    query.i === parent.imdbID && query.Episode ? episode('Catalog Story') : notFound);
  const result = await fixture.api.search(input(1,1));
  assert.strictEqual(result.failure,'Ambiguous series');
  assert.strictEqual(result.choices.length,2);
});

suite.test('caching an unconfirmed parent does not turn generic catalog titles into proof',async () => {
  const fixture = loadSearch(catalog([episode('Named in Catalog',1,1),episode('Episode #1.2',1,2)]));
  assert((await fixture.api.search(input(1,1))).success);
  const second = await fixture.api.search(input(1,2));
  assert.strictEqual(second.failure,'Episode mismatch');
  assert(/unconfirmed series/.test(second.data));
});

suite.test('parent caches do not cross independent physical series folders',async () => {
  const other = series('tt9000001','Test Series','2020');
  const originals = [episode('Original Story',1,1),episode('New Story',1,1,other.imdbID,{imdbID:'tt9000002'})];
  const fixture = loadSearch(query => query.s ? rows([parent,other]) :
    originals.find(record => record.seriesID === query.i && query.Episode === record.Episode));
  for (const [folder,title,id] of [['Original','Original Story',originals[0].imdbID],['Remake','New Story',originals[1].imdbID]]) {
    const result = await fixture.api.search(input(1,1,title,{filename:`/Shows/${folder}/one.mkv`}));
    assert(result.success,JSON.stringify(result));
    assert.strictEqual(result.data.imdbID,id);
  }
});

suite.test('a parent identified in another season permits explicit numbering without inventing local order witnesses',async () => {
  const other = series('tt9000001','Test Series','2020');
  const records = [episode('Pilot',1,1),episode('Arrival',2,1),episode('Return',2,2)];
  const lookup = catalog(records);
  const responder = query => query.s ? rows([parent,other]) : lookup(query);
  const videos = [input(1,1),input(2,1,'Arrival'),input(2,2,'Return')];
  for (const order of [videos,[...videos].reverse()]) {
    const run = await runAutoTag(order,responder);
    assert.strictEqual(run.result.statistics.Success,3);
    assert.strictEqual(run.saved.get('s1e1').imdbID,records[0].imdbID);
    assert.deepStrictEqual(run.saved.get('s1e1').taggingEvidence.orderAssessment.support,[]);
  }
});

suite.test('shifted named anchors veto number-only proposals even when processed later',async () => {
  const records = [episode('Opening',1,1),episode('Ink',1,2),episode('Acceptance',1,3),
    episode('Return',1,4),episode('Journey',1,5)];
  const videos = [input(1,4),input(1,3,'Ink'),input(1,5,'Return')];
  for (const order of [videos,[...videos].reverse()]) {
    const run = await runAutoTag(order,catalog(records));
    assert.strictEqual(run.result.statistics.Success,2);
    assert(!run.saved.get('s1e4').imdbID);
    assert.strictEqual(run.saved.get('s1e3').imdbID,records[1].imdbID);
    assert.strictEqual(run.saved.get('s1e5').imdbID,records[3].imdbID);
    assert(run.logs.some(item => item.data && /different catalog numbering/.test(item.data.reason)));
  }
});

suite.test('two independently named same-season files support one bounded ambiguity retry',async () => {
  const other = series('tt9000001','Test Series','2020');
  const records = [episode('Opening',1,1),episode('Arrival',1,2),episode('Return',1,3)];
  const lookup = catalog(records);
  const run = await runAutoTag([input(1,1),input(1,2,'Arrival'),input(1,3,'Return')],
    query => query.s ? rows([parent,other]) : lookup(query));
  assert.strictEqual(run.result.statistics.Success,3);
  assert.strictEqual(run.result.statistics.seriesRetries,1);
  assert.strictEqual(run.result.statistics.recoveredSeriesRetries,1);
  assert.strictEqual(run.result.statistics['Ambiguous series'],0);
  const recovered = run.saved.get('s1e1');
  assert.strictEqual(recovered.imdbID,records[0].imdbID);
  assert.strictEqual(recovered.taggingEvidence.orderAssessment.basis,'consistent-named-siblings');
  assert.strictEqual(recovered.taggingEvidence.version,83);
});

suite.test('one named neighbor cannot make unique-parent cache order change the result',async () => {
  for (const catalogTitle of ['Opening','Episode #1.1']) {
    const records = [episode(catalogTitle,1,1),episode('Arrival',1,2)];
    const videos = [input(1,1),input(1,2,'Arrival')];
    for (const order of [videos,[...videos].reverse()]) {
      const run = await runAutoTag(order,catalog(records));
      assert.strictEqual(run.result.statistics.Success,2);
      assert.strictEqual(run.saved.get('s1e1').imdbID,records[0].imdbID);
    }
  }
});

suite.test('a generic catalog title is usable once the parent is disambiguated, even with one named witness',async () => {
  const other = series('tt9000001','Test Series','2020');
  const records = [episode('Episode #1.1',1,1),episode('Arrival',1,2),episode('Return',1,3)];
  const lookup = catalog(records);
  const videos = [input(1,1),input(1,2,'Arrival'),input(1,3,'Return')];
  for (const count of [2,3]) {
    const selected = videos.slice(0,count);
    for (const order of [selected,[...selected].reverse()]) {
      const run = await runAutoTag(order,query => query.s ? rows([parent,other]) : lookup(query));
      assert.strictEqual(run.result.statistics.Success,count);
      assert.strictEqual(run.saved.get('s1e1').imdbID,records[0].imdbID);
    }
  }
});

suite.test('cancellation leaves deferred unreviewed candidates retryable and saves completed named files',async () => {
  const records = [episode('Opening',1,1),episode('Arrival',1,2),episode('Return',1,3)];
  const run = await runAutoTag([input(1,1),input(1,2,'Arrival'),input(1,3,'Return')],catalog(records),{
    afterRequest:(query,state) => {if (query.Episode === '2') state.cancelRequested = true;}
  });
  assert.strictEqual(run.result.canceled,true);
  assert.strictEqual(run.saved.has('s1e1'),false);
  assert.strictEqual(run.saved.get('s1e2').imdbID,records[1].imdbID);
  assert.strictEqual(run.saved.has('s1e3'),false);
  assert.strictEqual(run.result.statistics.Success,1);
  assert.strictEqual(run.result.statistics.processedVideos,1);
  assert.strictEqual(run.result.statistics.remainingVideos,2);
  assert.strictEqual(run.state.running,false);
});

suite.test('combined-duration files cannot silently become a single catalog part',async () => {
  const record = episode('Finale: Part 1',1,1,parent.imdbID,{Runtime:'24 min'});
  const fixture = loadSearch(catalog([record]));
  const result = await fixture.api.search(input(1,1,'Finale',{metadata:{duration:48*60}}));
  assert.strictEqual(result.failure,'Episode mismatch');
  assert(/coverage/.test(result.data));
  assert.strictEqual(fixture.downloads.length,0);
});

suite.test('explicit shorter file parts and unavailable runtime retain their prior behavior',async () => {
  for (const [title,duration] of [['Pilot Part 1',24*60],['Pilot',undefined]]) {
    const fixture = loadSearch(catalog([episode('Pilot',1,1,parent.imdbID,{Runtime:'48 min'})]));
    const result = await fixture.api.search(input(1,1,title,{metadata:{duration}}));
    assert(result.success,JSON.stringify(result));
  }
});

suite.test('movie title containment plus close year and runtime cannot prove an alternate title',async () => {
  const wrong = {Response:'True',Type:'movie',Title:'The Long Road Home',Year:'1999',imdbID:'tt0160481',
    Runtime:'90 min',imdbVotes:'100000',Poster:'N/A',Genre:'Drama',Ratings:[]};
  const fixture = loadSearch(query => query.s ? rows([wrong]) : wrong);
  const result = await fixture.api.search(show({kind:'movie',title:'The Road Home',year:'1999',
    filename:'/Movies/The Road Home (1999)/The Road Home.avi',metadata:{duration:89.51*60}}));
  assert(!result.success || Array.isArray(result.data),JSON.stringify(result));
  assert.strictEqual(fixture.downloads.length,0);
  assert(fixture.logs.some(item => item.data && item.data.reasons &&
    item.data.reasons.some(reason => /expanded movie title/.test(reason))));
});

suite.test('a verified exact movie remains automatic while a wrong explicit-ID response is rejected',async () => {
  const right = {Response:'True',Type:'movie',Title:'The Road Home',Year:'1999',imdbID:'tt0235060',
    Runtime:'90 min',Poster:'N/A',Genre:'Drama',Ratings:[]};
  const fixture = loadSearch(query => query.s ? rows([right]) : right);
  const original = show({kind:'movie',title:'The Road Home',year:'1999',metadata:{duration:90*60}});
  assert.strictEqual((await fixture.api.search(original)).data.imdbID,right.imdbID);
  const mismatched = await fixture.api.search({...original,imdbID:'tt0999999'});
  assert.strictEqual(mismatched.success,false);
  assert(/different IMDb identity/.test(mismatched.data));
});

runSuite(suite);
