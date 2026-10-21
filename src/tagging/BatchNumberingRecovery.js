// Plan once after independent first-pass and parent-recovery observations.
// Dependent results cannot expand this frozen list or supply further witnesses.
const {translated} = require('./EpisodeNumbering');
const RETRY_REASONS = new Set(['no-results','episode-mismatch','unverified-episode-title',
  'unverified-episode-order','unconfirmed-series','ambiguous-series']);

function canRetryNumbering(result) {
  if (result.status !== 'candidate' && !(['unmatched','ambiguous'].includes(result.status) &&
      RETRY_REASONS.has(result.reason && result.reason.code))) return false;
  const detail=result.status === 'candidate' ? result.candidate.evidence : result.evidence || {};
  return !detail.exactTitle && !detail.titleComparison?.matched;
}

function planNumberingRecovery(attempts, ledger) {
  const retries=[];
  for (const item of attempts) {
    const {result,video}=item;
    if (!canRetryNumbering(result)) continue;
    const detail=result.status === 'candidate' ? result.candidate.evidence : result.evidence || {};
    const found=ledger.numberingFor(video,result);
    if (!found) continue;
    const {assessment,parentEvidence}=found;
    const target=translated(assessment,detail.requested || video);
    if (!target || (!assessment.seasonOffset && !assessment.episodeOffset)) continue;
    retries.push({...item,numberingEvidence:assessment,parentEvidence});
  }
  return retries;
}
module.exports = {planNumberingRecovery,canRetryNumbering};
