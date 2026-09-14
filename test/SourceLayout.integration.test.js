const fs = require('fs');
const path = require('path');
const asar = require('asar');
const {FileMatcher} = require('app-builder-lib/out/fileMatcher');
const {assert, createSuite, runSuite, withTemporaryDirectory} = require('./helpers/TestHarness.js');
const {filesUnder, assertExactPath, auditReferences} = require('./helpers/SourceReferences.js');
const manifest = require('../scripts/source-reorganization.json');
const MediaTools = require('../src/media/MediaTools.js');
const devTools = require('../src/main/ReactDevTools.js');

const root = path.resolve(__dirname, '..');
const config = require('../package.json');
const suite = createSuite('Source imports, assets, and packaged layout', 'integration',
  'Resolves real imports with exact capitalization, follows styles/images/fonts, and checks a real ASAR archive using the builder file rules.');
let audit;

suite.test('resolves all relative imports and resource references in source, scripts, and tests', () => {
  audit = auditReferences(root);
  assert.deepStrictEqual(audit.errors, [], audit.errors.join('\n'));
  assert(audit.references.some(entry => entry.target.endsWith('ShowDetection.js')));
  assert(audit.references.some(entry => entry.target.endsWith('EpisodeMatch.js')));
  console.log(`        Checked ${audit.references.filter(entry => entry.kind === 'module').length} module references and ` +
    `${audit.references.filter(entry => entry.kind === 'resource').length} resource references.`);
});

suite.test('contains every relocated file and no superseded source locations', () => {
  for (const entry of manifest.files) {
    assertExactPath(path.join(root, entry.to));
    assert(!fs.existsSync(path.join(root, entry.from)),
      `${entry.from} is left over from fix76. Run npm run source:cleanup after extracting fix77.`);
  }
});

suite.test('keeps the default media stage and developer extension rooted at the project', () => {
  assert.strictEqual(MediaTools.stagedMediaRoot(), path.join(root, 'vendor', 'media-tools',
    `${MediaTools.builderPlatform(process.platform)}-${process.arch}`));
  assert.strictEqual(devTools.DEFAULT_EXTENSION_PATH,
    path.join(root, 'devtools', 'react-developer-tools'));
  assertExactPath(path.join(root, config.main));
});

suite.test('rejects a filename with the wrong capitalization on every platform', async () => {
  await withTemporaryDirectory('source-case', directory => {
    fs.writeFileSync(path.join(directory, 'Example.js'), 'module.exports = true;\n');
    assertExactPath(path.join(directory, 'Example.js'));
    assert.throws(() => assertExactPath(path.join(directory, 'example.js')), /capitalization/);
  });
});

suite.test('packages relocated modules, themes, fonts, and images at their referenced ASAR paths', async () => {
  await withTemporaryDirectory('source-package', async directory => {
    const stage = path.join(directory, 'app');
    const archive = path.join(directory, 'app.asar');
    const include = new FileMatcher(root, stage, value => value, config.build.files).createFilter();
    const included = [];
    for (const folder of ['src', 'images']) {
      for (const filename of filesUnder(path.join(root, folder))) {
        if (!include(filename, fs.statSync(filename))) continue;
        const relative = path.relative(root, filename);
        const destination = path.join(stage, relative);
        fs.mkdirSync(path.dirname(destination), {recursive: true});
        fs.copyFileSync(filename, destination);
        included.push(relative.split(path.sep).join('/'));
      }
    }
    fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify(config));
    fs.writeFileSync(path.join(stage, 'omdb.js'), "module.exports = {key: 'fixture-only'};\n");
    included.push('package.json', 'omdb.js');
    await asar.createPackage(stage, archive);
    const packaged = new Set(asar.listPackage(archive).map(name => name.replace(/^[/\\]/, '').replace(/\\/g, '/')));
    for (const filename of included) assert(packaged.has(filename), `ASAR omitted ${filename}`);
    for (const entry of (audit || auditReferences(root)).references) {
      if (!entry.owner.startsWith(`src${path.sep}`) || entry.owner.startsWith(`src${path.sep}legacy${path.sep}`)) continue;
      assert(packaged.has(entry.target.split(path.sep).join('/')), `Packaged reference is missing: ${entry.owner} -> ${entry.target}`);
    }
    assert(![...packaged].some(name => name.startsWith('src/legacy/') || name.startsWith('themes/')));
    for (const filename of included.filter(name => /\.(ttf|png|gif)$/.test(name))) {
      assert(asar.extractFile(archive, filename).equals(fs.readFileSync(path.join(root, filename))),
        `Packaged asset bytes changed: ${filename}`);
    }
    console.log(`        Verified ${included.length} packaged source/asset files.`);
  });
});

runSuite(suite);
