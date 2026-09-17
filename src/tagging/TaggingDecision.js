// One terminal contract. Only the public compatibility adapter translates it into the older
// success/data API. A candidate is a discovery proposal, never authorization.
const Evidence = require('./TaggingEvidence');
const STATUSES = Object.freeze(['matched','ambiguous','unmatched','service-error']);

function hasImdbID(video) {
  return video && typeof video.imdbID === 'string' && video.imdbID.trim() !== '';
}

function decision(status, reason, evidence, fields = {}) {
  if (!STATUSES.includes(status)) throw new TypeError('Unknown tagging decision');
  return {status,reason,evidence:Evidence.copy(evidence || {}),retryable:status === 'service-error',...fields};
}

function candidate(video, record, evidence) {
 // Resolvers retain their local lookup protocol; the engine removes this
 // compatibility flag when the proposal crosses the discovery boundary.
 return {success:true, status:'candidate', candidate:{video, record, evidence}};
}

function fromDiscovery(result, video, context) {
  if (result && result.status === 'candidate') {
    return {status:'candidate', candidate:result.candidate, context,
      evidence:Evidence.envelope(video,result.candidate.evidence,context)};
  }
  const raw = result || {failure:'Error',data:'Discovery returned no outcome'};
  const choices = Array.isArray(raw.data) ? raw.data : raw.choices || [];
  const failure = raw.failure || (choices.length ? 'Ambiguous results' : 'No results');
  const status = choices.length || /^Ambiguous/.test(failure) ? 'ambiguous' :
    (raw.permanentFailure || failure === 'No results' || failure === 'Not enough data') ? 'unmatched' : 'service-error';
  const error = raw.data && raw.data.Error || raw.data;
  const message = typeof raw.data === 'string' ? raw.data : error && error.message || failure;
  const code = raw.policyReason || error && error.code || String(failure).toLowerCase().replace(/[^a-z0-9]+/g,'-');
  return decision(status,{code,message},Evidence.envelope(video,{...raw.evidence,discovery:{failure,code,message,candidates:Evidence.copy(choices)},
    ...(error && error.budget ? {exhaustedBudget:error.budget} : {})},context),
    {failure,choices:Evidence.copy(choices),choiceType:raw.choiceType,
      ...(raw.choiceType !== 'series' && Array.isArray(raw.data) ? {choiceType:'record'} : {})});
}

function toLegacy(result) {
  if (result.status === 'matched') return {success:true,data:result.video,status:result.status,evidence:result.evidence};
  if (result.status === 'ambiguous' && result.choiceType === 'record') {
    return {success:true,data:result.choices,status:result.status,evidence:result.evidence};
  }
  return {success:false,failure:result.failure || (result.status === 'service-error' ? 'Error' : 'Episode mismatch'),
    data:result.reason.message,status:result.status,evidence:result.evidence,
    policyReason:result.reason.code,permanentFailure:!result.retryable,
    ...(result.choices && result.choices.length ? {choices:result.choices,choiceType:result.choiceType} : {})};
}

module.exports = {STATUSES,hasImdbID,candidate,decision,fromDiscovery,toLegacy};
