// A numbering convention is local to a release directory and local season.
// Only independent, accepted exact-title observations may establish it.
const {scopeFor} = require('./SeriesCollection');
const Match = require('./EpisodeMatch');
const {normalizeEpisodeNumber,validImdbID} = require('./CatalogResponse');
const {copy} = require('./TaggingEvidence');
const Limits = require('./TaggingLimits');

function assess(video, seriesID, anchors = [], requested = video) {
  const scope = scopeFor(video), season = normalizeEpisodeNumber(requested.season);
  const required = Limits.episode.offsetWitnesses;
  const result = {state:'insufficient',required,seriesID,localSeason:season,
    directoryKey:scope && scope.directoryKey,support:[]};
  if (!scope || season === null || !validImdbID(seriesID)) return result;
  const witnesses = anchors.filter(a => a.independentNumbering && a.directoryKey === scope.directoryKey &&
    a.localSeason === season && a.videoID !== video.id && a.filename !== video.filename &&
    validImdbID(a.id) && Match.episodeTitleComparison(a.originalTitle,a.catalogTitle,video.series).matched);
  result.support = copy(witnesses).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (!witnesses.length) return result;
  const values = witnesses.map(a => [a.localSeason,a.localEpisode,a.catalogSeason,a.catalogEpisode]
    .map(n => normalizeEpisodeNumber(n) === null ? NaN : Number(n)));
  if (witnesses.some(a => a.parent !== seriesID) || values.some(row=>row.some(n=>!Number.isSafeInteger(n)))) {
    return {...result,state:'conflicting',reason:'Sibling records disagree about the series or contain invalid numbering'};
  }
  const positions=new Map(), records=new Map();
  for (const a of witnesses) {
    const local=`${a.localSeason}|${a.localEpisode}`;
    if ((positions.has(local) && positions.get(local) !== a.id) ||
        (records.has(a.id) && records.get(a.id) !== local)) return {
      ...result,state:'conflicting',reason:'Sibling records do not provide a one-to-one episode mapping'};
    positions.set(local,a.id);records.set(a.id,local);
  }
  const offsets = values.map(([ls,le,cs,ce])=>[cs-ls,ce-le]);
  if (new Set(offsets.map(value=>JSON.stringify(value))).size !== 1) return {
    ...result,state:'conflicting',reason:'Exact-title siblings use different numbering offsets'};
  // A duplicated episode, record, file or local position supplies no second vote.
  if (Math.min(...['id','videoID','filename','localEpisode'].map(key=>new Set(witnesses.map(a=>a[key])).size)) < required) return result;
  const [seasonOffset,episodeOffset] = offsets[0];
  return {...result,state:'established',seasonOffset,episodeOffset};
}

function translated(mapping, requested) {
  if (!mapping || mapping.state !== 'established' ||
      normalizeEpisodeNumber(requested.season) !== mapping.localSeason) return null;
  const episode = normalizeEpisodeNumber(requested.episode);
  if (episode === null) return null;
  const season = Number(mapping.localSeason)+mapping.seasonOffset, number = Number(episode)+mapping.episodeOffset;
  if (![season,number].every(n=>Number.isSafeInteger(n) && n>=0)) return null;
  return {season:String(season),episode:String(number)};
}

module.exports = {assess,translated};
