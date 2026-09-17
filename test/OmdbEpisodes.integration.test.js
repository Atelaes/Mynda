const {assert, createSuite, runSuite} = require('./helpers/TestHarness.js');
const corpus = require('./fixtures/EpisodeTitleCorpus.json');
const corrections = require('./fixtures/EpisodeCorrections.json');
const precisionChanges = require('./fixtures/Fix80PolicyChanges.json');

const suite = createSuite('OMDb episode selection and tagging safeguards', 'integration',
  'Runs real search, caching, correction and tagging code against controlled OMDb responses; no network or real library access.');
const {SERIES, notFound, show, series, episode, loadSearch, catalog} = require('./helpers/OmdbFixtures.js');

suite.test('uses edited title tags and preserves display series names', async () => {
  const original = show({title:'My Edited Title', series:'Test Series (2000)',
    filename:'/Shows/Wrong Series (1954)/S01E01 - Wrong Filename Title.mkv'});
  const before = JSON.stringify(original);
  const {api, requests} = loadSearch(catalog([episode('My Edited Title')]));
  const result = await api.search(original);
  assert(result.success, JSON.stringify(result));
  assert.strictEqual(result.data.series, 'Test Series (2000)');
  assert.strictEqual(result.data.title, 'My Edited Title');
  assert.strictEqual(requests[0].s, 'Test Series');
  assert.strictEqual(requests[0].y, '2000');
  assert.strictEqual(JSON.stringify(original), before);
});

suite.test('uses a matching folder only to supply a missing series premiere year', async () => {
  const parent = series(SERIES, 'Kung Fu', '1972–1975');
  const original = show({title:'The Soul Is The Warrior', series:'Kung Fu', season:'1', episode:'6',
    filename:'H:\\Shows\\Kung Fu 1972-1975 (complete original TV series)\\KungFu S1E06 -Wrong Title.mp4'});
  const {api, requests} = loadSearch(catalog([episode('The Soul Is the Warrior','1','6')], parent));
  const result = await api.search(original);
  assert(result.success, JSON.stringify(result));
  assert.strictEqual(requests[0].y, '1972');
  assert.strictEqual(result.data.series, 'Kung Fu');
});

suite.test('an explicit series year wins over a conflicting folder year', async () => {
  const {api, requests} = loadSearch(catalog([episode('A Real Episode')], series(SERIES,'Kung Fu','2021–2023')));
  const result = await api.search(show({series:'Kung Fu (2021)', filename:'/Shows/Kung Fu 1972-1975/file.mkv'}));
  assert(result.success, JSON.stringify(result));
  assert.strictEqual(requests[0].y, '2021');
});

suite.test('does not borrow a year from a differently named series folder', async () => {
  const {api, requests} = loadSearch(catalog([episode('A Real Episode')]));
  assert((await api.search(show({filename:'/Shows/Another Series (1954)/file.mkv'}))).success);
  assert.strictEqual(requests[0].y, undefined);
});

suite.test('accepts a useful tag even when it equals the basename or has no filename', async () => {
  for (const filename of ['A Real Episode.mkv', undefined]) {
    const {api} = loadSearch(catalog([episode('A Real Episode')]));
    assert((await api.search(show({filename}))).success);
  }
});

suite.test('rejects every suspect Atelaes title pair before artwork or mutation', async () => {
  for (const pair of corpus.pairs.filter(p => p.source === 'Atelaes' && p.expected === 'reject')) {
    const data = episode(pair.omdbTitle, pair.season, pair.episode, SERIES, {Poster:'https://example.invalid/poster.jpg'});
    const {api, requests, downloads} = loadSearch(catalog([data],series(SERIES,pair.series)));
    const original = show({title:pair.localTitle, series:pair.series, season:pair.season, episode:pair.episode});
    const result = await api.search(original);
    assert.strictEqual(result.success, false, `${pair.localTitle} -> ${pair.omdbTitle}`);
    assert.strictEqual(result.failure, 'Episode mismatch');
    assert.strictEqual(original.imdbID, '');
    assert.strictEqual(downloads.length, 0);
    assert(requests.filter(q=>q.Episode !== undefined).length <= 7, 'Episode correction positions must remain bounded');
    assert(requests.filter(q=>q.Season !== undefined && q.Episode === undefined).length <= 3,
      'At most one cached episode list per visited season');
  }
});

suite.test('retains 27 reviewed wording variations and explicitly withholds three unverified alternates', async () => {
  for (const pair of corpus.pairs.filter(p => p.source === 'Atelaes' && p.expected === 'allow')) {
    const {api} = loadSearch(catalog([episode(pair.omdbTitle,pair.season,pair.episode)],series(SERIES,pair.series)));
    const result = await api.search(show({title:pair.localTitle,series:pair.series,season:pair.season,episode:pair.episode}));
    const change=precisionChanges.reviewedTitles.find(row=>row.localTitle===pair.localTitle && row.omdbTitle===pair.omdbTitle);
    if(change) {
      assert.strictEqual(result.success,false,change.explanation);
      assert.strictEqual(result.policyReason,change.policyReason);
      continue;
    }
    assert(result.success, `${pair.localTitle} -> ${pair.omdbTitle}: ${JSON.stringify(result)}`);
  }
});

suite.test('rejects both titled and untitled Ghost-in-the-Shell-style placeholder matches', async () => {
  for (const title of ['SA - Section-9', 'S01E01', '']) {
    const {api} = loadSearch(catalog([episode('Episode #1.1')],series(SERIES,'Ghost in the Shell','2026')));
    const result = await api.search(show({title,series:'Ghost in the Shell'}));
    assert.strictEqual(result.failure, 'Episode mismatch');
  }
});

suite.test('allows placeholder titles with a stored or explicitly selected series ID', async () => {
  for (const selected of [false,true]) {
    const {api} = loadSearch(catalog([episode('Episode #1.1')]));
    const result = await api.search(show({title:'',seriesImdbID:selected ? '' : SERIES}),
      selected ? {seriesImdbID:SERIES} : {});
    assert(result.success, JSON.stringify(result));
  }
});

suite.test('preserves all 16 logged Lost/Dead Like Me episode corrections and local numbering', async () => {
  assert.strictEqual(corrections.length, 16);
  for (const pair of corrections) {
    const target = episode(pair.matched.title,pair.matched.season,pair.matched.episode);
    const {api} = loadSearch(catalog([target]));
    const result = await api.search(show({title:pair.localTitle,season:pair.requested.season,episode:pair.requested.episode}));
    assert(result.success, `${pair.localTitle}: ${JSON.stringify(result)}`);
    assert.strictEqual(result.data.imdbID, target.imdbID);
    assert.strictEqual(result.data.season, pair.requested.season);
    assert.strictEqual(result.data.episode, pair.requested.episode);
  }
});

suite.test('preserves The Prisoner episode-zero lookup and ER normalized adjacent correction', async () => {
  for (const [title,remote,number] of [['Arrival','Arrival','0'],['Home FS','Home','8']]) {
    const target = episode(remote,'1',String(Number(number)+1));
    const {api} = loadSearch(catalog([target]));
    const result = await api.search(show({title,episode:number}));
    assert(result.success, JSON.stringify(result));
    assert.strictEqual(result.data.episode, number);
    assert.strictEqual(result.data.imdbID, target.imdbID);
  }
});

suite.test('never jumps to a merely fuzzy nearby episode', async () => {
  const {api} = loadSearch(catalog([episode('The Lich','1','2')]));
  const result = await api.search(show({title:'The Litch'}));
  assert.strictEqual(result.success, false);
});

suite.test('does not guess between two equally exact adjacent titles', async () => {
  const {api} = loadSearch(catalog([episode('Arrival','1','1'),episode('Arrival','1','3')]));
  const result = await api.search(show({title:'Arrival',episode:'2'}));
  assert.strictEqual(result.success, false);
});

suite.test('checks adjacent-season hints against each episode title', async () => {
  const {api} = loadSearch(catalog([episode('Arrival','2','1'),episode('Wrong Subject','2','2')]));
  const hints = new Map();
  const first = await api.search(show({title:'Arrival'}), {seasonOffsetHints:hints});
  assert(first.success, JSON.stringify(first));
  assert.strictEqual(first.data.season, '1');
  const second = await api.search(show({title:'Different Content',episode:'2'}), {seasonOffsetHints:hints});
  assert.strictEqual(second.success, false);
});

suite.test('retains season-index recovery when a direct episode lookup has a hole', async () => {
  const target = episode('Arrival');
  const {api} = loadSearch(query => {
    if (query.s) return {Response:'True', Search:[series()]};
    if (query.i === SERIES && query.Season && !query.Episode) {
      return {Response:'True', Season:'1', Episodes:[{Episode:'1',imdbID:target.imdbID}]};
    }
    if (query.i === target.imdbID) return target;
    if (query.i === SERIES && !query.Season) return series();
  });
  assert((await api.search(show({title:'Arrival'}))).success);
});

suite.test('uses the title to distinguish Kung Fu originals and remakes even if one lookup is missing', async () => {
  const old = series('tt0068093','Kung Fu','1972–1975'), remake = series('tt7475590','Kung Fu','2021–2023');
  const {api} = loadSearch(query => {
    if (query.s) return {Response:'True', Search:[old,remake]};
    if (query.i === remake.imdbID && query.Episode) return episode('Rage','1','6',remake.imdbID);
  });
  const result = await api.search(show({series:'Kung Fu',title:'The Soul Is The Warrior',episode:'6'}));
  assert.strictEqual(result.failure, 'Ambiguous series');
});

suite.test('retains Heroes chapter normalization during same-name series disambiguation', async () => {
  const right = series('tt0813715','Heroes','2006'), wrong = series('tt1111111','Heroes','2020');
  const {api} = loadSearch(query => {
    if (query.s) return {Response:'True', Search:[right,wrong]};
    if (query.i === right.imdbID) return query.Episode ? episode("Chapter One 'Genesis'",'1','1',right.imdbID) : right;
    if (query.i === wrong.imdbID) return episode('Another Story','1','1',wrong.imdbID);
  });
  const result = await api.search(show({series:'Heroes',title:'Genesis'}));
  assert(result.success, JSON.stringify(result));
  assert.strictEqual(result.data.seriesImdbID,right.imdbID);
});

suite.test('does not cache a rejected parent, but reuses validated series without extra searches', async () => {
  let corrected = false;
  const lookup = catalog([episode('A Real Episode')]);
  const {api, requests} = loadSearch(query => {
    if (query.i === SERIES && query.Episode === '1' && query.Season === '1' && !corrected) return episode('Totally Different Subject');
    return lookup(query);
  });
  assert.strictEqual((await api.search(show())).success,false);
  corrected = true;
  // A corrected provider record is visible in a new run; that run then shares responses.
  const session = api.createSeriesSearchSession();
  assert((await api.search(show(),{seriesSearchSession:session})).success);
  assert((await api.search(show(),{seriesSearchSession:session})).success);
  assert.strictEqual(requests.filter(q=>q.s).length,2);
});

suite.test('validates a batch representative before approving an ID for the whole batch', async () => {
  const {api, downloads} = loadSearch(catalog([episode('Unrelated Content')]));
  const original = show();
  const result = await api.resolveSeriesForBatch([original]);
  assert.strictEqual(result.failure,'Episode mismatch');
  assert.strictEqual(original.seriesImdbID,'');
  assert.strictEqual(downloads.length,0);
});

suite.test('successful batch preflight avoids artwork and returns the validated parent ID', async () => {
  const {api, downloads} = loadSearch(catalog([episode('A Real Episode','1','1',SERIES,{Poster:'https://example.invalid/poster.jpg'})]));
  const result = await api.resolveSeriesForBatch([show()]);
  assert(result.success,JSON.stringify(result));
  assert.strictEqual(result.data,SERIES);
  assert.strictEqual(downloads.length,0);
});

suite.test('one bonus or conflicting title cannot prevent a sound selected series batch', async () => {
  const {api} = loadSearch(catalog([episode('Wrong Content'),episode('A Real Episode','1','2')]));
  const result = await api.resolveSeriesForBatch([show({title:'Loglady'}),show({episode:'2'})]);
  assert(result.success,JSON.stringify(result));
  assert.strictEqual(result.data,SERIES);
});

suite.test('batch representative retries remain bounded and do not repeatedly probe duplicate tags', async () => {
  const {api,requests} = loadSearch(catalog(Array.from({length:10},(_,i)=>episode('Wrong Content','1',String(i+1)))));
  const videos = Array.from({length:10},(_,i)=>show({episode:String(i+1)}));
  const result = await api.resolveSeriesForBatch([videos[0],videos[0],...videos]);
  assert.strictEqual(result.failure,'Episode mismatch');
  assert.strictEqual(requests.filter(q=>q.s).length,1, 'Representatives share the series query, not their episode decisions');
  assert(requests.length <= 25, 'At most three representatives may be probed');
});

suite.test('blocks gross runtime mismatches even when the episode title matches', async () => {
  const {api, downloads} = loadSearch(catalog([episode('A Real Episode')]));
  const result = await api.search(show({metadata:{duration:120}}));
  assert.strictEqual(result.failure,'Episode mismatch');
  assert(/runtime mismatch/i.test(result.data));
  assert.strictEqual(downloads.length,0);
});

suite.test('uses refreshed technical duration while retaining all current tags as matching input', async () => {
  let calls=0;
  const {api} = loadSearch(catalog([episode('A Real Episode')]), {readDuration:async video=>{
    calls++;return {...video,metadata:{...video.metadata,duration:120}};
  }});
  const result=await api.search(show({metadata:{}}));
  assert.strictEqual(result.failure,'Episode mismatch');
  assert.strictEqual(calls,1);
});

suite.test('missing technical duration does not reject an otherwise sound match', async () => {
  const {api} = loadSearch(catalog([episode('A Real Episode')]));
  assert((await api.search(show({metadata:{}}))).success);
});

suite.test('transport failure during correction stays retryable and cannot authorize the original mismatch', async () => {
  const {api} = loadSearch(query => {
    if(query.s)return {Response:'True',Search:[series()]};
    if(query.Episode==='1'&&query.Season==='1')return episode('Unrelated Content');
    return new Error('Network unavailable');
  });
  const result=await api.search(show());
  assert.strictEqual(result.success,false);
  assert.notStrictEqual(result.permanentFailure,true);
});

suite.test('current exact IMDb IDs remain authoritative regardless of older filenames or titles', async () => {
  const data=episode('Previously Chosen Episode');
  const {api,requests}=loadSearch(catalog([data]));
  const result=await api.search(show({imdbID:data.imdbID,title:'Different Current Title',filename:'Another Original Title.mkv'}));
  assert(result.success,JSON.stringify(result));
  assert.strictEqual(result.data.imdbID,data.imdbID);
  assert.strictEqual(result.data.title,'Previously Chosen Episode');
  assert.strictEqual(requests.filter(q=>q.Episode||q.s).length,0);
});

// These fixtures record identities and local duration, not catalog runtime.
// An invented default 45-minute runtime would test false catalog facts.
suite.test('tags all 198 supplied release-label cases through the full guarded search', async () => {
  const recovery = require('./fixtures/UnmatchedShowRecovery.json');
  for (const item of recovery.releaseLabels) {
    const parentTitle = item.video.series.replace(/\s+-\s+\d{1,2}\s+-\s+/g, ' ');
    const target = episode(item.catalogTitle, item.video.season, item.video.episode, item.parentID, {imdbID:item.episodeID,Runtime:'N/A'});
    const {api, requests} = loadSearch(catalog([target], series(item.parentID, parentTitle)));
    const original = show(item.video), before = JSON.stringify(original);
    const result = await api.search(original);
    assert(result.success, `${item.video.title}: ${JSON.stringify(result)}`);
    assert.strictEqual(result.data.imdbID, item.episodeID);
    assert.strictEqual(result.data.seriesImdbID, item.parentID);
    assert.strictEqual(JSON.stringify(original), before);
    assert.strictEqual(requests.filter(q => q.Season && q.Episode).length, 1, 'A release label must not trigger irrelevant neighboring-title probes');
  }
});

suite.test('infers the season for all 30 miniseries files, verifying the repeated series prefix explicitly', async () => {
  const items = require('./fixtures/UnmatchedShowRecovery.json').miniseries;
  for (const name of new Set(items.map(item => item.video.series))) {
    const group = items.filter(item => item.video.series === name);
    const parent = {...series(SERIES, group[0].parentTitle, group[0].parentYear), totalSeasons:'1'};
    const targets = group.map(item => episode(item.catalogTitle, '1', item.video.episode, SERIES, {imdbID:item.episodeID,Runtime:'N/A'}));
    const {api, requests} = loadSearch(catalog(targets, parent));
    const session = api.createSeriesSearchSession();
    for (const item of group) {
      const original = show(item.video), before = JSON.stringify(original);
      const result = await api.search(original,{seriesSearchSession:session});
      const change=precisionChanges.miniseries.find(row=>row.title===item.video.title && row.episodeID===item.episodeID);
      if(change && !change.resolvedBy) {
        assert.strictEqual(result.success,false);
        assert.strictEqual(result.policyReason,change.policyReason);
        assert.strictEqual(JSON.stringify(original),before);
        continue;
      }
      assert(result.success, `${name}: ${item.video.title}: ${JSON.stringify(result)}`);
      assert.strictEqual(result.data.season, '1');
      assert.strictEqual(result.data.series, item.video.series);
      assert.strictEqual(result.data.imdbID, item.episodeID);
      if (change && change.resolvedBy) {
        assert.strictEqual(result.evidence.titleComparison.basis,change.resolvedBy);
        assert.strictEqual(result.evidence.titleComparison.originalTitle,item.video.title);
      }
      assert.strictEqual(JSON.stringify(original), before);
    }
    assert(requests.filter(q => q.i === SERIES && !q.Season).length <= 2,
      'Cache verified parent details; at most one additional parent request is needed for artwork fallback');
    if (/Roots|Pride and Prejudice/.test(name)) assert.strictEqual(requests.find(q => q.s).y, group[0].parentYear);
  }
});

suite.test('does not default ambiguous, unknown, multi-season, disc or pilot records to season one', async () => {
  for (const totalSeasons of ['2', 'N/A', undefined]) {
    const parent = {...series(), totalSeasons};
    const {api} = loadSearch(catalog([episode('A Real Episode')], parent));
    const original = show({season:''});
    assert.strictEqual((await api.search(original)).failure, 'Not enough data');
    assert.strictEqual(original.season, '');
  }
  for (const extra of [{dvd:true}, {episode:'0'}, {episode:'1.5'}, {season:'extras'}, {season:'bad'}]) {
    const {api, requests} = loadSearch(() => {throw new Error('No request should be made');});
    assert.strictEqual((await api.search(show({season:'', ...extra}))).failure, 'Not enough data');
    assert.strictEqual(requests.length, 0);
  }
  const {api} = loadSearch(q => q.s ? {Response:'True', Search:[series(),series('tt9999999')]} : notFound);
  assert.strictEqual((await api.search(show({season:''}))).failure, 'Ambiguous series');
});

suite.test('validates the full parent identity and leaves a failed inferred episode untouched', async () => {
  for (const parent of [{...series(), Type:'movie', totalSeasons:'1'},
    {...series(), imdbID:'tt9999999', totalSeasons:'1'},
    {...series(), Title:'Another Show', totalSeasons:'1'}]) {
    const {api} = loadSearch(q => q.s ? {Response:'True',Search:[series()]} : parent);
    const original = show({season:''});
    assert.strictEqual((await api.search(original)).success, false);
    assert.strictEqual(original.season, '');
  }
  const parent = {...series(), totalSeasons:'1'};
  const {api} = loadSearch(catalog([episode('Birthday Party')], parent));
  const original = show({season:'',title:'Arrival'}), before = JSON.stringify(original);
  assert.strictEqual((await api.search(original)).failure, 'Episode mismatch');
  assert.strictEqual(JSON.stringify(original), before);
});

suite.test('selected miniseries preflight verifies season and episode before returning a shared parent', async () => {
  const {api, downloads} = loadSearch(catalog([episode('A Real Episode')], {...series(),totalSeasons:'1'}));
  const original = show({season:''});
  const result = await api.resolveSeriesForBatch([original]);
  assert(result.success, JSON.stringify(result));
  assert.strictEqual(result.data, SERIES);
  assert.strictEqual(original.season, '');
  assert.strictEqual(downloads.length, 0);
});

suite.test('discovers Doctor Who with its explicit collection year and validates the serial subtitle', async () => {
  const parent = series(SERIES, 'Doctor Who', '1963–1989');
  const target = episode('The Cave of Skulls', '1', '2');
  const {api, requests} = loadSearch(q => {
    if (q.s === 'Dr Who') return {Response:'True',Search:[series('tt9999999','Dr. Who FA','2015')]};
    if (q.s === 'Doctor Who') return {Response:'True',Search:[parent]};
    return catalog([target], parent)(q);
  });
  const result = await api.search(show({series:'Dr Who',title:'An Unearthly Child Pt 2 The Cave of Skulls',episode:'2',
    filename:'/Fixtures/Dr Who/Doctor Who 01 S01-S04 (1963- 360p re-rip)/Serial/episode.mp4'}));
  assert(result.success, JSON.stringify(result));
  assert(requests.some(q => q.s === 'Doctor Who' && q.y === '1963'));
  assert.strictEqual(result.data.series, 'Dr Who');
});

suite.test('uses the dotted Prisoner premiere year before reconciling episode zero', async () => {
  const parent = series(SERIES,'The Prisoner','1967–1968');
  const {api, requests} = loadSearch(catalog([episode('Arrival')],parent));
  const result = await api.search(show({series:'The Prisoner',title:'Arrival',episode:'0',
    filename:'/Fixtures/The.Prisoner.1967-1968.Complete.Series.Subs.English+Nordic/The.Prisoner.S01E00.Arrival.mkv'}));
  assert(result.success, JSON.stringify(result));
  assert.strictEqual(requests[0].y, '1967');
  assert.strictEqual(result.data.episode, '0');
});

suite.test('retains all 167 current-run episode and season corrections', async () => {
  const cases = require('./fixtures/UnmatchedShowRecovery.json').numberCorrections;
  assert.strictEqual(cases.length, 167);
  for (const item of cases) {
    const target = episode(item.matched.title,item.matched.season,item.matched.episode);
    const {api} = loadSearch(catalog([target]));
    const result = await api.search(show({title:item.localTitle,season:item.requested.season,episode:item.requested.episode}));
    assert(result.success, `${item.series}: ${item.localTitle}: ${JSON.stringify(result)}`);
    assert.strictEqual(result.data.imdbID, target.imdbID);
    assert.strictEqual(result.data.season, item.requested.season);
    assert.strictEqual(result.data.episode, item.requested.episode);
  }
});

suite.test('keeps new release placeholders ambiguous between two returning remakes and rejects wrong-parent responses', async () => {
  const first = series(SERIES,'Dr. Death','2021'), other = series('tt9999999','Dr. Death','2018');
  const {api} = loadSearch(q => q.s ? {Response:'True',Search:[first,other]} :
    q.Episode ? episode('A Title','2','1',q.i) : notFound);
  const result = await api.search(show({series:'Dr Death',title:'Dr.Death.S02E01.1080p.WEBRip.x265-KONTRAST',season:'2'}));
  assert.strictEqual(result.failure, 'Ambiguous series');
  const wrong = loadSearch(catalog([episode('A Title','1','1','tt9999999')]));
  assert.strictEqual((await wrong.api.search(show({title:'Test.Series.S01E01.1080p.WEB.x264'}))).success,false);
});

suite.test('retains LA X and uses the numeric title to correct the observed TNG-style mismatch', async () => {
  const short = loadSearch(catalog([episode('LA X: Part 1')]));
  assert((await short.api.search(show({series:'Test Series',title:'LA X'}))).success);
  const target = episode('11001001','1','14');
  const numeric = loadSearch(catalog([episode('Too Short a Season','1','15'),target]));
  const result = await numeric.api.search(show({title:'11001001',episode:'15'}));
  assert(result.success,JSON.stringify(result));
  assert.strictEqual(result.data.imdbID,target.imdbID);
  assert.strictEqual(result.data.episode,'15');
});

suite.test('replays 138 Doctor Who variants with one explicitly unverified subtitle withheld', async () => {
  const cases = require('./fixtures/UnmatchedShowRecovery.json').doctorWho;
  const parent = series(SERIES,'Doctor Who','1963–1989');
  const targets = cases.map(item=>episode(item.catalogTitle,item.video.season,item.video.episode,SERIES,
    {imdbID:item.episodeID,Runtime:'25 min'}));
  const {api} = loadSearch(q=>q.s==='Dr Who'?notFound:catalog(targets,parent)(q));
  for(const item of cases) {
    const result=await api.search(show(item.video));
    const change=precisionChanges.doctorWho.find(row=>row.title===item.video.title && row.episodeID===item.episodeID);
    if(change) {
      assert.strictEqual(result.success,false,change.explanation);
      assert.strictEqual(result.policyReason,change.policyReason);
      continue;
    }
    assert(result.success,`${item.video.title}: ${JSON.stringify(result)}`);
    assert.strictEqual(result.data.imdbID,item.episodeID);
  }
});

suite.test('MST3K disc suffixes enable 19 exact corrections without accepting the abbreviated twentieth title', async () => {
  const cases=require('./fixtures/UnmatchedShowRecovery.json').mstDiscTitles;
  const parent=series(SERIES,'Mystery Science Theater 3000','1988–1999');
  const hints=new Map();let recovered=0;
  for(const item of cases) {
    const target=episode(item.catalogTitle,'9',item.video.episode,SERIES,{imdbID:item.episodeID,Runtime:'95 min'});
    const {api}=loadSearch(catalog([target],parent));
    const result=await api.search(show(item.video),{seasonOffsetHints:hints});
    if(item.video.title.startsWith('TheIncrediblyStrangeCreatures')) {
      assert.strictEqual(result.success,false);
    } else {
      assert(result.success,`${item.video.title}: ${JSON.stringify(result)}`);
      assert.strictEqual(result.data.imdbID,item.episodeID);
      assert.strictEqual(result.data.season,'8');recovered++;
    }
  }
  assert.strictEqual(recovered,19);
});

suite.test('incomplete parent metadata does not poison later missing-season attempts', async () => {
  let details=0;
  const parent=series();
  const target=episode('Arrival');
  const {api}=loadSearch(q=>{
    if(q.s)return {Response:'True',Search:[parent]};
    if(q.i===SERIES&&!q.Season)return {...parent,totalSeasons:++details===1?'N/A':'1'};
    return catalog([target],parent)(q);
  });
  const original=show({season:'',title:'Arrival'});
  assert.strictEqual((await api.search(original)).failure,'Not enough data');
  assert((await api.search(original)).success);
  assert.strictEqual(original.season,'');
});

runSuite(suite);
