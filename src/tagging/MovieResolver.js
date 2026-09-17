const Response = require('./CatalogResponse');
const {isNotFoundResponse, isTooManyResultsResponse, predictableFailure, requestFailure} = Response;

const Identity = require('./SeriesIdentity');
const {andAmpersandTitleAlternates} = Identity;

const MovieSearch = require('./MovieSearch');

const MatchPolicy = require('./MatchPolicy');
const Decision = require('./TaggingDecision');
const Limits = require('./TaggingLimits');
function createMovieResolver({log, pollOMDB, createURLParts}) {

  async function searchGeneralVideoByTitle(video, context) {
    const MAX_TITLE_REQUESTS = Limits.movie.titleQueries;
    const MAX_NORMALIZED_DISCOVERY_REQUESTS = Limits.movie.normalizedQueries;
    const MAX_AMBIGUOUS_DETAIL_PROBES = Limits.movie.detailCandidates;
    let candidates = MovieSearch.buildSearchCandidates(video);
    if (candidates.length === 0) {
      return predictableFailure('Not enough data', 'No usable title or filename was available');
    }

    let titleRequestCount = 0;
    let normalizedDiscoveryRequestCount = 0;
    let choicesByID = new Map();
    let sawAmbiguousResponse = false;
    let sawUnresolvedExactAmbiguity = false;
    let attemptedTitles = [];
    let type = MovieSearch.omdbTypeForKind(video.kind || video.type);
    let fullResultCache = new Map();
    let deferredArticleGroups = [];

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

      let evaluation = MatchPolicy.evaluateMovie(
        fetched.data, candidate, video, validationOptions
      );
      logFullMovieEvaluation(context, candidate, fetched.data, evaluation, stage);
      if (!evaluation.confident) return {};

      return {
        terminalResult: Decision.candidate(video, fetched.data, {kind:'movie', candidate, evaluation, validationOptions, stage})
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
      const evaluations = new Map();
      for (let result of uniqueResults) {
        let fetched = await fetchGeneralVideoResult(
          result.imdbID, context, fullResultCache, `${stage} candidate detail`
        );
        if (!fetched.success) {
          if (fetched.failure === 'No results') continue;
          return {terminalResult: fetched};
        }

        let evaluation = MatchPolicy.evaluateMovie(
          fetched.data, candidate, video, validationOptions
        );
        logFullMovieEvaluation(context, candidate, fetched.data, evaluation, stage);
        if (evaluation.confident) { plausible.push(fetched.data); evaluations.set(fetched.data.imdbID,evaluation); }
      }

      if (plausible.length === 1) {
        log.debug('Runtime evidence resolved otherwise ambiguous movie results', {
          searchID: context.searchID,
          candidate: candidate,
          selectedImdbID: plausible[0].imdbID,
          consideredImdbIDs: uniqueResults.map(result => result.imdbID)
        });
        return {
          terminalResult: Decision.candidate(video, plausible[0], {kind:'movie', candidate, evaluation:evaluations.get(plausible[0].imdbID), validationOptions, stage})
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
        }), {...context, searchID: context.searchID, stage: stage});
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
        }), {...context, searchID: context.searchID, stage: stage});
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
        let evaluation = MatchPolicy.evaluateMovie(
          response.data, candidate, video, validationOptions
        );
        logFullMovieEvaluation(context, candidate, response.data, evaluation, stage);
        if (evaluation.confident && evaluation.matchKind === 'exact') {
          return {
            terminalResult: Decision.candidate(video, response.data, {kind:'movie', candidate, evaluation, validationOptions, stage})
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
          }), {...context,
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
          let fullEvaluation = MatchPolicy.evaluateMovie(
            exactResponse.data, requestCandidate, video, exactValidationOptions
          );
          logFullMovieEvaluation(
            context, requestCandidate, exactResponse.data, fullEvaluation,
            'cleaned exact-title lookup'
          );
          if (fullEvaluation.confident && fullEvaluation.matchKind === 'exact') {
            return Decision.candidate(video, exactResponse.data, {kind:'movie', candidate:requestCandidate, evaluation:fullEvaluation, validationOptions:exactValidationOptions, stage:'exact title'});
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
    // the ordinary searches exposed no article candidate.
    if (!sawUnresolvedExactAmbiguity &&
        deferredArticleGroups.length === 0) {
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
      }
    }

    // Expanded titles remain manual choices; the policy cannot auto-accept them.
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

  async function fetchGeneralVideoResult(imdbID, context, cache, stage) {
    if (cache.has(imdbID)) return {success: true, data: cache.get(imdbID)};

    let response;
    try {
      response = await pollOMDB(createURLParts({id: imdbID}), {...context,
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
  return {resolve: searchGeneralVideoByTitle};
}

module.exports = {createMovieResolver};
