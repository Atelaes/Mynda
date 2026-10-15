const fs = require('fs');
const path = require('path');
const {
  assert,
  createSuite,
  runSuite
} = require('./helpers/TestHarness.js');

const packageJson = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, '..', 'package.json'),
  'utf8'
));
const buildFiles = packageJson.build && packageJson.build.files;
const extraResources = packageJson.build && packageJson.build.extraResources;
const dependencies = packageJson.dependencies || {};
const devDependencies = packageJson.devDependencies || {};

const suite = createSuite(
  'Production package file boundaries',
  'unit',
  'Checks the declarative electron-builder rules without creating an application bundle.'
);

suite.test('includes the application tree in production builds', () => {
  assert(Array.isArray(buildFiles), 'package.json build.files must be an array');
  assert(buildFiles.includes('**/*'), 'the application inclusion rule is missing');
});

suite.test('excludes the complete root sandbox tree after the broad inclusion', () => {
  const includeIndex = buildFiles.indexOf('**/*');
  const excludeIndex = buildFiles.indexOf('!sandbox{,/**/*}');
  assert(excludeIndex >= 0, 'the sandbox exclusion is missing');
  assert(excludeIndex > includeIndex, 'the sandbox exclusion must follow the broad inclusion');
});

suite.test('continues to exclude development-only files', () => {
  [
    '!devtools/**/*',
    '!scripts/**/*',
    '!src/legacy{,/**/*}',
    '!themes{,/**/*}',
    '!SOURCE_LAYOUT.md',
    '!test/**/*',
    '!vendor/**/*',
    '!TESTING.md',
    '!MEDIA_TOOLS.md',
    '!metadata-server.local.json',
    '!METADATA_SERVER.md'
  ].forEach(pattern => {
    assert(buildFiles.includes(pattern), `missing production exclusion: ${pattern}`);
  });
});

suite.test('ships node-mpv as a production dependency', () => {
  assert(dependencies['node-mpv'], 'node-mpv must be present in dependencies');
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(devDependencies, 'node-mpv'),
    false,
    'node-mpv must not remain development-only'
  );
});

suite.test('keeps test transpilers out of production and removes unused legacy packages', () => {
  for (const name of ['@babel/core','@babel/preset-react','@babel/register']) {
    assert(devDependencies[name], `${name} is required by source tests`);
    assert.strictEqual(dependencies[name], undefined);
  }
  for (const name of ['@babel/cli','request','fs-hard-drive','subtitle']) {
    assert.strictEqual(dependencies[name], undefined);
    assert.strictEqual(devDependencies[name], undefined);
  }
});

suite.test('does not ship an opaque npm FFmpeg binary package', () => {
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(dependencies, 'ffmpeg-ffprobe-static'),
    false,
    'the GPL-tagged static package must be replaced by Mynda\'s verified LGPL sidecars'
  );
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(dependencies, 'ffmpeg-static'),
    false,
    'the superseded FFmpeg-only package should be removed'
  );
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(dependencies, 'ffprobe-static'),
    false,
    'the old multi-platform FFprobe bundle should not be added'
  );
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(dependencies, 'ffprobe'),
    false,
    'the stream-only FFprobe wrapper should not discard container metadata'
  );
});

suite.test('does not ship the retired HLS player or its dependencies', () => {
  assert.strictEqual(dependencies['hls-server'], undefined);
  assert.strictEqual(dependencies['hls.js'], undefined);
  assert(buildFiles.includes('!src/legacy{,/**/*}'));
});

suite.test('copies only the matching staged platform media directory into Resources', () => {
  assert(Array.isArray(extraResources), 'package.json build.extraResources must be an array');
  assert.deepStrictEqual(extraResources, [{
    from: 'vendor/media-tools/${os}-${arch}',
    to: 'media-tools',
    filter: ['**/*']
  }]);
  assert.strictEqual(packageJson.build.asarUnpack, undefined);
});

suite.test('builds the browser bundle and verifies media even when electron-builder is invoked directly', () => {
  assert.strictEqual(packageJson.build.beforeBuild, './scripts/before-build.js');
  assert(packageJson.scripts['media:prepare'].includes('prepare-media-tools.js'));
  assert(packageJson.scripts['media:prepare:macos'].includes('prepare-media-tools-macos.sh'));
  assert(packageJson.scripts['media:prepare:windows'].includes('prepare-media-tools-windows.ps1'));
  assert(packageJson.scripts['media:prepare:linux'].includes('prepare-media-tools-linux.sh'));
  assert(packageJson.scripts['media:status'].includes('media-tools-status.js'));
  assert(packageJson.scripts['media:verify'].includes('verify-media-tools.js'));
});

suite.test('declares native Windows and Linux distributable targets', () => {
  assert.strictEqual(packageJson.build.win.target, 'nsis');
  assert.strictEqual(packageJson.build.linux.target, 'AppImage');
  assert.strictEqual(packageJson.build.linux.category, 'AudioVideo');
});

suite.test('pins the upgraded runtime and packaging tools with a supported build host and macOS floor', () => {
  for (const name of ['electron','electron-builder','@electron/asar']) {
    assert(/^\d+\.\d+\.\d+$/.test(devDependencies[name]), `${name} must be an exact stable version`);
  }
  assert.strictEqual(packageJson.engines.node, '>=22.12.0');
  assert.strictEqual(packageJson.build.mac.minimumSystemVersion, '13.0.0');
  assert.strictEqual(packageJson.scripts['electron:install'], 'install-electron');
});

suite.test('runs the packaged dependency smoke check after building', () => {
  const command = packageJson.scripts && packageJson.scripts['test:package'];
  assert.strictEqual(packageJson.main, 'src/bootstrap.js');
  assert(command.includes('npm run media:verify'));
  assert(command && command.includes('electron-builder --dir'));
  assert(command.includes('test/package/run-packaged-media-smoke.js'));
});

suite.test('requires verified media tools before creating distributable artifacts', () => {
  assert(packageJson.scripts.dist.startsWith('npm run media:verify'));
  assert(packageJson.scripts['test:media'].includes('--require-bundled'));
});

runSuite(suite);
