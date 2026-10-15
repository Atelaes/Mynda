const {LIVE_LIMIT} = require('./TaggingNetwork');
async function confirmLive({yes,interactive,ask}) {
  if (yes) return true;
  if (!interactive) throw new Error('Live tests require a terminal confirmation or an explicit --yes. No API requests were made.');
  const answer = await ask(`Run live tests through your metadata server? At most ${LIVE_LIMIT} desktop network requests, including artwork; server retries may use two provider requests per lookup. Only a disposable library is used. [y/N] `);
  return /^y(?:es)?$/i.test(String(answer).trim());
}
module.exports={confirmLive};
