const CatalogIdentity = require('./CatalogIdentity');
// Shared direct lookup and season-list/record-ID fallback for every episode path.
const {validImdbID,normalizeEpisodeNumber,requestFailure,episodeResponseMatches} = require('./CatalogResponse');
const {summarizeCatalogResponse} = require('./TaggingDiagnostics');
const {episodeTitlesMatch} = require('./EpisodeMatch');
function createEpisodeLookup({log,requestCatalog,createCatalogQuery}) {
  function seasonEpisodeIndexKey(seriesID, season) {
    return `${seriesID}|${season}`;
  }

  async function getSeasonEpisodeIndex(seriesID, season, context) {
    const seasonEpisodeIndexCache = context.seriesSession.episodeIndexes;
    const cacheKey = seasonEpisodeIndexKey(seriesID, season);
    if (seasonEpisodeIndexCache.has(cacheKey)) {
      const cachedIndex = seasonEpisodeIndexCache.get(cacheKey);
      log.debug('Using cached catalog season episode index', {
        searchID: context.searchID,
        seriesID: seriesID,
        season: season,
        episodeCount: cachedIndex.size
      });
      return {success: true, data: cachedIndex};
    }

    const response = await requestCatalog(createCatalogQuery({
      id: seriesID,
      season: season
    }), {...context, searchID: context.searchID, stage: 'season episode index fallback'});
    const failure = requestFailure(response);
    if (failure) {
      if (failure.failure === 'No results') {
        const emptyIndex = new Map();
        seasonEpisodeIndexCache.set(cacheKey, emptyIndex);
        log.debug('The catalog had no season episode index for fallback', {
          searchID: context.searchID,
          seriesID: seriesID,
          season: season
        });
        return {success: true, data: emptyIndex};
      }
      return {success: false, requestFailure: failure};
    }

    const seasonData = response.data;
    if (!seasonData || normalizeEpisodeNumber(seasonData.Season) !== season ||
        !Array.isArray(seasonData.Episodes)) {
      log.warn('The catalog season episode index did not match the fallback request', {
        searchID: context.searchID,
        expected: {seriesID: seriesID, season: season},
        received: summarizeCatalogResponse(response)
      });
      return {success: false, outcome:'invalid-record'};
    }

    const episodeIndex = new Map();
    episodeIndex.titles = new Map();
    const ambiguousEpisodes = new Set();
    let unusableEntries = 0;
    for (const listedEpisode of seasonData.Episodes) {
      const listedNumber = normalizeEpisodeNumber(listedEpisode && listedEpisode.Episode);
      const listedRecordID = listedEpisode && typeof CatalogIdentity.recordKey(listedEpisode) === 'string' ?
        CatalogIdentity.recordKey(listedEpisode).trim() : '';
      if (listedNumber === null || !CatalogIdentity.valid(listedRecordID)) {
        unusableEntries++;
        continue;
      }
      if (ambiguousEpisodes.has(listedNumber)) {
        continue;
      }
      if (episodeIndex.has(listedNumber) && episodeIndex.get(listedNumber) !== listedRecordID) {
        episodeIndex.delete(listedNumber);
        ambiguousEpisodes.add(listedNumber);
        continue;
      }
      episodeIndex.set(listedNumber, listedRecordID);
      episodeIndex.titles.set(listedNumber,listedEpisode.Title);
    }
    episodeIndex.complete = !unusableEntries && !ambiguousEpisodes.size &&
      seasonData.catalogCompleteness !== 'partial' && seasonData.catalogCompleteness !== 'unknown';

    seasonEpisodeIndexCache.set(cacheKey, episodeIndex);
    log.debug('Cached catalog season episode index for fallback', {
      searchID: context.searchID,
      seriesID: seriesID,
      season: season,
      listedEpisodeCount: seasonData.Episodes.length,
      usableEpisodeCount: episodeIndex.size,
      unusableEntryCount: unusableEntries,
      ambiguousEpisodes: Array.from(ambiguousEpisodes)
    });
    return {success: true, data: episodeIndex};
  }

  async function findEpisodeViaSeasonIndex(seriesID, season, episode, context) {
    const indexResult = await getSeasonEpisodeIndex(seriesID, season, context);
    if (!indexResult.success) {
      return indexResult;
    }

    const episodeRecordID = indexResult.data.get(episode);
    if (!episodeRecordID) {
      log.debug('The catalog season episode index did not contain the requested episode', {
        searchID: context.searchID,
        seriesID: seriesID,
        season: season,
        episode: episode
      });
      return {success: false, ...(episode === '0' && indexResult.data.complete && indexResult.data.has('1') ?
        {numberingConflict:{basis:'catalog-has-no-episode-zero',seriesID,season,catalogPositions:[...indexResult.data.keys()]}} : {})};
    }

    const response = await requestCatalog(createCatalogQuery({id: episodeRecordID}), {...context,
      searchID: context.searchID,
      stage: 'season index exact episode fallback'
    });
    const failure = requestFailure(response);
    if (failure) {
      return {success: false, requestFailure: failure};
    }

    const episodeData = response.data;
    if (!episodeResponseMatches(episodeData, seriesID, season, episode) ||
        !CatalogIdentity.matchesParent(episodeData,seriesID) || !CatalogIdentity.matchesRecord(episodeData,episodeRecordID)) {
      log.warn('The catalog season-index episode did not match the fallback request', {
        searchID: context.searchID,
        seasonIndexRecordID: episodeRecordID,
        expected: {seriesID: seriesID, season: season, episode: episode},
        received: summarizeCatalogResponse(response)
      });
      return {success: false, outcome:'invalid-record',
        rejectedRecord:episodeData && {...CatalogIdentity.recordFields(episodeData),Title:episodeData.Title}};
    }

    log.info('Recovered episode through catalog season index fallback', {
      searchID: context.searchID,
      seriesID: seriesID,
      season: season,
      episode: episode,
      recordID: CatalogIdentity.recordKey(episodeData),
      title: episodeData.Title
    });
    return {success: true, data: episodeData};
  }

  async function lookup(seriesID, season, episode, context, stage = 'episode lookup') {
    const response = await requestCatalog(createCatalogQuery({id:seriesID,season,episode}),{...context,stage});
    const failure = requestFailure(response);
    if (!failure) return {success:true,data:response.data,via:'direct'};
    if (failure.failure !== 'No results') return {success:false,requestFailure:failure,via:'direct'};
    const indexed = await findEpisodeViaSeasonIndex(seriesID,season,episode,context);
    if (indexed.success) return {...indexed,via:'season-list'};
    return {...indexed,success:false,requestFailure:indexed.requestFailure || failure,via:'season-list'};
  }
  async function findByTitle(seriesID, season, title, context) {
    const index = await getSeasonEpisodeIndex(seriesID,season,context);
    if (!index.success) return index;
    // An incomplete list cannot prove that a title occurs only once. Full
    // records must independently confirm the selected parent and position.
    if (!index.data.complete || !index.data.titles) return {success:false};
    const series = context.originalInput && context.originalInput.series;
    const matches = [...index.data].filter(([number])=>episodeTitlesMatch(title,index.data.titles.get(number),series));
    if (matches.length !== 1) return {success:false};
    const number = matches[0][0];
    const result = await findEpisodeViaSeasonIndex(seriesID,season,number,context);
    if (!result.success || !episodeTitlesMatch(title,result.data.Title,series)) return {...result,success:false};
    return {...result,episode:number,via:'complete-season-title'};
  }
  return {lookup,findByTitle};
}
module.exports = {createEpisodeLookup};
