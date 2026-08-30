const path = require('path');
const omdb = require('../omdb');
const axios = require('axios');
const _ = require('lodash');
const accounting = require('accounting');
const fs = require('fs');
const electron = require('electron');
const dl = require('./download');
const { ipcRenderer } = require('electron');
const Logger = require('./Logger.js');
const MovieSearch = require('./MovieSearch.js');

const log = Logger.child('OMDb');

// Process-local cache of Mynda series names to IMDb series IDs. Resolving the
// series only once keeps a large auto-tagging run to roughly one request per
// episode after the first episode of each series.
const seriesIdCache = new Map();
const seriesArtworkCache = new Map();
// Do not keep retrying a poster URL that the artwork server has confirmed no
// longer exists. This cache lasts only for the current Mynda process.
const failedArtworkURLs = new Set();
let nextSearchNumber = 0;
let nextArtworkDownloadNumber = 0;

function validSeriesImdbID(value) {
  return typeof value === 'string' && /^tt\d+$/.test(value.trim());
}

function summarizeVideo(video) {
  return {
    id: video && video.id,
    filename: video && video.filename,
    title: video && video.title,
    kind: video && video.kind,
    year: video && video.year,
    series: video && video.series,
    seriesImdbID: video && video.seriesImdbID,
    season: video && video.season,
    episode: video && video.episode,
    imdbID: video && video.imdbID
  };
}

function summarizeError(error) {
  let source = error && error.Error ? error.Error : error;
  if (!source || typeof source !== 'object') {
    return source;
  }
  return {
    name: source.name,
    message: source.message,
    code: source.code,
    httpStatus: source.response && source.response.status,
    httpStatusText: source.response && source.response.statusText,
    stack: source.stack
  };
}

function summarizeSearchResult(result) {
  if (!result || !result.success) {
    return {
      success: false,
      failure: result && result.failure,
      data: summarizeError(result && result.data),
      permanentFailure: Boolean(result && result.permanentFailure),
      choiceType: result && result.choiceType,
      choices: result && Array.isArray(result.choices) ? result.choices.map(choice => ({
        title: choice.Title,
        year: choice.Year,
        type: choice.Type,
        imdbID: choice.imdbID
      })) : undefined
    };
  }
  if (Array.isArray(result.data)) {
    return {
      success: true,
      resultCount: result.data.length,
      results: result.data.slice(0, 10).map(item => ({
        title: item.Title,
        year: item.Year,
        type: item.Type,
        imdbID: item.imdbID
      }))
    };
  }
  return {
    success: true,
    title: result.data && result.data.title,
    year: result.data && result.data.year,
    kind: result.data && result.data.kind,
    series: result.data && result.data.series,
    seriesImdbID: result.data && result.data.seriesImdbID,
    season: result.data && result.data.season,
    episode: result.data && result.data.episode,
    imdbID: result.data && result.data.imdbID
  };
}

function logSearchFinished(context, result) {
  let details = Object.assign({searchID: context.searchID}, summarizeSearchResult(result));
  if (result && result.success) {
    log.info('Tagging search finished', details);
  } else if (result && ['No results', 'Not enough data', 'Ambiguous results', 'Ambiguous series', 'Episode mismatch'].includes(result.failure)) {
    log.warn('Tagging search finished without a match', details);
  } else {
    log.error('Tagging search failed', details);
  }
}

// Public entry point for every OMDb lookup. It sends untagged show episodes to
// the stricter series/season/episode workflow, title-based movies to the
// conservative movie matcher, and pasted IMDb IDs to the exact-ID workflow.
// Returns a consistent object with either {success: true, data: ...} or failure
// information. A caller may pass a seriesImdbID option after presenting returned
// series choices to a user.
async function search(video, options = {}) {
  options = options || {};
  let context = {searchID: `${process.pid}-${++nextSearchNumber}`};
  log.debug('Tagging search started', Object.assign({
    searchID: context.searchID,
    selectedSeriesImdbID: options.seriesImdbID
  }, summarizeVideo(video)));
  let result;
  try {
    result = await performSearch(video, context, options);
  } catch(err) {
    result = {success: false, failure: 'Error', data: err};
  }
  logSearchFinished(context, result);
  return result;
}

async function performSearch(video, context, options) {
  // An existing IMDb ID is normally the most precise lookup, including for an
  // episode that has already been tagged. New show episodes instead use their
  // series, season, and episode fields. A caller-selected series ID explicitly
  // resolves an ambiguity and therefore takes precedence over a stale episode
  // ID that may still be present in an editor object.
  if (video && video.kind === 'show' && (options.seriesImdbID || !hasImdbID(video))) {
    return searchShowEpisode(video, context, options.seriesImdbID);
  }

  // A pasted IMDb ID remains authoritative and continues through the exact-ID
  // path below. All title-based movie/custom-kind searches first remove common
  // release text and then validate OMDb's answer; this replaces the old loop
  // that repeatedly removed the filename's final word until *anything* matched.
  if (!hasImdbID(video)) {
    return searchGeneralVideoByTitle(video, context);
  }

  //start by pulling and formatting useful information
  //persisting is the information organized for quick access and modification
  let persisting = extractParts(video);
  //console.log(persisting);
  //urlParts is a joinable array formatted for url
  let urlParts = createURLParts(persisting);
  let originalTitle = persisting.title;
  let originalSearchResults = null;
  let andAmpersandAlternates = persisting.title ?
    andAmpersandTitleAlternates(persisting.title) : [];
  //console.log(urlParts);
  //Now that we have everything formatted, enter an infinite loop.
  //Each pass of the loop we poll the database.
  //If we get no response modify the search parameters.
  //Loop is broken by a return following one of three conditions:
  // 1. We got results from OMDB
  // 2. We've exhausted all options and give up
  // 3. We got an error
  let returnObject = {success: false};
  // If there is no usable search data, give up before making a request.
  if (Object.keys(persisting).length === 0) {
    returnObject.failure = 'Not enough data';
    return returnObject;
  }
  while (true) {
    try {
      let response = await pollOMDB(urlParts, {searchID: context.searchID, stage: 'general title/IMDb lookup'});
      //console.log(`pollOMDB response is ${JSON.stringify(response)}.`)
      if (response.status !== 200) {
        //console.log(response.status + ': ' + response.statusText);
        returnObject.failure = response.status;
        returnObject.data = response.statusText;
        return returnObject;
      } else if (response.data.Response === 'True') {
        //If "Search", then it's an array of movie(s) with minimal info
        if (response.data.Search) {
          let titleWasFound = searchResultsContainTitle(response.data.Search, originalTitle);
          if (!titleWasFound && andAmpersandAlternates.length > 0) {
            originalSearchResults = originalSearchResults || response.data.Search;
            let previousTitle = new URL(urlParts.join('&')).searchParams.get('s');
            persisting.title = andAmpersandAlternates.shift();
            urlParts = createURLParts(persisting);
            log.debug('Retrying tagging search with an and/ampersand title alternative', {
              searchID: context.searchID,
              previousTitle: previousTitle,
              nextTitle: persisting.title,
              reason: 'The first search returned no equivalent title'
            });
            continue;
          }
          returnObject.success = true;
          // If the alternative was no better, retain the original result list
          // so this retry does not otherwise change established search behavior.
          returnObject.data = !titleWasFound && originalSearchResults ?
            originalSearchResults : response.data.Search;
          return returnObject;
        } else {
          //If not, then we have a single entry with full info
          //Format the new info, merge it into the given video object, and return.
          let omdbData = response.data;

          // A user editing a show may paste the IMDb ID for the series rather
          // than the individual episode. The generic ID request is the safest
          // first step because it tells us which kind of ID was supplied. If
          // OMDb identifies it as a series, combine that authoritative series
          // ID with Mynda's existing season and episode fields and continue
          // through the normal episode workflow. An actual episode ID retains
          // the established exact-ID behavior below.
          if (video && video.kind === 'show' && omdbData.Type === 'series') {
            log.debug('IMDb ID identified a series for a show episode; continuing with episode lookup', {
              searchID: context.searchID,
              suppliedImdbID: video.imdbID,
              seriesImdbID: omdbData.imdbID,
              seriesTitle: omdbData.Title,
              season: video.season,
              episode: video.episode
            });
            return searchShowEpisode(video, context, omdbData.imdbID);
          }

          video = addTagsToVideo(_.cloneDeep(video), omdbData, context);
          video.artwork = await downloadArtworkWithSeriesFallback(
            omdbData,
            omdbData.Type === 'episode' ? omdbData.seriesID : null,
            context
          );
          returnObject.success = true;
          returnObject.data = video;
          return returnObject;
        }

      } else if (isNotFoundResponse(response.data) && andAmpersandAlternates.length > 0) {
        let previousTitle = new URL(urlParts.join('&')).searchParams.get('s');
        persisting.title = andAmpersandAlternates.shift();
        urlParts = createURLParts(persisting);
        log.debug('Retrying tagging search with an and/ampersand title alternative', {
          searchID: context.searchID,
          previousTitle: previousTitle,
          nextTitle: persisting.title
        });
      } else if (isNotFoundResponse(response.data) && originalSearchResults) {
        // The original search did return choices; its punctuation alternative
        // did not improve them. Preserve the original results exactly.
        returnObject.success = true;
        returnObject.data = originalSearchResults;
        return returnObject;
      } else if (isNotFoundResponse(response.data) && persisting.title && persisting.title.split(/[.\-–—_,;/\\\s]/).length > 1) {
        // try some modifications on the title
        //console.log('nothing found, trying again with modifications');

        if (/\./.test(persisting.title)) {
          // if there are periods, replace them all with spaces
          persisting.title = persisting.title.replace(/\.+/g,' ');
        } else if (/[-–—_,;/\\]/.test(persisting.title)) {
          // if that didn't work,
          // replace most other punctuation with spaces
          // and try again
          persisting.title = persisting.title.replace(/[-–—_,;/\\]+/g,' ');
        } else {
          // if that didn't work, start lopping off the last word
          // (and recursing until we find some results)
          persisting.title = persisting.title.split(/\s/).slice(0,-1).join(' ');
        }
        let previousTitle = new URL(urlParts.join('&')).searchParams.get('s');
        urlParts = createURLParts(persisting);
        log.debug('Retrying tagging search with a simplified title', {
          searchID: context.searchID,
          previousTitle: previousTitle,
          nextTitle: persisting.title
        });
      } else if (isNotFoundResponse(response.data)) {
        //console.log(`Did not find any results, giving up.`);
        returnObject.failure = 'No results';
        return returnObject;
      } else {
        returnObject.failure = 'Error';
        returnObject.data = response.data && response.data.Error ? response.data.Error : 'Unexpected OMDb response';
        return returnObject;
      }
    } catch (e) {
      //console.log(e);
      returnObject.failure = 'Error';
      returnObject.data = e;
      return returnObject;
    }
  }
}

// Searches a movie (or any non-show custom kind) from a short, ordered title
// plan. A normal clean title/year still completes in one request. Additional
// requests happen only after that precise path fails: first a broad search with
// the same year, then (for the primary candidate) one search without the year
// so punctuation and regional release-year discrepancies can surface. Search
// rows are evaluated in confidence tiers: exact normalized titles first,
// leading-article equivalents second, and canonical expansions last. If the
// ordinary plan exposes no such candidate, two final discovery-only queries may
// restore likely punctuation or use distinctive title words.
//
// Lightweight OMDb search rows are never applied directly. Before unattended
// tagging, the selected IMDb ID is expanded to a full record and checked
// against the local video's duration. Yearless matches additionally need a
// comparable runtime and a meaningful vote history. If those checks cannot
// identify one safe record, the collected choices go back to the editor.
async function searchGeneralVideoByTitle(video, context) {
  const MAX_TITLE_REQUESTS = 8;
  const MAX_NORMALIZED_DISCOVERY_REQUESTS = 2;
  const MAX_AMBIGUOUS_DETAIL_PROBES = 7;
  let candidates = MovieSearch.buildSearchCandidates(video);
  if (candidates.length === 0) {
    return predictableFailure('Not enough data', 'No usable title or filename was available');
  }

  let titleRequestCount = 0;
  let normalizedDiscoveryRequestCount = 0;
  let choicesByID = new Map();
  let sawAmbiguousResponse = false;
  let sawUnresolvedExactAmbiguity = false;
  let sawUnresolvedArticleAmbiguity = false;
  let attemptedTitles = [];
  let type = MovieSearch.omdbTypeForKind(video.kind || video.type);
  let fullResultCache = new Map();
  let deferredArticleGroups = [];
  let deferredCanonicalGroups = [];

  log.debug('Prepared conservative movie tagging search', {
    searchID: context.searchID,
    candidates: candidates.slice(0, MAX_TITLE_REQUESTS)
  });

  // Retrieves and validates one lightweight search choice. A rejection is a
  // normal branch, not a search failure: continue through the bounded plan in
  // case another query exposes the real movie.
  async function trySearchChoice(result, candidate, validationOptions, stage) {
    let fetched = await fetchGeneralVideoResult(
      result.imdbID, context, fullResultCache, stage
    );
    if (!fetched.success) {
      // A lightweight row can outlive its full OMDb record. Treat that one row
      // as unusable and continue; authentication, transport, and other errors
      // still stop the operation so Auto-Tag can retry them later.
      return fetched.failure === 'No results' ? {} : {terminalResult: fetched};
    }

    let evaluation = MovieSearch.evaluateFullResult(
      fetched.data, candidate, video, validationOptions
    );
    logFullMovieEvaluation(context, candidate, fetched.data, evaluation, stage);
    if (!evaluation.confident) return {};

    return {
      terminalResult: await applyGeneralVideoResult(video, fetched.data, context)
    };
  }

  // When several lightweight rows have equally good title/year evidence, probe
  // at most seven full records. Runtime plausibility often leaves one real
  // feature and rejects a short, fan record, or compilation with the same name.
  // The limit is per result group, not global: an ambiguous early filename
  // interpretation must not consume the probes needed by a later, cleaner
  // parent-folder or spelling variant. The shared full-result cache prevents
  // duplicate requests when groups contain the same IMDb IDs.
  async function tryAmbiguousChoices(results, candidate, validationOptions, stage) {
    let uniqueResults = Array.from(new Map(results.map(result => [result.imdbID, result])).values());
    if (uniqueResults.length < 2) return {};
    if (uniqueResults.length > MAX_AMBIGUOUS_DETAIL_PROBES) {
      log.debug('Movie result tier exceeded the bounded detail-probe limit', {
        searchID: context.searchID,
        stage: stage,
        candidate: candidate,
        resultCount: uniqueResults.length,
        maximumDetailProbes: MAX_AMBIGUOUS_DETAIL_PROBES,
        consideredImdbIDs: uniqueResults.map(result => result.imdbID)
      });
      return {unresolvedAmbiguity: true, plausibleCount: null};
    }

    let plausible = [];
    for (let result of uniqueResults) {
      let fetched = await fetchGeneralVideoResult(
        result.imdbID, context, fullResultCache, `${stage} candidate detail`
      );
      if (!fetched.success) {
        if (fetched.failure === 'No results') continue;
        return {terminalResult: fetched};
      }

      let evaluation = MovieSearch.evaluateFullResult(
        fetched.data, candidate, video, validationOptions
      );
      logFullMovieEvaluation(context, candidate, fetched.data, evaluation, stage);
      if (evaluation.confident) plausible.push(fetched.data);
    }

    if (plausible.length === 1) {
      log.debug('Runtime evidence resolved otherwise ambiguous movie results', {
        searchID: context.searchID,
        candidate: candidate,
        selectedImdbID: plausible[0].imdbID,
        consideredImdbIDs: uniqueResults.map(result => result.imdbID)
      });
      return {
        terminalResult: await applyGeneralVideoResult(video, plausible[0], context)
      };
    }
    if (plausible.length > 1) {
      log.debug('Full movie evidence left multiple records equally plausible', {
        searchID: context.searchID,
        stage: stage,
        candidate: candidate,
        plausibleImdbIDs: plausible.map(result => result.imdbID)
      });
    }
    return {
      unresolvedAmbiguity: plausible.length > 1,
      plausibleCount: plausible.length
    };
  }

  // Runs one already-filtered confidence tier. A single row still receives a
  // full-record plausibility check; a small tie is resolved by runtime/votes;
  // a large or still-indistinguishable tie remains manual. Keeping this helper
  // tier-specific is what prevents weaker canonical rows from inflating an
  // otherwise manageable exact-title group.
  async function tryResultTier(results, candidate, validationOptions, stage) {
    let uniqueResults = Array.from(new Map(
      (results || []).map(result => [result.imdbID, result])
    ).values());
    if (uniqueResults.length === 0) return {};
    if (uniqueResults.length === 1) {
      return trySearchChoice(uniqueResults[0], candidate, validationOptions, stage);
    }
    return tryAmbiguousChoices(uniqueResults, candidate, validationOptions, stage);
  }

  async function runBroadSearch(candidate, requestYear, validationOptions, stage, requestOptions = {}) {
    let useDiscoveryBudget = Boolean(requestOptions.useDiscoveryBudget);
    if (useDiscoveryBudget) {
      if (normalizedDiscoveryRequestCount >= MAX_NORMALIZED_DISCOVERY_REQUESTS) return {};
      normalizedDiscoveryRequestCount++;
    } else {
      if (titleRequestCount >= MAX_TITLE_REQUESTS) return {};
      titleRequestCount++;
    }
    let queryTitle = requestOptions.queryTitle || candidate.title;

    let response;
    try {
      response = await pollOMDB(createURLParts({
        title: queryTitle,
        year: requestYear || null,
        type: type || null
      }), {searchID: context.searchID, stage: stage});
    } catch(err) {
      return {terminalResult: {success: false, failure: 'Error', data: err}};
    }

    if (!response || response.status !== 200) {
      return {
        terminalResult: {
          success: false,
          failure: response ? response.status : 'Error',
          data: response ? response.statusText : 'No response from OMDb'
        }
      };
    }

    if (response.data && response.data.Response === 'True' && Array.isArray(response.data.Search)) {
      let evaluation = MovieSearch.evaluateSearchResults(
        response.data.Search, candidate, video, validationOptions
      );
      for (let result of evaluation.rankedResults) {
        if (!choicesByID.has(result.imdbID)) choicesByID.set(result.imdbID, result);
      }
      log.debug('Evaluated conservative movie tagging results', {
        searchID: context.searchID,
        candidate: candidate,
        queryTitle: queryTitle,
        requestYear: requestYear || null,
        allowCanonicalTitle: Boolean(validationOptions.allowCanonicalTitle),
        allowAdjacentYear: Boolean(validationOptions.allowAdjacentYear),
        allowDistantYear: Boolean(validationOptions.allowDistantYear),
        resultCount: response.data.Search.length,
        acceptableResultCount: evaluation.acceptableResults.length,
        exactResultCount: evaluation.exactResults.length,
        articleResultCount: evaluation.articleResults.length,
        canonicalResultCount: evaluation.canonicalResults.length,
        selectedImdbID: evaluation.confident && evaluation.confident.imdbID
      });

      // During the query phase, only exact normalized titles may finish the
      // search. Article-only and canonical matches are retained, but evaluated
      // after every parsed candidate and strict discovery query has had a
      // chance to expose an exact title.
      let strictOptions = Object.assign({}, validationOptions, {allowCanonicalTitle: false});
      let exactAttempt = await tryResultTier(
        evaluation.exactResults, candidate, strictOptions, `${stage} exact-title tier`
      );
      if (exactAttempt.terminalResult) return exactAttempt;
      if (exactAttempt.unresolvedAmbiguity) {
        sawUnresolvedExactAmbiguity = true;
        return {};
      }

      if (evaluation.articleResults.length > 0) {
        deferredArticleGroups.push({
          results: evaluation.articleResults,
          candidate: candidate,
          validationOptions: strictOptions,
          stage: `${stage} article-only tier`
        });
      }
      if (validationOptions.allowCanonicalTitle && evaluation.canonicalResults.length > 0) {
        deferredCanonicalGroups.push({
          results: evaluation.canonicalResults,
          candidate: candidate,
          validationOptions: validationOptions,
          stage: `${stage} canonical-title tier`
        });
      }
      return {};
    }

    if (isTooManyResultsResponse(response.data)) {
      sawAmbiguousResponse = true;
      return {};
    }
    if (isNotFoundResponse(response.data)) return {};
    return {
      terminalResult: {
        success: false,
        failure: 'Error',
        data: response.data && response.data.Error ?
          response.data.Error : 'Unexpected OMDb response'
      }
    };
  }

  // OMDb's list search can occasionally miss a correctly punctuated two-word
  // possessive even with its known year (notably "Pan's Labyrinth"). After that
  // strict discovery request fails, spend the remaining discovery request on
  // the exact-title endpoint. Acceptance remains tied to the original parsed
  // title and year, so this changes discovery without relaxing matching.
  async function runStrictNormalizedExactLookup(candidate, queryTitle, stage) {
    if (!candidate.year ||
        normalizedDiscoveryRequestCount >= MAX_NORMALIZED_DISCOVERY_REQUESTS) return {};
    normalizedDiscoveryRequestCount++;

    let response;
    try {
      response = await pollOMDB(createURLParts({
        exactTitle: queryTitle,
        year: candidate.year,
        type: type || null
      }), {searchID: context.searchID, stage: stage});
    } catch(err) {
      return {terminalResult: {success: false, failure: 'Error', data: err}};
    }

    if (!response || response.status !== 200) {
      return {
        terminalResult: {
          success: false,
          failure: response ? response.status : 'Error',
          data: response ? response.statusText : 'No response from OMDb'
        }
      };
    }
    if (response.data && response.data.Response === 'True') {
      if (response.data.imdbID) fullResultCache.set(response.data.imdbID, response.data);
      let validationOptions = {allowCanonicalTitle: false};
      let evaluation = MovieSearch.evaluateFullResult(
        response.data, candidate, video, validationOptions
      );
      logFullMovieEvaluation(context, candidate, response.data, evaluation, stage);
      if (evaluation.confident && evaluation.matchKind === 'exact') {
        return {
          terminalResult: await applyGeneralVideoResult(video, response.data, context)
        };
      }
      return {};
    }
    if (isTooManyResultsResponse(response.data)) {
      sawAmbiguousResponse = true;
      return {};
    }
    if (isNotFoundResponse(response.data)) return {};
    return {
      terminalResult: {
        success: false,
        failure: 'Error',
        data: response.data && response.data.Error ?
          response.data.Error : 'Unexpected OMDb response'
      }
    };
  }

  function isTwoWordPossessiveDiscovery(candidateTitle, queryTitle) {
    let candidateWords = String(candidateTitle || '').trim().split(/\s+/).filter(Boolean);
    return candidateWords.length === 2 &&
      !/[\u2019']/.test(String(candidateTitle || '')) &&
      /[\u2019']s\b/i.test(String(queryTitle || '')) &&
      MovieSearch.titleKey(candidateTitle) === MovieSearch.titleKey(queryTitle);
  }

  // Try every parser-derived title once before spending requests on spelling
  // variants. This round-robin ordering prevents an and/ampersand or alias
  // retry for a noisy filename from exhausting the bounded request plan before
  // a clean parent-folder candidate can run.
  let queryPlans = [];
  let plannedTitles = new Set();
  function addQueryPlan(candidate, candidateIndex, title, variantReason) {
    title = String(title || '').replace(/\s+/g, ' ').trim();
    let key = `${title.toLowerCase()}\u0000${candidate.year || ''}`;
    if (!title || plannedTitles.has(key)) return;
    plannedTitles.add(key);
    queryPlans.push({
      candidate: candidate,
      candidateIndex: candidateIndex,
      title: title,
      variantReason: variantReason
    });
  }

  candidates.forEach((candidate, candidateIndex) => {
    addQueryPlan(candidate, candidateIndex, candidate.title, 'parsed title');
  });
  candidates.forEach((candidate, candidateIndex) => {
    let variants = andAmpersandTitleAlternates(candidate.title)
      .map(title => ({title: title, reason: 'and/ampersand alternative'}))
      .concat(MovieSearch.buildTitleQueryVariants(candidate.title));
    for (let variant of variants) {
      addQueryPlan(candidate, candidateIndex, variant.title, variant.reason);
      for (let conjunctionVariant of andAmpersandTitleAlternates(variant.title)) {
        addQueryPlan(
          candidate, candidateIndex, conjunctionVariant,
          `${variant.reason}; and/ampersand alternative`
        );
      }
    }
  });

  for (let plan of queryPlans) {
    if (titleRequestCount >= MAX_TITLE_REQUESTS) break;
    let candidate = plan.candidate;
    let title = plan.title;
    let requestCandidate = Object.assign({}, candidate, {
      title: title,
      variantReason: plan.variantReason
    });
    attemptedTitles.push({
      title: title,
      year: candidate.year || '',
      source: candidate.source,
      variantReason: plan.variantReason
    });

    // A known year makes OMDb's title endpoint both precise and fast: it
    // returns the full metadata record in the same request. If OMDb responds
    // with a merely similar title, strict full-record validation rejects it and
    // the ordinary search below can still provide choices for manual selection.
    if (candidate.year && titleRequestCount < MAX_TITLE_REQUESTS) {
      titleRequestCount++;
      let exactResponse;
      try {
        exactResponse = await pollOMDB(createURLParts({
          exactTitle: title,
          year: candidate.year,
          type: type || null
        }), {
          searchID: context.searchID,
          stage: 'cleaned exact-title lookup'
        });
      } catch(err) {
        return {success: false, failure: 'Error', data: err};
      }

      if (!exactResponse || exactResponse.status !== 200) {
        return {
          success: false,
          failure: exactResponse ? exactResponse.status : 'Error',
          data: exactResponse ? exactResponse.statusText : 'No response from OMDb'
        };
      }
      if (exactResponse.data && exactResponse.data.Response === 'True') {
        if (exactResponse.data.imdbID) {
          fullResultCache.set(exactResponse.data.imdbID, exactResponse.data);
        }
        let exactValidationOptions = {
          allowCanonicalTitle: true,
          allowAdjacentYear: true,
          allowDistantYear: true,
          maxYearDifference: 3
        };
        let fullEvaluation = MovieSearch.evaluateFullResult(
          exactResponse.data, requestCandidate, video, exactValidationOptions
        );
        logFullMovieEvaluation(
          context, requestCandidate, exactResponse.data, fullEvaluation,
          'cleaned exact-title lookup'
        );
        if (fullEvaluation.confident && fullEvaluation.matchKind === 'exact') {
          return applyGeneralVideoResult(video, exactResponse.data, context);
        }
        if (fullEvaluation.confident && fullEvaluation.matchKind === 'article') {
          deferredArticleGroups.push({
            results: [exactResponse.data],
            candidate: requestCandidate,
            validationOptions: Object.assign({}, exactValidationOptions, {
              allowCanonicalTitle: false
            }),
            stage: 'cleaned exact-title lookup article-only tier'
          });
        } else if (fullEvaluation.confident && fullEvaluation.matchKind === 'canonical') {
          deferredCanonicalGroups.push({
            results: [exactResponse.data],
            candidate: requestCandidate,
            validationOptions: exactValidationOptions,
            stage: 'cleaned exact-title lookup canonical-title tier'
          });
        }
        if (exactResponse.data.imdbID && !choicesByID.has(exactResponse.data.imdbID)) {
          choicesByID.set(exactResponse.data.imdbID, exactResponse.data);
        }
      } else if (isTooManyResultsResponse(exactResponse.data)) {
        sawAmbiguousResponse = true;
      } else if (!isNotFoundResponse(exactResponse.data)) {
        return {
          success: false,
          failure: 'Error',
          data: exactResponse.data && exactResponse.data.Error ?
            exactResponse.data.Error : 'Unexpected OMDb response'
        };
      }
    }

    let broadResult = await runBroadSearch(
      requestCandidate,
      candidate.year || null,
      {
        allowCanonicalTitle: true,
        requireStrongEvidence: !candidate.year
      },
      'cleaned general-title search'
    );
    if (broadResult.terminalResult) return broadResult.terminalResult;

    // The primary parsed title gets one bounded year-relaxed retry. A one-year
    // discrepancy retains the established behavior. A two/three-year result
    // is eligible only for an exact normalized title; full validation then
    // additionally requires a close runtime and meaningful IMDb vote history.
    if (plan.candidateIndex === 0 && candidate.year && titleRequestCount < MAX_TITLE_REQUESTS) {
      let relaxedResult = await runBroadSearch(
        requestCandidate,
        null,
        {
          allowCanonicalTitle: true,
          allowAdjacentYear: true,
          allowDistantYear: true,
          maxYearDifference: 3
        },
        'cleaned year-relaxed title search'
      );
      if (relaxedResult.terminalResult) return relaxedResult.terminalResult;
    }
  }

  // OMDb can return "Movie not found" for a complete title merely because a
  // filename lost catalog punctuation: "Oceans Eleven" versus "Ocean's
  // Eleven", "310 to Yuma" versus "3:10 to Yuma", and dotted initialisms are
  // common examples. Spend at most two separately budgeted search requests on
  // repaired/keyword queries. The query is allowed to be shorter, but matching
  // is not: runBroadSearch validates rows against the complete original
  // candidate with canonical matching disabled. This fallback runs only when
  // the ordinary searches exposed no article/canonical candidate at all, so it
  // does not add requests to already-working canonical matches.
  if (!sawUnresolvedExactAmbiguity &&
      deferredArticleGroups.length === 0 && deferredCanonicalGroups.length === 0) {
    let discoveryVariants = candidates.map(candidate =>
      MovieSearch.buildNormalizedDiscoveryQueries(candidate.title));
    let maximumVariants = discoveryVariants.reduce(
      (maximum, variants) => Math.max(maximum, variants.length), 0
    );
    let discoveryPlans = [];
    let discoveryKeys = new Set();
    for (let variantIndex=0; variantIndex<maximumVariants; variantIndex++) {
      candidates.forEach((candidate, candidateIndex) => {
        let variant = discoveryVariants[candidateIndex][variantIndex];
        if (!variant) return;
        let key = `${variant.title.toLowerCase()}\u0000${candidate.year || ''}`;
        if (plannedTitles.has(key) || discoveryKeys.has(key)) return;
        discoveryKeys.add(key);
        discoveryPlans.push({candidate: candidate, variant: variant});
      });
    }

    for (let plan of discoveryPlans) {
      if (normalizedDiscoveryRequestCount >= MAX_NORMALIZED_DISCOVERY_REQUESTS ||
          sawUnresolvedExactAmbiguity) break;
      attemptedTitles.push({
        title: plan.variant.title,
        year: plan.candidate.year || '',
        source: plan.candidate.source,
        variantReason: plan.variant.reason
      });
      log.debug('Retrying movie search with strict normalized-title discovery', {
        searchID: context.searchID,
        candidate: plan.candidate,
        queryTitle: plan.variant.title,
        reason: plan.variant.reason,
        requestNumber: normalizedDiscoveryRequestCount + 1,
        maximumRequests: MAX_NORMALIZED_DISCOVERY_REQUESTS
      });
      let discoveryResult = await runBroadSearch(
        plan.candidate,
        plan.candidate.year || null,
        {
          allowCanonicalTitle: false,
          requireStrongEvidence: !plan.candidate.year
        },
        'strict normalized-title discovery search',
        {queryTitle: plan.variant.title, useDiscoveryBudget: true}
      );
      if (discoveryResult.terminalResult) return discoveryResult.terminalResult;

      // Keep this retry deliberately narrower than general punctuation repair:
      // the query must only restore a possessive in a two-word title, its year
      // must be known, and an unresolved exact-title tier still blocks it.
      if (!sawUnresolvedExactAmbiguity &&
          isTwoWordPossessiveDiscovery(plan.candidate.title, plan.variant.title) &&
          normalizedDiscoveryRequestCount < MAX_NORMALIZED_DISCOVERY_REQUESTS) {
        attemptedTitles.push({
          title: plan.variant.title,
          year: plan.candidate.year,
          source: plan.candidate.source,
          variantReason: `${plan.variant.reason}; exact-title endpoint`
        });
        log.debug('Retrying strict normalized title through exact-title lookup', {
          searchID: context.searchID,
          candidate: plan.candidate,
          queryTitle: plan.variant.title,
          requestNumber: normalizedDiscoveryRequestCount + 1,
          maximumRequests: MAX_NORMALIZED_DISCOVERY_REQUESTS
        });
        let exactDiscoveryResult = await runStrictNormalizedExactLookup(
          plan.candidate,
          plan.variant.title,
          'strict normalized-title exact lookup'
        );
        if (exactDiscoveryResult.terminalResult) {
          return exactDiscoveryResult.terminalResult;
        }
      }
    }
  }

  // Only after every query has failed to produce an exact normalized title do
  // we evaluate article-only equivalents. A still-ambiguous exact tier is a
  // deliberate stop: weaker title evidence must never override it.
  if (!sawUnresolvedExactAmbiguity) {
    for (let group of deferredArticleGroups) {
      let articleAttempt = await tryResultTier(
        group.results, group.candidate, group.validationOptions, group.stage
      );
      if (articleAttempt.terminalResult) return articleAttempt.terminalResult;
      if (articleAttempt.unresolvedAmbiguity) sawUnresolvedArticleAmbiguity = true;
    }
  }

  // Canonical expansions remain available for the cases fix03 already handled,
  // but only after exact and article-only tiers have both failed cleanly.
  if (!sawUnresolvedExactAmbiguity && !sawUnresolvedArticleAmbiguity) {
    for (let groupIndex=0; groupIndex<deferredCanonicalGroups.length; groupIndex++) {
      let group = deferredCanonicalGroups[groupIndex];
      let canonicalAttempt = await tryResultTier(
        group.results, group.candidate, group.validationOptions, group.stage
      );
      if (canonicalAttempt.terminalResult) return canonicalAttempt.terminalResult;
      if (canonicalAttempt.unresolvedAmbiguity) {
        // A broad subtitle fragment can expose more rows than the bounded probe
        // limit even when a later, more specific query exposes one of those same
        // rows as its sole canonical result. Validate that corroborated singleton
        // before stopping; small or genuinely competing ambiguities keep fix04's
        // existing behavior unchanged.
        if (canonicalAttempt.plausibleCount === null) {
          let blockedImdbIDs = new Set(
            group.results.map(result => result && result.imdbID).filter(Boolean)
          );
          let corroboratingSingleton = deferredCanonicalGroups
            .slice(groupIndex + 1)
            .find(laterGroup => {
              let laterIDs = Array.from(new Set(
                laterGroup.results.map(result => result && result.imdbID).filter(Boolean)
              ));
              return laterIDs.length === 1 && blockedImdbIDs.has(laterIDs[0]);
            });
          if (corroboratingSingleton) {
            log.debug('Validating a canonical singleton corroborated by an oversized result tier', {
              searchID: context.searchID,
              blockedCandidate: group.candidate,
              candidate: corroboratingSingleton.candidate,
              imdbID: corroboratingSingleton.results[0].imdbID
            });
            let singletonAttempt = await tryResultTier(
              corroboratingSingleton.results,
              corroboratingSingleton.candidate,
              corroboratingSingleton.validationOptions,
              corroboratingSingleton.stage
            );
            if (singletonAttempt.terminalResult) return singletonAttempt.terminalResult;
          }
        }
        break;
      }
    }
  }

  let choices = Array.from(choicesByID.values());
  if (choices.length > 0) {
    log.debug('Movie tagging search remained ambiguous; returning choices', {
      searchID: context.searchID,
      attemptedTitles: attemptedTitles,
      choiceCount: choices.length
    });
    return {success: true, data: choices};
  }
  if (sawAmbiguousResponse) {
    return predictableFailure(
      'Ambiguous results',
      'OMDb found too many possible matches to choose one safely'
    );
  }
  return predictableFailure('No results', 'OMDb found no safely matching title');
}

// Fetches one full movie record by ID, reusing any full response returned by an
// earlier exact-title request. Full-detail probes are deliberately separate
// from the title-request budget because they occur only after a small set of
// lightweight results has already passed title/year screening.
async function fetchGeneralVideoResult(imdbID, context, cache, stage) {
  if (cache.has(imdbID)) return {success: true, data: cache.get(imdbID)};

  let response;
  try {
    response = await pollOMDB(createURLParts({id: imdbID}), {
      searchID: context.searchID,
      stage: stage || 'selected movie IMDb-ID lookup'
    });
  } catch(err) {
    return {success: false, failure: 'Error', data: err};
  }
  let failure = requestFailure(response);
  if (failure) return failure;
  if (!response.data || response.data.imdbID !== imdbID) {
    return {
      success: false,
      failure: 'Error',
      data: 'OMDb returned a different record than the selected IMDb ID'
    };
  }
  cache.set(imdbID, response.data);
  return {success: true, data: response.data};
}

function logFullMovieEvaluation(context, candidate, omdbData, evaluation, stage) {
  let details = {
    searchID: context.searchID,
    stage: stage,
    candidate: candidate,
    imdbID: omdbData && omdbData.imdbID,
    omdbTitle: omdbData && omdbData.Title,
    omdbYear: omdbData && omdbData.Year,
    accepted: evaluation.confident,
    titleMatchKind: evaluation.matchKind,
    yearDifference: evaluation.yearDifference,
    localRuntimeMinutes: evaluation.plausibility.localRuntimeMinutes,
    omdbRuntimeMinutes: evaluation.plausibility.omdbRuntimeMinutes,
    imdbVotes: evaluation.plausibility.imdbVotes,
    splitFile: evaluation.plausibility.splitFile,
    reasons: evaluation.reasons
  };
  if (evaluation.confident) {
    log.debug('Full movie result passed plausibility validation', details);
  } else {
    log.warn('Full movie result was not safe to auto-select', details);
  }
}

// Applies one already-validated full OMDb record and downloads its artwork.
// This is shared by ordinary search results and the exact-title fallback.
async function applyGeneralVideoResult(video, omdbData, context) {
  let taggedVideo = addTagsToVideo(_.cloneDeep(video), omdbData, context);
  taggedVideo.artwork = await downloadArtworkWithSeriesFallback(
    omdbData,
    omdbData.Type === 'episode' ? omdbData.seriesID : null,
    context
  );
  return {success: true, data: taggedVideo};
}

// True only when a video has a nonempty string IMDb ID. An existing ID is more
// precise than any title-based lookup and therefore takes precedence.
function hasImdbID(video) {
  return typeof video.imdbID === 'string' && video.imdbID.trim() !== '';
}

// Converts a nonnegative integer or digit string to OMDb's canonical string
// form ("003" becomes "3", while zero remains "0"). Returns null for extras,
// blanks, fractions, negative numbers, and any other nonnumeric value.
function normalizeEpisodeNumber(value) {
  let stringValue = String(value).trim();
  if (!/^\d+$/.test(stringValue)) {
    return null;
  }
  return stringValue.replace(/^0+(?=\d)/, '');
}

// Identifies an ordinary OMDb "not found" response. This is kept separate from
// authentication, quota, network, and other errors that should remain retryable.
function isNotFoundResponse(data) {
  return data && data.Response === 'False' && /not found|no results/i.test(data.Error || '');
}

// OMDb reports broad search ambiguity as a Response:false payload rather than
// an HTTP error. Treating it as a normal server failure caused Auto-Tag to retry
// the same title forever; it is a predictable, user-resolvable outcome.
function isTooManyResultsResponse(data) {
  return data && data.Response === 'False' && /too many results/i.test(data.Error || '');
}

// Builds a failure that another identical auto-tag pass cannot resolve by
// itself. autoTag() records these as attempted; editing and saving the video
// resets autotag_tried so corrected metadata can be tried later.
function predictableFailure(failure, data) {
  return {
    success: false,
    failure: failure,
    data: data,
    // autoTag() can record this attempt instead of retrying the same
    // untaggable video every time. Saving it in the editor resets the flag.
    permanentFailure: true
  };
}

// Converts an Axios/OMDb response into Mynda's standard failure object. A null
// return means the response is successful and its data is safe to inspect.
function requestFailure(response) {
  if (!response || response.status !== 200) {
    return {
      success: false,
      failure: response ? response.status : 'Error',
      data: response ? response.statusText : 'No response from OMDb'
    };
  }
  if (response.data && response.data.Response === 'True') {
    return null;
  }
  if (isNotFoundResponse(response.data)) {
    return predictableFailure('No results', response.data.Error);
  }
  if (isTooManyResultsResponse(response.data)) {
    return predictableFailure('Ambiguous results', response.data.Error);
  }
  return {
    success: false,
    failure: 'Error',
    data: response.data && response.data.Error ? response.data.Error : 'Unexpected OMDb response'
  };
}

function usablePosterURL(poster) {
  if (typeof poster !== 'string') {
    return null;
  }
  let url = poster.trim();
  return url && url.toUpperCase() !== 'N/A' ? url : null;
}

// Retrieves and caches the poster from a full OMDb series record. A missing
// poster is cached too, while request/authentication failures remain retryable.
// Artwork is optional metadata, so a failed fallback never makes an otherwise
// successful episode-tagging operation fail.
async function getSeriesArtwork(seriesID, context) {
  if (seriesArtworkCache.has(seriesID)) {
    let cachedArtwork = seriesArtworkCache.get(seriesID);
    log.debug('Using cached series artwork fallback', {
      searchID: context.searchID,
      seriesID: seriesID,
      artworkAvailable: Boolean(cachedArtwork)
    });
    return cachedArtwork;
  }

  try {
    let response = await pollOMDB(createURLParts({id: seriesID}), {
      searchID: context.searchID,
      stage: 'series artwork fallback'
    });
    let failure = requestFailure(response);
    if (failure) {
      if (failure.failure === 'No results') {
        seriesArtworkCache.set(seriesID, '');
      }
      log.warn('Could not retrieve series artwork fallback', {
        searchID: context.searchID,
        seriesID: seriesID,
        failure: failure.failure,
        error: summarizeError(failure.data)
      });
      return '';
    }

    let seriesData = response.data;
    if (seriesData.Type !== 'series' || seriesData.imdbID !== seriesID) {
      log.warn('Series artwork fallback response did not match the requested series', {
        searchID: context.searchID,
        seriesID: seriesID,
        received: summarizeOMDbResponse(response)
      });
      return '';
    }

    let artwork = usablePosterURL(seriesData.Poster) || '';
    seriesArtworkCache.set(seriesID, artwork);
    if (artwork) {
      log.debug('Found series artwork fallback', {
        searchID: context.searchID,
        seriesID: seriesID,
        seriesTitle: seriesData.Title
      });
    } else {
      log.debug('Series has no usable artwork fallback', {
        searchID: context.searchID,
        seriesID: seriesID,
        seriesTitle: seriesData.Title
      });
    }
    return artwork;
  } catch(err) {
    log.warn('Series artwork fallback request failed; keeping the episode without artwork', {
      searchID: context.searchID,
      seriesID: seriesID,
      error: summarizeError(err)
    });
    return '';
  }
}

function summarizeArtworkDownloadFailure(failure) {
  let source = failure && failure.response ? failure.response : failure;
  if (!source || typeof source !== 'object') {
    return {message: String(source || 'Download failed')};
  }
  return {
    message: source.message || 'Download failed',
    status: source.status || (source.response && source.response.status),
    statusText: source.statusText || (source.response && source.response.statusText)
  };
}

function artworkHostname(url) {
  try {
    return new URL(url).hostname;
  } catch(err) {
    return '';
  }
}

// Attempts one poster URL and returns a local filepath on success. A confirmed
// 404 is remembered for this run so repeated tagging cannot repeatedly request
// the same dead OMDb image URL.
async function tryDownloadArtwork(url, source, seriesID, context) {
  if (!url) {
    return '';
  }
  if (failedArtworkURLs.has(url)) {
    log.debug('Skipping OMDb artwork URL that previously returned 404', {
      searchID: context.searchID,
      artworkSource: source,
      artworkHost: artworkHostname(url)
    });
    return '';
  }

  try {
    return await downloadArt(url, Object.assign({}, context, {artworkSource: source}));
  } catch(err) {
    let failure = summarizeArtworkDownloadFailure(err);
    if (failure.status === 404) {
      failedArtworkURLs.add(url);
      if (source === 'series' && seriesID) {
        // The cached URL itself is bad, not merely this particular request.
        seriesArtworkCache.set(seriesID, '');
      }
    }
    log.warn('Could not download OMDb artwork', {
      searchID: context.searchID,
      artworkSource: source,
      artworkHost: artworkHostname(url),
      httpStatus: failure.status,
      httpStatusText: failure.statusText,
      error: failure.message
    });
    return '';
  }
}

// Downloads the title/episode poster first. For an episode, a missing or failed
// episode poster triggers one attempt to retrieve and download the series
// poster. No remote URL is returned: callers receive either a valid local path
// or an empty artwork value.
async function downloadArtworkWithSeriesFallback(data, seriesID, context) {
  let isEpisode = data && data.Type === 'episode';
  let primaryArtwork = usablePosterURL(data && data.Poster);
  if (primaryArtwork) {
    let downloadedArtwork = await tryDownloadArtwork(
      primaryArtwork,
      isEpisode ? 'episode' : 'title',
      seriesID,
      context
    );
    if (downloadedArtwork) {
      return downloadedArtwork;
    }
  }

  if (!isEpisode || !seriesID) {
    return '';
  }

  let seriesArtwork = await getSeriesArtwork(seriesID, context);
  if (!seriesArtwork) {
    return '';
  }
  if (primaryArtwork) {
    log.debug('Trying series artwork after the episode artwork download failed', {
      searchID: context.searchID,
      seriesID: seriesID
    });
  }
  let downloadedSeriesArtwork = await tryDownloadArtwork(
    seriesArtwork,
    'series',
    seriesID,
    context
  );
  if (downloadedSeriesArtwork) {
    log.debug('Using series artwork fallback', {
      searchID: context.searchID,
      seriesID: seriesID
    });
  }
  return downloadedSeriesArtwork;
}

function requestParametersForLog(urlParts) {
  try {
    let requestURL = new URL(urlParts.join('&'));
    let parameters = {};
    requestURL.searchParams.forEach((value, key) => {
      if (key.toLowerCase() !== 'apikey') {
        parameters[key] = value;
      }
    });
    return parameters;
  } catch(err) {
    // The first array member contains the API key. Never include it in the
    // fallback diagnostic representation.
    return {unparsedParameters: urlParts.slice(1)};
  }
}

function summarizeOMDbResponse(response) {
  let data = response && response.data ? response.data : {};
  let summary = {
    httpStatus: response && response.status,
    httpStatusText: response && response.statusText,
    response: data.Response,
    error: data.Error,
    title: data.Title,
    year: data.Year,
    type: data.Type,
    imdbID: data.imdbID,
    runtime: data.Runtime,
    genre: data.Genre,
    imdbVotes: data.imdbVotes,
    seriesID: data.seriesID,
    season: data.Season,
    episode: data.Episode
  };
  if (Array.isArray(data.Search)) {
    summary.resultCount = data.Search.length;
    summary.results = data.Search.slice(0, 20).map(result => ({
      title: result.Title,
      year: result.Year,
      type: result.Type,
      imdbID: result.imdbID
    }));
  }
  return summary;
}

// Turns Mynda's stored series name into a cleaner OMDb query title and an
// optional series premiere year. It handles folder-style forms such as
// "Prisoner, The (2009)" without changing the value stored in the library.
function extractSeriesSearchParts(series) {
  let title = series.trim();
  let year = null;

  // A year attached to the series name can distinguish two series with the
  // same title. It is a series year, unlike video.year, which is normally the
  // air year of one episode and is deliberately ignored here.
  let yearMatch = title.match(/\s*[\[(]((?:19|20)\d{2})(?:\s*-\s*(?:19|20)\d{2})?[\])]\s*$/);
  if (yearMatch) {
    year = yearMatch[1];
    title = title.slice(0, yearMatch.index).trim();
  }

  // Normalize a few common folder-name conventions without changing the
  // series value stored in the library.
  title = title.replace(/^(.+),\s*(The|An|A)$/i, (whole, name, article) => `${article} ${name}`);
  title = title.replace(/\s+-\s+\d{1,2}\s+-\s+/g, ' ');
  title = title.replace(/\s{2,}/g, ' ').trim();

  return {title: title, year: year};
}

// Looks for a premiere year or year range in the folder that supplied the
// video's series name. findSeasonEpisode() deliberately cleans release details
// out of the stored series value, so a folder such as
// "Kung Fu 1972-1975 (complete original TV series...)" becomes simply
// "Kung Fu" in the library. The discarded first year is still valuable when
// OMDb contains an original series and a same-name remake.
//
// This does not grab an arbitrary year from the path. The text before the year
// must normalize to exactly the stored series title. Thus a parent named
// "Archive 1972-1975" or a season folder containing an episode air year cannot
// influence the series search.
function extractSeriesFolderYear(filename, seriesTitle) {
  let expectedTitle = comparableSeriesTitle(seriesTitle);
  if (!expectedTitle || typeof filename !== 'string' || !filename.trim()) {
    return null;
  }

  // Split on both separators so this works with libraries created on either
  // macOS or Windows, regardless of the OS currently running Mynda.
  let folders = filename.split(/[\\/]+/).slice(0, -1).reverse();
  for (let folder of folders) {
    let yearMatch = folder.match(
      /(?:^|[\s.(\[_-])((?:19|20)\d{2})(?:\s*[-–—]\s*(?:19|20)\d{2})?(?=$|[\s.)\]_-])/
    );
    if (!yearMatch) {
      continue;
    }

    let titleBeforeYear = folder.slice(0, yearMatch.index).trim();
    if (comparableSeriesTitle(titleBeforeYear) === expectedTitle) {
      return yearMatch[1];
    }
  }
  return null;
}

// Combines an explicit year written in the editable series field with the
// conservative folder hint above. The explicit value wins. video.year is not
// used because it describes one episode's air year, not the series premiere.
function seriesSearchPartsForVideo(video) {
  let series = video && typeof video.series === 'string' ? video.series.trim() : '';
  let searchParts = extractSeriesSearchParts(series);
  searchParts.yearSource = searchParts.year ? 'series field' : null;
  if (!searchParts.year) {
    searchParts.year = extractSeriesFolderYear(video && video.filename, searchParts.title);
    if (searchParts.year) {
      searchParts.yearSource = 'series folder';
    }
  }
  return searchParts;
}

// Returns narrowly targeted query alternatives for titles whose only likely
// catalog spelling difference is the conjunction: "Law and Order" becomes
// "Law & Order", and "Me & You" becomes "Me and You". Whole-word matching
// prevents an "and" inside a word such as "Candy" from being changed.
function andAmpersandTitleAlternates(title) {
  let original = String(title || '').trim();
  let alternatives = [];
  const addAlternative = value => {
    value = value.replace(/\s{2,}/g, ' ').trim();
    if (value && value !== original && !alternatives.includes(value)) {
      alternatives.push(value);
    }
  };

  if (/\band\b/i.test(original)) {
    addAlternative(original.replace(/\band\b/gi, '&'));
  }
  if (/&/.test(original)) {
    addAlternative(original.replace(/\s*&\s*/g, ' and '));
  }
  return alternatives;
}

// Returns the part of a series name before a final standalone uppercase
// acronym. This is a discovery aid for names such as "Law and Order SVU":
// OMDb may find nothing for the abbreviation even though a broader search for
// "Law and Order" returns "Law & Order: Special Victims Unit". Lowercase
// words, punctuation-bound suffixes, acronyms longer than six characters, and
// acronym-only names are deliberately excluded so ordinary titles are never
// shortened by this fallback.
function terminalAcronymSearchPrefix(title) {
  let original = String(title || '').trim();
  let match = original.match(/^(.+?)\s+([A-Z0-9]{2,6})$/);
  if (!match || !/[A-Z]/.test(match[2])) {
    return null;
  }
  return {
    title: match[1].trim(),
    acronym: match[2]
  };
}

function comparableCatalogTitle(title) {
  return String(title || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '');
}

function searchResultsContainTitle(results, requestedTitle) {
  let requested = comparableCatalogTitle(requestedTitle);
  return Boolean(requested && (Array.isArray(results) ? results : []).some(result => {
    return comparableCatalogTitle(result && result.Title) === requested;
  }));
}

// Produces an aggressive comparison key for a series title. Display-only
// differences such as punctuation, accents, a leading article, "&" versus
// "and", "Dr" versus "Doctor", and dotted initialisms are normalized away.
function comparableSeriesTitle(title) {
  let normalized = String(title || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  normalized = normalized.replace(/^(.+),\s*(The|An|A)$/i, (whole, name, article) => `${article} ${name}`);
  let initialParts = normalized.match(/[a-z0-9]+/gi) || [];
  if (initialParts.length >= 2 && initialParts.every(part => part.length === 1)) {
    // Treat dotted initialisms as words, and collapse an immediately repeated
    // initial (for example the real-world folder typo "E.R..R" -> "ER").
    normalized = initialParts.filter((part, index) => {
      return index === 0 || part.toLowerCase() !== initialParts[index-1].toLowerCase();
    }).join('');
  }
  normalized = normalized.toLowerCase().replace(/&/g, ' and ').replace(/\bdr\.?\b/g, 'doctor');
  normalized = normalized.replace(/^\s*(?:the|an|a)\s+/, '');
  return normalized.replace(/[^a-z0-9]+/g, '');
}

function seriesCacheKey(searchParts) {
  return `${comparableSeriesTitle(searchParts.title)}|${searchParts.year || ''}`;
}

// Tokenizes a series title for acronym comparison. Unlike the compact key
// above, this retains word boundaries and capitalization so a terminal token
// such as "SVU" or "MST3K" can be recognized as an acronym.
function seriesTitleWords(title) {
  let value = String(title || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  value = value.replace(/^(.+),\s*(The|An|A)$/i, (whole, name, article) => `${article} ${name}`);
  value = value.replace(/&/g, ' and ').replace(/\bdr\.?\b/gi, 'Doctor');
  let words = value.match(/[a-z0-9]+/gi) || [];
  if (/^(?:the|an|a)$/i.test(words[0])) {
    words.shift();
  }
  return words;
}

// Tests whether the final token of the requested title abbreviates the
// remaining words in an OMDb title: for example, "Law and Order SVU" matches
// "Law & Order: Special Victims Unit", and "MST3K" matches
// "Mystery Science Theater 3000".
function seriesAcronymMatches(requestedTitle, resultTitle) {
  let requestedWords = seriesTitleWords(requestedTitle);
  let resultWords = seriesTitleWords(resultTitle);
  if (requestedWords.length === 0 || resultWords.length === 0) {
    return false;
  }

  let mismatch = 0;
  while (mismatch < requestedWords.length-1 && mismatch < resultWords.length &&
         requestedWords[mismatch].toLowerCase() === resultWords[mismatch].toLowerCase()) {
    mismatch++;
  }

  let acronym = requestedWords[mismatch];
  if (mismatch !== requestedWords.length-1 || !/^(?=.*[A-Z])[A-Z0-9]{2,6}$/.test(acronym || '')) {
    return false;
  }

  const numberInitials = {
    zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5',
    six: '6', seven: '7', eight: '8', nine: '9', ten: '10'
  };
  let expandedInitials = resultWords.slice(mismatch).map(word => {
    let lowerWord = word.toLowerCase();
    if (numberInitials[lowerWord]) {
      return numberInitials[lowerWord];
    }
    if (/^\d000$/.test(lowerWord)) {
      return `${lowerWord[0]}k`;
    }
    return lowerWord[0];
  }).join('');

  return acronym.toLowerCase() === expandedInitials;
}

// Calculates Levenshtein edit distance: the minimum number of single-character
// insertions, deletions, or substitutions needed to turn one string into the
// other. Series matching uses it only to tolerate very small spelling errors.
function editDistance(left, right) {
  let previous = Array.from({length: right.length+1}, (value, index) => index);
  for (let i=1; i<=left.length; i++) {
    let current = [i];
    for (let j=1; j<=right.length; j++) {
      current[j] = Math.min(
        current[j-1]+1,
        previous[j]+1,
        previous[j-1]+(left[i-1] === right[j-1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return previous[right.length];
}

// Applies the complete conservative title-matching policy. It accepts normalized
// equality and supported acronyms, optionally accepts a substantial contained
// title, and finally permits at most one or two spelling edits for longer names.
function seriesTitlesMatch(requestedTitle, resultTitle, allowContainedTitle) {
  let requested = comparableSeriesTitle(requestedTitle);
  let result = comparableSeriesTitle(resultTitle);
  if (!requested || !result) {
    return false;
  }
  if (requested === result) {
    return true;
  }
  if (seriesAcronymMatches(requestedTitle, resultTitle)) {
    return true;
  }

  let longer = requested.length >= result.length ? requested : result;
  let shorter = requested.length < result.length ? requested : result;
  if (allowContainedTitle && shorter.length >= 6 && longer.includes(shorter) && shorter.length/longer.length >= 0.35) {
    return true;
  }

  // Permit a small spelling discrepancy, but only for substantial titles.
  let allowedEdits = longer.length >= 14 ? 2 : (longer.length >= 7 ? 1 : 0);
  return allowedEdits > 0 && editDistance(requested, result) <= allowedEdits;
}

// Produces a deliberately strict comparison key for episode titles. It ignores
// punctuation and a few display-only conventions, including "Chapter 4: Title",
// "Chapter Four 'Title'", and equivalent part suffixes such as "(1)" versus
// "Part I". Unlike series matching, it does not use substring or edit-distance
// matching: a nearby episode number is accepted only when the titles clearly
// agree.
function comparableEpisodeTitle(title) {
  let normalized = String(title || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '');

  // Some shows use an editorial chapter wrapper around the real episode title.
  // Heroes, for example, is returned by OMDb as "Chapter One 'Genesis'" even
  // when the release filename contains only "Genesis". Treat the wrapper as
  // presentation text, but require a numeric/number-word chapter and either a
  // clear separator or balanced-looking quotation marks. This remains much
  // stricter than accepting an arbitrary substring of an episode title.
  const smallNumber = '(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)';
  const tensNumber = '(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[\\s-]+(?:one|two|three|four|five|six|seven|eight|nine))?';
  const chapterNumber = `(?:\\d{1,3}|${smallNumber}|${tensNumber})`;
  normalized = normalized.replace(
    new RegExp(`^\\s*(?:episode|chapter)\\s+${chapterNumber}\\s+['\"“‘](.+)['\"”’]\\s*$`, 'i'),
    '$1'
  );
  normalized = normalized.replace(
    new RegExp(`^\\s*(?:episode|chapter)\\s+${chapterNumber}\\s*[:\\-–—]\\s*`, 'i'),
    ''
  );

  const partNumbers = {
    one: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    i: 1, ii: 2, iii: 3, iv: 4, v: 5,
    vi: 6, vii: 7, viii: 8, ix: 9, x: 10
  };
  const normalizePartNumber = value => {
    let key = String(value || '').toLowerCase();
    let number = /^\d{1,2}$/.test(key) ? Number(key) : partNumbers[key];
    return number >= 1 && number <= 10 ? number : null;
  };
  const replacePartSuffix = (whole, value) => {
    let number = normalizePartNumber(value);
    return number === null ? whole : ` part ${number}`;
  };

  normalized = normalized.replace(
    /\s*(?:[:\-–—]\s*)?(?:part|pt)\.?\s*(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|i{1,3}|iv|v|vi{0,3}|ix|x)\s*$/i,
    replacePartSuffix
  );
  normalized = normalized.replace(
    /\s*[\[(](\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|i{1,3}|iv|v|vi{0,3}|ix|x)[\])]\s*$/i,
    replacePartSuffix
  );

  normalized = normalized.toLowerCase().replace(/&/g, ' and ');
  return normalized.replace(/[^a-z0-9]+/g, '');
}

// Older releases sometimes leave presentation/source flags at the end of the
// title extracted from their filename. For example, the ER files in the user's
// library produce titles such as "Day One FS", "Chicago Heat WS", and
// "Another Perfect Day FS DVD-SFM". These are not alternate episode titles:
// FS and WS mean fullscreen and widescreen, while the following tokens describe
// the audio, disc/source, encoder, or codec.
//
// Keep this deliberately narrower than the general filename parser. A suffix is
// removable only when it starts with the standalone FS or WS release flag, and
// every later token is also recognized technical metadata. Unknown trailing
// words are preserved, so "Day One fan edit" cannot become a match for OMDb's
// "Day One" merely because the beginning happens to agree.
function stripTrailingEpisodeReleaseFlags(title) {
  let original = String(title || '').trim();
  let stripped = original.replace(
    /[\s._-]+(?:fs|ws)(?:[\s._-]+(?:ac-?3|eac-?3|aac|dvd(?:rip)?|sfm|smis|xvid|x26[45]|h26[45]|hevc))*\s*$/i,
    ''
  ).trim();

  // Never turn a title made entirely from release flags into an empty match.
  return stripped ? stripped : original;
}

function episodeTitlesMatch(localTitle, omdbTitle) {
  let local = comparableEpisodeTitle(localTitle);
  let omdb = comparableEpisodeTitle(omdbTitle);
  if (!local || !omdb) {
    return false;
  }
  if (local === omdb) {
    return true;
  }

  // Only the local filename-derived title can contain release flags. After
  // removing a recognized trailing run, still require exact normalized title
  // equality. The four-character minimum retains useful short titles such as
  // ER's "Home FS" while rejecting very weak one- or two-letter evidence.
  let localWithoutReleaseFlags = comparableEpisodeTitle(
    stripTrailingEpisodeReleaseFlags(localTitle)
  );
  return localWithoutReleaseFlags.length >= 4 &&
    localWithoutReleaseFlags !== local && localWithoutReleaseFlags === omdb;
}

// findEpisodeTitle() leaves the complete basename in video.title when it could
// not confidently extract a real episode title. Only a title that differs from
// that fallback, and contains enough information to be useful, may correct an
// nearby OMDb episode number.
function localEpisodeTitleForVerification(video) {
  let title = video && typeof video.title === 'string' ? video.title.trim() : '';
  let filename = video && typeof video.filename === 'string' ? video.filename : '';
  if (!title || !filename) {
    return null;
  }

  let basename = path.basename(filename, path.extname(filename)).trim();
  let titleKey = comparableEpisodeTitle(title);
  if (titleKey.length < 6 || titleKey === comparableEpisodeTitle(basename)) {
    return null;
  }
  return title;
}

// Checks an optional series-year hint against OMDb's Year field. startsWith()
// deliberately accepts both a single year and ranges such as "2005–2013".
function seriesYearMatches(requestedYear, resultYear) {
  return !requestedYear || String(resultYear || '').startsWith(requestedYear);
}

// Ranks valid series results instead of treating every plausible title match as
// equally strong. An exact normalized title wins over acronyms, and acronyms
// win over contained/fuzzy matches. This prevents an exact "Friends" result
// from becoming ambiguous merely because OMDb also returned "Smiling Friends."
function matchingSeriesResults(requestedTitle, requestedYear, results) {
  let eligible = (Array.isArray(results) ? results : []).filter(result => {
    return result && result.Type === 'series' && result.imdbID &&
      seriesYearMatches(requestedYear, result.Year);
  });

  let exact = eligible.filter(result => {
    return comparableSeriesTitle(requestedTitle) === comparableSeriesTitle(result.Title);
  });
  if (exact.length > 0) {
    return {matchStrength: 'exact', candidates: exact};
  }

  let acronym = eligible.filter(result => seriesAcronymMatches(requestedTitle, result.Title));
  if (acronym.length > 0) {
    return {matchStrength: 'acronym', candidates: acronym};
  }

  let fuzzy = eligible.filter(result => seriesTitlesMatch(requestedTitle, result.Title, true));
  return {matchStrength: 'fuzzy', candidates: fuzzy};
}

// Converts an OMDb series search result into a stable choice object that any
// caller can present to a user. OmdbHelper itself remains unaware of whether
// the search was initiated manually or by automatic tagging.
function makeSeriesChoice(result) {
  return {
    Poster: result.Poster,
    Title: result.Title,
    Type: 'series',
    Year: result.Year,
    imdbID: result.imdbID,
    myndaChoiceType: 'series'
  };
}

function ambiguousSeriesFailure(series, candidates) {
  let failure = predictableFailure(
    'Ambiguous series',
    `More than one OMDb series matches "${series}"`
  );
  failure.choiceType = 'series';
  failure.choices = candidates.map(makeSeriesChoice);
  return failure;
}

// When two series have the same exact title, test the requested episode against
// each series ID. If Mynda has a clean filename-derived episode title, require
// that title to agree as well. This matters when both an original and a remake
// have the same S/E number, and it prevents the only series with a returned
// episode from winning when its title clearly describes different content.
// Without a usable local title, retain the older existence-only fallback.
async function disambiguateSeriesByEpisode(candidates, season, episode, localTitle, context) {
  let episodeMatches = [];
  for (let candidate of candidates) {
    let response = await pollOMDB(createURLParts({
      id: candidate.imdbID,
      season: season,
      episode: episode
    }), {
      searchID: context.searchID,
      stage: 'series disambiguation episode probe'
    });
    let failure = requestFailure(response);
    if (!failure && episodeResponseMatches(response.data, candidate.imdbID, season, episode)) {
      episodeMatches.push({
        candidate: candidate,
        episodeData: response.data,
        titleMatches: localTitle ? episodeTitlesMatch(localTitle, response.data.Title) : null
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

  // A title extracted independently from the filename is stronger evidence
  // than episode existence. Kung Fu S1E6 exposed why: OMDb temporarily returned
  // no episode for the 1972 series and "Rage" for the 2021 series, while the
  // local title was "The Soul Is the Warrior". Existence alone selected and
  // cached the remake; a clear title disagreement must instead stay ambiguous.
  let decisiveMatches = localTitle ?
    episodeMatches.filter(match => match.titleMatches) : episodeMatches;
  if (decisiveMatches.length === 1) {
    return {
      success: true,
      candidate: decisiveMatches[0].candidate,
      episodeData: decisiveMatches[0].episodeData
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

// Resolves a Mynda series name to one IMDb series ID. It checks the cache,
// searches series-only results so same-name remakes can be detected, refuses to
// guess when several candidates match, and uses OMDb's single-title endpoint as
// a carefully validated fallback. Expected failures and API errors are returned
// in the same result format as search().
async function resolveSeries(video, season, episode, localTitle, context, options = {}) {
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

  let cacheKey = seriesCacheKey(searchParts);
  if (!options.ignoreStoredSeriesImdbID && validSeriesImdbID(video.seriesImdbID)) {
    let storedID = video.seriesImdbID.trim();
    seriesIdCache.set(cacheKey, storedID);
    log.debug('Using stored IMDb series ID', {
      searchID: context.searchID,
      queryTitle: searchParts.title,
      queryYear: searchParts.year,
      imdbID: storedID
    });
    return {success: true, data: storedID};
  }
  if (!options.ignoreSeriesCache && seriesIdCache.has(cacheKey)) {
    let cachedID = seriesIdCache.get(cacheKey);
    log.debug('Using cached IMDb series ID', {
      searchID: context.searchID,
      queryTitle: searchParts.title,
      queryYear: searchParts.year,
      imdbID: cachedID
    });
    return {success: true, data: cachedID};
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
      let response = await pollOMDB(createURLParts({
        title: queryTitle,
        year: searchParts.year,
        type: 'series'
      }), {
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
        response.data.Search
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
      seriesIdCache.set(cacheKey, result.imdbID);
      return {success: true, data: result.imdbID};
    }
    if (candidates.length > 1) {
      // Exact and acronym matches are strong enough to disambiguate further
      // by testing the requested episode. Fuzzy candidates remain a manual
      // choice because an episode existing in a loosely related series is not
      // strong enough evidence by itself.
      if (matches.matchStrength === 'exact' || matches.matchStrength === 'acronym') {
        let episodeResult = await disambiguateSeriesByEpisode(
          candidates, season, episode, localTitle, context
        );
        if (episodeResult.requestFailure) {
          return episodeResult.requestFailure;
        }
        if (episodeResult.success) {
          seriesIdCache.set(cacheKey, episodeResult.candidate.imdbID);
          return {
            success: true,
            data: episodeResult.candidate.imdbID,
            episodeData: episodeResult.episodeData
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
      let response = await pollOMDB(createURLParts({
        series: queryTitle,
        year: searchParts.year,
        type: 'series'
      }), {
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
      if (result.Type === 'series' && result.imdbID &&
          seriesYearMatches(searchParts.year, result.Year) &&
          seriesTitlesMatch(searchParts.title, result.Title, false)) {
        seriesIdCache.set(cacheKey, result.imdbID);
        return {success: true, data: result.imdbID};
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
      return predictableFailure('Ambiguous series', `Could not confidently identify the series "${series}"`);
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

// Resolve one authoritative parent-series ID before a homogeneous selected
// batch begins saving episodes. Stored IDs and the process cache are bypassed:
// this path is specifically for an unsettled batch, including one whose videos
// disagree about their saved seriesImdbID values. Prefer a usable episode with
// an independently extracted local title because it supplies the strongest
// evidence when same-name originals and remakes both exist.
async function resolveSeriesForBatch(videos) {
  const context = {searchID: `${process.pid}-${++nextSearchNumber}`};
  const candidates = (Array.isArray(videos) ? videos : [])
    .filter(video => video && video.kind === 'show' &&
      typeof video.series === 'string' && video.series.trim() &&
      normalizeEpisodeNumber(video.season) !== null &&
      normalizeEpisodeNumber(video.episode) !== null)
    .map(video => ({
      video: video,
      season: normalizeEpisodeNumber(video.season),
      episode: normalizeEpisodeNumber(video.episode),
      localTitle: localEpisodeTitleForVerification(video)
    }));

  const representative = candidates.find(candidate => candidate.localTitle) || candidates[0];
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
    return failure;
  }

  const result = await resolveSeries(
    representative.video,
    representative.season,
    representative.episode,
    representative.localTitle,
    context,
    {
      ignoreStoredSeriesImdbID: true,
      ignoreSeriesCache: true
    }
  );

  if (result.success && validSeriesImdbID(result.data)) {
    const success = {success: true, data: result.data.trim()};
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
  return result;
}

// Final guard before metadata is applied. The response must describe an episode
// with an IMDb ID and exactly the requested series, season, and episode numbers.
function episodeResponseMatches(data, seriesID, season, episode) {
  return data && data.Response === 'True' && data.Type === 'episode' &&
    data.imdbID && normalizeEpisodeNumber(data.Season) === season &&
    normalizeEpisodeNumber(data.Episode) === episode &&
    (!data.seriesID || data.seriesID === seriesID);
}

// Some releases use a different episode order from OMDb (for example, a pilot
// stored as episode 0 or a small block of episodes rearranged on home video).
// When Mynda has a real extracted title, inspect the immediately adjacent
// episodes first. Only when neither matches, inspect episodes two places away.
// A correction is accepted only when exactly one title at that distance is an
// exact normalized match, keeping the wider search conservative.
async function findNearbyEpisodeByTitle(seriesID, season, episode, localTitle, context) {
  let episodeNumber = Number(episode);
  for (let distance of [1, 2]) {
    let nearbyEpisodes = [episodeNumber-distance, episodeNumber+distance]
      .filter(number => number >= 0)
      .map(String);
    let matches = [];

    for (let nearbyEpisode of nearbyEpisodes) {
      let response = await pollOMDB(createURLParts({
        id: seriesID,
        season: season,
        episode: nearbyEpisode
      }), {searchID: context.searchID, stage: 'nearby episode title probe'});
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

      let titleMatches = episodeTitlesMatch(localTitle, response.data.Title);
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
        matches.push({episode: nearbyEpisode, data: response.data});
      }
    }

    if (matches.length === 1) {
      log.warn('Corrected shifted OMDb episode number using the local title', {
        searchID: context.searchID,
        localTitle: localTitle,
        requested: {season: season, episode: episode},
        matched: {
          season: season,
          episode: matches[0].episode,
          distance: distance,
          title: matches[0].data.Title,
          imdbID: matches[0].data.imdbID
        }
      });
      return {
        success: true,
        data: matches[0].data,
        episode: matches[0].episode
      };
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
  }
  return {success: false};
}

// Show-specific auto-tagging workflow. It validates Mynda's series/season/episode
// fields, resolves and caches the IMDb series ID, retrieves the exact episode,
// validates that response, applies its metadata, and downloads available art.
// A confidently extracted local title may correct an OMDb episode number up to
// two places away, but it never changes the season/episode stored by Mynda.
async function searchShowEpisode(video, context, selectedSeriesImdbID) {
  let series = typeof video.series === 'string' ? video.series.trim() : '';
  let season = normalizeEpisodeNumber(video.season);
  let episode = normalizeEpisodeNumber(video.episode);

  if (!series || season === null || episode === null) {
    let reason = String(video.season).toLowerCase() === 'extras' ?
      'OMDb does not assign ordinary season and episode numbers to Mynda extras' :
      'A show needs series, season, and episode values for auto-tagging';
    log.warn('Show episode lookup does not have usable identifiers', {
      searchID: context.searchID,
      series: series,
      season: video.season,
      episode: video.episode,
      reason: reason
    });
    return predictableFailure('Not enough data', reason);
  }

  // Resolve this before choosing a series so a clean filename-derived episode
  // title can distinguish same-name originals and remakes during the probes.
  let localTitle = localEpisodeTitleForVerification(video);
  let seriesResult;
  if (typeof selectedSeriesImdbID !== 'undefined') {
    if (!validSeriesImdbID(String(selectedSeriesImdbID))) {
      return predictableFailure('Invalid series selection', 'The selected series did not have a valid IMDb ID');
    }
    selectedSeriesImdbID = String(selectedSeriesImdbID).trim();
    log.debug('Using caller-selected series for episode lookup', {
      searchID: context.searchID,
      series: series,
      selectedSeriesImdbID: selectedSeriesImdbID
    });
    let selectedSearchParts = seriesSearchPartsForVideo(video);
    let selectedCacheKey = seriesCacheKey(selectedSearchParts);
    seriesIdCache.set(selectedCacheKey, String(selectedSeriesImdbID));
    seriesResult = {success: true, data: String(selectedSeriesImdbID)};
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
    let matchedEpisode = episode;
    let lookupFailure = null;
    if (!episodeData) {
      let response = await pollOMDB(createURLParts({
        id: seriesID,
        season: season,
        episode: episode
      }), {searchID: context.searchID, stage: 'episode lookup'});
      lookupFailure = requestFailure(response);
      if (!lookupFailure) {
        episodeData = response.data;
      }
    }

    if (lookupFailure) {
      // A missing episode 0 is the common signal for a release whose numbering
      // is shifted by one. Do not broaden the search unless the filename parser
      // supplied a useful title that can verify the nearby result.
      if (lookupFailure.failure === 'No results' && localTitle) {
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
      if (!episodeData) {
        return lookupFailure;
      }
    }

    if (!episodeResponseMatches(episodeData, seriesID, season, matchedEpisode)) {
      log.warn('OMDb episode response did not match the request', {
        searchID: context.searchID,
        expected: {seriesID: seriesID, season: season, episode: matchedEpisode},
        received: summarizeOMDbResponse({status: 200, data: episodeData})
      });
      return predictableFailure(
        'Episode mismatch',
        `OMDb did not return a valid episode for ${series} S${season}E${episode}`
      );
    }

    // A structurally valid S/E response can still describe the wrong content
    // when a release uses a different episode order. A unique nearby title
    // match is stronger evidence than the numeric label alone. If no nearby title
    // matches, preserve the existing exact-S/E behavior to avoid introducing
    // false negatives for alternate episode titles.
    if (matchedEpisode === episode && localTitle &&
        !episodeTitlesMatch(localTitle, episodeData.Title)) {
      let correction = await findNearbyEpisodeByTitle(
        seriesID, season, episode, localTitle, context
      );
      if (correction.success) {
        episodeData = correction.data;
        matchedEpisode = correction.episode;
      } else {
        log.warn('Local and OMDb episode titles differed; retaining the exact season/episode result', {
          searchID: context.searchID,
          localTitle: localTitle,
          omdbTitle: episodeData.Title,
          season: season,
          episode: episode,
          nearbyProbeError: summarizeError(correction.requestFailure && correction.requestFailure.data)
        });
      }
    }

    let taggedVideo = addTagsToVideo(_.cloneDeep(video), episodeData, context);
    taggedVideo.seriesImdbID = seriesID;
    taggedVideo.artwork = await downloadArtworkWithSeriesFallback(
      episodeData,
      seriesID,
      context
    );
    return {success: true, data: taggedVideo};
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

// Extracts the parameters used by the general movie/IMDb-ID search. IMDb ID wins;
// otherwise the title falls back to the filename, an explicit or embedded year
// is included when available, and Mynda's kind is translated to OMDb's type.
function extractParts(video) {
  let persisting = {};
  // first check to see if an IMDb ID exists
  if (video.imdbID && video.imdbID !== '') {
    // if they have, then we add that to the search
    persisting.id = video.imdbID;
  } else {
    // otherwise, we want to query the database using the existing field values
    // of the movie object, if present; OMDB only allows us to search by Title,
    // Year, and Type;
    // if the title field is empty, we will substitute the file name
    // const filename = this.props.video.filename.match(/[^/]+$/)[0]; // get just the filename from the path // /[^/]+(?=\.\w{2,4}$)/
    let filename = path.basename(video.filename,path.extname(video.filename));
    //console.log('filename: ' + filename);
    persisting.title = video.title || filename;
    persisting.year = video.year || null;
    let typeConversion = {movie: 'movie', show: 'episode', episode: 'episode', series: 'series'}
    let videoType = video.kind || video.type;
    if (videoType && typeConversion[videoType]) {
      persisting.type = typeConversion[videoType];
    }

    // if we have no year, see if a year-like string is in the file name or title
    if (persisting.year === null) {
      let str = persisting.title
      // find any 4 digit strings starting with 19 or 20
      let results = str.match(/(?:19|20)\d{2}/g);
      try {
        // filter the results for years no more than 1 in the future
        results = results.filter(el => {
          return Number(el) <= Number(new Date().getFullYear()) + 1;
        });

        // for now, just pick the first one
        if (results[0]) {
          persisting.year = results[0];
        }
      } catch(err) {
        // there were no results, so we do nothing
      }
    }
  }
  return persisting;
}

// Maps Mynda's internal search-property names to OMDb query parameters, safely
// URL-encodes every value, and returns an array that pollOMDB() can join with &.
function createURLParts(persisting) {
  let urlParts = [`https://www.omdbapi.com/?apikey=${encodeURIComponent(omdb.key)}`];
  let possibleParts = ['id', 'title', 'exactTitle', 'year', 'type', 'series', 'season', 'episode'];
  let prefixes = {id: 'i', title: 's', exactTitle: 't', year: 'y', type: 'type', series: 't', season: 'Season', episode: 'Episode'};
  for (let part of possibleParts) {
    if (persisting[part] !== null && typeof persisting[part] !== 'undefined' && persisting[part] !== '') {
      urlParts.push(`${prefixes[part]}=${encodeURIComponent(persisting[part])}`);
    }
  }
  return urlParts;
}

// Performs one OMDb GET request with a 20-second timeout. The raw Axios response
// is resolved for the caller to classify; transport failures reject the promise.
// Diagnostics deliberately record only the non-secret query parameters.
async function pollOMDB(urlParts, context = {}) {
  let requestDetails = {
    searchID: context.searchID,
    stage: context.stage,
    parameters: requestParametersForLog(urlParts)
  };
  log.debug('OMDb request started', requestDetails);
  try {
    let response = await axios({
      method: 'get',
      url: urlParts.join('&'),
      timeout: 20000,
    });
    log.debug('OMDb response received', {
      searchID: context.searchID,
      stage: context.stage,
      request: requestDetails.parameters,
      response: summarizeOMDbResponse(response)
    });
    return response;
  } catch(error) {
    log.error('OMDb request failed', {
      searchID: context.searchID,
      stage: context.stage,
      request: requestDetails.parameters,
      error: summarizeError(error)
    });
    throw {Error: error};
  }
}

// Mutates a Mynda video with the full metadata from one OMDb title or episode.
// It normalizes OMDb field names, merges genres into existing tags, preserves
// unrelated Mynda-only fields (including kind, series, season, and episode),
// and treats an unavailable individual field as nonfatal so the rest can still
// be applied.
function addTagsToVideo(video, data, context = {}) {
  //console.log(JSON.stringify(video));
  video.imdbID = data.imdbID;
  if (video.kind === 'show') {
    if (validSeriesImdbID(data.seriesID)) {
      video.seriesImdbID = data.seriesID.trim();
    } else if (!validSeriesImdbID(video.seriesImdbID)) {
      video.seriesImdbID = '';
    }
  } else {
    video.seriesImdbID = '';
  }
  video.title = data.Title;
  delete video.Title;
  video.description = data.Plot;
  video.artwork = data.Poster; // the MynEditArtwork component will do the work to actually download the image from this url and change the reference to the local file when finished
  if (video.artwork === "N/A") video.artwork = '';
  delete video.Poster;
  video.year = data.Year;
  delete video.Year;
  video.director = data.Director,
  // OMDb's Type describes its record, not the user's Mynda category. In
  // particular, overwriting this field destroyed custom kinds. The video was
  // already categorized before tagging, so preserve that value unchanged.
  delete video.Type;
  video.country = data.Country;
  video.rated = data.Rated;
  try {
    video.boxoffice = accounting.parse(data.BoxOffice) || 0; //parseInt(response.data.BoxOffice.replace(/[^0-9.-]/g,'')) || null, // this may fail miserably in other locales, but assuming OMDB always uses $0,000,000.00 format, it'll be fine
  } catch(err) { log.debug('OMDb did not supply a usable box-office value', {searchID: context.searchID, error: summarizeError(err)}); }
  try {
    video.directorsort = /^\w+\s\w+$/.test(data.Director) ? data.Director.replace(/^(\w+)\s(\w+)$/,($match,$1,$2) => `${$2}, ${$1}`) : data.Director; // if the director field consists only of a first and last name separated by a space, set directorsort to 'lastname, firstname', otherwise, leave as-is and let the user edit it manually
  } catch(err) { log.debug('OMDb did not supply a usable director-sort value', {searchID: context.searchID, error: summarizeError(err)}); }
  try {
    video.cast = data.Actors.split(', ');
  } catch(err) { log.debug('OMDb did not supply usable actors', {searchID: context.searchID, error: summarizeError(err)}); }
  try {
    video.genre = data.Genre.split(', ')[0]; // just pick the first genre for genre, since we only allow one
  } catch(err) { log.debug('OMDb did not supply a usable primary genre', {searchID: context.searchID, error: summarizeError(err)}); }
  try {
    video.languages = data.Language.split(', ');
  } catch(err) { log.debug('OMDb did not supply usable languages', {searchID: context.searchID, error: summarizeError(err)}); }
  try {
    video.tags = video.tags || [];
    video.tags = Array.from(new Set(data.Genre.split(', ').map((item) => item.toLowerCase()).concat(video.tags))); // add new tags to existing tags, removing duplicates
  } catch(err) { log.debug('OMDb did not supply usable genre tags', {searchID: context.searchID, error: summarizeError(err)}); }
  let ratings = _.cloneDeep(video.ratings) || {};
  try {
    ratings.imdb = Number(data.Ratings.filter(object => object.Source == "Internet Movie Database")[0].Value.match(/^[\d\.]+(?=\/)/)); // / 10;
  } catch(err) { log.debug('OMDb did not supply an IMDb rating', {searchID: context.searchID, error: summarizeError(err)}); }
  try {
    ratings.rt = Number(data.Ratings.filter(object => object.Source == "Rotten Tomatoes")[0].Value.match(/^\d+/)); // / 100;
  } catch(err) { log.debug('OMDb did not supply a Rotten Tomatoes rating', {searchID: context.searchID, error: summarizeError(err)}); }
  try {
    ratings.mc = Number(data.Ratings.filter(object => object.Source == "Metacritic")[0].Value.match(/^\d+(?=\/)/)); // / 100;
  } catch(err) { log.debug('OMDb did not supply a Metacritic rating', {searchID: context.searchID, error: summarizeError(err)}); }
  video.ratings = ratings;
  return video;
}

// Downloads an OMDb poster into Mynda's user-data Artwork folder and resolves
// with the local filepath. It reuses an existing file and supports calls from
// either Electron's main process or renderer process.
function downloadArt(url, context = {}) {
  return new Promise(function(resolve, reject) {
    let fileExt = path.extname(url)
    let fileName = path.basename(url, fileExt);
    log.debug('Preparing OMDb artwork download', {searchID: context.searchID, sourceFilename: fileName});
    fileName = fileName.replace(/[\*\."/\\\[\]:;\|,]/g, '') + fileExt;
    log.debug('Prepared local OMDb artwork filename', {searchID: context.searchID, localFilename: fileName});
    let filePath = path.join((electron.app || electron.remote.app).getPath('userData'),'Library','Artwork', fileName);
    if (fs.existsSync(filePath)) {
      log.debug('Reusing existing OMDb artwork file', {
        searchID: context.searchID,
        destination: filePath
      });
      return resolve(filePath);
    }

    if (electron.app) {
      dl.download(url,filePath, (args) => {
        try {
          // if successful, we'll receive an object with the path at "path"
          if (args && Object.prototype.hasOwnProperty.call(args, 'path')) {
            log.debug('OMDb artwork download finished', {
              searchID: context.searchID,
              artworkSource: context.artworkSource,
              destination: args.path
            });
            resolve(args.path);
          } else {
            reject({
              message: args && args.message ? args.message : String(args || 'Download returned no path'),
              status: args && args.status,
              statusText: args && args.statusText
            });
          }
        } catch(error) {
          reject({
            message: error && error.message ? error.message : String(error),
            status: error && error.response && error.response.status,
            statusText: error && error.response && error.response.statusText
          });
        }
      });
    } else {
      // Every renderer download gets a private, one-use reply channel. The old
      // shared "downloaded" listener remained active forever and allowed one
      // download completion to resolve every outstanding artwork request.
      let responseChannel = `downloaded-omdb-${process.pid}-${++nextArtworkDownloadNumber}`;
      let handleDownload = (event, response) => {
        if (response && response.success) {
          let destination = response.message || filePath;
          log.debug('OMDb artwork download finished', {
            searchID: context.searchID,
            artworkSource: context.artworkSource,
            destination: destination
          });
          resolve(destination);
        } else {
          reject({
            message: response && response.message ? response.message : 'Download failed',
            status: response && response.status,
            statusText: response && response.statusText
          });
        }
      };
      ipcRenderer.once(responseChannel, handleDownload);
      try {
        ipcRenderer.send('download', url, filePath, responseChannel);
      } catch(err) {
        ipcRenderer.removeListener(responseChannel, handleDownload);
        reject(err);
      }
    }


    /*
    let file = fs.createWriteStream(filePath);
    let source = axios.CancelToken.source();
    axios({
      method: 'get',
      url: url,
      responseType: 'stream',
      timeout: 30000,
      cancelToken: source.token
    })
      .then(function (response) {
        /*if (response.status !== 200) {
          console.log(`OmdbHelper problem downloading artwork: ${response.status} : ${response.statusText}.`)
          reject();
        }
        // pipe data to file
        response.data.pipe(file);
      })
      .catch(function (error) {
        // delete file
        fs.unlink(filePath, (errfs) => {
          if (errfs) console.log(errfs);
          else {
            console.log("Deleted file");
          }
        });
        reject(error.message);
      })

      file.on('finish', () => {
        file.close();
        resolve(filePath);
      });

      file.on('error', (err) => { // Handle errors
          fs.unlink(filePath, (errfs) => {
            if (errfs) console.log(errfs);
            else {
              console.log("Deleted file");
            }
          });
          reject(err.message);
      });*/
  });
}

module.exports = {search, resolveSeriesForBatch};
