const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {webcrypto} = require('crypto');
const asar = require('@electron/asar');
const {FileMatcher} = require('app-builder-lib/out/fileMatcher');
const {assert, createSuite, runSuite, withTemporaryDirectory} = require('./helpers/TestHarness.js');
const {filesUnder, assertExactPath, auditReferences} = require('./helpers/SourceReferences.js');
const manifest = require('../scripts/source-reorganization.json');
const MediaTools = require('../src/media/MediaTools.js');
const devTools = require('../src/main/ReactDevTools.js');
const {buildRenderer, OUTPUT_PATH, PRELOAD_PATH} = require('../scripts/build-renderer.js');

const root = path.resolve(__dirname, '..');
const config = require('../package.json');
const suite = createSuite('Source imports, assets, and packaged layout', 'integration',
  'Resolves real imports with exact capitalization, follows styles/images/fonts, and checks a real ASAR archive using the builder file rules.');
let audit;

suite.test('resolves all relative imports and resource references in source, scripts, and tests', async () => {
  const build = await buildRenderer({mode: 'production'});
  const inputs = Object.keys(build.metafile.inputs);
  assert(inputs.includes('src/renderer/Renderer.js'));
  assert(!inputs.some(name => /(?:^|\/)omdb\.js$/.test(name)), 'The API key must not be bundled into the renderer');
  assert(!inputs.some(name => /(?:^|\/)MetadataServer(?:Client|Config)\.js$/.test(name)),
    'Metadata server configuration and transport belong only to the main process');
  assert(!inputs.some(name => /^src\/(?:main|media|scanning)\//.test(name) && /(?:Service|Process|Tools)\.js$/.test(name)),
    'Backend process services must not be bundled into the renderer');
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

suite.test('the real compiled browser entry initializes without Node or dynamic code generation', async () => {
  let requestedSnapshot = false;
  // This covers loading the complete production dependency graph, not DOM
  // rendering. The native Electron suites own rendering and user workflows.
  const context = vm.createContext({setTimeout, clearTimeout, console, URL, crypto: webcrypto,
    document: undefined, // Disabled diagnostics can capture this global in the DOM-free fixture.
    mynda: {app: {platform: 'darwin'}, logs: {write: async () => {}}, library: {
      onCommitted() {}, onCloseCanceled() {}, onPrepareClose() {},
      snapshot() { requestedSnapshot = true; return new Promise(() => {}); }
    }}
  }, {codeGeneration: {strings: false, wasm: false}});
  vm.runInContext('window = globalThis; self = globalThis;', context);
  vm.runInContext(fs.readFileSync(path.join(root, OUTPUT_PATH), 'utf8'), context);
  await Promise.resolve();
  assert(requestedSnapshot, 'The browser entry must reach its library initialization');
  assert.strictEqual(typeof context.require, 'undefined');
  assert.strictEqual(typeof context.process, 'undefined');
  assert.strictEqual(typeof context.Buffer, 'undefined');
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
    included.push('package.json');
    await asar.createPackage(stage, archive);
    const packaged = new Set(asar.listPackage(archive).map(name => name.replace(/^[/\\]/, '').replace(/\\/g, '/')));
    assert(!packaged.has('omdb.js'), 'The application must not need a provider-key module');
    assert(packaged.has(OUTPUT_PATH), 'ASAR omitted the compiled renderer');
    assert(packaged.has(PRELOAD_PATH), 'ASAR omitted the sandboxed preload');
    for (const filename of [OUTPUT_PATH, PRELOAD_PATH]) {
      assert(asar.extractFile(archive, filename).equals(fs.readFileSync(path.join(root, filename))),
        `ASAR changed the compiled artifact: ${filename}`);
    }
    for (const filename of included) assert(packaged.has(filename), `ASAR omitted ${filename}`);
    for (const entry of (audit || auditReferences(root)).references) {
      if (!entry.owner.startsWith(`src${path.sep}`) || entry.owner.startsWith(`src${path.sep}legacy${path.sep}`)) continue;
      // Source renderer/preload modules are compiled into their entry bundles.
      // Their assets still need shipping, but their authored imports do not.
      if (entry.kind === 'module' && !packaged.has(entry.owner.split(path.sep).join('/'))) continue;
      assert(packaged.has(entry.target.split(path.sep).join('/')), `Packaged reference is missing: ${entry.owner} -> ${entry.target}`);
    }
    assert(![...packaged].some(name => name.startsWith('src/legacy/') || name.startsWith('themes/')));
    assert(!packaged.has('src/renderer/Renderer.js'));
    assert(!packaged.has('src/preload/index.js'));
    assert(!packaged.has(`${OUTPUT_PATH}.map`));
    for (const filename of included.filter(name => /\.(ttf|png|gif)$/.test(name))) {
      assert(asar.extractFile(archive, filename).equals(fs.readFileSync(path.join(root, filename))),
        `Packaged asset bytes changed: ${filename}`);
    }
    console.log(`        Verified ${included.length} packaged source/asset files.`);
  });
});

runSuite(suite);
