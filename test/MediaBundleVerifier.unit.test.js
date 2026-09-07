const fs = require('fs');
const path = require('path');
const MediaBundleVerifier = require('../scripts/verify-media-tools.js');
const {
  assert,
  createSuite,
  runSuite,
  withTemporaryDirectory
} = require('./helpers/TestHarness.js');

const suite = createSuite(
  'Media bundle staging verifier',
  'unit',
  'Protects platform staging, checksum/build policy, libdvdcss exclusion, and relocatable macOS dylibs.'
);

suite.test('selects the electron-builder platform and architecture directory', () => {
  assert.strictEqual(
    MediaBundleVerifier.stageDirectory({
      projectRoot: '/project',
      platform: 'darwin',
      arch: 'arm64'
    }),
    path.join('/project', 'vendor', 'media-tools', 'mac-arm64')
  );
});

suite.test('parses Mach-O dependency paths without their version annotations', () => {
  assert.deepStrictEqual(MediaBundleVerifier.dependencyPaths([
    '/tmp/mpv:',
    '\t@executable_path/lib/libass.9.dylib (compatibility version 9.0.0, current version 9.3.1)',
    '\t/System/Library/Frameworks/Cocoa.framework/Versions/A/Cocoa (compatibility version 1.0.0)'
  ].join('\n')), [
    '@executable_path/lib/libass.9.dylib',
    '/System/Library/Frameworks/Cocoa.framework/Versions/A/Cocoa'
  ]);
});

suite.test('accepts the real FFmpeg and MPV version-line formats', () => {
  assert.doesNotThrow(() => MediaBundleVerifier.assertVersion(
    'ffmpeg version 6.1.6 Copyright (c) the FFmpeg developers',
    'ffmpeg',
    '6.1.6'
  ));
  assert.doesNotThrow(() => MediaBundleVerifier.assertVersion(
    'mpv v0.41.0 Copyright © 2000-2025 mpv/MPlayer/mplayer2 projects',
    'mpv',
    '0.41.0'
  ));
  assert.throws(
    () => MediaBundleVerifier.assertVersion('mpv v0.40.0', 'mpv', '0.41.0'),
    /mpv 0\.41\.0 was expected/
  );
});

suite.test('reuses only version-pinned LGPL FFmpeg sidecars during an MPV rebuild', async () => {
  await withTemporaryDirectory('media-reusable-ffmpeg', async directory => {
    const paths = MediaBundleVerifier.toolPaths(directory, 'darwin');
    [paths.ffmpeg, paths.ffprobe].forEach(filename => {
      fs.mkdirSync(path.dirname(filename), {recursive: true});
      fs.writeFileSync(filename, 'fixture');
      fs.chmodSync(filename, 0o755);
    });
    const runner = async filename => ({
      stdout: `${path.basename(filename)} version 6.1.6\n` +
        'configuration: --disable-gpl --disable-nonfree --disable-version3\n',
      stderr: ''
    });
    const report = await MediaBundleVerifier.verifyFfmpegSidecars({
      stage: directory,
      platform: 'darwin',
      arch: 'arm64',
      runExecutable: runner
    });
    assert.strictEqual(report.ffmpeg.license, 'LGPL-2.1-or-later');
    assert.strictEqual(report.ffprobe.license, 'LGPL-2.1-or-later');
  });
});

suite.test('rejects a libdvdcss library while allowing the exclusion patch', async () => {
  await withTemporaryDirectory('media-no-dvdcss', directory => {
    const licenseDirectory = path.join(directory, 'licenses');
    fs.mkdirSync(licenseDirectory, {recursive: true});
    fs.writeFileSync(
      path.join(licenseDirectory, 'libdvdread-no-libdvdcss.patch'),
      'source patch documenting that the loader is disabled'
    );
    assert.doesNotThrow(() => MediaBundleVerifier.assertNoDvdCss(directory));

    fs.writeFileSync(path.join(directory, 'libdvdcss.2.dylib'), 'not a real library');
    assert.throws(
      () => MediaBundleVerifier.assertNoDvdCss(directory),
      /libdvdcss must not be bundled/
    );
  });
});

suite.test('rejects libdvdread when it still contains the dynamic libdvdcss loader', async () => {
  await withTemporaryDirectory('media-no-dvdcss-loader', directory => {
    const libraryDirectory = path.join(directory, 'mpv.app', 'Contents', 'MacOS', 'lib');
    fs.mkdirSync(libraryDirectory, {recursive: true});
    fs.writeFileSync(
      path.join(libraryDirectory, 'libdvdread.8.dylib'),
      Buffer.from('binary fixture\0libdvdcss.2.dylib\0')
    );
    assert.throws(
      () => MediaBundleVerifier.assertNoDvdCss(directory),
      /must not contain a dynamic libdvdcss loader/
    );
  });
});

suite.test('accepts a complete staged bundle with the real tool output formats', async () => {
  await withTemporaryDirectory('media-complete-stage', async directory => {
    const toolPaths = MediaBundleVerifier.toolPaths(directory, 'darwin');
    const dvdreadLibrary = path.join(
      directory,
      'mpv.app',
      'Contents',
      'MacOS',
      'lib',
      'libdvdread.8.dylib'
    );
    const requiredFiles = [
      path.join(directory, 'THIRD_PARTY_NOTICES.md'),
      path.join(directory, 'licenses', 'FFmpeg-COPYING.LGPLv2.1'),
      path.join(directory, 'licenses', 'MPV-LICENSE.GPL'),
      path.join(directory, 'licenses', 'libdvdread-COPYING'),
      path.join(directory, 'licenses', 'libdvdnav-COPYING'),
      path.join(directory, 'licenses', 'libdvdread-no-libdvdcss.patch'),
      dvdreadLibrary
    ];
    [...Object.values(toolPaths), ...requiredFiles].forEach(filename => {
      fs.mkdirSync(path.dirname(filename), {recursive: true});
      fs.writeFileSync(filename, 'fixture');
    });
    Object.values(toolPaths).forEach(filename => fs.chmodSync(filename, 0o755));

    const runner = async (filename, args) => {
      if (filename === toolPaths.ffmpeg) {
        return {
          stdout: 'ffmpeg version 6.1.6\nconfiguration: --disable-gpl --disable-nonfree --disable-version3\n',
          stderr: ''
        };
      }
      if (filename === toolPaths.ffprobe) {
        return {
          stdout: 'ffprobe version 6.1.6\nconfiguration: --disable-gpl --disable-nonfree --disable-version3\n',
          stderr: ''
        };
      }
      if (filename === toolPaths.mpv && args[0] === '--version') {
        return {
          stdout: 'mpv v0.41.0 Copyright © 2000-2025 mpv/MPlayer/mplayer2 projects\n',
          stderr: ''
        };
      }
      if (filename === toolPaths.mpv && args.includes('--list-protocols')) {
        return {stdout: 'Protocols:\n\n dvd://\n dvdnav://\n file://\n', stderr: ''};
      }
      if (filename === toolPaths.mpv && args.includes('--vo=help')) {
        return {stdout: 'Available video outputs:\n  gpu-next\n  gpu\n  null\n', stderr: ''};
      }
      if (filename === toolPaths.mpv && args.includes('--gpu-context=help')) {
        return {stdout: 'Available GPU contexts:\n  auto\n  macvk\n', stderr: ''};
      }
      throw new Error(`Unexpected verifier command: ${filename} ${args.join(' ')}`);
    };

    const report = await MediaBundleVerifier.verifyStage({
      stage: directory,
      platform: 'darwin',
      arch: 'arm64',
      runExecutable: runner,
      skipMachOChecks: true
    });
    assert.strictEqual(report.ffmpeg.license, 'LGPL-2.1-or-later');
    assert.strictEqual(report.ffprobe.license, 'LGPL-2.1-or-later');
    assert.strictEqual(report.mpv.dvd, true);
    assert.strictEqual(report.mpv.graphicalVideo, true);
    assert.strictEqual(report.mpv.videoOutput, 'gpu-next');
    assert.strictEqual(report.mpv.gpuContext, 'macvk');
    assert.strictEqual(report.mpv.libdvdcssBundled, false);
    assert.strictEqual(report.mpv.libdvdcssDynamicLoading, false);
  });
});

suite.test('accepts app-relative and Apple system Mach-O dependencies', async () => {
  await withTemporaryDirectory('media-relocatable', async directory => {
    const contents = path.join(directory, 'mpv.app', 'Contents');
    const libraryDirectory = path.join(contents, 'MacOS', 'lib');
    fs.mkdirSync(libraryDirectory, {recursive: true});
    const moltenVk = path.join(libraryDirectory, 'libMoltenVK.dylib');
    fs.writeFileSync(moltenVk, 'fixture');
    const paths = {
      ffmpeg: path.join(directory, 'ffmpeg'),
      ffprobe: path.join(directory, 'ffprobe'),
      mpv: path.join(contents, 'MacOS', 'mpv')
    };
    const runner = async (command, args) => {
      if (command === '/usr/bin/lipo') return {stdout: 'arm64\n', stderr: ''};
      if (args[1] === moltenVk) {
        return {stdout: [
          `${moltenVk}:`,
          '\t/opt/homebrew/opt/molten-vk/lib/libMoltenVK.dylib (compatibility version 1.0.0)',
          '\t/System/Library/Frameworks/Metal.framework/Versions/A/Metal (compatibility version 1.0.0)'
        ].join('\n'), stderr: ''};
      }
      return {stdout: [
        'fixture:',
        '\t@executable_path/lib/libass.9.dylib (compatibility version 9.0.0)',
        '\t/System/Library/Frameworks/Cocoa.framework/Versions/A/Cocoa (compatibility version 1.0.0)',
        '\t/usr/lib/libz.1.dylib (compatibility version 1.0.0)'
      ].join('\n'), stderr: ''};
    };
    await MediaBundleVerifier.assertRelocatableMacBinaries(
      directory,
      paths,
      'arm64',
      runner
    );
  });
});

suite.test('rejects a Homebrew dylib reference that escaped MPV bundling', async () => {
  await withTemporaryDirectory('media-external-dylib', async directory => {
    const contents = path.join(directory, 'mpv.app', 'Contents');
    const libraryDirectory = path.join(contents, 'MacOS', 'lib');
    fs.mkdirSync(libraryDirectory, {recursive: true});
    const moltenVk = path.join(libraryDirectory, 'libMoltenVK.dylib');
    fs.writeFileSync(moltenVk, 'fixture');
    const paths = {
      ffmpeg: path.join(directory, 'ffmpeg'),
      ffprobe: path.join(directory, 'ffprobe'),
      mpv: path.join(contents, 'MacOS', 'mpv')
    };
    const runner = async (command, args) => {
      if (command === '/usr/bin/lipo') return {stdout: 'arm64\n', stderr: ''};
      if (args[1] === moltenVk) {
        return {stdout: [
          `${moltenVk}:`,
          '\t/opt/homebrew/opt/molten-vk/lib/libMoltenVK.dylib (compatibility version 1.0.0)',
          '\t/opt/homebrew/opt/vulkan-loader/lib/libvulkan.1.dylib (compatibility version 1.0.0)'
        ].join('\n'), stderr: ''};
      }
      return {stdout: 'fixture:\n\t/usr/lib/libz.1.dylib (compatibility version 1.0.0)', stderr: ''};
    };
    await assert.rejects(
      MediaBundleVerifier.assertRelocatableMacBinaries(directory, paths, 'arm64', runner),
      /non-system libraries outside the app/
    );
  });
});

suite.test('pins verified sources and explicitly disables GPL/nonfree FFmpeg and libdvdcss', () => {
  const script = fs.readFileSync(path.resolve(
    __dirname,
    '..',
    'scripts',
    'prepare-media-tools-macos.sh'
  ), 'utf8');
  [
    'FFMPEG_VERSION="6.1.6"',
    'MPV_VERSION="0.41.0"',
    'DVDREAD_VERSION="7.1.1"',
    'DVDNAV_VERSION="7.0.0"',
    '--disable-gpl',
    '--disable-nonfree',
    '-Dlibdvdcss=disabled',
    '-DMYNDA_DISABLE_LIBDVDCSS',
    'libdvdread-no-libdvdcss.patch',
    'CANDIDATE_STAGE=',
    'Checking the completed media build preserved from the previous attempt',
    '-Dgpl=true',
    '-Ddvdnav=enabled',
    '-Dgl=enabled',
    '-Dvulkan=enabled',
    '-Dvideotoolbox-pl=enabled'
  ].forEach(value => assert(script.includes(value), `missing media build policy: ${value}`));
  assert.strictEqual((script.match(/_SHA256="[a-f0-9]{64}"/g) || []).length, 4);
});

runSuite(suite);
