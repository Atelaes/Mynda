const fs = require('fs');
const path = require('path');
const {assert, createSuite, runSuite} = require('./helpers/TestHarness');
const {installApplicationPresentation} = require('../src/main/ApplicationPresentation');
const config = require('../package.json');
const suite = createSuite('Mynda application name', 'unit',
  'Uses Electron productName for application/profile naming while retaining the lowercase package and stable bundle ID.');
suite.test('keeps the standard Electron menus on all desktop platforms', () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    let about;
    installApplicationPresentation({platform, app: {
      setAboutPanelOptions: value => {about = value;},
      setName: () => {throw new Error('The package productName supplies the name');},
      setPath: () => {throw new Error('Profile migration is an explicit offline step');}
    }, Menu: {setApplicationMenu: () => {throw new Error('Keep Electron standard menus');}}});
    assert.deepStrictEqual(about, {applicationName: 'Mynda'});
  }
});
suite.test('uses the same product name at runtime and in native packages', () => {
  assert.strictEqual(config.name, 'mynda');
  assert.strictEqual(config.productName, 'Mynda');
  assert.strictEqual(config.build.productName, undefined);
  assert.strictEqual(config.build.appId, 'com.torvor.mynda');
  assert.strictEqual(config.build.mac.extendInfo, undefined);
  assert(fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8').includes('<title>Mynda</title>'));
});
runSuite(suite);
