// Test-only translation of recorded catalog fixtures into the public server
// contract. The separate server replay tests exercise the real provider adapter.
const connection = {url:'http://127.0.0.1:8787', token:'fixture-metadata-token-for-tests-only'};
const provenance = {provider:'fixture', fetchedAt:'2026-10-15T00:00:00.000Z'};
const ref = id => ({provider:'fixture', id:'native-' + id});
const text = value => value == null || value === 'N/A' ? null : String(value);
const number = value => text(value) === null ? null : Number(value);
const list = value => text(value) === null ? null : value.split(',').map(item => item.trim());
function summary(row) {
  const year = text(row.Year);
  return {ref:ref(row.imdbID), externalIds:{imdb:row.imdbID}, title:row.Title, kind:row.Type,
    year:year === null ? null : {text:year, start:Number(year.slice(0,4)), end:null},
    artwork:text(row.Poster) ? [{type:'poster',url:row.Poster,provider:'fixture'}] : []};
}
function record(row) {
  return {...summary(row), released:text(row.Released), plot:text(row.Plot), contentRating:text(row.Rated),
    boxOffice:text(row.BoxOffice), genres:list(row.Genre), directors:list(row.Director), actors:list(row.Actors),
    countries:list(row.Country), languages:list(row.Language),
    runtimeMinutes:text(row.Runtime) ? Number.parseFloat(row.Runtime) : null,
    ratings:(row.Ratings || []).map(item => ({source:item.Source,value:item.Value,provider:'fixture'})),
    votes:text(row.imdbVotes) ? [{source:'imdb',count:Number(String(row.imdbVotes).replace(/,/g,'')),provider:'fixture'}] : [],
    series:text(row.seriesID) ? ref(row.seriesID) : null,
    seriesExternalIds:text(row.seriesID) ? {imdb:row.seriesID} : {},
    season:number(row.Season), episode:number(row.Episode), totalSeasons:number(row.totalSeasons),
    episodeOrder:row.Type === 'episode' ? 'provider' : null, provenance};
}
function fixtureQuery(route, body) {
  const query = {};
  if (body.ref || body.series) query.i = (body.ref || body.series).id;
  if (body.title) query[route === '/v1/search' ? 's' : 't'] = body.title;
  for (const [name,key] of Object.entries({kind:'type',year:'y',page:'page',season:'Season',episode:'Episode'})) {
    if (body[name] !== undefined) query[key] = String(body[name]);
  }
  return query;
}
function response(raw, query) {
  const requestId = 'fixture-request-id';
  if (raw.Response === 'False') {
    const code = /Invalid API key/.test(raw.Error) ? 'PROVIDER_AUTH_ERROR' :
      /limit reached/.test(raw.Error) ? 'PROVIDER_QUOTA_EXCEEDED' :
      /Too many/.test(raw.Error) ? 'TOO_MANY_RESULTS' : 'NOT_FOUND';
    return {status:code === 'NOT_FOUND' ? 404 : code === 'TOO_MANY_RESULTS' ? 422 : 503,
      data:{requestId,error:{code,message:'Fixture service error',retryable:code.startsWith('PROVIDER_')}}};
  }
  let data;
  if (Array.isArray(raw.Search)) {
    const total = raw.totalResults === undefined ? null : Number(raw.totalResults);
    data = {items:raw.Search.map(summary),page:Number(query.page || 1),totalResults:total,
      hasMore:total === null ? null : Number(query.page || 1)*10 < total,provenance};
  } else if (Array.isArray(raw.Episodes)) {
    data = {series:ref(query.i),seriesExternalIds:{imdb:query.i},season:Number(raw.Season),order:'provider',
      totalSeasons:number(raw.totalSeasons),completeness:'unknown',provenance,
      episodes:raw.Episodes.map(row => ({ref:ref(row.imdbID),externalIds:{imdb:row.imdbID},title:row.Title,
        episode:number(row.Episode),released:text(row.Released)}))};
  } else data = record(raw);
  return {status:200,data:{requestId,data}};
}
module.exports = {connection, fixtureQuery, response};
