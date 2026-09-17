// Electron composition and the legacy public result adapters. The engine and
// batch runner use explicit decisions internally; neither depends on Electron.
const electron = require('electron');
const log = require('../platform/Logger.js').child('OMDb');
const {createCatalogClient} = require('./CatalogClient');
const {createArtworkService} = require('./ArtworkService');
const {createTagApplier} = require('./TagApplier');
const {createTaggingEngine} = require('./TaggingEngine');
const Decision = require('./TaggingDecision');

const client = createCatalogClient({axios:require('axios'),omdb:require('../../omdb'),log});
const artwork = createArtworkService({...client,log,electron,ipcRenderer:electron.ipcRenderer,
  dl:require('../platform/download'),fs:require('fs'),path:require('path')});
const engine = createTaggingEngine({client,log,applier:createTagApplier({log,...artwork}),
  withEpisodeDuration:require('./EpisodeRuntime.js').withEpisodeDuration});

async function search(video,options) { return Decision.toLegacy(await engine.tag(video,options)); }
async function resolveSeriesForBatch(videos,options) {
  const result = await engine.preflight(videos,options);
  return result.status === 'parent-resolved' ? {success:true,data:result.seriesID,evidence:result.evidence} : Decision.toLegacy(result);
}
module.exports = {...engine,search,resolveSeriesForBatch};
