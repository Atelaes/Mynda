const fs = require('fs');
const path = require('path');
const {assert, createSuite, runSuite} = require('./helpers/TestHarness');
const config = require('../package.json');
const suite = createSuite('Mynda application name', 'unit',
  'Uses Electron productName for application/profile naming while retaining the lowercase package and stable bundle ID.');
suite.test('uses the same product name at runtime and in native packages', () => {
  assert.strictEqual(config.name, 'mynda');
  assert.strictEqual(config.productName, 'Mynda');
  assert.strictEqual(config.build.productName, undefined);
  assert.strictEqual(config.build.appId, 'com.torvor.mynda');
  assert.strictEqual(config.build.mac.extendInfo, undefined);
  assert(fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8').includes('<title>Mynda</title>'));
});
runSuite(suite);
