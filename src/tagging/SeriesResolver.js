const Response = require('./CatalogResponse');
const {validSeriesImdbID, normalizeEpisodeNumber, predictableFailure, requestFailure, episodeResponseMatches} = Response;
const {summarizeVideo, summarizeError} = require('./TaggingDiagnostics');
const Identity = require('./SeriesIdentity');
const {seriesSearchPartsForVideo, andAmpersandTitleAlternates, terminalAcronymSearchPrefix, seriesCacheKey, seriesTitlesMatch, localEpisodeTitleForVerification, seriesYearMatches, matchingSeriesResults, ambiguousSeriesFailure, canInferSingleSeason} = Identity;
const SeriesSearch = require('./SeriesSearch');
const Evidence = require('./TaggingEvidence');
const Limits = require('./TaggingLimits');

const EpisodeMatch = require('./EpisodeMatch');
const {episodeTitlesMatch} = EpisodeMatch;

function createSeriesResolver({log, pollOMDB, createURLParts, searchShowEpisode}) {

  async function disambiguateSeriesByEpisode(candidates, season, episode, localTitle, context, video) {
    let episodeMatches = [];
    for (let candidate of candidates) {
      let response = await pollOMDB(createURLParts({
        id: candidate.imdbID,
        season: season,
        episode: episode
      }), {...context,
        searchID: context.searchID,
        stage: 'series disambiguation episode probe'
      });
      let failure = requestFailure(response);
      if (!failure && episodeResponseMatches(response.data, candidate.imdbID, season, episode)) {
        episodeMatches.push({
          candidate: candidate,
          episodeData: response.data,
          titleMatches: localTitle ? episodeTitlesMatch(localTitle, response.data.Title, video.series) : null
        });
      } else if (failure && failure.failure !== 'No results') {
        return {success: false, requestFailure: failure};
      }
    }

    log.debug('Episode probes evaluated ambiguous series', {
      searchID: context.searchID,
      season: season,
      episode: episode,
      localTitle: localTitle,
      matchingCandidates: episodeMatches.map(match => ({
        title: match.candidate.Title,
        year: match.candidate.Year,
        imdbID: match.candidate.imdbID,
        episodeTitle: match.episodeData.Title,
        episodeTitleMatches: match.titleMatches
      }))
    });

    // A useful title tag is stronger evidence
    // than episode existence. Kung Fu S1E6 exposed why: OMDb temporarily returned
    // no episode for the 1972 series and "Rage" for the 2021 series, while the
    // local title was "The Soul Is the Warrior". Existence alone selected and
    // cached the remake; a clear title disagreement must instead stay ambiguous.
    let decisiveMatches = localTitle ?
      episodeMatches.filter(match => match.titleMatches) : [];
    // A title that already proved an adjacent-number correction must be usable
    // while choosing between same-name series too. No fuzzy title can authorize
    // this choice, and no speculative candidate may seed the series cache.
    if (localTitle && decisiveMatches.length === 0 && video && candidates.length <= SeriesSearch.MAX_CANDIDATES) {
      for (const candidate of candidates) {
        const direct = episodeMatches.find(match=>match.candidate.imdbID === candidate.imdbID);
        const check = await searchShowEpisode(video, context, undefined, undefined, {
          seriesResult:{success:true, data:candidate.imdbID, confidentSeries:false,
            episodeData:direct && direct.episodeData}, validateOnly:true, speculative:true
        });
        if (!check.success && !check.permanentFailure) return {success:false, requestFailure:check};
        if (check.success && check.exactTitle && check.episodeData.seriesID === candidate.imdbID) {
          decisiveMatches.push({candidate, episodeData:check.episodeData,
            matchedSeason:check.matchedSeason, matchedEpisode:check.matchedEpisode});
        }
      }
    }
    if (decisiveMatches.length === 1) {
      return {
        success: true,
        candidate: decisiveMatches[0].candidate,
        episodeData: decisiveMatches[0].episodeData,
        matchedSeason:decisiveMatches[0].matchedSeason,
        matchedEpisode:decisiveMatches[0].matchedEpisode
      };
    }
    return {
      success: false,
      // If more than one title agrees, narrow the choices to those matches. If
      // no title agrees, keep every original candidate available for a manual
      // decision—including one whose episode endpoint may simply be incomplete.
      candidates: decisiveMatches.length > 1 ?
        decisiveMatches.map(match => match.candidate) : candidates
    };
  }

  async function pollSeriesOMDB(parts, context, details = {}) {
    const session = context.seriesSession;
    const key = JSON.stringify(parts);
    const traceIndex = context.requestTrace.length;
    // CatalogClient owns response reuse. Count the actual request observation,
    // including cache eviction, rather than treating a remembered query as a hit.
    const pending = pollOMDB(createURLParts(parts),{...context,stage:details.stage});
    const observation = context.requestTrace[traceIndex];
    const reused = observation.reused;
    if (reused) session.reused++;
    else if (observation.issued) {
      session.requests++;
      if (details.fallback) session.fallbackRequests++;
    }
    let response;
    try {
      response = await pending;
    } catch (error) {
      if (session) session.queries.delete(key);
      if (context.seriesTrace) context.seriesTrace.push({query:parts, stage:details.stage, failure:'Error'});
      throw error;
    }
    const failure = requestFailure(response);
    const data = response && response.data;
    const cacheable = failure ? failure.failure === 'No results' :
      data && (Array.isArray(data.Search) || (data.Type === 'series' && validSeriesImdbID(data.imdbID)));
    if (session) {
      if (cacheable) session.queries.set(key, true);
      else session.queries.delete(key);
    }
    if (context.seriesTrace) context.seriesTrace.push({
      query:parts, reused:Boolean(reused), stage:details.stage,
      failure:failure && failure.failure, totalResults:data && data.totalResults,
      returned:(data && Array.isArray(data.Search) ? data.Search : data && data.Type ? [data] : [])
        .slice(0, 10).map(row => ({title:row.Title, year:row.Year, type:row.Type, imdbID:row.imdbID}))
    });
    return response;
  }

  async function resolveSeries(video, season, episode, localTitle, context, options = {}) {
    const traced = {...context, seriesTrace:[]};
    let result = await resolveSeriesPrimary(video, season, episode, localTitle, traced, options);
    const parts = seriesSearchPartsForVideo(video);
    if (!result.success && (result.failure === 'No results' || result.seriesDiscoveryExhausted)) {
      try {
        const recovered = await discoverSeries(video, season, episode, localTitle, parts, traced);
        if (recovered) result = recovered;
      } catch (error) {
        result = {success:false, failure:'Error', data:error};
      }
    }
    if (traced.seriesTrace.length) {
      const reportKey = JSON.stringify([parts.title, parts.year, result.success,
        result.success ? result.data : result.failure]);
      const session = context.seriesSession;
      if (!session || !session.logged.has(reportKey)) {
        if (session) session.logged.add(reportKey);
        log.info('Series discovery diagnostics', {
          searchID:context.searchID, storedSeries:video.series,
          requestedYear:parts.year, yearSource:parts.yearSource,
          representative:{title:video.title, season:video.season, episode:video.episode},
          queries:traced.seriesTrace, success:result.success,
          seriesImdbID:result.success ? result.data : undefined,
          failure:result.failure, fallback:Boolean(result.discovery)
        });
      }
    }
    if (result.success) {
      const catalogYears = [...new Set(traced.seriesTrace.flatMap(trace => trace.returned || [])
        .filter(row => row.imdbID === result.data).map(row => String(row.year || '').match(/^(?:19|20)\d{2}/))
        .filter(Boolean).map(match => match[0]))];
      result.parentEvidence = {...result.parentEvidence,
        ...(catalogYears.length === 1 ? {catalogYear:catalogYears[0]} : {}),
        origin:result.parentEvidence && result.parentEvidence.origin || 'automatic',
        seriesID:result.data};
      if (!result.parentEvidence.support) {
        result.parentEvidence.support = [{input:Evidence.snapshot(video),
          queries:Evidence.copy(traced.seriesTrace),
          ...(result.episodeData ? {episode:Evidence.witness(video,result.episodeData,
            {season,episode},{season:result.matchedSeason || season,episode:result.matchedEpisode || episode})} : {})}];
      }
    }
    return result;
  }

  async function discoverSeries(video, season, episode, localTitle, parts, context) {
    const queries = SeriesSearch.buildQueries(parts);
    let spent = 0;
    for (const query of queries) {
      const candidates = new Map();
      let incomplete = false;
      for (let page = 1; page <= SeriesSearch.MAX_PAGES && spent < SeriesSearch.MAX_REQUESTS; page++) {
        const parameters = {title:query.title, year:query.year, type:'series'};
        if (page > 1) parameters.page = page;
        spent++;
        const response = await pollSeriesOMDB(parameters, context, {
          stage:`series discovery: ${query.reason}`, fallback:true
        });
        const failure = requestFailure(response);
        if (failure) {
          if (failure.failure !== 'No results' && failure.failure !== 'Ambiguous results') return failure;
          break;
        }
        const rows = response.data && response.data.Search;
        if (!Array.isArray(rows)) return {success:false, failure:'Error', data:'OMDb returned a malformed series search'};
        for (const candidate of rows) {
          const reason = SeriesSearch.candidateRejection(query, candidate);
          if (!reason) candidates.set(candidate.imdbID, candidate);
        }
        const trace = context.seriesTrace[context.seriesTrace.length-1];
        trace.evaluation = rows.slice(0,10).map(row => ({imdbID:row.imdbID,
          rejectedBecause:SeriesSearch.candidateRejection(query,row)}));
        incomplete = Number(response.data.totalResults) > page * 10;
        if (!incomplete) break;
      }
      // Do not turn a bounded, incomplete result list into false uniqueness.
      if (incomplete && candidates.size && !query.imdbID) {
        return ambiguousSeriesFailure(video.series, [...candidates.values()]);
      }
      if (!candidates.size && spent < SeriesSearch.MAX_REQUESTS) {
        spent++;
        const response = await pollSeriesOMDB({series:query.title, year:query.year, type:'series'}, context,
          {stage:`single-series discovery: ${query.reason}`, fallback:true});
        const failure = requestFailure(response);
        if (failure && failure.failure !== 'No results' && failure.failure !== 'Ambiguous results') return failure;
        if (!failure && !SeriesSearch.candidateRejection(query, response.data)) candidates.set(response.data.imdbID, response.data);
      }
      if (candidates.size === 1) {
        const candidate = [...candidates.values()][0];
        return {success:true, data:candidate.imdbID, confidentSeries:Boolean(query.year), discovery:true,
          parentEvidence:{basis:query.year?'series-title-and-year':'unique-series-title',confident:Boolean(query.year)}};
      }
      if (candidates.size > 1) {
        const choices = [...candidates.values()];
        if (!localTitle || choices.length > SeriesSearch.MAX_CANDIDATES) return ambiguousSeriesFailure(video.series, choices);
        const verified = [];
        for (const candidate of choices) {
          // Use the actual episode workflow, including the historical MST3K
          // season correction. Speculative probes never seed the parent cache.
          const check = await searchShowEpisode(video, context, undefined, undefined, {
            seriesResult:{success:true, data:candidate.imdbID, confidentSeries:false},
            validateOnly:true, speculative:true
          });
          if (!check.success && !check.permanentFailure) return check;
          if (check.success && check.exactTitle && check.episodeData.seriesID === candidate.imdbID) verified.push(check);
        }
        if (verified.length !== 1) return ambiguousSeriesFailure(video.series, choices);
        return {...verified[0], confidentSeries:true, discovery:true,
          parentEvidence:{basis:'verified-episode-title',confident:true}};
      }
      if (spent >= SeriesSearch.MAX_REQUESTS) break;
    }
    return null;
  }

  async function resolveSeriesPrimary(video, season, episode, localTitle, context, options = {}) {
    const seriesIdCache = context.seriesSession.parents;
    options = options || {};
    let series = typeof video.series === 'string' ? video.series.trim() : '';
    let searchParts = seriesSearchPartsForVideo(video);
    log.debug('Resolving series for episode lookup', {
      searchID: context.searchID,
      storedSeries: series,
      queryTitle: searchParts.title,
      queryYear: searchParts.year,
      queryYearSource: searchParts.yearSource,
      localEpisodeTitle: localTitle
    });
    if (!searchParts.title) {
      return predictableFailure('Not enough data', 'Series is empty');
    }

    let cacheKey = seriesCacheKey(searchParts,video);
    if (!options.ignoreStoredSeriesImdbID && validSeriesImdbID(video.seriesImdbID)) {
      let storedID = video.seriesImdbID.trim();
      const storedEvidence = Evidence.storedParent(video);
      log.debug('Using stored IMDb series ID', {
        searchID: context.searchID,
        queryTitle: searchParts.title,
        queryYear: searchParts.year,
        imdbID: storedID
      });
      return {success:true, data:storedID, confidentSeries:storedEvidence.confident, parentEvidence:storedEvidence};
    }
    // A named file supplies independent evidence and must be allowed to expose
    // a conflicting parent. Reuse its HTTP responses, not a sibling's judgment.
    // A batch gathers all named evidence before sharing parent judgments; the
    // request cache still serves identical discovery/probe calls immediately.
    if (!localTitle && !context.deferSeriesEvidence && !options.ignoreSeriesCache && seriesIdCache.has(cacheKey)) {
      let cached = seriesIdCache.get(cacheKey);
      let cachedID = cached.data;
      log.debug('Using cached IMDb series ID', {
        searchID: context.searchID,
        queryTitle: searchParts.title,
        queryYear: searchParts.year,
        imdbID: cachedID
      });
      return {success:true, ...Evidence.copy(cached)};
    }

    try {
      // Search series-only results first so that two shows with the same title
      // (for example, an original and a remake) are visible instead of silently
      // accepting whichever one OMDb considers most popular. OMDb's search is
      // sensitive to "and" versus "&", so try that exact alternative before a
      // merely fuzzy result is trusted. If both full-title forms fail and the
      // stored title ends in an uppercase acronym, a later query may omit only
      // that acronym to make OMDb surface possible expanded titles. Those wider
      // results still have to exactly match the complete original title or pass
      // seriesAcronymMatches(), so this changes discovery but not acceptance.
      let exactQueryTitles = [searchParts.title].concat(
        andAmpersandTitleAlternates(searchParts.title)
      );
      // Comparison already equates Dr/Doctor, but discovery must also ask for
      // the expanded spelling before accepting merely fuzzy fan-series hits.
      if (/\bDr\.?\b/i.test(searchParts.title)) {
        exactQueryTitles.push(searchParts.title.replace(/\bDr\.?\b/gi, 'Doctor').replace(/Doctor\./g, 'Doctor'));
      }
      let seriesQueries = exactQueryTitles.map(title => ({
        title: title,
        terminalAcronym: null
      }));
      let acronymPrefix = terminalAcronymSearchPrefix(searchParts.title);
      if (acronymPrefix) {
        let prefixTitles = [acronymPrefix.title].concat(
          andAmpersandTitleAlternates(acronymPrefix.title)
        );
        for (let prefixTitle of prefixTitles) {
          if (!seriesQueries.some(query => query.title === prefixTitle)) {
            seriesQueries.push({
              title: prefixTitle,
              terminalAcronym: acronymPrefix.acronym
            });
          }
        }
      }
      let matchRanks = {fuzzy: 1, acronym: 2, exact: 3};
      let bestMatches = {matchStrength: 'fuzzy', candidates: []};
      for (let queryIndex=0; queryIndex<seriesQueries.length; queryIndex++) {
        let query = seriesQueries[queryIndex];
        let queryTitle = query.title;
        if (queryIndex > 0) {
          if (query.terminalAcronym) {
            log.debug('Retrying series search without a terminal acronym', {
              searchID: context.searchID,
              previousTitle: seriesQueries[queryIndex-1].title,
              nextTitle: queryTitle,
              omittedAcronym: query.terminalAcronym,
              reason: 'The full abbreviated series title did not return a validated match'
            });
          } else {
            log.debug('Retrying series search with an and/ampersand title alternative', {
              searchID: context.searchID,
              previousTitle: seriesQueries[queryIndex-1].title,
              nextTitle: queryTitle
            });
          }
        }
        let response = await pollSeriesOMDB({
          title: queryTitle,
          year: searchParts.year,
          type: 'series'
        }, context, {
          searchID: context.searchID,
          stage: query.terminalAcronym ?
            'terminal-acronym prefix series search' :
            (queryIndex === 0 ? 'series search' : 'and/ampersand series search')
        });
        let failure = requestFailure(response);
        if (failure) {
          if (failure.failure !== 'No results') {
            return failure;
          }
          continue;
        }

        let currentMatches = matchingSeriesResults(
          searchParts.title,
          searchParts.year,
          (Array.isArray(response.data.Search) ? response.data.Search : []).filter(candidate =>
            !SeriesSearch.regionRejection(searchParts, candidate))
        );
        if (query.terminalAcronym && currentMatches.matchStrength === 'fuzzy') {
          // The prefix query is intentionally broader than the stored title.
          // Never let its mere containment create a new fuzzy match (for example,
          // "Law & Order" must not satisfy "Law and Order SVU"). Only an exact
          // full-title result or a validated acronym expansion can be accepted.
          currentMatches = {matchStrength: 'fuzzy', candidates: []};
        }
        log.debug('Evaluated OMDb series candidates', {
          searchID: context.searchID,
          queryTitle: queryTitle,
          requestedTitle: searchParts.title,
          requestedYear: searchParts.year,
          matchStrength: currentMatches.matchStrength,
          matchingCandidates: currentMatches.candidates.map(candidate => ({
            title: candidate.Title,
            year: candidate.Year,
            imdbID: candidate.imdbID
          }))
        });

        if (currentMatches.candidates.length > 0 &&
            (bestMatches.candidates.length === 0 ||
             matchRanks[currentMatches.matchStrength] > matchRanks[bestMatches.matchStrength])) {
          bestMatches = currentMatches;
        }

        // An exact or supported-acronym match is already strong. A fuzzy match
        // waits until the punctuation alternative has had its chance.
        if (currentMatches.candidates.length > 0 &&
            (currentMatches.matchStrength === 'exact' || currentMatches.matchStrength === 'acronym')) {
          break;
        }
      }

      let matches = bestMatches;
      let candidates = matches.candidates;
      if (candidates.length === 1) {
        let result = candidates[0];
        // A single search hit is provisional until the episode checks pass.
        return {success: true, data: result.imdbID, confidentSeries: Boolean(searchParts.year),
          parentEvidence:{basis:searchParts.year?'series-title-and-year':'unique-series-title',confident:Boolean(searchParts.year)}};
      }
      if (candidates.length > 1) {
        // Exact and acronym matches are strong enough to disambiguate further
        // by testing the requested episode. Fuzzy candidates remain a manual
        // choice because an episode existing in a loosely related series is not
        // strong enough evidence by itself.
        if (matches.matchStrength === 'exact' || matches.matchStrength === 'acronym') {
          let episodeResult = await disambiguateSeriesByEpisode(
            candidates, season, episode, localTitle, context, video
          );
          if (episodeResult.requestFailure) {
            return episodeResult.requestFailure;
          }
          if (episodeResult.success) {

            return {
              success: true,
              data: episodeResult.candidate.imdbID,
              confidentSeries: Boolean(localTitle || searchParts.year),
              parentEvidence:{basis:'verified-episode-title',confident:true},
              episodeData: episodeResult.episodeData,
              matchedSeason:episodeResult.matchedSeason,
              matchedEpisode:episodeResult.matchedEpisode
            };
          }
          candidates = episodeResult.candidates;
        }
        log.warn('Refusing to guess between multiple matching series', {
          searchID: context.searchID,
          storedSeries: series,
          matchStrength: matches.matchStrength,
          candidates: candidates.map(candidate => ({
            title: candidate.Title,
            year: candidate.Year,
            imdbID: candidate.imdbID
          }))
        });
        return ambiguousSeriesFailure(series, candidates);
      }

      // If search supplied no plausible candidate, try the single-title endpoint
      // as a fallback, but require a close title (and year) match before trusting
      // its "most popular" result.
      let lastNoResultsFailure = null;
      let invalidFallbackFound = false;
      for (let queryIndex=0; queryIndex<exactQueryTitles.length; queryIndex++) {
        let queryTitle = exactQueryTitles[queryIndex];
        if (queryIndex > 0) {
          log.debug('Retrying single-series lookup with an and/ampersand title alternative', {
            searchID: context.searchID,
            previousTitle: exactQueryTitles[queryIndex-1],
            nextTitle: queryTitle
          });
        }
        let response = await pollSeriesOMDB({
          series: queryTitle,
          year: searchParts.year,
          type: 'series'
        }, context, {
          searchID: context.searchID,
          stage: queryIndex === 0 ? 'single-series fallback' : 'and/ampersand single-series fallback'
        });
        let failure = requestFailure(response);
        if (failure) {
          if (failure.failure !== 'No results') {
            return failure;
          }
          lastNoResultsFailure = failure;
          continue;
        }

        let result = response.data;
        if (result.Type === 'series' && result.imdbID && !SeriesSearch.regionRejection(searchParts, result) &&
            seriesYearMatches(searchParts.year, result.Year) &&
            seriesTitlesMatch(searchParts.title, result.Title, false)) {
          return {success: true, data: result.imdbID, confidentSeries: Boolean(searchParts.year),
          parentEvidence:{basis:searchParts.year?'series-title-and-year':'unique-series-title',confident:Boolean(searchParts.year)}};
        }

        invalidFallbackFound = true;
        log.warn('Single-series fallback did not pass validation', {
          searchID: context.searchID,
          queryTitle: queryTitle,
          requestedTitle: searchParts.title,
          requestedYear: searchParts.year,
          returnedTitle: result.Title,
          returnedYear: result.Year,
          returnedType: result.Type,
          returnedImdbID: result.imdbID
        });
      }

      if (invalidFallbackFound) {
        return Object.assign(predictableFailure('Ambiguous series', `Could not confidently identify the series "${series}"`), {seriesDiscoveryExhausted:true});
      }
      return lastNoResultsFailure || predictableFailure('No results', 'Series not found!');
    } catch(err) {
      log.error('Series resolution request failed', {
        searchID: context.searchID,
        storedSeries: series,
        error: summarizeError(err)
      });
      return {success: false, failure: 'Error', data: err};
    }
  }

  async function resolveSeriesForBatch(videos, options, context) {
    const candidates = (Array.isArray(videos) ? videos : [])
      .filter(video => video && video.kind === 'show' &&
        typeof video.series === 'string' && video.series.trim() &&
        (normalizeEpisodeNumber(video.season) !== null || canInferSingleSeason(video)) &&
        normalizeEpisodeNumber(video.episode) !== null)
      .map(video => ({
        video: video,
        season: canInferSingleSeason(video) ? 1 : normalizeEpisodeNumber(video.season),
        episode: normalizeEpisodeNumber(video.episode),
        localTitle: localEpisodeTitleForVerification(video)
      }));

    // A selected batch may start with an intro or an unusually named episode.
    // Try at most three distinct representatives before giving up, so one bad
    // entry does not prevent the rest of a sound series from being tagged.
    const seenRepresentatives = new Set();
    const representatives = candidates.filter(candidate => candidate.localTitle)
      .concat(candidates.filter(candidate => !candidate.localTitle))
      .filter(candidate => {
        const key = JSON.stringify([candidate.season, candidate.episode, candidate.localTitle]);
        if (seenRepresentatives.has(key)) return false;
        seenRepresentatives.add(key);
        return true;
      }).slice(0, Limits.series.representatives);
    let representative = representatives[0];
    log.info('Selected-batch series preflight started', {
      searchID: context.searchID,
      videoCount: Array.isArray(videos) ? videos.length : 0,
      usableEpisodeCount: candidates.length,
      representative: representative ? summarizeVideo(representative.video) : undefined
    });

    if (!representative) {
      const failure = predictableFailure(
        'Not enough data',
        'No selected episode has usable series, season, and episode values for series preflight'
      );
      log.warn('Selected-batch series preflight could not start', {
        searchID: context.searchID,
        failure: failure.failure,
        data: failure.data
      });
      return {...failure,context};
    }

    let result, ambiguousResult;
    const ambiguousRepresentatives=[];
    for (representative of representatives) {
      context.originalInput = Evidence.snapshot(representative.video);
      result = await resolveSeries(
        representative.video, representative.season, representative.episode,
        representative.localTitle, context,
        {ignoreStoredSeriesImdbID: true, ignoreSeriesCache: true}
      );
      // The caller writes this ID onto the selected batch; validate before that.
      if (result.success) {
        result = await searchShowEpisode(representative.video, context, undefined, undefined, {
          seriesResult: result, validateOnly: true
        });
      }
      if (result.success || !result.permanentFailure) break;
      if (result.choices) {
        if (!ambiguousResult) ambiguousResult = result;
        ambiguousRepresentatives.push({videoID:representative.video.id,title:representative.video.title,
          choices:result.choices});
      }
    }
    if (!result.success && result.permanentFailure && ambiguousResult) {
      const choices=[...new Map(ambiguousRepresentatives.flatMap(item=>item.choices).map(choice=>[choice.imdbID,choice])).values()];
      result={...ambiguousResult,choices,seriesChoiceConstraints:ambiguousRepresentatives
        .filter(item=>item.choices.length < choices.length)
        .map(item=>({videoID:item.videoID,title:item.title,candidates:item.choices.map(choice=>choice.imdbID)}))};
    }
    if (result.success && validSeriesImdbID(result.data)) {
      const success = {success:true, data:result.data.trim(), context,
        evidence:Evidence.envelope(representative.video,result.evidence,context)};
      log.info('Selected-batch series preflight finished', {
        searchID: context.searchID,
        series: representative.video.series,
        seriesImdbID: success.data
      });
      return success;
    }

    log.warn('Selected-batch series preflight did not resolve a series', {
      searchID: context.searchID,
      series: representative.video.series,
      failure: result.failure,
      choiceType: result.choiceType,
      choiceCount: Array.isArray(result.choices) ? result.choices.length : 0
    });
    return {...result,context};
  }
  return {resolve: resolveSeries, resolveForBatch: resolveSeriesForBatch};
}

module.exports = {createSeriesResolver};
