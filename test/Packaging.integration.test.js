const fs = require('fs');
const path = require('path');
const asar = require('@electron/asar');
const {FileMatcher} = require('app-builder-lib/out/fileMatcher');
const {assert, createSuite, runSuite, withTemporaryDirectory} = require('./helpers/TestHarness');
const {filesUnder} = require('./helpers/SourceReferences');
const {buildRenderer, OUTPUT_PATH} = require('../scripts/build-renderer');
const verify = require('../scripts/verify-package');
const config = require('../package.json');
const root = path.resolve(__dirname, '..');
const suite = createSuite('Production package boundaries', 'integration',
  'Exercises the builder file rules and finished ASAR/resources, including private-file and missing-runtime failures.');

function write(root, filename, content = 'fixture') {
  const target = path.join(root, filename);
  fs.mkdirSync(path.dirname(target), {recursive: true});
  fs.writeFileSync(target, content);
}

async function fixture(directory, {platform = 'linux', change} = {}) {
  const app = path.join(directory, 'payload');
  const resources = path.join(directory, 'resources');
  const expected = {name:'mynda', version:'1.0.0', main:'src/bootstrap.js',
    dependencies:{'runtime-fixture':'1.0.0'}, devDependencies:{'build-fixture':'1.0.0'}};
  for (const name of verify.REQUIRED_APP_FILES) write(app, name);
  write(app, 'package.json', JSON.stringify(expected));
  write(app, 'node_modules/runtime-fixture/package.json', '{"name":"runtime-fixture"}');
  for (const name of ['THIRD_PARTY_NOTICES.md','licenses/fonts.txt','licenses/OFL-1.1.txt']) write(resources, name);
  for (const name of verify.REQUIRED_MEDIA_NOTICES) write(resources, `media-tools/${name}`);
  const tools = platform === 'darwin' ? ['ffmpeg','ffprobe','mpv.app/Contents/MacOS/mpv'] :
    platform === 'win32' ? ['ffmpeg.exe','ffprobe.exe','mpv.exe'] : ['ffmpeg','ffprobe','mpv'];
  for (const name of tools) write(resources, `media-tools/${name}`);
  if (change) change({app, resources, expected});
  const archive = path.join(resources, 'app.asar');
  await asar.createPackage(app, archive);
  return {app, resources, archive, expected, platform};
}

suite.test('builder includes the runtime and excludes unrelated/private files at every app boundary', async () => {
  await withTemporaryDirectory('package-policy', directory => {
    const include = new FileMatcher(directory, path.join(directory,'output'), value=>value, config.build.files).createFilter();
    const wanted = ['src/bootstrap.js', 'src/main/index.js', 'src/tagging/MetadataCredentials.js',
      'src/renderer/index.html', OUTPUT_PATH, 'src/preload/generated/preload.js',
      'src/renderer/styles/main.css', 'src/renderer/styles/themes/_fonts/Dorsa-Regular.ttf',
      'images/logos/rt-logo.png', 'images/loading-icon.gif'];
    const unwanted = ['future-notes.txt', 'library.json', '.env', '.env.production', '.dev.vars', '.npmrc',
      'metadata-server.local.json', 'metadata-credentials.json', '.metadata-credentials-key.tmp', 'omdb.js',
      'src/tagging/omdb.js', 'src/tagging/.secret.js', 'src/tagging/private.json',
      'src/renderer/Renderer.js', `${OUTPUT_PATH}.map`, 'src/preload/index.js',
      'src/legacy/Stream.js', 'images/library-real.json', 'images/.env', 'licenses/.env',
      'test/fixture.js', 'scripts/private.js', 'devtools/extension.js', 'sandbox/library.json',
      'dist/old-app.zip', 'vendor/media-tools/win-x64/mpv.exe', '.git/config',
      'THIRD_PARTY_NOTICES.md', 'licenses/fonts.txt'];
    for (const filename of [...wanted, ...unwanted]) {
      write(directory, filename);
      const absolute = path.join(directory, filename);
      assert.strictEqual(include(absolute, fs.statSync(absolute)), wanted.includes(filename), filename);
    }
    assert.strictEqual(config.build.allowMissingDependencies, false);
    assert.strictEqual(config.build.asar, true);
    assert.strictEqual(config.build.afterPack, './scripts/verify-package.js');
    assert.match(config.scripts.dist, /--publish never/);
  });
});

suite.test('production bundles retain external debug maps without linking or packaging them', async () => {
  await buildRenderer({mode:'production'});
  const bundle = fs.readFileSync(path.join(root, OUTPUT_PATH), 'utf8');
  assert(!/sourceMappingURL=/.test(bundle));
  const map = JSON.parse(fs.readFileSync(path.join(root, `${OUTPUT_PATH}.map`), 'utf8'));
  assert(!map.sourcesContent, 'Production source text must not be embedded in the map');
});

suite.test('the actual compiled app and its CSS/font/image references pass archive inspection', async () => {
  await withTemporaryDirectory('package-real-assets', async directory => {
    const stage = path.join(directory, 'app');
    const include = new FileMatcher(root, stage, value=>value, config.build.files).createFilter();
    for (const folder of ['src','images']) {
      for (const filename of filesUnder(path.join(root, folder))) {
        if (include(filename, fs.statSync(filename))) write(stage, path.relative(root, filename), fs.readFileSync(filename));
      }
    }
    // Native/full-builder tests own dependency execution; this fixture checks
    // our production assets with a real archive, without copying node_modules.
    const expected = {...config, dependencies:{}, devDependencies:{}};
    write(stage, 'package.json', JSON.stringify(expected));
    const archive = path.join(directory, 'app.asar');
    await asar.createPackage(stage, archive);
    const result = verify.inspectArchive(archive, expected);
    assert(result.files > 100);
  });
});

suite.test('finished resource layouts pass for macOS, Windows and Linux fixtures', async () => {
  for (const platform of ['darwin','win32','linux']) await withTemporaryDirectory(`package-${platform}`, async directory => {
    const value = await fixture(directory, {platform});
    assert.strictEqual(verify.verifyPackage(value.resources, value).platform, platform);
  });
});

suite.test('finished archives reject missing startup files, assets and production dependencies', async () => {
  for (const missing of ['src/bootstrap.js','src/main/index.js','src/preload/generated/preload.js',
    OUTPUT_PATH, 'images/logos/imdb-logo.png', 'node_modules/runtime-fixture/package.json']) {
    await withTemporaryDirectory('package-missing', async directory => {
      const value = await fixture(directory, {change:({app})=>fs.unlinkSync(path.join(app,missing))});
      assert.throws(()=>verify.verifyPackage(value.resources,value), /missing or empty|Production dependency is missing/);
    });
  }
  await withTemporaryDirectory('package-font', async directory => {
    const value = await fixture(directory, {change:({app})=>
      write(app,'src/renderer/styles/main.css','@font-face {src:url("themes/_fonts/Missing.ttf")}')});
    assert.throws(()=>verify.verifyPackage(value.resources,value), /Packaged asset.*Missing.ttf/);
  });
});

suite.test('finished archives reject leaked development files, credentials and library snapshots', async () => {
  for (const extra of ['.env', 'omdb.js', 'library.json', 'src/tagging/omdb.js', 'test/fixture.js',
    'src/renderer/Renderer.js', 'src/renderer/generated/renderer.js.map',
    'node_modules/runtime-fixture/metadata-credentials.json', 'node_modules/build-fixture/package.json']) {
    await withTemporaryDirectory('package-leak', async directory => {
      const value = await fixture(directory, {change:({app})=>write(app,extra,'secret-fixture')});
      assert.throws(()=>verify.verifyPackage(value.resources,value), /Unexpected or private|Development dependency/);
    });
  }
});

suite.test('finished resources reject missing sidecars/notices, leaked data and unexpected unpacked files', async () => {
  for (const missing of ['media-tools/ffmpeg','media-tools/licenses/MPV-LICENSE.GPL',
    'THIRD_PARTY_NOTICES.md', 'licenses/fonts.txt', 'licenses/OFL-1.1.txt']) {
    await withTemporaryDirectory('package-resource-missing', async directory => {
      const value = await fixture(directory, {change:({resources})=>fs.unlinkSync(path.join(resources,missing))});
      assert.throws(()=>verify.verifyPackage(value.resources,value), /Required packaged resource is missing/);
    });
  }
  for (const extra of ['media-tools/.env', 'licenses/metadata-credentials.json',
    'media-tools/library-real.json', 'app.asar.unpacked/debug.txt']) {
    await withTemporaryDirectory('package-resource-leak', async directory => {
      const value = await fixture(directory, {change:({resources})=>write(resources,extra)});
      assert.throws(()=>verify.verifyPackage(value.resources,value), /Private file|Unexpected unpacked/);
    });
  }
});

runSuite(suite);
