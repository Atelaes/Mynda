const {createAutoTagRunner} = require('../../src/tagging/AutoTagRunner');
const {loadSearch} = require('./OmdbFixtures');

async function runAutoTag(videos, responder, options = {}) {
  const state = {running:false,cancelRequested:false,cancellationDecision:null,scope:'library'};
  const saved = new Map(), batches = [], logs = [];
  const fixture = loadSearch(async (query, requests) => {
    const response = await responder(query, requests);
    if (options.afterRequest) options.afterRequest(query, state);
    return response;
  });
  const run = createAutoTagRunner({state,catalog:fixture.api,
    log:Object.fromEntries(['debug','info','warn','error'].map(level => [level,
      (message,data) => logs.push({level,message,data})])),
    getCandidates:() => videos,getLibraryVideos:() => options.libraryVideos || [], preferences:{remove_autotagged_from_new:false},
    chooseSeries:async () => options.selectedSeries || null,
    notifyStatus() {}, whenIdle:async () => {},
    save:async batch => {
      if (new Set(batch.map(video => video.id)).size !== batch.length) throw Error('Duplicate IDs in save batch');
      const copy = JSON.parse(JSON.stringify(batch));
      batches.push(copy);
      for (const video of copy) saved.set(video.id,video);
    }
  });
  const result = await run({videos,...options.batchOptions});
  return {result,saved,batches,state,...fixture,logs:[...fixture.logs,...logs]};
}

module.exports = {runAutoTag};
