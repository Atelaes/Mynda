const {assert,createSuite,runSuite} = require('./helpers/TestHarness');
const {show,series,episode,loadSearch,catalog,notFound} = require('./helpers/OmdbFixtures');
const {runAutoTag} = require('./helpers/AutoTagFixture');
const {scopeFor} = require('../src/tagging/SeriesCollection');
const {createEvidence} = require('../src/tagging/BatchEvidence');
const Match = require('../src/tagging/EpisodeMatch');
const suite = createSuite('Series collection identity and local episode order','integration',
  'Runs the real resolver, acceptance policy and batch saves across seasons, remakes, conflicts and shuffled inputs.');
const NAME = 'Silver Observatory', PARENT = 'tt1000001', OTHER = 'tt9000001';
const original = series(PARENT,NAME,'1994'), remake = series(OTHER,NAME,'2020');
const input = (season,number,title,extra={}) => show({id:`s${season}e${number}`,series:NAME,
  filename:`/Shows/${NAME} - Complete Series (S01-06)/${NAME} Season ${season}/${number}.mkv`,
  season:String(season),episode:String(number),title:title || `S${season}E${number}`,...extra});
const rows = items => ({Response:'True',Search:items});
const ambiguity = {status:'ambiguous',failure:'Ambiguous series',reason:{code:'ambiguous-series'},choices:[original,remake]};
const accepted = (video,parent=PARENT,parentEvidence={}) => ({status:'matched',
  evidence:{kind:'episode',parentEvidence,original:{...video}},
  video:{...video,seriesImdbID:parent,imdbID:`tt3${video.season}00${video.episode}`}});
const permutations = items => items.length ? items.flatMap((item,index) =>
  permutations(items.filter((_,i)=>i!==index)).map(rest=>[item,...rest])) : [[]];
function responder(records, otherRecords=[]) {
  const one = catalog(records,original), two = catalog(otherRecords,remake);
  return query => query.s ? rows([original,remake]) : one(query) || two(query) || notFound;
}
const alternate = record => ({...record,seriesID:OTHER,imdbID:record.imdbID.replace('tt2','tt9')});
function assertUniqueRequests(run) {
  const keys=run.requests.map(query=>JSON.stringify(Object.entries(query).sort()));
  assert.strictEqual(new Set(keys).size,keys.length,'Probes and retries must reuse cached catalog responses');
}

suite.test('physical season layouts share only their parent identity scope',()=>{
  const target=input(1,1), root='/Shows/Silver Observatory';
  for (const folder of ['Season 1','Season.02','S03','Silver Observatory Season 4','Season 5 1080p BluRay']) {
    const scope=scopeFor({...target,filename:`${root}/${folder}/episode.mkv`});
    assert.strictEqual(scope.root,root,folder);
    assert.strictEqual(scope.directory,`${root}/${folder}`);
  }
  assert.strictEqual(scopeFor(input(4,3)).root,`/Shows/${NAME} - Complete Series (S01-06)`);
  assert.strictEqual(scopeFor({...target,filename:'C:\\Shows\\Silver Observatory\\S02\\episode.mkv'}).root,
    'C:/Shows/Silver Observatory');
  for (const folder of ['Season 2 remake','Season 2 US','Specials','Another show Season 2','Original']) {
    const scope=scopeFor({...target,filename:`${root}/${folder}/episode.mkv`});
    assert.strictEqual(scope.root,`${root}/${folder}`,folder);
  }
  assert.strictEqual(scopeFor({...target,filename:'/Shows/Collection/Season 1/episode.mkv'}).root,
    '/Shows/Collection/Season 1');
  assert.strictEqual(scopeFor({...target,filename:'episode.mkv'}),null);
  assert.strictEqual(scopeFor({...target,filename:'/Shows/../Season 1/episode.mkv'}),null);
  assert.strictEqual(scopeFor({...target,kind:'movie'}),null);
  assert.strictEqual(scopeFor({...target,dvd:true}),null);
});

suite.test('one independent named episode resolves other seasons and permits their explicit numbering in any order',async()=>{
  const records=[episode('Arrival',3,1),episode('Handicaps',4,3),episode('Opening',1,1)];
  const videos=[input(3,1,'Arrival'),input(4,3,`${NAME} Handicaps`),input(1,1)];
  for (const order of permutations(videos)) {
    const run=await runAutoTag(order,responder(records,[alternate(records[1])]));
    assert.strictEqual(run.result.statistics.Success,3);
    const named=run.saved.get('s4e3'), numbered=run.saved.get('s1e1');
    assert.strictEqual(named.imdbID,records[1].imdbID);
    assert.strictEqual(named.taggingEvidence.titleComparison.basis,'repeated-series-prefix');
    assert.strictEqual(named.taggingEvidence.original.title,`${NAME} Handicaps`);
    assert.strictEqual(named.taggingEvidence.parentEvidence.basis,'siblings-series-selection');
    assert.strictEqual(named.taggingEvidence.parentEvidence.support.length,1);
    assert.strictEqual(named.taggingEvidence.parentEvidence.support[0].videoID,'s3e1');
    assert.strictEqual(numbered.seriesImdbID,PARENT);
    assert.strictEqual(numbered.imdbID,records[2].imdbID);
    assert.strictEqual(numbered.taggingEvidence.orderAssessment.basis,'confident-series-numbering');
    assert.deepStrictEqual(numbered.taggingEvidence.orderAssessment.support,[]);
    assert.strictEqual(run.result.statistics.seriesRetries,2);
    assert.strictEqual(run.result.statistics.recoveredSeriesRetries,2);
    assertUniqueRequests(run);
  }
});

suite.test('recovered names verify their own season order before numbered-only acceptance in every permutation',async()=>{
  const records=[episode('Arrival',3,1),episode('Opening',2,1),episode('Q2',2,2),episode('11:59',2,3)];
  const videos=[input(3,1,'Arrival'),input(2,1),input(2,2,`${NAME} Q2`),input(2,3,'11:59')];
  for (const order of permutations(videos)) {
    const run=await runAutoTag(order,responder(records,records.slice(2).map(alternate)));
    assert.strictEqual(run.result.statistics.Success,4);
    const evidence=run.saved.get('s2e1').taggingEvidence;
    assert.strictEqual(evidence.orderAssessment.basis,'consistent-named-siblings');
    assert.strictEqual(evidence.orderAssessment.support.length,2);
    assert(evidence.orderAssessment.support.every(anchor=>anchor.localSeason==='2'));
    assert.deepStrictEqual(evidence.parentEvidence.support.map(anchor=>anchor.videoID),['s3e1']);
    assertUniqueRequests(run);
  }
});

suite.test('cross-season identity plus two local exact witnesses permits a consistent shift in any order',async()=>{
  const records=[episode('Arrival',3,1),episode('Opening',2,1),episode('Other',2,2),episode('Return',2,3),episode('Journey',2,4)];
  const videos=[input(3,1,'Arrival'),input(2,1),input(2,2,'Return'),input(2,3,'Journey')];
  for (const order of permutations(videos)) {
    const run=await runAutoTag(order,responder(records,records.slice(1).map(alternate)));
    assert.strictEqual(run.result.statistics.Success,4);
    const numbered=run.saved.get('s2e1');
    assert.strictEqual(numbered.imdbID,records[2].imdbID);
    assert.strictEqual(numbered.taggingEvidence.orderAssessment.basis,'sibling-numbering');
    assert.strictEqual(run.saved.get('s2e2').imdbID,records[3].imdbID);
    assert.strictEqual(run.saved.get('s2e3').imdbID,records[4].imdbID);
  }
});

suite.test('order anchors never cross two releases of the same season',async()=>{
  const records=[episode('Opening',1,1),episode('Arrival',1,2),episode('Return',1,3)];
  const videos=[input(1,1,undefined,{filename:`/Shows/${NAME}/S01/1.mkv`}),
    input(1,2,'Arrival',{filename:`/Shows/${NAME}/Season 1/2.mkv`}),
    input(1,3,'Return',{filename:`/Shows/${NAME}/Season 1/3.mkv`})];
  const run=await runAutoTag(videos,responder(records));
  const target=run.saved.get('s1e1');
  assert.strictEqual(target.seriesImdbID,PARENT);
  assert.strictEqual(target.imdbID,records[0].imdbID);
  assert.deepStrictEqual(target.taggingEvidence.orderAssessment.support,[]);
});

suite.test('same-name shows in separate physical roots do not borrow identity',async()=>{
  const records=[episode('Arrival',3,1),episode('Opening',1,1)];
  for (const filename of [`/Elsewhere/${NAME}/Season 1/1.mkv`,`/Shows/${NAME} (2020)/Season 1/1.mkv`,
    `/Shows/${NAME} - Complete Series (S01-06)/Remake/Season 1/1.mkv`]) {
    const videos=[input(3,1,'Arrival'),input(1,1,undefined,{filename})];
    const run=await runAutoTag(videos,responder(records));
    assert(!run.saved.get('s1e1').imdbID);
    assert(!run.saved.get('s1e1').seriesImdbID);
    assert.strictEqual(run.result.statistics.seriesRetries,undefined);
  }
});

suite.test('conflicting independently named parents block sharing across seasons in every order',async()=>{
  const records=[episode('Arrival',3,1),episode('Opening',1,1)];
  const otherRecords=[alternate(episode('Departure',4,1))];
  const videos=[input(3,1,'Arrival'),input(4,1,'Departure'),input(1,1)];
  for (const order of permutations(videos)) {
    const run=await runAutoTag(order,responder(records,otherRecords));
    assert.strictEqual(run.result.statistics.Success,2);
    assert.strictEqual(run.saved.get('s1e1').taggingDecision.reason.code,'ambiguous-series');
    assert(!run.saved.get('s1e1').seriesImdbID);
    assert.strictEqual(run.result.statistics.seriesRetries,undefined);
  }
});

suite.test('explicit parent and year conflicts are checked even when those files never match',()=>{
  const named=input(3,1,'Arrival'), target=input(1,1);
  for (const extra of [{seriesImdbID:OTHER},{series:`${NAME} (2020)`}]) {
    const conflicting=input(5,1,'Unknown',extra);
    const ledger=createEvidence([target,named,conflicting]);
    ledger.observe(named,accepted(named,PARENT,{catalogYear:'1994'}));
    assert.strictEqual(ledger.parentFor(target,ambiguity),null);
  }
  const conflictInOnePath=input(3,1,'Arrival',{series:`${NAME} (2020)`,
    filename:`/Shows/${NAME} (1994)/Season 3/1.mkv`});
  const ledger=createEvidence([conflictInOnePath]);
  ledger.observe(conflictInOnePath,accepted(conflictInOnePath));
  assert.strictEqual(ledger.parentFor({...conflictInOnePath,title:'S3E2'},ambiguity),null);
});

suite.test('episode air years are not series identity constraints',()=>{
  const named=input(3,1,'Arrival',{year:'1998'}), target=input(1,1,undefined,{year:'1995'});
  const ledger=createEvidence([named,target]);
  ledger.observe(named,accepted(named,PARENT,{catalogYear:'1994'}));
  assert.strictEqual(ledger.parentFor(target,ambiguity).seriesID,PARENT);
});

suite.test('inherited parent evidence can supply local order but cannot bootstrap independent identity',()=>{
  const named=input(1,2,'Arrival'), target=input(1,1);
  for (const basis of ['siblings-series-selection','batch-series-selection']) {
    const ledger=createEvidence([named,target]);
    ledger.observe(named,accepted(named,PARENT,{basis}));
    assert.strictEqual(ledger.parentFor(target,ambiguity),null);
    assert.strictEqual(ledger.anchorsFor(target,{candidate:{evidence:{kind:'episode',requested:{season:'1'}}}}).length,1);
  }
});

suite.test('missing episode records retain the resolved parent and final catalog failure',async()=>{
  const run=await runAutoTag([input(1,1),input(3,1,'Arrival')],responder([episode('Arrival',3,1)]));
  const saved=run.saved.get('s1e1');
  assert.strictEqual(saved.seriesImdbID,PARENT);
  assert(!saved.imdbID);
  assert.strictEqual(saved.taggingDecision.reason.code,'no-results');
  assert.strictEqual(saved.taggingDecision.evidence.parentEvidence.basis,'siblings-series-selection');
  assert.strictEqual(run.result.statistics.Success,1);
  assert.strictEqual(run.result.statistics['Ambiguous series'],0);
  assert.strictEqual(run.result.statistics['No results'],1);
  assertUniqueRequests(run);
});

suite.test('repeated series prefixes are optional exact interpretations with whole-title priority',()=>{
  for (const [local,remote,name] of [
    ['Party of Five Handicaps','Handicaps','Party of Five'],
    ['Party of Five Moving on','Moving On','Party of Five'],
    ['Party of Five Wrestling Demons','Wrestling Demons','Party of Five'],
    ['Silver.Observatory - Return (2)','Return Part II',NAME],
    ['Silver Observatory Q2','Q2',NAME],['Silver Observatory 11:59','11:59',NAME],
    ['Silver Observatory (1) Beginning','(1) Beginning',NAME],
    ['District 12 Arrival','Arrival','District 12'],["Dr. Finch's Files Return",'Return',"Dr. Finch's Files"],
    ['Silver Observatory Arrival','Arrival',`${NAME} (1994)`]
  ]) {
    const evidence=Match.episodeTitleComparison(local,remote,name);
    assert.strictEqual(evidence.matched,true,local);
    assert.strictEqual(evidence.basis,'repeated-series-prefix',local);
    assert.strictEqual(evidence.originalTitle,local);
    assert.strictEqual(Match.assessEpisodeTitle(local,remote,name).state,'compatible',local);
  }
  assert.strictEqual(Match.episodeTitleComparison('Dark Matter','Dark Matter','Dark').basis,'exact-normalized-title');
  for (const [local,remote,name] of [
    ['Silver Observatory Return Part 1','Return Part 2',NAME],
    ['Silver Observatory Return fan edit','Return',NAME],
    ['Silver Observatory US Return','Return',NAME],
    ['Silver ObservatoryOther Return','Return',NAME],
    ['Observatory Return','Return',NAME],['District 13 Arrival','Arrival','District 12'],
    ['Wrong Series Handicaps','Handicaps','Party of Five'],['Silver Observatory Episode 2','Episode 3',NAME]
  ]) assert.strictEqual(Match.episodeTitlesMatch(local,remote,name),false,local);
});

suite.test('the real resolver corrects prefixed titles and saves the original numbering and comparison',async()=>{
  const video=input(2,3,`${NAME} Return`), record=episode('Return',2,2);
  const fixture=loadSearch(catalog([record],original));
  const result=await fixture.api.tag(video);
  assert.strictEqual(result.status,'matched');
  assert.strictEqual(result.video.imdbID,record.imdbID);
  assert.deepStrictEqual(result.evidence.requested,{season:'2',episode:'3'});
  assert.deepStrictEqual(result.evidence.matched,{season:'2',episode:'2'});
  assert.strictEqual(result.evidence.titleComparison.basis,'repeated-series-prefix');
  assert.strictEqual(result.evidence.original.title,video.title);
  assert.strictEqual(video.episode,'3');
});

suite.test('autotag never reparses a filename to erase the current edited title',async()=>{
  const record=episode('Return',2,2);
  const video=input(2,2,'A Deliberate Different Title',{
    filename:`/Shows/${NAME}/Season 2/2x02 ${NAME} Return.mkv`});
  const fixture=loadSearch(catalog([record],original));
  const result=await fixture.api.tag(video);
  assert.strictEqual(result.status,'unmatched');
  assert.strictEqual(result.evidence.original.title,'A Deliberate Different Title');
});

suite.test('a series prefix does not neutralize bonus labels or contradictory part numbers',async()=>{
  for (const [local,remote] of [['Return Part 1','Return Part 2'],['Pilot Loglady','Pilot'],['Return - Surviving Clips','Return']]) {
    const fixture=loadSearch(catalog([episode(remote,1,1)],original));
    const result=await fixture.api.tag(input(1,1,`${NAME} ${local}`));
    assert.strictEqual(result.status,'unmatched',local);
  }
});
suite.test('replays all 140 Party of Five files, recovering 42 recorded rejections while retaining 50 catalog holes',async()=>{
  const replay=require('./fixtures/PartyOfFiveFix81Replay.json');
  const parent=series('tt0108894','Party of Five','1994'), other=series('tt7431790','Party of Five','2020');
  const records=replay.records.map(row=>episode(row.Title,row.Season,row.Episode,parent.imdbID,
    {imdbID:row.imdbID,Runtime:row.Runtime}));
  const lookup=catalog(records,parent), respond=q=>q.s?rows([parent,other]):lookup(q);
  for (const order of [replay.videos,[...replay.videos].reverse()]) {
    const run=await runAutoTag(order,respond);
    assert.strictEqual(run.result.statistics.Success,90);
    assert.strictEqual(run.result.statistics['No results'],50);
    for (const video of replay.videos) {
      const saved=run.saved.get(video.id);
      assert.strictEqual(saved.imdbID || null,replay.expected[video.id],video.filename);
      assert.strictEqual(saved.seriesImdbID,parent.imdbID);
    }
    for (const key of ['s6e8','s6e16']) {
      const e=run.saved.get(key).taggingEvidence;
      assert.strictEqual(e.exactTitle,false);
      assert.strictEqual(e.titleAssessment.state,'compatible');
      assert.strictEqual(e.titleAssessment.normalization,'repeated-series-prefix');
      assert.deepStrictEqual(e.requested,e.matched);
    }
  }
});
runSuite(suite);
