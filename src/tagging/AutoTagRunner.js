// Owns batch lifecycle and persistence. Discovery and final acceptance belong
// to the engine; this runner consumes only its typed decision contract.
const _ = require('lodash');
const BatchEvidence = require('./BatchEvidence');
const {planRecovery} = require('./BatchSeriesRecovery');
const Evidence = require('./TaggingEvidence');
const Decision = require('./TaggingDecision');
const Limits = require('./TaggingLimits');
const {createRequestBudget} = require('./RequestBudget');
const {validSeriesImdbID} = require('./CatalogResponse');

function shouldDefer(result) {
  return result.status === 'candidate' && result.candidate.evidence.kind === 'episode' &&
    !result.candidate.evidence.localTitle;
}

function createAutoTagRunner({state,catalog,log,getCandidates,save,notifyStatus,chooseSeries,preferences,whenIdle}) {
  return async function autoTag(options = {}) {
    if (state.running) return;
    const videos = _.cloneDeep(Array.isArray(options.videos) ? options.videos : getCandidates());
    const budgets = videos.map(() => createRequestBudget(options.requestBudgetLimit));
    state.running = true;
    state.cancelRequested = false;
    state.scope = options.scope === 'selected' ? 'selected' : 'library';
    const seriesBatch = options.seriesBatch;
    const session = catalog.createSeriesSearchSession();
    const ledger = BatchEvidence.createEvidence(videos);
    const seasonOffsetHints = new Map();
    const retryCandidates = [], pendingMatches = [], outcomes = new Map();
    const statistics = {totalVideos:videos.length};
    let batchSave = [], processed = 0, canceledPending = 0;
    let sharedID = seriesBatch && validSeriesImdbID(seriesBatch.storedSeriesImdbID) ? seriesBatch.storedSeriesImdbID.trim() : '';
    let sharedSource = sharedID ? 'stored' : 'batch', sharedEvidence;
    let seriesSelectionCanceled = false, seriesPreflightFailure = null;

    async function flush() {
      if (!batchSave.length) return;
      const completed = batchSave;
      batchSave = [];
      await save(completed);
    }
    async function canContinue() {
      if (state.cancellationDecision) await state.cancellationDecision;
      return !state.cancelRequested;
    }
    function searchOptions(index) {
      return {seasonOffsetHints,seriesSearchSession:session,requestBudget:budgets[index],deferSeriesEvidence:true,
        ...(sharedID ? {seriesImdbID:sharedID,seriesSelectionSource:sharedSource,parentEvidence:sharedEvidence} : {})};
    }
    async function resolve(video,settings) {
      try { return await catalog.resolve(video,settings); }
      catch(error) { return Decision.fromDiscovery({failure:'Error',data:error},video,{}); }
    }
    async function finish(video,result) {
      return result.status === 'candidate' ? catalog.applyMatch(result,{anchors:ledger.anchorsFor(video,result)}) : result;
    }
    // Every pass uses this one outcome recorder. Retries replace a disposition;
    // a service failure never marks the file permanently attempted.
    async function record(video,result,index,retry = false,parent) {
      const previous = outcomes.get(index);
      if (previous) statistics[previous]--;
      const disposition = result.status === 'matched' ? 'Success' : result.failure || result.reason.code;
      outcomes.set(index,disposition);
      statistics[disposition] = (statistics[disposition] || 0) + 1;
      if (retry && result.status === 'matched') statistics.recoveredSeriesRetries = (statistics.recoveredSeriesRetries || 0) + 1;
      if (result.status === 'matched') {
        const tagged = result.video;
        tagged.autotag_tried = true;
        if (preferences.remove_autotagged_from_new) tagged.new = false;
        delete tagged.taggingDecision;
        ledger.observe(video,result);
        batchSave.push(tagged);
      } else if (!result.retryable || retry) {
        const parentID = parent ? parent.seriesID : sharedID;
        const unresolved = parentID ? Evidence.assignParent(video,parentID,
          Evidence.selectedParent(video,parentID,{seriesSelectionSource:parent ? parent.source || 'siblings' : sharedSource,
            parentEvidence:parent ? parent.evidence : sharedEvidence})) : video;
        batchSave.push({...unresolved,autotag_tried:!result.retryable,
          taggingDecision:Evidence.copy({status:result.status,reason:result.reason,evidence:result.evidence})});
      }
      log[result.status === 'matched' ? 'debug' : result.retryable ? 'error' : 'warn'](
        result.status === 'matched' ? 'Automatic tagging finished for video' :
          result.retryable ? 'Automatic tagging failed for video' : 'Automatic tagging did not tag video',
        {id:video.id,filename:video.filename,title:video.title,disposition,status:result.status,
          reason:result.reason,evidence:result.evidence,permanentFailure:!result.retryable});
      if (batchSave.length >= Limits.saveBatchSize) await flush();
    }

    try {
      notifyStatus({action:'autotag'});
      log.info('Automatic tagging batch started',{totalVideos:videos.length,scope:state.scope,
        sameSeriesShowBatch:Boolean(seriesBatch),series:seriesBatch && seriesBatch.series});
      if (seriesBatch && !sharedID) {
        let preflight;
        try { preflight = await catalog.preflight(videos,{seriesSearchSession:session,requestBudgetLimit:options.requestBudgetLimit}); }
        catch(error) { preflight = Decision.fromDiscovery({failure:'Error',data:error},videos[0] || {},{}); }
        if (preflight.status === 'parent-resolved') {
          sharedID = preflight.seriesID;
          sharedEvidence = preflight.evidence;
        } else if (preflight.status === 'ambiguous' && preflight.choiceType === 'series' && preflight.choices.length) {
          const selected = await chooseSeries(seriesBatch,preflight.choices,videos.length);
          if (selected && validSeriesImdbID(selected.imdbID)) {
            sharedID = selected.imdbID.trim();
            sharedSource = 'user';
            sharedEvidence = {choice:Evidence.copy(selected)};
          } else seriesSelectionCanceled = true;
        } else seriesPreflightFailure = preflight;
      }
      if (sharedID) {
        // Keep each source record intact for provenance. The established parent
        // is attached to a failed saved attempt too, as in selected-batch tagging.
        if (sharedSource === 'stored') {
          const source = videos.find(video => video.seriesImdbID === sharedID);
          if (source) sharedEvidence = Evidence.storedParent(source);
        }
      }
      for (let index = 0; !seriesSelectionCanceled && !seriesPreflightFailure && index < videos.length; index++) {
        if (!await canContinue()) break;
        notifyStatus({action:'autotag',numCurrent:index+1,numTotal:videos.length});
        const video = videos[index];
        let result = await resolve(video,searchOptions(index));
        if (BatchEvidence.canRetry(result)) retryCandidates.push({video,result,index});
        if (shouldDefer(result)) pendingMatches.push({video,result,index});
        else {
          result = await finish(video,result);
          await record(video,result,index);
        }
        processed = index + 1;
      }
      // A retry must never put the old and replacement versions of one file
      // into the same save batch.
      await flush();
      // Freeze independent parent decisions before dependent retries supply any
      // additional order observations. No retry can bootstrap another parent.
      const {retries,structureChecks} = await planRecovery({pending:retryCandidates,ledger,catalog,session,budgets,canContinue});
      if (structureChecks) statistics.seriesStructureChecks=structureChecks;
      for (const pending of retries) {
        if (!await canContinue()) break;
        const parent = pending.parent;
        if (!parent) {
          if (pending.resolutionError) await record(pending.video,pending.resolutionError,pending.index,true);
          else if (pending.structureEvidence) await record(pending.video,{...pending.result,evidence:{...pending.result.evidence,
            structureAssessment:pending.structureEvidence}},pending.index,true);
          continue;
        }
        const result = await resolve(pending.video,{seasonOffsetHints,seriesSearchSession:session,requestBudget:budgets[pending.index],
          seriesImdbID:parent.seriesID,seriesSelectionSource:parent.source || 'siblings',parentEvidence:parent.evidence});
        statistics.seriesRetries = (statistics.seriesRetries || 0) + 1;
        if (shouldDefer(result)) {
          pendingMatches.push({...pending,result,retry:true});
          continue;
        }
        const finished = await finish(pending.video,result);
        await record(pending.video,finished,pending.index,true,parent);
        log.info('Automatic tagging series retry finished',{id:pending.video.id,filename:pending.video.filename,
          seriesImdbID:parent.seriesID,success:finished.status === 'matched',reason:finished.reason});
      }
      // Named matches supply observations. The final policy alone decides
      // whether they establish the order for a numbered-only proposal.
      for (const pending of pendingMatches) {
        if (!await canContinue()) {
          if (!pending.retry) canceledPending++;
          continue;
        }
        const result = await finish(pending.video,pending.result);
        await record(pending.video,result,pending.index,pending.retry,pending.parent);
        const assessment = result.evidence.orderAssessment || {};
        log.info('Automatic tagging episode-order decision',{id:pending.video.id,filename:pending.video.filename,
          accepted:result.status === 'matched',reason:result.status === 'matched' ? undefined : result.reason.message,
          basis:assessment.basis,evidence:result.evidence});
        if (pending.retry) log.info('Automatic tagging series retry finished',{
          id:pending.video.id,success:result.status === 'matched',reason:result.reason});
      }
      await flush();
      await whenIdle();
      statistics.processedVideos = processed - canceledPending;
      statistics.remainingVideos = videos.length - statistics.processedVideos;
      if (canceledPending) statistics.unreviewedCandidates = canceledPending;
      if (sharedID) statistics.seriesImdbID = sharedID;
      log.info('Automatic tagging series discovery summary',catalog.seriesSearchSummary(session));
      const status = seriesSelectionCanceled ? 'series-selection-canceled' : seriesPreflightFailure ?
        'series-preflight-failed' : state.cancelRequested ? 'canceled' : 'finished';
      log.info('Automatic tagging batch '+status,{scope:state.scope,statistics});
      log.debug('Automatic tagging batch diagnostics',{scope:state.scope,status,statistics,
        videoResults:[...outcomes].map(([i,disposition]) => `${videos[i].title}: ${disposition}`).sort()});
      return {statistics,canceled:state.cancelRequested,seriesSelectionCanceled,seriesPreflightFailure};
    } finally {
      state.running = false;
      state.cancelRequested = false;
      state.scope = 'library';
      notifyStatus({action:''});
    }
  };
}
module.exports = {createAutoTagRunner};
