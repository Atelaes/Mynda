// Electron composition and the legacy public result adapters. The engine and
// batch runner use explicit decisions internally; neither depends on Electron.
const {app} = require('electron');
const log = require('../platform/Logger.js').child('Tagging');
const {createCatalogClient} = require('./CatalogClient');
const {createArtworkService} = require('./ArtworkService');
const {createTagApplier} = require('./TagApplier');
const {createTaggingEngine} = require('./TaggingEngine');
const Decision = require('./TaggingDecision');
const connection = require('../main/MetadataConnection');
const access = require('../main/FeatureAccess');

const client = createCatalogClient({axios:require('axios'),server:async()=>{
  await access.requireFeature('tagging');
  return connection.getConfig();
},onUnauthorized:config=>connection.reject(config),log});
const path = require('path');
const artwork = createArtworkService({...client,log,
  artworkDirectory:path.join(app.getPath('userData'),'Library','Artwork'),
  dl:require('../platform/download'),fs:require('fs'),path});
const rawEngine = createTaggingEngine({client,log,applier:createTagApplier({log,...artwork}),
  withEpisodeDuration:require('./EpisodeRuntime.js').withEpisodeDuration});
// Guard above discovery and application, so session caches and exact-ID paths
// obey the same policy even when they make no metadata request.
const engine = {...rawEngine,...Object.fromEntries(['resolve','applyMatch','preflight','resolveSeriesStructure']
  .map(name=>[name,access.protect('tagging',rawEngine[name])]))};
engine.tag = async (video,options) => engine.applyMatch(await engine.resolve(video,options));

async function search(video,options) { return Decision.toLegacy(await engine.tag(video,options)); }
async function resolveSeriesForBatch(videos,options) {
  const result = await engine.preflight(videos,options);
  return result.status === 'parent-resolved' ? {success:true,data:result.seriesID,evidence:result.evidence} : Decision.toLegacy(result);
}
module.exports = {...engine,search,resolveSeriesForBatch};
