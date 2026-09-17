const path=require('path');
const {assert,createSuite,runSuite}=require('./helpers/TestHarness.js');
const {loadSearch}=require('./helpers/OmdbFixtures.js');
const MovieSearch=require('../src/tagging/MovieSearch.js');
const history=require('./fixtures/HistoricalMovieDiscoveries.json');
const suite=createSuite('Individual fix03–fix05 movie discoveries','integration',
  'Checks every changed movie in the saved before/after libraries against its final IMDb identity, using controlled catalog responses.');

for(const [index,item] of history.cases.entries()) suite.test(`[M${String(index+1).padStart(3,'0')}] ${item.label} (${item.expected.imdbID})`,async()=>{
  const data={Response:'True',Type:'movie',Title:item.expected.title,Year:String(item.expected.year),
    imdbID:item.expected.imdbID,Runtime:`${Math.round(item.duration/60)} min`,imdbVotes:'100,000',Genre:'Drama',Poster:'N/A',Ratings:[]};
  const {api}=loadSearch(q=>{
    if(q.i) return q.i===data.imdbID ? data : undefined;
    if(q.y && q.y!==data.Year) return undefined;
    const text=String(q.s || q.t || '');
    // Catalog rows may be returned by an alias/keyword query. The application
    // still has to qualify the unreduced input title and fetch the full ID.
    if(q.s) return {Response:'True',Search:[data]};
    if(q.t && MovieSearch.titleKey(text)===MovieSearch.titleKey(data.Title)) return data;
  },{modulePath:process.env.MYNDA_HISTORY_MODULE});
  const result=await api.search({...item.video,series:'',seriesImdbID:'',season:'',episode:'',
    metadata:{duration:item.duration},filename:path.join(path.parse(__dirname).root,'fixture-media',...item.filenameParts)});
  assert(result.success && !Array.isArray(result.data),JSON.stringify(result));
  assert.strictEqual(result.data.imdbID,item.expected.imdbID);
  if(item.previousWrongImdbID) assert.notStrictEqual(result.data.imdbID,item.previousWrongImdbID);
});

runSuite(suite);
