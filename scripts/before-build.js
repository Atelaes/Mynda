// electron-builder also invokes this when called directly, so packaging can
// never accidentally reuse a stale development bundle.
const {buildRenderer} = require('./build-renderer.js');
const verifyMediaTools = require('./verify-media-tools.js');
module.exports = async context => {
  await buildRenderer({mode: 'production'});
  return verifyMediaTools(context);
};
