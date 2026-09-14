const path = require('path');
const {assert, createSuite, runSuite} = require('./helpers/TestHarness.js');
const {loadFreshWithMocks} = require('./helpers/ModuleMocks.js');
const {videoFixture} = require('./helpers/Fixtures.js');
const corpus = require('./fixtures/EpisodeTitleCorpus.json');
const corrections = require('./fixtures/EpisodeCorrections.json');

const suite = createSuite('OMDb episode selection and tagging safeguards', 'integration',
  'Runs real search, caching, correction and tagging code against controlled OMDb responses; no network or real library access.');
const SERIES = 'tt1000001';
const notFound = {Response:'False', Error:'Movie not found!'};
const show = overrides => videoFixture({
  id:'test-video', title:'A Real Episode', kind:'show', series:'Test Series',
  season:'1', episode:'1', imdbID:'', seriesImdbID:'', filename:'unrelated.mkv',
  metadata:{duration:2700}, ...overrides
});
const series = (id = SERIES, title = 'Test Series', year = '2000') => ({
  Response:'True', Type:'series', Title:title, Year:year, imdbID:id, Poster:'N/A'
});
const episode = (title, season = '1', number = '1', parent = SERIES, extra = {}) => ({
  Response:'True', Type:'episode', Title:title, Season:String(season), Episode:String(number),
  seriesID:parent, imdbID:`tt2${String(season).padStart(3,'0')}${String(number).padStart(3,'0')}`,
  Runtime:'45 min', Year:'2000', Poster:'N/A', Plot:'Fixture episode', Ratings:[],
  Genre:'Drama', Director:'Example Director', Actors:'Example Actor', Language:'English', ...extra
});

function loadSearch(responder, options = {}) {
  const requests = [], logs = [], downloads = [];
  const logger = Object.fromEntries(['debug','info','warn','error'].map(level => [level,
    (message, data) => logs.push({level, message, data})]));
  const axios = async request => {
    const query = Object.fromEntries(new URL(request.url).searchParams);
    delete query.apikey;
    requests.push(query);
    const response = await responder(query, requests);
    if (response instanceof Error) throw response;
    return {status:200, statusText:'OK', data:response || notFound};
  };
  const api = loadFreshWithMocks(path.join(__dirname,'../src/tagging/OmdbHelper.js'), {
    '../../omdb':{key:'fixture-only'}, axios,
    electron:{app:{getPath:() => '/unused-fixture-user-data'}, ipcRenderer:{}},
    '../platform/Logger.js':{child:() => logger},
    './EpisodeRuntime.js':{withEpisodeDuration:options.readDuration || (async video => video)},
    '../platform/download':{download:(url, destination, callback) => {downloads.push(url);callback({path:destination});}}
  });
  return {api, requests, logs, downloads};
}

function catalog(episodes, parent = series()) {
  return query => {
    if (query.s || query.t) return query.s ? {Response:'True', Search:[parent]} : parent;
    if (query.i === parent.imdbID && !query.Season) return parent;
    if (query.i === parent.imdbID && query.Episode) {
      return episodes.find(item => item.Season === query.Season && item.Episode === query.Episode);
    }
    return episodes.find(item => item.imdbID === query.i);
  };
}

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
    assert(requests.length <= 8, 'Episode correction requests must remain bounded');
  }
});

suite.test('retains all 30 reviewed Atelaes wording and multipart variations', async () => {
  for (const pair of corpus.pairs.filter(p => p.source === 'Atelaes' && p.expected === 'allow')) {
    const {api} = loadSearch(catalog([episode(pair.omdbTitle,pair.season,pair.episode)],series(SERIES,pair.series)));
    const result = await api.search(show({title:pair.localTitle,series:pair.series,season:pair.season,episode:pair.episode}));
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
  assert((await api.search(show())).success);
  assert((await api.search(show())).success);
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
  assert.strictEqual(requests.filter(q=>q.s).length,3);
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

runSuite(suite);
