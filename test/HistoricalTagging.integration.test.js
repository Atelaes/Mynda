const path = require('path');
const {assert, createSuite, runSuite} = require('./helpers/TestHarness.js');
const {show, series, episode, loadSearch, catalog} = require('./helpers/OmdbFixtures.js');
const replay = require('./fixtures/HistoricalTaggingReplay.json');
const corrections = require('./fixtures/HistoricalEpisodeCorrections.json');
const suite = createSuite('Individual historical tagging regressions', 'integration',
  'Replays recorded Torgo-library searches and individual corrections with catalog IDs checked against the reference library; no network.');
const queryKey = query => JSON.stringify(Object.keys(query).sort().map(key=>[key,String(query[key])]));
const supplements = require('./fixtures/HistoricalTaggingSupplements.json');
const precisionChanges = require('./fixtures/Fix80PolicyChanges.json').history;

for (const [index, item] of replay.cases.entries()) suite.test(`[R${String(index+1).padStart(4,'0')}] ${item.label}`, async()=>{
  const responses = new Map(item.responses.map(row=>[queryKey(row.query),row.data]));
  // Original recorded queries and expected IDs stay intact. These explicitly
  // documented fixtures cover fix79's new year-filtered Prisoner query using
  // only series rows already present in the historical response.
  for (const extra of supplements.cases.filter(row=>row.caseNumber===index+1)) {
    assert.strictEqual(extra.label,item.label);
    const key = queryKey(extra.query);
    assert(!responses.has(key),'A supplement must not replace a recorded response');
    responses.set(key,extra.data);
  }
  const misses=[];
  const {api}=loadSearch(q=>{
    const response=responses.get(queryKey(q));
    if (!response) misses.push(q);
    return response;
  },{modulePath:process.env.MYNDA_HISTORY_MODULE});
  const video=show({...item.video,filename:path.join(path.parse(__dirname).root,'fixture-media',...item.video.filenameParts)});
  delete video.filenameParts;
  const result=await api.search(video,item.options);
  const change=precisionChanges.find(row=>row.caseNumber===index+1);
  if (change) assert.strictEqual(change.label,item.label,'Policy review must refer to this exact historical case');
  if (change && !change.resolvedBy) {
    assert.strictEqual(result.success,false,change.explanation);
    assert.strictEqual(result.failure,change.expectedFailure);
    if(change.policyReason) assert.strictEqual(result.policyReason,change.policyReason);
    if(change.expectedFailure==='Ambiguous series') assert(result.choices.length>1);
    assert.strictEqual(result.permanentFailure,true);
    return;
  }
  if (item.expectedFailure) {
    assert.strictEqual(result.success,false);
    assert.strictEqual(result.failure,item.expectedFailure);
    return;
  }
  assert(result.success, `${JSON.stringify(result)}; unrecorded queries: ${JSON.stringify(misses)}`);
  assert.strictEqual(result.data.imdbID,item.expectedImdbID);
  if (change && change.resolvedBy) {
    assert.strictEqual(result.evidence.titleComparison.basis,change.resolvedBy);
    assert.strictEqual(result.evidence.titleComparison.originalTitle,item.video.title);
  }
  assert.strictEqual(result.data.kind,item.video.kind);
  if(item.video.kind==='show') {
    assert.strictEqual(result.data.series,item.video.series);
    assert.strictEqual(result.data.season,item.video.season);
    assert.strictEqual(result.data.episode,item.video.episode);
  }
});

for (const [index, item] of corrections.entries()) suite.test(
  `[C${String(index+1).padStart(3,'0')}] ${item.series} / ${item.localTitle} (S${item.requested.season}E${item.requested.episode} → S${item.matched.season}E${item.matched.episode})`,async()=>{
  const parent=series(item.seriesID,item.series);
  const target=episode(item.matched.title,item.matched.season,item.matched.episode,item.seriesID,
    {imdbID:item.matched.imdbID});
  const {api}=loadSearch(catalog([target],parent),{modulePath:process.env.MYNDA_HISTORY_MODULE});
  const result=await api.search(show({series:item.series,seriesImdbID:item.seriesID,title:item.localTitle,
    season:item.requested.season,episode:item.requested.episode}));
  assert(result.success,JSON.stringify(result));
  assert.strictEqual(result.data.imdbID,item.matched.imdbID);
  assert.strictEqual(result.data.season,item.requested.season);
  assert.strictEqual(result.data.episode,item.requested.episode);
});

runSuite(suite);
