const {assert,createSuite,runSuite}=require('./helpers/TestHarness.js');
const {show,series,episode,loadSearch,catalog}=require('./helpers/OmdbFixtures.js');
const artwork=require('./fixtures/HistoricalArtwork.json');
const suite=createSuite('Historical tagging workflows','integration',
  'Protects individual artwork, batch, series-selection, title-normalization and explicit-ID cases recovered from project logs.');
const rows=items=>({Response:'True',Search:items});

for(const item of artwork) suite.test(`${item.series}: failed episode artwork falls back and a 404 is not retried`,async()=>{
  const parent={...series(item.seriesID,item.series),Poster:'https://example.invalid/series.jpg'};
  const target=episode(item.title,item.season,item.episode,item.seriesID,
    {imdbID:item.episodeID,Poster:'https://example.invalid/episode.jpg'});
  const {api,requests,downloads}=loadSearch(catalog([target],parent),{download:(url,destination,done)=>
    done(url.endsWith('/episode.jpg')?{message:'Not found',status:404}:{path:destination})});
  const input=show({imdbID:item.episodeID,series:item.series,seriesImdbID:item.seriesID,
    title:item.title,season:item.season,episode:item.episode});
  const result=await api.search(input);
  assert(result.success,JSON.stringify(result));assert(result.data.artwork.endsWith('series.jpg'));
  assert((await api.search(input)).success);
  assert.strictEqual(downloads.filter(url=>url.endsWith('/episode.jpg')).length,1);
  assert.strictEqual(requests.filter(q=>q.i===item.seriesID).length,1);
});

suite.test('Elfen Lied: unavailable artwork never discards a successful episode tag',async()=>{
  const parent={...series('tt0480489','Elfen Lied'),Poster:'https://example.invalid/series.jpg'};
  const data=episode('Encounter',1,1,parent.imdbID,{imdbID:'tt0909536',Poster:'https://example.invalid/episode.jpg'});
  const {api}=loadSearch(catalog([data],parent),{download:(url,destination,done)=>done({message:'Not found',status:404})});
  const result=await api.search(show({imdbID:data.imdbID,series:'Elfen Lied'}));
  assert(result.success);assert.strictEqual(result.data.imdbID,data.imdbID);assert.strictEqual(result.data.artwork,'');
});

suite.test('Party of Five: pasting a series IMDb ID still retrieves the specified episode',async()=>{
  const parent=series('tt0108894','Party of Five','1994');
  const target=episode('Pilot',1,1,parent.imdbID,{imdbID:'tt0670343'});
  const {api}=loadSearch(catalog([target],parent));
  const result=await api.search(show({title:'Party of Five 1x01',series:'Party of Five',imdbID:parent.imdbID}));
  assert(result.success,JSON.stringify(result));assert.strictEqual(result.data.imdbID,target.imdbID);
  assert.strictEqual(result.data.seriesImdbID,parent.imdbID);
});

suite.test('Band of Brothers: an incomplete batch prefix cannot hide a usable representative',async()=>{
  const right=series('tt0185906','Band of Brothers','2001'), other=series('tt5217254','Band of Brothers','2008');
  const data=episode('Currahee',1,1,right.imdbID,{imdbID:'tt1245384'});
  const {api}=loadSearch(q=>q.s?rows([right,other]):q.i===right.imdbID&&q.Episode?data:undefined);
  const input=Array.from({length:12},()=>show({series:'Band of Brothers',season:'',episode:''}));
  input.push(show({title:'Currahee',series:'Band of Brothers'}));
  const result=await api.resolveSeriesForBatch(input);
  assert(result.success,JSON.stringify(result));assert.strictEqual(result.data,right.imdbID);
  assert(input.every(v=>v.seriesImdbID===''), 'Preflight itself must not mutate the selection');
});

suite.test('Law and Order SVU: ampersand and acronym searches cannot select Law & Order',async()=>{
  const parent=series('tt0203259','Law & Order: Special Victims Unit','1999');
  const original=series('tt0098844','Law & Order','1990');
  const {api,requests}=loadSearch(q=>q.s==='Law & Order'?rows([original,parent]):
    q.i===parent.imdbID ? q.Episode?episode('Payback',1,1,parent.imdbID,{imdbID:'tt0629700'}):parent:undefined);
  const result=await api.search(show({series:'Law and Order SVU',title:'Payback'}));
  assert(result.success);assert.strictEqual(result.data.imdbID,'tt0629700');
  assert(requests.some(q=>q.s==='Law & Order SVU'));assert(requests.some(q=>q.s==='Law & Order'));
});

suite.test('E.R..R: the dotted-initial typo can still reach the corrected Day One episode',async()=>{
  const parent=series('tt0108757','ER','1994');
  const data=episode('Day One',1,2,parent.imdbID,{imdbID:'tt0567951'});
  const lookup=catalog([data],parent);
  const {api}=loadSearch(q=>q.s||q.t?q.s==='ER'?rows([parent]):undefined:lookup(q));
  const result=await api.search(show({series:'E.R..R',title:'Day One FS',episode:'3'}));
  assert(result.success,JSON.stringify(result));assert.strictEqual(result.data.imdbID,data.imdbID);
  assert.strictEqual(result.data.episode,'3');
});

suite.test('Prisoner, The (2009): article order and explicit premiere year select the remake',async()=>{
  const parent=series('tt1043714','The Prisoner','2009');
  const {api,requests}=loadSearch(catalog([episode('Arrival',1,1,parent.imdbID)],parent));
  const result=await api.search(show({series:'Prisoner, The (2009)',title:'Arrival'}));
  assert(result.success);assert.strictEqual(requests[0].s,'The Prisoner');assert.strictEqual(requests[0].y,'2009');
  assert.strictEqual(result.data.series,'Prisoner, The (2009)');
});

suite.test('Seinfeld: The Clip Show keeps its reviewed The Chronicle title alias',async()=>{
  const parent=series('tt0098904','Seinfeld','1989');
  const target=episode('The Chronicle',9,21,parent.imdbID);
  const {api}=loadSearch(catalog([target],parent));
  const result=await api.search(show({series:'Seinfeld',title:'The Clip Show',season:'9',episode:'21'}));
  assert(result.success);assert.strictEqual(result.data.imdbID,target.imdbID);
});

suite.test('a saved IMDb ID remains authoritative even when a filename describes another movie',async()=>{
  const record={Response:'True',Type:'movie',Title:'First Blood',Year:'1982',imdbID:'tt0083944',Poster:'N/A',Ratings:[]};
  const {api,requests}=loadSearch(q=>q.i===record.imdbID?record:undefined);
  const result=await api.search(show({kind:'movie',title:'An Edited Label',filename:'Rambo.Part.II.1985.mkv',imdbID:record.imdbID}));
  assert(result.success);assert.strictEqual(result.data.imdbID,record.imdbID);assert.strictEqual(requests.length,1);
});

runSuite(suite);
