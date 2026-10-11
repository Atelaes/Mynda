// Raw catalog records and disposable videos. No precomputed match decisions.
const fs = require('fs');
const path = require('path');
const {createHash} = require('crypto');
const copy = value => JSON.parse(JSON.stringify(value));
const missing = {Response: 'False', Error: 'Movie not found!'};
const poster = name => `https://artwork.mynda.test/${name}.png`;
const id = name => createHash('sha256').update('mynda-tagging-e2e:' + name).digest('hex');
const movie = (Title, imdbID, extra = {}) => ({Response:'True', Type:'movie', Title, imdbID,
  Year:'2001', Runtime:'120 min', Plot:'Catalog description for ' + Title, Director:'Avery Example',
  Actors:'Morgan Sample, Riley Example', Genre:'Drama, Adventure', Language:'English', Country:'Canada',
  Rated:'PG', BoxOffice:'$1,234', Poster:poster(imdbID), Ratings:[
    {Source:'Internet Movie Database', Value:'7.8/10'},
    {Source:'Rotten Tomatoes', Value:'84%'}, {Source:'Metacritic', Value:'72/100'}], ...extra});
const series = (Title, imdbID, Year = '2001') => ({...movie(Title, imdbID), Type:'series', Year, totalSeasons:'2'});
const episode = (parent, Season, Episode, Title, imdbID) => ({...movie(Title, imdbID),
  Type:'episode', seriesID:parent.imdbID, Season:String(Season), Episode:String(Episode), Runtime:'45 min',
  Poster:'N/A'});
const parents = {
  lantern:series('Lantern Harbor','tt19000101'), remake:series('Lantern Harbor','tt19000102','2011'),
  clock:series('Clockwork Vale','tt19000103'), quiet:series('Quiet Planet','tt19000104'),
  mirror:series('Mirror Bay','tt19000105'), mirrorOther:series('Mirror Bay','tt19000106','2011')
};
const records = [
  movie('Lunar Archive','tt19000001'), movie('Paper Comet','tt19000002'),
  movie('Shared Horizon','tt19000003'), movie('Shared Horizon','tt19000004'),
  movie('Held Orbit','tt19000005'), movie('Cancel First','tt19000006'), movie('Cancel Second','tt19000007'),
  movie('Lost Poster','tt19000008', {Poster:poster('missing')}),
  movie('Disk First','tt19000009'), movie('Disk Second','tt19000010'),
  ...Object.values(parents),
  episode(parents.lantern,1,1,'First Light','tt19000201'),
  episode(parents.lantern,2,1,'Homeward','tt19000202'),
  episode(parents.remake,1,1,'Different Beginning','tt19000203'),
  episode(parents.clock,2,1,'First Signal','tt19000211'),
  episode(parents.clock,2,2,'Second Signal','tt19000212'),
  episode(parents.clock,2,3,'Third Signal','tt19000213'),
  episode(parents.quiet,1,1,'Landing','tt19000221'),
  episode(parents.mirror,1,1,'Opening','tt19000231'), episode(parents.mirror,1,2,'Crossing','tt19000232'),
  episode(parents.mirrorOther,1,1,'Another Opening','tt19000241'),
  episode(parents.mirrorOther,1,2,'Another Crossing','tt19000242')
];
const normalize = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g,'');
function catalog(query) {
  const name = query.s || query.t;
  if (/Invalid Key/i.test(name || '')) return {Response:'False',Error:'Invalid API key!'};
  if (/Quota Orbit/i.test(name || '')) return {Response:'False',Error:'Request limit reached!'};
  if (/Timeout Orbit/i.test(name || '')) throw Object.assign(new Error('Fixture timeout'),{code:'ETIMEDOUT'});
  // Exact-title lookup is unavailable here; search exposes two equally plausible
  // identities. Returning either one from `t` would bypass this ambiguity case.
  if (query.t && normalize(query.t) === normalize('Shared Horizon')) return copy(missing);
  let found = records.filter(record => query.i ? record.imdbID === query.i : normalize(record.Title) === normalize(name));
  if (query.type) found = found.filter(record => record.Type === query.type);
  if (query.y) found = found.filter(record => record.Year.startsWith(query.y));
  if (query.Season) {
    const parent = found.find(record => record.Type === 'series');
    const episodes = parent ? records.filter(record => record.seriesID === parent.imdbID && record.Season === query.Season) : [];
    if (query.Episode) return copy(episodes.find(record => record.Episode === query.Episode) || missing);
    return episodes.length ? {Response:'True', Title:parent.Title, Season:query.Season, totalSeasons:parent.totalSeasons,
      Episodes:episodes.map(record => ({Title:record.Title, Episode:record.Episode, imdbID:record.imdbID, Released:'2001-01-01'}))} : copy(missing);
  }
  if (query.s) return found.length && (!query.page || query.page === '1') ?
    {Response:'True',Search:copy(found),totalResults:String(found.length)} : copy(missing);
  return copy(found[0] || missing);
}
const show = (seriesName, season, number, title = `${seriesName} S0${season}E0${number}`, extra = {}) =>
  ({kind:'show',series:seriesName,season:String(season),episode:String(number),title,year:'',duration:2700,...extra});
const definitions = {
  movies:[{title:'Lunar Archive'},{title:'Shared Horizon'},{title:'No Such Catalog Movie'}],
  'episode-parents':[
    show('Lantern Harbor',1,1), show('Lantern Harbor',2,1,'Homeward'), show('Quiet Planet',1,9)],
  'episode-numbering':[
    show('Clockwork Vale',1,1,'First Signal'), show('Clockwork Vale',1,2,'Second Signal'), show('Clockwork Vale',1,3)],
  manual:[{title:'Paper Comet'}, show('Quiet Planet',1,1,'Landing')],
  batch:[{title:'Batch Alpha',cast:['Common Cast','Alpha Cast'],tags:['common','alpha'],country:'Alpha',savedArt:true},
    {title:'Batch Beta',cast:['Common Cast','Beta Cast'],tags:['common','beta'],country:'Beta',savedArt:true},
    {title:'Untouched Control',new:false}],
  selected:[show('Mirror Bay',1,1),show('Mirror Bay',1,2),{title:'Untouched Control',new:false}],
  concurrency:[{title:'Held Orbit'},{title:'Untouched Control',new:false}],
  failures:[{title:'Invalid Key'},{title:'Quota Orbit'},{title:'Timeout Orbit'},{title:'Lost Poster'}],
  cancel:[{title:'Cancel First'},{title:'Cancel Second'}],
  'disk-full':[{title:'Disk First'},{title:'Disk Second'}],
  live:[{title:'The Matrix',year:1999,duration:8160},
    {title:'Arrival',year:2016,duration:6960,new:false},
    show('Breaking Bad',1,1,'Pilot',{seriesImdbID:'tt0903747',new:false}),
    show('Breaking Bad',1,2,"Cat's in the Bag...",{seriesImdbID:'tt0903747',new:false})]
};
function videos(scenario, directory) {
  if (!definitions[scenario]) throw new Error('Unknown tagging scenario: ' + scenario);
  return definitions[scenario].map((definition,index) => {
    const {duration = 7200, savedArt, ...fields} = definition;
    const name = `${scenario}-${index}`;
    return {id:id(name),title:'',year:2001,kind:'movie',series:'',season:'',episode:'',imdbID:'',seriesImdbID:'',
      director:'Original Director',directorsort:'Director, Original',cast:[],description:'Original description',
      genre:'Original',tags:['personal'],seen:true,new:true,watchlater:true,position:42,
      ratings:{user:4,imdb:'',rt:'',mc:''},dateadded:1700000000+index,lastseen:'',
      filename:path.join(directory,`${index}-${definition.title}.mkv`),duplicates:[],artwork:'',subtitles:[],
      boxoffice:'',rated:'',languages:['English'],country:'Original country',
      metadata:{checked:true,video_stream_checked:true,duration,width:1920,height:1080,codec:'h264'},
      autotag_tried:false,dvd:false,...copy(fields)};
  });
}
function seed(scenario, directory, image) {
  fs.mkdirSync(directory,{recursive:true});
  const entries = videos(scenario,directory);
  entries.forEach((video,index) => {
    fs.writeFileSync(video.filename,'Disposable tagging fixture ' + video.id);
    if (definitions[scenario][index].savedArt) {
      video.artwork = path.join(directory,`${index}-original.png`);
      fs.copyFileSync(image,video.artwork);
    }
  });
  return entries;
}
module.exports = {id,records,parents,catalog,definitions,videos,seed,missing,copy};
