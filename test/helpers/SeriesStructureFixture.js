const {assert} = require('./TestHarness');
const {show,series,episode,notFound} = require('./OmdbFixtures');
const NAME='Orchard Signal', A='tt1000001', B='tt9000001', C='tt8000001';
const range=n=>Array.from({length:n},(_,i)=>i+1);
const input=(s,n,extra={})=>show({id:`s${s}e${n}`,series:NAME,season:String(s),episode:String(n),
  title:`${NAME} S${String(s).padStart(2,'0')}E${String(n).padStart(2,'0')}`,
  filename:`/Shows/${NAME}/Season ${s}/${n}.mkv`,...extra});
const videosFor=counts=>Object.entries(counts).flatMap(([s,n])=>range(n).map(ep=>input(s,ep)));
function fixture(counts,options={}) {
  const parents=Object.entries(counts).map(([id,seasons],i)=>({...series(id,NAME,String(1990+i*10)),
    totalSeasons:String(Math.max(...Object.keys(seasons).map(Number)))}));
  const records=Object.entries(counts).flatMap(([id,seasons])=>Object.entries(seasons).flatMap(([s,n])=>range(n).map(ep=>
    episode(`Catalog story ${s}.${ep}`,s,ep,id,{imdbID:`tt${id.slice(2)}${String(s).padStart(3,'0')}${String(ep).padStart(3,'0')}`}))));
  const responder=q=>{
    if (q.s) return {Response:'True',Search:parents};
    const parent=parents.find(p=>p.imdbID===q.i);
    if (parent && !q.Season) return options.metadata?options.metadata(parent):parent;
    if (parent && q.Season && !q.Episode) {
      const rows=records.filter(r=>r.seriesID===q.i && r.Season===q.Season)
        .map(r=>({Episode:r.Episode,Title:r.Title,imdbID:r.imdbID}));
      const result=rows.length?{Response:'True',Title:NAME,Season:q.Season,totalSeasons:parent.totalSeasons,Episodes:rows}:notFound;
      return options.list?options.list(q,result):result;
    }
    const record=records.find(r=>parent && q.Episode?r.seriesID===q.i && r.Season===q.Season && r.Episode===q.Episode:r.imdbID===q.i);
    return options.record?options.record(q,record):record || notFound;
  };
  return {responder,parents,records};
}
const winner=run=>[...new Set([...run.saved.values()].filter(v=>v.imdbID).map(v=>v.seriesImdbID))];
function assertNoMatch(run) {assert.deepStrictEqual(winner(run),[]);}
function assertRequestsReused(run) {
  const keys=run.requests.map(q=>JSON.stringify(Object.entries(q).sort()));
  assert.strictEqual(new Set(keys).size,keys.length,'Structural lookups and episode fallbacks must reuse the catalog cache');
}

module.exports = {NAME,A,B,C,range,input,videosFor,fixture,winner,assertNoMatch,assertRequestsReused};
