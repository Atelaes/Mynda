// Parent identity belongs to a physical series collection. Episode order
// belongs to a season within one directory/release. Neither scope can turn a
// generated title or a dependent recovery into independent identity evidence.
const Match = require('./EpisodeMatch');
const {copy} = require('./TaggingEvidence');
const {normalizeEpisodeNumber,validSeriesImdbID} = require('./CatalogResponse');
const {scopeFor} = require('./SeriesCollection');
const {profileFor} = require('./SeriesStructure');

const directoryKey = video => {const scope = scopeFor(video); return scope && scope.directoryKey;};
const sorted = anchors => copy(anchors).sort((a,b) => {
  const left = JSON.stringify(a), right = JSON.stringify(b);
  return left < right ? -1 : left > right ? 1 : 0;
});

function createEvidence(videos = []) {
  const collections = new Map(), directories = new Map();
  function collection(scope) {
    if (!collections.has(scope.key)) collections.set(scope.key,{anchors:[],parents:new Set(),years:new Set(),members:[]});
    return collections.get(scope.key);
  }
  // Inspect declarations before processing starts, including records that may
  // fail lookup later. Conflict handling must not depend on enumeration order.
  for (const video of videos) {
    const scope = scopeFor(video);
    if (!scope) continue;
    const group = collection(scope);
    group.members.push(video);
    if (validSeriesImdbID(video.seriesImdbID)) group.parents.add(video.seriesImdbID.trim());
    scope.years.forEach(year => group.years.add(year));
  }

  function observe(video, result) {
    if (!result || result.status !== 'matched') return;
    const tagged = result.video, detail = result.evidence;
    const scope = scopeFor(video);
    if (!tagged || !scope || (detail && detail.kind !== 'episode')) return;
    const parent = tagged.seriesImdbID;
    if (!validSeriesImdbID(parent) || !/^tt\d+$/.test(tagged.imdbID || '')) return;
    const group = collection(scope);
    group.parents.add(parent);
    scope.years.forEach(year => group.years.add(year));
    const parentEvidence = detail && detail.parentEvidence || {};
    if (parentEvidence.catalogYear) group.years.add(parentEvidence.catalogYear);
    const original = detail && detail.original || video;
    const title = Match.usefulEpisodeTitle(original.title,original.series,{dvd:Boolean(original.dvd)});
    const comparison = Match.episodeTitleComparison(title,tagged.title,original.series);
    if (!title || !comparison.matched) return;
    const requested = detail && detail.requested || {season:video.season,episode:video.episode};
    const matched = detail && detail.matched || requested;
    const anchor = {
      parent,id:tagged.imdbID,videoID:video.id,filename:video.filename,
      originalTitle:original.title,catalogTitle:tagged.title,titleComparison:comparison,
      localSeason:normalizeEpisodeNumber(requested.season),
      localEpisode:normalizeEpisodeNumber(requested.episode),
      catalogSeason:normalizeEpisodeNumber(matched.season),
      catalogEpisode:normalizeEpisodeNumber(matched.episode)
    };
    if (Object.values(anchor).some(value => value === null)) return;
    if (!directories.has(scope.directoryKey)) directories.set(scope.directoryKey,[]);
    const add = list => {if (!list.some(item => JSON.stringify(item) === JSON.stringify(anchor))) list.push(anchor);};
    add(directories.get(scope.directoryKey));
    // A recovered named episode may verify local numbering, but its inherited
    // parent cannot become a new independent witness for collection identity.
    if (!['siblings-series-selection','batch-series-selection','structure-series-selection'].includes(parentEvidence.basis)) add(group.anchors);
  }

  function parentFor(video, failure) {
    if (!canRetry(failure)) return null;
    if (Match.assessEpisodeTitle(video.title,'Episode #0.0',video.series).state === 'contradiction') return null;
    const scope = scopeFor(video);
    const group = scope && collections.get(scope.key);
    if (!group || !group.anchors.length || group.parents.size !== 1 || group.years.size > 1) return null;
    const parent = [...group.parents][0];
    if (video.seriesImdbID && video.seriesImdbID.trim() !== parent) return null;
    const choices = Array.isArray(failure.choices) ? failure.choices : [];
    const selected = choices.find(choice => choice.imdbID === parent);
    if (choices.length && !selected) return null;
    const candidateYear = selected && String(selected.Year || '').match(/^(?:19|20)\d{2}/);
    const knownYears = new Set([...group.years,...(candidateYear ? [candidateYear[0]] : [])]);
    if (knownYears.size > 1 || scope.years.some(year => !knownYears.has(year))) return null;
    return {seriesID:parent,evidence:sorted(group.anchors)};
  }

  function anchorsFor(video, result) {
    const {evidence} = result.candidate;
    if (evidence.kind !== 'episode') return [];
    return sorted((directories.get(directoryKey(video)) || [])
      .filter(anchor => anchor.localSeason === normalizeEpisodeNumber(evidence.requested.season)));
  }
  function structureGroups(pending) {
    const groups=new Map();
    for (const item of pending) {
      if (item.parent || !canRetry(item.result) || !Array.isArray(item.result.choices) || item.result.choices.length < 2) continue;
      const scope=scopeFor(item.video), group=scope && collections.get(scope.key);
      // Counts cannot overrule conflicting independently named episodes or
      // contradict explicit declarations, including failed input records.
      if (!group || group.anchors.length || group.parents.size > 1 || group.years.size > 1) continue;
      if (!groups.has(scope.key)) {
        const profile=profileFor(group.members);
        if (!profile) continue;
        groups.set(scope.key,{profile,pending:[]});
      }
      groups.get(scope.key).pending.push(item);
    }
    return [...groups.values()].sort((a,b)=>a.profile.key.localeCompare(b.profile.key));
  }
  return {observe,parentFor,anchorsFor,structureGroups};
}

function canRetry(result) {
  return result && ['ambiguous','unmatched'].includes(result.status) && result.reason &&
    ['ambiguous-series','unconfirmed-series'].includes(result.reason.code);
}
module.exports = {createEvidence,directoryKey,canRetry};
