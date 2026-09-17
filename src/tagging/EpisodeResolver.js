const Response = require('./CatalogResponse');
const {validImdbID, validSeriesImdbID, normalizeEpisodeNumber, predictableFailure, requestFailure, episodeResponseMatches} = Response;
const {summarizeError, summarizeOMDbResponse} = require('./TaggingDiagnostics');
const Identity = require('./SeriesIdentity');
const {seriesSearchPartsForVideo, seriesCacheKey, seriesTitlesMatch, localEpisodeTitleForVerification, seriesYearMatches, canInferSingleSeason} = Identity;

const EpisodeMatch = require('./EpisodeMatch');
const {episodeTitlesMatch} = EpisodeMatch;

const MatchPolicy = require('./MatchPolicy');
const Decision = require('./TaggingDecision');
const Evidence = require('./TaggingEvidence');
const Limits = require('./TaggingLimits');
function createEpisodeResolver({log, pollOMDB, createURLParts, resolveSeries, withEpisodeDuration}) {
  function seasonEpisodeIndexKey(seriesID, season) {
    return `${seriesID}|${season}`;
  }

  async function getSeasonEpisodeIndex(seriesID, season, context) {
    const seasonEpisodeIndexCache = context.seriesSession.episodeIndexes;
    const cacheKey = seasonEpisodeIndexKey(seriesID, season);
    if (seasonEpisodeIndexCache.has(cacheKey)) {
      const cachedIndex = seasonEpisodeIndexCache.get(cacheKey);
      log.debug('Using cached OMDb season episode index', {
        searchID: context.searchID,
        seriesID: seriesID,
        season: season,
        episodeCount: cachedIndex.size
      });
      return {success: true, data: cachedIndex};
    }

    const response = await pollOMDB(createURLParts({
      id: seriesID,
      season: season
    }), {...context, searchID: context.searchID, stage: 'season episode index fallback'});
    const failure = requestFailure(response);
    if (failure) {
      if (failure.failure === 'No results') {
        const emptyIndex = new Map();
        seasonEpisodeIndexCache.set(cacheKey, emptyIndex);
        log.debug('OMDb had no season episode index for fallback', {
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
      log.warn('OMDb season episode index did not match the fallback request', {
        searchID: context.searchID,
        expected: {seriesID: seriesID, season: season},
        received: summarizeOMDbResponse(response)
      });
      return {success: false};
    }

    const episodeIndex = new Map();
    const ambiguousEpisodes = new Set();
    let unusableEntries = 0;
    for (const listedEpisode of seasonData.Episodes) {
      const listedNumber = normalizeEpisodeNumber(listedEpisode && listedEpisode.Episode);
      const listedImdbID = listedEpisode && typeof listedEpisode.imdbID === 'string' ?
        listedEpisode.imdbID.trim() : '';
      if (listedNumber === null || !validImdbID(listedImdbID)) {
        unusableEntries++;
        continue;
      }
      if (ambiguousEpisodes.has(listedNumber)) {
        continue;
      }
      if (episodeIndex.has(listedNumber) && episodeIndex.get(listedNumber) !== listedImdbID) {
        episodeIndex.delete(listedNumber);
        ambiguousEpisodes.add(listedNumber);
        continue;
      }
      episodeIndex.set(listedNumber, listedImdbID);
    }

    seasonEpisodeIndexCache.set(cacheKey, episodeIndex);
    log.debug('Cached OMDb season episode index for fallback', {
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

    const episodeImdbID = indexResult.data.get(episode);
    if (!episodeImdbID) {
      log.debug('OMDb season episode index did not contain the requested episode', {
        searchID: context.searchID,
        seriesID: seriesID,
        season: season,
        episode: episode
      });
      return {success: false};
    }

    const response = await pollOMDB(createURLParts({id: episodeImdbID}), {...context,
      searchID: context.searchID,
      stage: 'season index exact episode fallback'
    });
    const failure = requestFailure(response);
    if (failure) {
      return {success: false, requestFailure: failure};
    }

    const episodeData = response.data;
    if (!episodeResponseMatches(episodeData, seriesID, season, episode) ||
        episodeData.seriesID !== seriesID || episodeData.imdbID !== episodeImdbID) {
      log.warn('OMDb season-index episode did not match the fallback request', {
        searchID: context.searchID,
        seasonIndexImdbID: episodeImdbID,
        expected: {seriesID: seriesID, season: season, episode: episode},
        received: summarizeOMDbResponse(response)
      });
      return {success: false};
    }

    log.info('Recovered episode through OMDb season index fallback', {
      searchID: context.searchID,
      seriesID: seriesID,
      season: season,
      episode: episode,
      imdbID: episodeData.imdbID,
      title: episodeData.Title
    });
    return {success: true, data: episodeData};
  }

  async function findNearbyEpisodeByTitle(seriesID, season, episode, localTitle, context) {
    let episodeNumber = Number(episode);
    const matches=[];
    const accept = match => {
      log.warn('Corrected shifted OMDb episode number using the local title', {
        searchID:context.searchID,localTitle,requested:{season,episode},
        matched:{season,episode:match.episode,distance:match.distance,title:match.data.Title,imdbID:match.data.imdbID}
      });
      return {success:true,data:match.data,episode:match.episode};
    };
    for (let distance of Limits.episode.nearbyDistances) {
      let nearbyEpisodes = [episodeNumber-distance, episodeNumber+distance]
        .filter(number => number >= 0)
        .map(String);

      for (let nearbyEpisode of nearbyEpisodes) {
        let response = await pollOMDB(createURLParts({
          id: seriesID,
          season: season,
          episode: nearbyEpisode
        }), {...context, searchID: context.searchID, stage: 'nearby episode title probe'});
        let failure = requestFailure(response);
        if (failure) {
          if (failure.failure !== 'No results') {
            return {success: false, requestFailure: failure};
          }
          continue;
        }

        if (!episodeResponseMatches(response.data, seriesID, season, nearbyEpisode)) {
          log.warn('Nearby OMDb episode response did not match the probe', {
            searchID: context.searchID,
            expected: {seriesID: seriesID, season: season, episode: nearbyEpisode},
            received: summarizeOMDbResponse(response)
          });
          continue;
        }

        const comparison = EpisodeMatch.episodeTitleComparison(localTitle, response.data.Title, context.originalInput && context.originalInput.series);
        const titleMatches = comparison.matched;
        log.debug('Compared nearby OMDb episode title', {
          searchID: context.searchID,
          localTitle: localTitle,
          omdbTitle: response.data.Title,
          season: season,
          episode: nearbyEpisode,
          distance: distance,
          titleMatches: titleMatches
        });
        if (titleMatches) {
          matches.push({episode: nearbyEpisode, data: response.data, distance, annotations:comparison.annotations});
        }
      }

      if (matches.length > 1) {
        log.warn('More than one nearby OMDb episode matched the local title; retaining normal lookup behavior', {
          searchID: context.searchID,
          localTitle: localTitle,
          requested: {season: season, episode: episode},
          distance: distance,
          matchingEpisodes: matches.map(match => match.episode)
        });
        return {success: false};
      }
      // Removing a catalog annotation can expose a repeated core title. Check
      // the whole existing nearby window before using that core to renumber.
      if (matches.length === 1 && !matches[0].annotations) return accept(matches[0]);
    }
    return matches.length === 1 ? accept(matches[0]) : {success:false};
  }

  function seasonOffsetHintFor(hints, seriesID) {
    if (!(hints instanceof Map)) return null;
    let hint = hints.get(seriesID);
    return hint === -1 || hint === 1 ? hint : null;
  }

  function rememberSeasonOffsetHint(hints, seriesID, offset, context) {
    if (!(hints instanceof Map) || (offset !== -1 && offset !== 1)) return;
    let previousOffset = seasonOffsetHintFor(hints, seriesID);
    hints.set(seriesID, offset);
    if (previousOffset !== offset) {
      log.debug('Remembered title-verified OMDb season offset for this tagging batch', {
        searchID: context.searchID,
        seriesID: seriesID,
        previousOffset: previousOffset,
        seasonOffset: offset
      });
    }
  }

  async function probeAdjacentSeasonEpisodeByTitle(
    seriesID, season, episode, localTitle, offset, context, stage
  ) {
    let adjacentSeasonNumber = Number(season) + offset;
    if (!Number.isInteger(adjacentSeasonNumber) || adjacentSeasonNumber < 0) {
      return {success: false};
    }
    let adjacentSeason = String(adjacentSeasonNumber);
    let response = await pollOMDB(createURLParts({
      id: seriesID,
      season: adjacentSeason,
      episode: episode
    }), {...context, searchID: context.searchID, stage: stage || 'adjacent season title probe'});
    let failure = requestFailure(response);
    if (failure) {
      return failure.failure === 'No results' ?
        {success: false} : {success: false, requestFailure: failure};
    }

    if (!episodeResponseMatches(response.data, seriesID, adjacentSeason, episode) ||
        response.data.seriesID !== seriesID) {
      log.warn('Adjacent-season OMDb episode response did not match the probe', {
        searchID: context.searchID,
        expected: {seriesID: seriesID, season: adjacentSeason, episode: episode},
        received: summarizeOMDbResponse(response)
      });
      return {success: false};
    }

    let titleMatches = episodeTitlesMatch(localTitle, response.data.Title, context.originalInput && context.originalInput.series);
    log.debug('Compared adjacent-season OMDb episode title', {
      searchID: context.searchID,
      localTitle: localTitle,
      omdbTitle: response.data.Title,
      requested: {season: season, episode: episode},
      probed: {season: adjacentSeason, episode: episode},
      seasonOffset: offset,
      titleMatches: titleMatches
    });
    if (!titleMatches) return {success: false};

    return {
      success: true,
      data: response.data,
      season: adjacentSeason,
      episode: episode,
      offset: offset
    };
  }

  async function findAdjacentSeasonEpisodeByTitle(
    seriesID, season, episode, localTitle, context, preferredOffset
  ) {
    let offsets = Limits.episode.adjacentSeasonOffsets.filter(offset => Number(season) + offset >= 0);
    if (offsets.includes(preferredOffset)) offsets.sort((a,b) => (b === preferredOffset) - (a === preferredOffset));
    let matches = [];
    for (let offset of offsets) {
      let candidate = await probeAdjacentSeasonEpisodeByTitle(
        seriesID,
        season,
        episode,
        localTitle,
        offset,
        context,
        'adjacent season title probe'
      );
      if (candidate.requestFailure) return candidate;
      if (candidate.success) matches.push(candidate);
    }

    if (matches.length !== 1) {
      if (matches.length > 1) {
        log.warn('Both adjacent OMDb seasons matched the local episode title; retaining normal lookup behavior', {
          searchID: context.searchID,
          localTitle: localTitle,
          requested: {season: season, episode: episode},
          matchingSeasons: matches.map(match => match.season)
        });
      }
      return {success: false};
    }

    let match = matches[0];
    log.warn('Corrected shifted OMDb season using the local title', {
      searchID: context.searchID,
      localTitle: localTitle,
      requested: {season: season, episode: episode},
      matched: {
        season: match.season,
        episode: match.episode,
        seasonOffset: match.offset,
        title: match.data.Title,
        imdbID: match.data.imdbID
      }
    });
    return match;
  }

  async function inferSingleSeason(video, context, selectedSeriesImdbID, validation) {
    const singleSeasonMetadataCache = context.seriesSession.singleSeasons;
    let seriesResult = validation.seriesResult;
    if (!seriesResult) {
      if (typeof selectedSeriesImdbID !== 'undefined') {
        if (!validSeriesImdbID(selectedSeriesImdbID)) {
          return predictableFailure('Invalid series selection', 'The selected series did not have a valid IMDb ID');
        }
        const parentEvidence = Evidence.selectedParent(video,selectedSeriesImdbID.trim(),context);
        seriesResult = {success:true,data:selectedSeriesImdbID.trim(),
          confidentSeries:parentEvidence.confident,parentEvidence};
      } else {
        seriesResult = await resolveSeries(video, 1, normalizeEpisodeNumber(video.episode),
          localEpisodeTitleForVerification(video), context);
      }
    }
    if (!seriesResult.success) return seriesResult;
    const seriesID = seriesResult.data;
    let metadata = singleSeasonMetadataCache.get(seriesID);
    if (!metadata) {
      const response = await pollOMDB(createURLParts({id: seriesID}), {...context,
        searchID: context.searchID, stage: 'verify missing-season inference'
      });
      const failure = requestFailure(response);
      if (failure) return failure;
      metadata = response.data;
      if (!metadata || metadata.Type !== 'series' || metadata.imdbID !== seriesID ||
          metadata.Response !== 'True') {
        return predictableFailure('Not enough data', 'The parent record could not confirm a missing season');
      }
    }
    if (String(metadata.totalSeasons).trim() !== '1') {
      return predictableFailure('Not enough data', 'A missing season can only be inferred from a confirmed single-season series');
    }
    const parts = seriesSearchPartsForVideo(video);
    const explicitParent = typeof selectedSeriesImdbID !== 'undefined' ||
      (validSeriesImdbID(video.seriesImdbID) && video.seriesImdbID.trim() === seriesID);
    if (!explicitParent && (!seriesTitlesMatch(parts.title, metadata.Title, false) ||
        !seriesYearMatches(parts.year, metadata.Year))) {
      return predictableFailure('Episode mismatch', 'The full parent record did not confirm the series for a missing season');
    }
    // Cache only successful confirmation, not incomplete provider metadata.
    singleSeasonMetadataCache.set(seriesID, metadata);
    log.info('Using verified single season for an unnumbered episode', {
      searchID: context.searchID, series: video.series, seriesID,
      episode: video.episode, inferredSeason: '1'
    });
    return {success: true, seriesResult};
  }

  async function searchShowEpisode(
    video, context, selectedSeriesImdbID, seasonOffsetHints, validation = {}
  ) {
    const seriesIdCache = context.seriesSession.parents;
    if (canInferSingleSeason(video)) {
      const inferred = await inferSingleSeason(video, context, selectedSeriesImdbID, validation);
      if (!inferred.success) return inferred;
      // Only the returned, successfully validated episode receives the inferred
      // season. A failed lookup must leave the caller's original tags untouched.
      return searchShowEpisode({...video, season: '1'}, context, selectedSeriesImdbID,
        seasonOffsetHints, {...validation, seriesResult: inferred.seriesResult});
    }
    let series = typeof video.series === 'string' ? video.series.trim() : '';
    let season = normalizeEpisodeNumber(video.season);
    let episode = normalizeEpisodeNumber(video.episode);

    if (!series || season === null || episode === null) {
      let storedEpisode = String(video.episode).trim();
      let reason;
      if (String(video.season).toLowerCase() === 'extras') {
        reason = 'OMDb does not assign ordinary season and episode numbers to Mynda extras';
      } else if (/^\d+\.[1-9]$/.test(storedEpisode)) {
        reason = `OMDb cannot search for fractional episode ${storedEpisode}. ` +
          'Mynda can store and sort this episode position; tag it individually by entering its exact IMDb ID.';
      } else {
        reason = 'A show needs a series and whole-number season and episode values for auto-tagging';
      }
      log.warn('Show episode lookup does not have usable identifiers', {
        searchID: context.searchID,
        series: series,
        season: video.season,
        episode: video.episode,
        reason: reason
      });
      return predictableFailure('Not enough data', reason);
    }

    // The current title tag can distinguish same-name originals and remakes.
    let localTitle = localEpisodeTitleForVerification(video);
    let seriesResult;
    if (validation.seriesResult) {
      seriesResult = validation.seriesResult;
    } else if (typeof selectedSeriesImdbID !== 'undefined') {
      if (!validSeriesImdbID(String(selectedSeriesImdbID))) {
        return predictableFailure('Invalid series selection', 'The selected series did not have a valid IMDb ID');
      }
      selectedSeriesImdbID = String(selectedSeriesImdbID).trim();
      log.debug('Using caller-selected series for episode lookup', {
        searchID: context.searchID,
        series: series,
        selectedSeriesImdbID: selectedSeriesImdbID
      });
      const parentEvidence = Evidence.selectedParent(video,selectedSeriesImdbID,context);
      seriesResult = {success:true,data:selectedSeriesImdbID,
        confidentSeries:parentEvidence.confident,parentEvidence};
    } else {
      seriesResult = await resolveSeries(video, season, episode, localTitle, context);
    }
    if (!seriesResult.success) {
      return seriesResult;
    }

    let seriesID = seriesResult.data;
    try {
      // OMDb supports Season+Episode with a series IMDb ID. Once a series has
      // been resolved, its ID is cached so every later episode needs one request.
      // If ambiguity was just resolved by episode probes, reuse that full episode
      // response instead of making the same OMDb request twice.
      let episodeData = seriesResult.episodeData;
      let matchedSeason = seriesResult.matchedSeason || season;
      let matchedEpisode = seriesResult.matchedEpisode || episode;
      let lookupFailure = null;

      // A learned offset only orders the adjacent probes after direct lookup
      // and nearby correction fail. It never takes precedence over the requested
      // position, and both adjacent seasons still participate in uniqueness.
      const seasonOffsetHint = seasonOffsetHintFor(seasonOffsetHints,seriesID);

      if (!episodeData) {
        let response = await pollOMDB(createURLParts({
          id: seriesID,
          season: season,
          episode: episode
        }), {...context, searchID: context.searchID, stage: 'episode lookup'});
        lookupFailure = requestFailure(response);
        if (!lookupFailure) {
          episodeData = response.data;
        }
      }

      if (lookupFailure) {
        // OMDb occasionally has a complete episode record but a hole in its
        // direct series+Season+Episode index. Before giving up—or probing nearby
        // episode numbers—ask for this season's cached episode list and retry the
        // requested episode by its exact IMDb ID.
        if (lookupFailure.failure === 'No results') {
          let seasonIndexResult = await findEpisodeViaSeasonIndex(
            seriesID, season, episode, context
          );
          if (seasonIndexResult.success) {
            episodeData = seasonIndexResult.data;
          } else if (seasonIndexResult.requestFailure &&
                     seasonIndexResult.requestFailure.failure !== 'No results') {
            return seasonIndexResult.requestFailure;
          }
        }

        // A missing episode 0 is the common signal for a release whose numbering
        // is shifted by one. Do not broaden the search without a useful current
        // title tag that can verify the nearby result.
        if (!episodeData && lookupFailure.failure === 'No results' && localTitle) {
          let correction = await findNearbyEpisodeByTitle(
            seriesID, season, episode, localTitle, context
          );
          if (correction.requestFailure) {
            return correction.requestFailure;
          }
          if (correction.success) {
            episodeData = correction.data;
            matchedEpisode = correction.episode;
          }
        }

        // A different catalog may count a local season zero as season one and
        // shift every later season by the same amount. Probe only the same
        // episode in the immediately adjacent seasons, and require the local
        // title to uniquely prove the correction.
        if (!episodeData && lookupFailure.failure === 'No results' && localTitle) {
          let seasonCorrection = await findAdjacentSeasonEpisodeByTitle(
            seriesID, season, episode, localTitle, context, seasonOffsetHint
          );
          if (seasonCorrection.requestFailure) {
            return seasonCorrection.requestFailure;
          }
          if (seasonCorrection.success) {
            episodeData = seasonCorrection.data;
            matchedSeason = seasonCorrection.season;
            matchedEpisode = seasonCorrection.episode;
            rememberSeasonOffsetHint(
              seasonOffsetHints,
              seriesID,
              seasonCorrection.offset,
              context
            );
          }
        }
        if (!episodeData) {
          return lookupFailure;
        }
      }

      if (!episodeResponseMatches(
        episodeData, seriesID, matchedSeason, matchedEpisode
      )) {
        log.warn('OMDb episode response did not match the request', {
          searchID: context.searchID,
          expected: {
            seriesID: seriesID,
            season: matchedSeason,
            episode: matchedEpisode
          },
          received: summarizeOMDbResponse({status: 200, data: episodeData})
        });
        return predictableFailure(
          'Episode mismatch',
          `OMDb did not return a valid episode for ${series} S${season}E${episode}`
        );
      }

      // Preserve strict, bounded episode-order corrections. The forgiving check
      // below may accept the requested episode, but cannot select another one.
      let correctionFailure = null;
      if (matchedSeason === season && matchedEpisode === episode && localTitle &&
          !episodeTitlesMatch(localTitle, episodeData.Title, series)) {
        let correction = await findNearbyEpisodeByTitle(
          seriesID, season, episode, localTitle, context
        );
        if (correction.success) {
          episodeData = correction.data;
          matchedEpisode = correction.episode;
        } else {
          let seasonCorrection = await findAdjacentSeasonEpisodeByTitle(
            seriesID, season, episode, localTitle, context, seasonOffsetHint
          );
          if (seasonCorrection.success) {
            episodeData = seasonCorrection.data;
            matchedSeason = seasonCorrection.season;
            matchedEpisode = seasonCorrection.episode;
            rememberSeasonOffsetHint(
              seasonOffsetHints,
              seriesID,
              seasonCorrection.offset,
              context
            );
          } else {
            correctionFailure = correction.requestFailure || seasonCorrection.requestFailure;
            log.debug('No exact title correction found; checking episode plausibility', {
              searchID: context.searchID,
              localTitle: localTitle,
              omdbTitle: episodeData.Title,
              season: season,
              episode: episode,
              nearbyProbeError: summarizeError(correction.requestFailure && correction.requestFailure.data),
              adjacentSeasonProbeError: summarizeError(
                seasonCorrection.requestFailure && seasonCorrection.requestFailure.data
              )
            });
          }
        }
      }

      const titleAssessment = EpisodeMatch.assessEpisodeTitle(localTitle, episodeData.Title, series);
      const cacheKey = seriesCacheKey(seriesSearchPartsForVideo(video),video);
      const rejectMatch = (reason, policyReason) => {
        if (seriesIdCache.get(cacheKey)?.data === seriesID) seriesIdCache.delete(cacheKey);
        log.warn('Rejected implausible episode match', {
          searchID: context.searchID, videoID: video.id, series, seriesID,
          season, episode, localTitle, omdbTitle: episodeData.Title,
          reason, policyReason, titleAssessment
        });
        return {...predictableFailure('Episode mismatch',reason),policyReason,
          evidence:{...evidence,catalogTitle:episodeData.Title,imdbID:episodeData.imdbID}};
      };
      const evidence = {kind:'episode', localTitle, originalTitle:video.title,
        requested:{season,episode}, matched:{season:matchedSeason,episode:matchedEpisode},
        seriesID, titleAssessment, exactTitle:episodeTitlesMatch(localTitle, episodeData.Title, series),
        confidentSeries:Boolean(seriesResult.confidentSeries),
        parentEvidence:seriesResult.parentEvidence || {basis:'catalog-candidate',origin:'automatic',confident:Boolean(seriesResult.confidentSeries)}};
      const titleDecision = MatchPolicy.evaluateEpisode({localTitle, record:episodeData, titleAssessment,
        confidentSeries:evidence.confidentSeries, remoteTitle:EpisodeMatch.usefulEpisodeTitle(episodeData.Title),video});
      if (!titleDecision.accepted) {
        if (correctionFailure) {
          if (seriesIdCache.get(cacheKey)?.data === seriesID) seriesIdCache.delete(cacheKey);
          return correctionFailure;
        }
        return rejectMatch(titleDecision.reason,titleDecision.policyReason);
      }
      const withDuration = await withEpisodeDuration(video, episodeData, context);
      const runtimeAssessment = EpisodeMatch.assessEpisodeRuntime(withDuration, episodeData);
      evidence.runtimeAssessment = runtimeAssessment;
      const decision = MatchPolicy.evaluateEpisode({localTitle, record:episodeData, titleAssessment, runtimeAssessment,
        confidentSeries:evidence.confidentSeries, remoteTitle:EpisodeMatch.usefulEpisodeTitle(episodeData.Title),video});
      if (!decision.accepted) return rejectMatch(decision.reason,decision.policyReason);
      log.debug('Episode match passed sanity checks', {
        searchID: context.searchID, titleAssessment, runtimeAssessment
      });
      if (!validation.speculative) {
        // Reuse the original parent decision, including its confidence and
        // order requirements. A cache hit must not change acceptance policy.
        seriesIdCache.set(cacheKey,{data:seriesID,
          confidentSeries:Boolean(seriesResult.confidentSeries),
          parentEvidence:evidence.parentEvidence});
        if (seriesResult.discovery) {
          const recovered = {storedSeries:series, seriesImdbID:seriesID};
          if (context.seriesSession) context.seriesSession.recovered.set(cacheKey, recovered);
          log.info('Recovered series through fallback discovery', {...recovered,
            searchID:context.searchID, episodeTitle:episodeData.Title,
            localSeason:season, localEpisode:episode});
        }
      }
      if (validation.validateOnly) return {success:true, data:seriesID, episodeData,
        matchedSeason, matchedEpisode, evidence, exactTitle:evidence.exactTitle};

      return Decision.candidate(withDuration, episodeData, evidence);
    } catch(err) {
      log.error('Episode lookup request failed', {
        searchID: context.searchID,
        series: series,
        season: season,
        episode: episode,
        error: summarizeError(err)
      });
      return {success: false, failure: 'Error', data: err};
    }
  }
  return {resolve: searchShowEpisode};
}

module.exports = {createEpisodeResolver};
