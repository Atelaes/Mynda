// electron-builder also invokes this when called directly, so packaging can
// never accidentally reuse a stale development bundle.
const {buildRenderer} = require('./build-renderer.js');
const verifyMediaTools = require('./verify-media-tools.js');
const fs = require('fs');
const path = require('path');
const {execFileSync} = require('child_process');
module.exports = async context => {
  // Icon Composer needs full Xcode. Keep an explicit DEVELOPER_DIR or a
  // selected full Xcode; otherwise use the standard installation for this
  // build process only, without changing xcode-select for other projects.
  if (process.platform === 'darwin' && context.platform?.nodeName === 'darwin' && !process.env.DEVELOPER_DIR) {
    let selected = '';
    try { selected = execFileSync('/usr/bin/xcode-select', ['-p'], {encoding: 'utf8'}).trim(); }
    catch (_) { /* Try the standard Xcode installation below. */ }
    if (!selected || !fs.existsSync(path.join(selected, 'usr/bin/actool'))) {
      const xcode = '/Applications/Xcode.app/Contents/Developer';
      if (!fs.existsSync(path.join(xcode, 'usr/bin/actool'))) {
        throw new Error('Mac icon compilation requires Xcode 26 or newer. Install Xcode or set DEVELOPER_DIR to its Contents/Developer directory.');
      }
      process.env.DEVELOPER_DIR = xcode;
    }
  }
  await buildRenderer({mode: 'production'});
  return verifyMediaTools(context);
};
