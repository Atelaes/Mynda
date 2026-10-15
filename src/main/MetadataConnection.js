'use strict';
const {app, safeStorage} = require('electron');
const {createCredentialStore, verifyConnection} = require('../tagging/MetadataCredentials');
const {configPath} = require('../tagging/MetadataServerConfig');
let store;
function credentials() {
  if (!store) store = createCredentialStore({userData:app.getPath('userData'), safeStorage,
    ready:()=>app.isReady() ? Promise.resolve() : app.whenReady(), legacyFile:app.isPackaged ? null : configPath,
    allowServerOverride:!app.isPackaged, verify:config=>verifyConnection(require('axios'), config)});
  return store;
}
module.exports = {
  getConfig:()=>credentials().getConfig(),
  requireActivation:()=>credentials().requireActivation(),
  reject:config=>credentials().reject(config),
  initialize:()=>credentials().getStatus(),
  credentials,
  methods:{
    'metadata.getStatus':()=>credentials().getStatus(),
    'metadata.save':(_event, input)=>credentials().save(input),
    'metadata.check':()=>credentials().check(),
    'metadata.remove':()=>credentials().remove(),
  },
};
