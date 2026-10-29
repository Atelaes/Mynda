#!/usr/bin/env node
// Runs against the finished payload, including files copied outside app.asar.
// This is a contents check, not proof of signing, playback or native startup.
const fs = require('fs');
const path = require('path');
const asar = require('@electron/asar');
const configuration = require('../package.json');

const REQUIRED_APP_FILES = [
  'src/bootstrap.js', 'src/main/index.js', 'src/main/RendererBridge.js',
  'src/main/MetadataConnection.js', 'src/main/FeatureAccess.js',
  'src/main/PackagedMediaSmoke.js', 'src/main/LinuxSandboxCheck.js',
  'src/library/Library.js', 'src/library/LibraryPersistence.js',
  'src/tagging/MetadataCredentials.js', 'src/tagging/MetadataServerClient.js',
  'src/renderer/index.html', 'src/renderer/generated/renderer.js',
  'src/preload/generated/preload.js', 'src/renderer/styles/main.css',
  'src/renderer/styles/themes/appearances/dark-theme.css',
  'src/renderer/styles/themes/layouts/default-layout-theme.css',
  'images/mynda-icon.png', 'images/mynda-icon-mac.png',
  'images/logos/imdb-logo.png', 'images/logos/rt-logo.png', 'images/logos/mc-logo.png'
];
const REQUIRED_MEDIA_NOTICES = [
  'THIRD_PARTY_NOTICES.md', 'licenses/FFmpeg-COPYING.LGPLv2.1',
  'licenses/MPV-LICENSE.GPL', 'licenses/libdvdread-COPYING',
  'licenses/libdvdnav-COPYING', 'licenses/libdvdread-no-libdvdcss.patch'
];

function privatePath(filename) {
  return filename.split('/').some(name =>
    /^(?:\.env(?:\..*)?|\.dev\.vars(?:\..*)?|\.git|\.npmrc|\.wrangler|omdb\.js|metadata-server\.local\.json|metadata-credentials\.json|\.metadata-(?:credentials|server)-.*\.tmp)$/i.test(name) ||
    /^(?:library(?:[-.(].*)?\.json|mynda-(?:info|error|ui-diagnostics)(?:\.\d+)?\.log)$/i.test(name));
}

function applicationPath(filename) {
  // Independent of build.files: a future broad builder rule must not silently
  // turn development material into an approved release payload.
  return filename === 'package.json' ||
    /^node_modules\//.test(filename) ||
    filename === 'src/bootstrap.js' ||
    /^src\/(?:main|library|media|platform|scanning|sharing|tagging)\/(?:[^/.][^/]*\/)*[^/.][^/]*\.js$/.test(filename) ||
    /^src\/(?:renderer\/generated\/renderer|preload\/generated\/preload)\.js$/.test(filename) ||
    filename === 'src/renderer/index.html' ||
    /^src\/renderer\/styles\/.*\.css$/.test(filename) ||
    /^src\/renderer\/styles\/themes\/_fonts\/[^/]+\.ttf$/.test(filename) ||
    /^images\/(?:[^/]+\/)*[^/]+\.(?:png|gif)$/.test(filename);
}

function inspectArchive(archive, expected = configuration) {
  const entries = new Map();
  for (const entry of asar.listPackage(archive)) {
    const filename = entry.replace(/^[/\\]/, '').replace(/\\/g, '/');
    const stat = asar.statFile(archive, filename, false);
    if (stat.files) continue;
    if (stat.link) throw new Error(`Application archive contains a symlink: ${filename}`);
    if (privatePath(filename) || !applicationPath(filename)) {
      throw new Error(`Unexpected or private application file: ${filename}`);
    }
    entries.set(filename, stat);
  }
  for (const filename of ['package.json', ...REQUIRED_APP_FILES]) {
    if (!entries.has(filename) || entries.get(filename).size === 0) {
      throw new Error(`Required application file is missing or empty: ${filename}`);
    }
  }
  // Follow HTML/CSS resources in the finished archive so omitted fonts and
  // theme images fail here, not only when a tester opens that part of the UI.
  const checkResource = (owner, reference, base = owner) => {
    if (!reference || /^(?:[a-z]+:|\/\/|#)/i.test(reference)) return;
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(base),
      decodeURIComponent(reference.split(/[?#]/)[0])));
    if (!entries.has(target) || entries.get(target).size === 0) {
      throw new Error(`Packaged asset is missing or empty: ${owner} -> ${target}`);
    }
  };
  for (const filename of entries.keys()) {
    if (!filename.startsWith('src/renderer/') || !/\.(?:css|html)$/.test(filename)) continue;
    const content = asar.extractFile(archive, filename).toString('utf8');
    if (filename.endsWith('.html')) {
      for (const match of content.replace(/<!--[\s\S]*?-->/g, '').matchAll(/\b(?:src|href)\s*=\s*(['"])(.*?)\1/g)) {
        checkResource(filename, match[2]);
      }
    } else {
      const css = content.replace(/\/\*[\s\S]*?\*\//g, '');
      for (const match of css.matchAll(/url\(\s*(['"]?)([^'"\)]+)\1\s*\)/g)) {
        const declaration = css.slice(0, match.index).split(/[;{}]/).pop();
        checkResource(filename, match[2].trim(), /^\s*--[\w-]+\s*:/.test(declaration) ?
          'src/renderer/styles/main.css' : filename);
      }
      for (const match of css.matchAll(/@import\s+(['"])(.*?)\1/g)) checkResource(filename, match[2]);
    }
  }
  const packaged = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'));
  for (const key of ['name', 'version', 'main']) {
    if (packaged[key] !== expected[key]) throw new Error(`Packaged ${key} differs from the source package.json`);
  }
  for (const dependency of Object.keys(expected.dependencies || {})) {
    if (!entries.has(`node_modules/${dependency}/package.json`)) {
      throw new Error(`Production dependency is missing: ${dependency}`);
    }
  }
  for (const dependency of Object.keys(expected.devDependencies || {})) {
    if (!expected.dependencies?.[dependency] && entries.has(`node_modules/${dependency}/package.json`)) {
      throw new Error(`Development dependency entered the application: ${dependency}`);
    }
  }
  return {files: entries.size, version: packaged.version};
}

function inspectExternalFiles(directory, resourcesDirectory, unpacked = false) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
    const filename = path.join(directory, entry.name);
    const relative = path.relative(resourcesDirectory, filename).split(path.sep).join('/');
    if (privatePath(relative)) throw new Error(`Private file entered packaged resources: ${relative}`);
    if (unpacked && !entry.isDirectory() && !applicationPath(relative.replace(/^app\.asar\.unpacked\//, ''))) {
      throw new Error(`Unexpected unpacked application file: ${relative}`);
    }
    if (entry.isSymbolicLink()) {
      const resolved = fs.realpathSync(filename);
      const target = path.relative(fs.realpathSync(resourcesDirectory), resolved);
      if (target === '..' || target.startsWith(`..${path.sep}`) || path.isAbsolute(target)) {
        throw new Error(`Packaged resource points outside the application: ${relative}`);
      }
    } else if (entry.isDirectory()) {
      inspectExternalFiles(filename, resourcesDirectory, unpacked);
    }
  }
}

function verifyPackage(resourcesDirectory, {platform = process.platform, expected = configuration} = {}) {
  const root = path.resolve(resourcesDirectory);
  const report = inspectArchive(path.join(root, 'app.asar'), expected);
  const mediaExecutables = platform === 'darwin' ? ['ffmpeg', 'ffprobe', 'mpv.app/Contents/MacOS/mpv'] :
    platform === 'win32' ? ['ffmpeg.exe', 'ffprobe.exe', 'mpv.exe'] : ['ffmpeg', 'ffprobe', 'mpv'];
  const required = [
    'THIRD_PARTY_NOTICES.md', 'licenses/fonts.txt', 'licenses/OFL-1.1.txt',
    ...[...REQUIRED_MEDIA_NOTICES, ...mediaExecutables].map(name => `media-tools/${name}`)
  ];
  if (platform === 'darwin' && expected.build?.mac?.icon?.endsWith('.icon')) {
    // Both the layered icon and Apple's flattened fallback must ship.
    required.push('Assets.car', 'icon.icns');
  }
  for (const name of required) {
    const filename = path.join(root, name);
    if (!fs.existsSync(filename) || !fs.statSync(filename).isFile() || fs.statSync(filename).size === 0) {
      throw new Error(`Required packaged resource is missing or empty: ${name}`);
    }
  }
  inspectExternalFiles(root, root);
  inspectExternalFiles(path.join(root, 'app.asar.unpacked'), root, true);
  return {...report, platform};
}

async function afterPack(context) {
  const resources = context.packager.getResourcesDir(context.appOutDir);
  const report = verifyPackage(resources, {platform: context.electronPlatformName});
  console.log(`  • verified application payload  files=${report.files} version=${report.version}`);
}

if (require.main === module) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: npm run package:verify -- /path/to/packaged/resources');
    const report = verifyPackage(process.argv[2]);
    console.log(`Verified packaged Mynda ${report.version}: ${report.files} application/dependency files and required notices/media resources.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = afterPack;
Object.assign(module.exports, {verifyPackage, inspectArchive, privatePath, REQUIRED_APP_FILES, REQUIRED_MEDIA_NOTICES});
