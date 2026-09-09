const fs = require('fs');
const path = require('path');
const MediaTools = require('../src/MediaTools.js');
const {
  assert,
  createSuite,
  runSuite,
  withTemporaryDirectory
} = require('./helpers/TestHarness.js');

const suite = createSuite(
  'Media executable resolution',
  'unit',
  'Checks packaged/staged sidecar paths, executable validation, and development fallbacks without launching media tools.'
);

suite.test('maps Electron and Node platforms to electron-builder stage names', () => {
  assert.strictEqual(MediaTools.builderPlatform('darwin'), 'mac');
  assert.strictEqual(MediaTools.builderPlatform('win32'), 'win');
  assert.strictEqual(MediaTools.builderPlatform('linux'), 'linux');
});

suite.test('uses one architecture-specific developer staging directory', () => {
  assert.strictEqual(
    MediaTools.stagedMediaRoot({
      projectRoot: '/project',
      platform: 'darwin',
      arch: 'arm64'
    }),
    path.join('/project', 'vendor', 'media-tools', 'mac-arm64')
  );
  assert.strictEqual(
    MediaTools.stagedMediaRoot({projectRoot: 'C:\\project', platform: 'win32', arch: 'x64'}),
    path.join('C:\\project', 'vendor', 'media-tools', 'win-x64')
  );
  assert.strictEqual(
    MediaTools.stagedMediaRoot({projectRoot: '/project', platform: 'linux', arch: 'x64'}),
    path.join('/project', 'vendor', 'media-tools', 'linux-x64')
  );
});

suite.test('accepts files only when they are executable on Unix', async () => {
  await withTemporaryDirectory('media-executable', directory => {
    const candidate = path.join(directory, 'tool');
    fs.writeFileSync(candidate, '#!/bin/sh\nexit 0\n');
    if (process.platform !== 'win32') {
      fs.chmodSync(candidate, 0o644);
      assert.strictEqual(MediaTools.executableExists(candidate), false);
      fs.chmodSync(candidate, 0o755);
    }
    assert.strictEqual(MediaTools.executableExists(candidate), true);
    assert.strictEqual(MediaTools.executableExists(path.join(directory, 'missing')), false);
  });
});

suite.test('gives explicit executable overrides first priority', () => {
  const candidates = MediaTools.mpvCandidates({
    env: {MYNDA_MPV_PATH: '/custom/player/mpv', PATH: '/one:/two'},
    platform: 'linux',
    arch: 'x64',
    projectRoot: '/project',
    homeDirectory: '/home/example',
    resourcesPath: '/resources'
  });
  assert.strictEqual(candidates[0], '/custom/player/mpv');
  assert(candidates.includes('/resources/media-tools/mpv'));
  assert(candidates.includes(path.join('/project', 'vendor', 'media-tools', 'linux-x64', 'mpv')));
  assert(candidates.includes('/one/mpv'));
});

suite.test('looks in packaged Resources before the developer stage and PATH', () => {
  const candidates = MediaTools.mediaToolCandidates('ffprobe', {
    env: {PATH: '/usr/bin'},
    platform: 'darwin',
    arch: 'arm64',
    projectRoot: '/project',
    resourcesPath: '/Applications/Mynda.app/Contents/Resources'
  });
  assert.deepStrictEqual(candidates.slice(0, 3), [
    '/Applications/Mynda.app/Contents/Resources/media-tools/ffprobe',
    path.join('/project', 'vendor', 'media-tools', 'mac-arm64', 'ffprobe'),
    '/usr/bin/ffprobe'
  ]);
});

suite.test('includes common Homebrew, MacPorts, and app-bundle locations on macOS', () => {
  const candidates = MediaTools.mpvCandidates({
    env: {PATH: ''},
    platform: 'darwin',
    homeDirectory: '/Users/example',
    resourcesPath: '/Applications/Mynda.app/Contents/Resources'
  });
  assert(candidates.includes('/opt/homebrew/bin/mpv'));
  assert(candidates.includes('/opt/local/bin/mpv'));
  assert(candidates.includes('/usr/local/bin/mpv'));
  assert(candidates.includes('/Applications/mpv.app/Contents/MacOS/mpv'));
});

suite.test('finds the first executable MPV candidate', () => {
  const inspected = [];
  const found = MediaTools.findMpvPath({
    env: {MYNDA_MPV_PATH: '/missing/mpv', PATH: '/working:/later'},
    platform: 'linux',
    arch: 'x64',
    projectRoot: '/project',
    homeDirectory: '/home/example',
    resourcesPath: '/resources',
    isExecutable(candidate) {
      inspected.push(candidate);
      return candidate === '/working/mpv';
    }
  });
  assert.strictEqual(found, '/working/mpv');
  assert.deepStrictEqual(inspected.slice(0, 4), [
    '/missing/mpv',
    '/resources/media-tools/mpv',
    path.join('/project', 'vendor', 'media-tools', 'linux-x64', 'mpv'),
    '/working/mpv'
  ]);
});

suite.test('reports no MPV when every known location is unavailable', () => {
  assert.strictEqual(MediaTools.findMpvPath({
    env: {PATH: ''},
    platform: 'linux',
    arch: 'x64',
    projectRoot: '/project',
    homeDirectory: '/home/example',
    resourcesPath: '',
    isExecutable: () => false
  }), null);
});

suite.test('uses .exe names for every Windows media sidecar', () => {
  const candidates = MediaTools.bundledCandidates('ffprobe', {
    platform: 'win32',
    arch: 'x64',
    projectRoot: 'C:\\project',
    resourcesPath: 'C:\\Mynda\\resources'
  });
  assert(candidates.every(candidate => candidate.toLowerCase().endsWith('ffprobe.exe')));
  assert(candidates.some(candidate => candidate.includes('win-x64')));
});

suite.test('reports staged, packaged, overridden, system, and missing sources', () => {
  const options = {
    platform: 'linux',
    arch: 'x64',
    projectRoot: '/project',
    resourcesPath: '/application/resources',
    env: {MYNDA_MPV_PATH: '/custom/mpv', PATH: '/usr/bin'}
  };
  assert.strictEqual(MediaTools.mediaToolSource('mpv', '/custom/mpv', options), 'override');
  assert.strictEqual(
    MediaTools.mediaToolSource('mpv', '/application/resources/media-tools/mpv', options),
    'packaged'
  );
  assert.strictEqual(
    MediaTools.mediaToolSource('mpv', '/project/vendor/media-tools/linux-x64/mpv', options),
    'staged'
  );
  assert.strictEqual(MediaTools.mediaToolSource('mpv', '/usr/bin/mpv', options), 'system');
  assert.strictEqual(MediaTools.mediaToolSource('mpv', null, options), 'missing');
});

runSuite(suite);
