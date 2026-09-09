#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const {execFile} = require('child_process');
const MediaBundleInspection = require('../src/MediaBundleInspection.js');
const MediaToolPolicy = require('../src/MediaToolPolicy.js');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const EXPECTED = {
  ffmpeg: '6.1.6',
  ffprobe: '6.1.6',
  mpv: '0.41.0'
};

function builderPlatform(platform) {
  if (platform === 'darwin') return 'mac';
  if (platform === 'win32') return 'win';
  return platform;
}

function stageDirectory(options = {}) {
  const projectRoot = options.projectRoot || PROJECT_ROOT;
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  return path.join(projectRoot, 'vendor', 'media-tools', `${builderPlatform(platform)}-${arch}`);
}

function toolPaths(stage, platform) {
  const suffix = platform === 'win32' ? '.exe' : '';
  return {
    ffmpeg: path.join(stage, `ffmpeg${suffix}`),
    ffprobe: path.join(stage, `ffprobe${suffix}`),
    mpv: platform === 'darwin' ?
      path.join(stage, 'mpv.app', 'Contents', 'MacOS', 'mpv') :
      path.join(stage, `mpv${suffix}`)
  };
}

function runExecutable(filename, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(filename, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      maxBuffer: 20 * 1024 * 1024,
      timeout: options.timeout || 30000,
      windowsHide: true
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = String(stdout || '');
        error.stderr = String(stderr || '');
        reject(error);
        return;
      }
      resolve({stdout: String(stdout || ''), stderr: String(stderr || '')});
    });
  });
}

function assertExecutable(filename, label, platform = process.platform) {
  let stats;
  try {
    stats = fs.statSync(filename);
  } catch(error) {
    throw new Error(`${label} is missing: ${filename}`);
  }
  if (!stats.isFile()) throw new Error(`${label} is not a file: ${filename}`);
  if (platform !== 'win32') {
    try {
      fs.accessSync(filename, fs.constants.X_OK);
    } catch(error) {
      throw new Error(`${label} is not executable: ${filename}`);
    }
  }
}

function walkFiles(directory, result = []) {
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) walkFiles(filename, result);
    else if (entry.isFile()) result.push(filename);
  }
  return result;
}

function assertNoDvdCss(stage) {
  // Compliance notices and our source patch deliberately mention libdvdcss.
  // Reject actual library artifacts, not documentation proving their removal.
  const dvdCssLibraryName = /^libdvdcss(?:[-.]?\d+)*(?:\.dylib|\.dll|\.a|\.so(?:\.\d+)*)?$/i;
  const matches = walkFiles(stage).filter(filename =>
    dvdCssLibraryName.test(path.basename(filename))
  );
  if (matches.length) {
    throw new Error(`libdvdcss must not be bundled:\n${matches.join('\n')}`);
  }

  const dvdreadLibraries = walkFiles(stage).filter(filename =>
    /(?:libdvdread[^/]*\.(?:dylib|dll)|libdvdread\.so(?:\.\d+)*)$/i.test(path.basename(filename))
  );
  for (const filename of dvdreadLibraries) {
    const contents = fs.readFileSync(filename);
    if (contents.includes(Buffer.from('libdvdcss'))) {
      throw new Error(
        `Bundled libdvdread must not contain a dynamic libdvdcss loader: ${filename}`
      );
    }
  }
}

function dependencyPaths(otoolOutput) {
  return String(otoolOutput || '').split(/\r?\n/).slice(1)
    .map(line => line.trim().split(/\s+/)[0])
    .filter(Boolean);
}

function runtimeDependencyPaths(filename, otoolOutput) {
  const paths = dependencyPaths(otoolOutput);
  // For a dylib, otool -L prints LC_ID_DYLIB first. That is the library's own
  // historical install identifier, not a path the library attempts to load.
  // The remaining entries are its real runtime dependencies.
  return /\.dylib$/i.test(filename) ? paths.slice(1) : paths;
}

async function assertRelocatableMacBinaries(stage, paths, arch, runner = runExecutable) {
  const libraryFiles = walkFiles(path.join(stage, 'mpv.app', 'Contents'))
    .filter(filename => /\.dylib$/i.test(filename));
  const machoFiles = [paths.ffmpeg, paths.ffprobe, paths.mpv, ...libraryFiles];
  const forbidden = [];

  for (const filename of machoFiles) {
    const linked = await runner('/usr/bin/otool', ['-L', filename]);
    for (const dependency of runtimeDependencyPaths(filename, linked.stdout)) {
      if (/libdvdcss/i.test(dependency)) {
        forbidden.push(`${filename}: ${dependency}`);
      } else if (dependency.startsWith('/') &&
        !dependency.startsWith('/System/Library/') &&
        !dependency.startsWith('/usr/lib/')) {
        forbidden.push(`${filename}: ${dependency}`);
      }
    }
  }

  if (forbidden.length) {
    throw new Error(
      `Bundled media tools still reference non-system libraries outside the app:\n${forbidden.join('\n')}`
    );
  }

  for (const filename of [paths.ffmpeg, paths.ffprobe, paths.mpv]) {
    const architectures = await runner('/usr/bin/lipo', ['-archs', filename]);
    const values = architectures.stdout.trim().split(/\s+/);
    if (!values.includes(arch)) {
      throw new Error(`${filename} does not contain the required ${arch} architecture`);
    }
  }
}

function assertVersion(output, name, expected) {
  // FFmpeg reports "ffmpeg version 6.1.6" while current MPV reports
  // "mpv v0.41.0". Accept only those harmless presentation differences.
  const pattern = new RegExp(
    `(?:^|\\s)${name}(?: version)? v?${expected.replace(/\./g, '\\.')}\\b`,
    'i'
  );
  if (!pattern.test(output)) {
    throw new Error(`${name} ${expected} was expected, but received: ${MediaToolPolicy.firstLine(output)}`);
  }
}

async function verifyFfmpegSidecars(options = {}) {
  const platform = options.platform || process.platform;
  const stage = options.stage || stageDirectory({
    projectRoot: options.projectRoot,
    platform,
    arch: options.arch || process.arch
  });
  const runner = options.runExecutable || runExecutable;
  const paths = toolPaths(stage, platform);

  assertExecutable(paths.ffmpeg, 'FFmpeg', platform);
  assertExecutable(paths.ffprobe, 'FFprobe', platform);

  const ffmpegVersion = await runner(paths.ffmpeg, ['-version']);
  const ffmpegOutput = `${ffmpegVersion.stdout}\n${ffmpegVersion.stderr}`;
  assertVersion(ffmpegOutput, 'ffmpeg', EXPECTED.ffmpeg);
  const ffmpegLicense = MediaToolPolicy.assertLgplOnlyFfmpeg(ffmpegOutput, 'FFmpeg');

  const ffprobeVersion = await runner(paths.ffprobe, ['-version']);
  const ffprobeOutput = `${ffprobeVersion.stdout}\n${ffprobeVersion.stderr}`;
  assertVersion(ffprobeOutput, 'ffprobe', EXPECTED.ffprobe);
  const ffprobeLicense = MediaToolPolicy.assertLgplOnlyFfmpeg(ffprobeOutput, 'FFprobe');

  return {
    paths,
    ffmpeg: {
      version: MediaToolPolicy.firstLine(ffmpegOutput),
      license: 'LGPL-2.1-or-later',
      configuration: ffmpegLicense.configuration
    },
    ffprobe: {
      version: MediaToolPolicy.firstLine(ffprobeOutput),
      license: 'LGPL-2.1-or-later',
      configuration: ffprobeLicense.configuration
    }
  };
}

async function verifyStage(options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const stage = options.stage || stageDirectory({
    projectRoot: options.projectRoot,
    platform,
    arch
  });
  const runner = options.runExecutable || runExecutable;
  const paths = toolPaths(stage, platform);

  const supportedTargets = new Set(['darwin-arm64', 'win32-x64', 'linux-x64']);
  if (!supportedTargets.has(`${platform}-${arch}`)) {
    throw new Error(
      `Mynda does not yet prepare ${builderPlatform(platform)}-${arch} media tools. ` +
      'The current targets are mac-arm64, win-x64, and linux-x64. Build each target on its native host.'
    );
  }
  if (!fs.existsSync(stage) || !fs.statSync(stage).isDirectory()) {
    throw new Error(
      `Prepared media tools were not found at ${stage}. Run "npm run media:prepare" on the target platform first.`
    );
  }

  assertExecutable(paths.ffmpeg, 'FFmpeg', platform);
  assertExecutable(paths.ffprobe, 'FFprobe', platform);
  assertExecutable(paths.mpv, 'MPV', platform);
  [
    path.join(stage, 'THIRD_PARTY_NOTICES.md'),
    path.join(stage, 'licenses', 'FFmpeg-COPYING.LGPLv2.1'),
    path.join(stage, 'licenses', 'MPV-LICENSE.GPL'),
    path.join(stage, 'licenses', 'libdvdread-COPYING'),
    path.join(stage, 'licenses', 'libdvdnav-COPYING'),
    path.join(stage, 'licenses', 'libdvdread-no-libdvdcss.patch')
  ].forEach(filename => {
    if (!fs.existsSync(filename)) throw new Error(`Required media license file is missing: ${filename}`);
  });
  assertNoDvdCss(stage);

  const ffmpegSidecars = await verifyFfmpegSidecars({
    stage,
    platform,
    arch,
    runExecutable: runner
  });

  const mpvVersion = await runner(paths.mpv, ['--version']);
  const mpvOutput = `${mpvVersion.stdout}\n${mpvVersion.stderr}`;
  assertVersion(mpvOutput, 'mpv', EXPECTED.mpv);
  const protocols = await runner(paths.mpv, ['--no-config', '--list-protocols']);
  const protocolOutput = `${protocols.stdout}\n${protocols.stderr}`;
  MediaToolPolicy.assertMpvDvdSupport(protocolOutput);
  const videoOutputs = await runner(paths.mpv, ['--no-config', '--vo=help']);
  const videoOutputHelp = `${videoOutputs.stdout}\n${videoOutputs.stderr}`;
  const gpuContexts = await runner(paths.mpv, ['--no-config', '--gpu-context=help']);
  const gpuContextHelp = `${gpuContexts.stdout}\n${gpuContexts.stderr}`;
  const videoSupport = MediaToolPolicy.assertMpvVideoSupport(
    platform,
    videoOutputHelp,
    gpuContextHelp
  );

  if (platform === 'darwin' && options.skipMachOChecks !== true) {
    await assertRelocatableMacBinaries(stage, paths, arch, runner);
  } else if (platform === 'win32' && options.skipWindowsChecks !== true) {
    MediaBundleInspection.assertWindowsBundle(stage, paths, arch, {
      readFile: options.readFile
    });
  } else if (platform === 'linux' && options.skipLinuxChecks !== true) {
    await MediaBundleInspection.assertLinuxBundle(stage, paths, arch, runner, {
      readFile: options.readFile
    });
  }

  return {
    schemaVersion: 3,
    platform,
    arch,
    ffmpeg: ffmpegSidecars.ffmpeg,
    ffprobe: ffmpegSidecars.ffprobe,
    mpv: {
      version: MediaToolPolicy.firstLine(mpvOutput),
      license: 'GPL-2.0-or-later',
      dvd: true,
      graphicalVideo: true,
      videoOutput: videoSupport.videoOutputs[0],
      gpuContext: videoSupport.gpuContexts[0],
      gpuContexts: videoSupport.gpuContexts,
      videoPolicy: videoSupport.description,
      libdvdcssBundled: false,
      libdvdcssDynamicLoading: false
    }
  };
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (!argument.startsWith('--')) continue;
    values[argument.slice(2)] = argv[index + 1];
    index++;
  }
  return values;
}

async function beforeBuild(context) {
  const platform = context && context.platform && context.platform.nodeName ?
    context.platform.nodeName : process.platform;
  const arch = context && context.arch ? context.arch : process.arch;
  const report = await verifyStage({platform, arch});
  console.log(`  • verified bundled media tools  platform=${builderPlatform(platform)} arch=${arch}`);
  return Boolean(report);
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args.mode === 'ffmpeg') {
    const report = await verifyFfmpegSidecars({
      stage: args.stage,
      platform: args.platform || process.platform,
      arch: args.arch || process.arch
    });
    console.log(`Verified reusable ${report.ffmpeg.version} and ${report.ffprobe.version}`);
    return;
  }
  const report = await verifyStage({
    stage: args.stage,
    platform: args.platform || process.platform,
    arch: args.arch || process.arch
  });
  if (args['write-info']) {
    fs.writeFileSync(args['write-info'], `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(`Verified Mynda media tools (${builderPlatform(report.platform)}-${report.arch}):`);
  console.log(`  ${report.ffmpeg.version} — LGPL-only configuration`);
  console.log(`  ${report.ffprobe.version} — LGPL-only configuration`);
  console.log(
    `  ${report.mpv.version} — bundled, relocatable, ` +
    `${report.mpv.videoPolicy}, dvd:// enabled, no libdvdcss`
  );
}

if (require.main === module) {
  main().catch(error => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  });
}

module.exports = beforeBuild;
module.exports.assertNoDvdCss = assertNoDvdCss;
module.exports.assertRelocatableMacBinaries = assertRelocatableMacBinaries;
module.exports.assertVersion = assertVersion;
module.exports.beforeBuild = beforeBuild;
module.exports.builderPlatform = builderPlatform;
module.exports.dependencyPaths = dependencyPaths;
module.exports.runtimeDependencyPaths = runtimeDependencyPaths;
module.exports.stageDirectory = stageDirectory;
module.exports.toolPaths = toolPaths;
module.exports.verifyFfmpegSidecars = verifyFfmpegSidecars;
module.exports.verifyStage = verifyStage;
