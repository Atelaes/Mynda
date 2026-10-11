const {LIVE_LIMIT} = require('./TaggingNetwork');
async function confirmLive({yes,interactive,ask}) {
  if (yes) return true;
  if (!interactive) throw new Error('Live tests require a terminal confirmation or an explicit --yes. No API requests were made.');
  const answer = await ask(`Run live OMDb tests using your API key? At most ${LIVE_LIMIT} network requests, including artwork; only a disposable library is used. [y/N] `);
  return /^y(?:es)?$/i.test(String(answer).trim());
}
module.exports={confirmLive};
