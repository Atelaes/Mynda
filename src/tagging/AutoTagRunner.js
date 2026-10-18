const CatalogIdentity = require('./CatalogIdentity');
// Owns batch lifecycle and persistence. Discovery and final acceptance belong
// to the engine; this runner consumes only its typed decision contract.
const _ = require('lodash');
const BatchEvidence = require('./BatchEvidence');
const {planRecovery} = require('./BatchSeriesRecovery');
const {planNumberingRecovery} = require('./BatchNumberingRecovery');
const Evidence = require('./TaggingEvidence');
const Decision = require('./TaggingDecision');
const Limits = require('./TaggingLimits');
const {createRequestBudget} = require('./RequestBudget');
const {validSeriesImdbID} = require('./CatalogResponse');
const {canceled} = require('./CapacityWait');
const {isFeatureAccessError} = require('../platform/FeatureAccess');

function shouldDefer(result) {
  return result.status === 'candidate' && result.candidate.evidence.kind === 'episode' &&
    (!result.candidate.evidence.localTitle || result.candidate.evidence.exactTitle === false);
}

function createAutoTagRunner({state,catalog,log,getCandidates,getLibraryVideos,save,notifyStatus,chooseSeries,preferences,whenIdle,
  requireFeature = async()=>{}}) {
  return async function autoTag(options = {}) {
    if (state.running) return;
    await requireFeature('tagging');
    if (state.running) return;
    const videos = _.cloneDeep(Array.isArray(options.videos) ? options.videos : getCandidates());
    // Lookups run outside the library commit queue. Keep the record they were
    // based on so a later result cannot overwrite edits made during a lookup.
    // Successful earlier passes become the baseline for this run's retries;
    // never refresh it from arbitrary concurrent edits in the live library.
    const saveBaselines = new Map(videos.map(video => [video.id, _.cloneDeep(video)]));
    const budgets = videos.map(() => createRequestBudget(options.requestBudgetLimit));
    state.running = true;
    state.cancelRequested = false;
    state.scope = options.scope === 'selected' ? 'selected' : 'library';
    const seriesBatch = options.seriesBatch;
    const session = catalog.createSeriesSearchSession();
    const controller = new AbortController();
    const waits = new Map();
    let currentProgress = {action:'autotag'}, waitFailure;
    state.capacityWaiting = false;
    state.cancelCapacityWait = () => {
      if (!state.capacityWaiting) return false;
      controller.abort();
      return true;
    };
    const requestControl = {workload:'batch',signal:controller.signal,
      isCanceled:() => {
        if (state.cancelRequested) controller.abort();
        return state.cancelRequested;
      },
      onCapacityWait:async status => {
        if (status.waiting) {
          state.capacityWaiting = true;
          if (!waits.size) {
            try { await flush(); }
            catch (error) { waitFailure = error; controller.abort(); throw error; }
          }
          waits.set(status.waitID,status);
          if (state.cancelRequested) controller.abort();
        } else waits.delete(status.waitID);
        state.capacityWaiting = waits.size > 0;
        notifyStatus({...currentProgress,...(waits.size ? {capacityWait:waits.values().next().value} : {})});
      }};
    session.catalog = session.catalog || {};
    session.catalog.control = requestControl;
    const ledger = BatchEvidence.createEvidence(videos,getLibraryVideos ? getLibraryVideos() : []);
    const seasonOffsetHints = new Map();
    const retryCandidates = [], pendingMatches = [], outcomes = new Map(), attempts = new Map();
    const statistics = {totalVideos:videos.length};
    let batchSave = [], processed = 0, canceledPending = 0;
    let sharedID = seriesBatch && CatalogIdentity.valid((seriesBatch.storedSeriesID || seriesBatch.storedSeriesImdbID)) ? (seriesBatch.storedSeriesID || seriesBatch.storedSeriesImdbID).trim() : '';
    let sharedSource = sharedID ? 'stored' : 'batch', sharedEvidence;
    let seriesSelectionCanceled = false, seriesPreflightFailure = null;

    function checkLookup() {
      if (waitFailure) throw waitFailure;
      if (controller.signal.aborted) throw canceled();
    }
    function progress(status) { currentProgress = status; notifyStatus(status); }

    async function flush() {
      if (!batchSave.length) return;
      const completed = batchSave;
      batchSave = [];
      try {
        const result = await save(completed, {
          baselines: completed.map(video => _.cloneDeep(saveBaselines.get(video.id)))
        });
        const conflicts = new Set((result && result.conflicts || []).map(item => item.id));
        for (const video of completed) {
          if (!conflicts.has(video.id)) saveBaselines.set(video.id, _.cloneDeep(video));
          else {
            const index = videos.findIndex(input => input.id === video.id);
            const previous = outcomes.get(index);
            if (previous) statistics[previous]--;
            outcomes.set(index, 'Changed during lookup');
            statistics['Changed during lookup'] = (statistics['Changed during lookup'] || 0) + 1;
            log.warn('Automatic tagging result skipped because the video changed during lookup', {id:video.id});
          }
        }
      }
      catch(cause) {
        const error = new Error('Auto-Tag could not finish saving its results.');
        error.name = 'AutoTagSaveError';
        error.cause = cause;
        error.code = cause && cause.code;
        error.autoTagFailure = {stage:'save',videoCount:completed.length,
          committed:Boolean(cause && cause.libraryOperation && cause.libraryOperation.committed)};
        throw error;
      }
    }
    async function canContinue() {
      if (state.cancellationDecision) await state.cancellationDecision;
      return !state.cancelRequested;
    }
    function searchOptions(index) {
      return {seasonOffsetHints,seriesSearchSession:session,requestBudget:budgets[index],deferSeriesEvidence:true,
        ...(sharedID ? {seriesID:sharedID,seriesSelectionSource:sharedSource,parentEvidence:sharedEvidence} : {})};
    }
    async function resolve(video,settings) {
      let result;
      try { result = await catalog.resolve(video,settings); }
      catch(error) {
        if (isFeatureAccessError(error)) throw error;
        result = Decision.fromDiscovery({failure:'Error',data:error},video,{});
      }
      checkLookup();
      return result;
    }
    async function finish(video,result) {
      checkLookup();
      const finished = result.status === 'candidate' ? await catalog.applyMatch(result,{
        anchors:ledger.anchorsFor(video,result),orderConflicts:ledger.orderConflictsFor(video,result)}) : result;
      checkLookup();
      return finished;
    }
    // Every pass uses this one outcome recorder. Retries replace a disposition;
    // a service failure never marks the file permanently attempted.
    async function record(video,result,index,retry = false,parent) {
      checkLookup();
      attempts.set(index,{video,result,index,parent});
      const previous = outcomes.get(index);
      if (previous) statistics[previous]--;
      const disposition = result.status === 'matched' ? 'Success' : result.failure || result.reason.code;
      outcomes.set(index,disposition);
      statistics[disposition] = (statistics[disposition] || 0) + 1;
      ledger.observe(video,result);
      if (retry && result.status === 'matched') {
        const counter=retry === 'numbering' ? 'recoveredNumberingRetries' : 'recoveredSeriesRetries';
        statistics[counter]=(statistics[counter] || 0)+1;
      }
      if (result.status === 'matched') {
        const tagged = result.video;
        tagged.autotag_tried = true;
        if (preferences.remove_autotagged_from_new) tagged.new = false;
        delete tagged.taggingDecision;
        batchSave.push(tagged);
      } else {
        const parentID = parent ? parent.seriesID : sharedID;
        // First-pass service errors previously saved nothing. Persist their
        // report without changing a previously tagged video's selected parent.
        const preserveTags = result.retryable && !retry;
        const unresolved = parentID && !preserveTags ? Evidence.assignParent(video,parentID,
          Evidence.selectedParent(video,parentID,{seriesSelectionSource:parent ? parent.source || 'siblings' : sharedSource,
            parentEvidence:parent ? parent.evidence : sharedEvidence})) : video;
        // Keep a report for every completed attempt, including first-pass
        // service errors. Their retry eligibility and existing tags stay intact.
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
      progress({action:'autotag'});
      log.info('Automatic tagging batch started',{totalVideos:videos.length,scope:state.scope,
        sameSeriesShowBatch:Boolean(seriesBatch),series:seriesBatch && seriesBatch.series});
      if (seriesBatch && !sharedID) {
        let preflight;
        try { preflight = await catalog.preflight(videos,{seriesSearchSession:session,requestBudgetLimit:options.requestBudgetLimit}); }
        catch(error) {
          if (isFeatureAccessError(error)) throw error;
          preflight = Decision.fromDiscovery({failure:'Error',data:error},videos[0] || {},{});
        }
        checkLookup();
        if (preflight.status === 'parent-resolved') {
          sharedID = preflight.seriesID;
          sharedEvidence = preflight.evidence;
        } else if (preflight.status === 'ambiguous' && preflight.choiceType === 'series' && preflight.choices.length) {
          const selected = await chooseSeries(seriesBatch,preflight.choices,videos.length);
          if (selected && CatalogIdentity.valid(CatalogIdentity.recordKey(selected))) {
            sharedID = CatalogIdentity.recordKey(selected);
            sharedSource = 'user';
            sharedEvidence = {choice:Evidence.copy(selected)};
          } else seriesSelectionCanceled = true;
        } else seriesPreflightFailure = preflight;
      }
      if (sharedID) {
        // Keep each source record intact for provenance. The established parent
        // is attached to a failed saved attempt too, as in selected-batch tagging.
        if (sharedSource === 'stored') {
          const source = videos.find(video => CatalogIdentity.parentKey(video) === sharedID);
          if (source) sharedEvidence = Evidence.storedParent(source);
        }
      }
      for (let index = 0; !seriesSelectionCanceled && !seriesPreflightFailure && index < videos.length; index++) {
        if (!await canContinue()) break;
        progress({action:'autotag',numCurrent:index+1,numTotal:videos.length});
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
      checkLookup();
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
          seriesID:parent.seriesID,seriesSelectionSource:parent.source || 'siblings',parentEvidence:parent.evidence,
          priorCorrectionChecks:pending.result.evidence && pending.result.evidence.correctionChecks});
        statistics.seriesRetries = (statistics.seriesRetries || 0) + 1;
        if (shouldDefer(result)) {
          pendingMatches.push({...pending,result,retry:true});
          continue;
        }
        const finished = await finish(pending.video,result);
        await record(pending.video,finished,pending.index,true,parent);
        log.info('Automatic tagging series retry finished',{id:pending.video.id,filename:pending.video.filename,
          seriesID:parent.seriesID,success:finished.status === 'matched',reason:finished.reason});
      }
      // Freeze a separate numbering plan after independent exact matches and
      // parent retries. Later fuzzy recoveries cannot create additional votes.
      await flush();
      const numberingInputs=new Map(attempts);
      pendingMatches.forEach(item=>numberingInputs.set(item.index,item));
      const numberingRetries=planNumberingRecovery([...numberingInputs.values()],ledger);
      const numberingCompleted=new Set();
      for (const pending of numberingRetries) {
        if (!await canContinue()) break;
        const {seriesID}=pending.numberingEvidence;
        const previous=pending.result.evidence;
        const result=await resolve(pending.video,{...searchOptions(pending.index),
          seriesID:seriesID,seriesSelectionSource:'siblings',parentEvidence:pending.parentEvidence,
          numberingEvidence:pending.numberingEvidence,priorCorrectionChecks:previous && previous.correctionChecks});
        statistics.numberingRetries=(statistics.numberingRetries || 0)+1;
        const finished=await finish(pending.video,result);
        await record(pending.video,finished,pending.index,'numbering');
        numberingCompleted.add(pending.index);
        log.info('Automatic tagging numbering retry finished',{id:pending.video.id,seriesID,
          success:finished.status === 'matched',reason:finished.reason});
      }
      // Named matches supply observations. The final policy alone decides
      // whether they establish the order for a numbered-only proposal.
      for (const pending of pendingMatches) {
        if (numberingCompleted.has(pending.index)) continue;
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
      if (sharedID) statistics.seriesID = sharedID;
      log.info('Automatic tagging series discovery summary',catalog.seriesSearchSummary(session));
      const status = seriesSelectionCanceled ? 'series-selection-canceled' : seriesPreflightFailure ?
        'series-preflight-failed' : state.cancelRequested ? 'canceled' : 'finished';
      log.info('Automatic tagging batch '+status,{scope:state.scope,statistics});
      log.debug('Automatic tagging batch diagnostics',{scope:state.scope,status,statistics,
        videoResults:[...outcomes].map(([i,disposition]) => `${videos[i].title}: ${disposition}`).sort()});
      return {statistics,canceled:state.cancelRequested,seriesSelectionCanceled,seriesPreflightFailure};
    } catch (error) {
      if (isFeatureAccessError(error)) {
        // Keep already completed work, but do not record a tagging attempt or
        // failure on the blocked video (or continue through the rest of a batch).
        await flush();
        await whenIdle();
        throw error;
      }
      if (!error || error.code !== 'METADATA_CANCELED') throw error;
      state.cancelRequested = true;
      await flush();
      await whenIdle();
      statistics.processedVideos = outcomes.size;
      statistics.remainingVideos = videos.length - outcomes.size;
      log.info('Automatic tagging canceled while waiting for metadata capacity',{scope:state.scope,statistics});
      return {statistics,canceled:true,seriesSelectionCanceled:false,seriesPreflightFailure:null};
    } finally {
      state.running = false;
      state.cancelRequested = false;
      state.scope = 'library';
      state.capacityWaiting = false;
      state.cancelCapacityWait = null;
      notifyStatus({action:''});
    }
  };
}
module.exports = {createAutoTagRunner};
