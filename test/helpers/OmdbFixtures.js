const path = require('path');
const {loadFreshWithMocks} = require('./ModuleMocks.js');
const {videoFixture} = require('./Fixtures.js');
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
  const api = loadFreshWithMocks(options.modulePath || path.join(__dirname,'../../src/tagging/OmdbHelper.js'), {
    '../../omdb':{key:'fixture-only'}, axios,
    electron:{app:{getPath:() => '/unused-fixture-user-data'}, ipcRenderer:{}},
    '../platform/Logger.js':{child:() => logger},
    './EpisodeRuntime.js':{withEpisodeDuration:options.readDuration || (async video => video)},
    '../platform/download':{download:(url, destination, callback) => {
      downloads.push(url);
      if (options.download) return options.download(url,destination,callback);
      callback({path:destination});
    }}
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

module.exports = {SERIES, notFound, show, series, episode, loadSearch, catalog};
