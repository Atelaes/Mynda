const fs = require('fs');
const os = require('os');
const path = require('path');
const {execFile} = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');

function executableExists(filename, options = {}) {
  if (typeof filename !== 'string' || !filename) return false;
  const filesystem = options.fs || fs;
  const platform = options.platform || process.platform;
  try {
    const stats = filesystem.statSync(filename);
    if (!stats.isFile()) return false;
    if (platform !== 'win32' && typeof filesystem.accessSync === 'function') {
      filesystem.accessSync(filename, fs.constants.X_OK);
    }
    return true;
  } catch(err) {
    return false;
  }
}

function unique(values) {
  const seen = new Set();
  return values.filter(value => {
    if (typeof value !== 'string' || !value || seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function builderPlatform(platform) {
  if (platform === 'darwin') return 'mac';
  if (platform === 'win32') return 'win';
  return platform;
}

function stagedMediaRoot(options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const projectRoot = options.projectRoot || PROJECT_ROOT;
  return path.join(projectRoot, 'vendor', 'media-tools', `${builderPlatform(platform)}-${arch}`);
}

function packagedMediaRoot(options = {}) {
  const resourcesPath = typeof options.resourcesPath === 'string' ?
    options.resourcesPath : process.resourcesPath;
  return resourcesPath ? path.join(resourcesPath, 'media-tools') : null;
}

function executableName(tool, platform) {
  return platform === 'win32' ? `${tool}.exe` : tool;
}

function bundledCandidates(tool, options = {}) {
  const platform = options.platform || process.platform;
  const filename = executableName(tool, platform);
  const packagedRoot = packagedMediaRoot(options);
  const stagedRoot = stagedMediaRoot(options);
  const candidates = [];

  if (packagedRoot) {
    candidates.push(path.join(packagedRoot, filename));
    if (tool === 'mpv' && platform === 'darwin') {
      candidates.push(path.join(packagedRoot, 'mpv.app', 'Contents', 'MacOS', 'mpv'));
    }
  }

  candidates.push(path.join(stagedRoot, filename));
  if (tool === 'mpv' && platform === 'darwin') {
    candidates.push(path.join(stagedRoot, 'mpv.app', 'Contents', 'MacOS', 'mpv'));
  }
  return unique(candidates);
}

function pathCandidates(tool, options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const filename = executableName(tool, platform);
  const pathValue = typeof env.PATH === 'string' ? env.PATH : '';
  const pathDelimiter = options.pathDelimiter || (platform === 'win32' ? ';' : ':');
  return pathValue.split(pathDelimiter).filter(Boolean)
    .map(directory => path.join(directory, filename));
}

function overrideName(tool) {
  return `MYNDA_${tool.toUpperCase()}_PATH`;
}

function mediaToolCandidates(tool, options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const homeDirectory = typeof options.homeDirectory === 'string' ?
    options.homeDirectory : os.homedir();
  const filename = executableName(tool, platform);
  const candidates = [env[overrideName(tool)]];

  candidates.push(...bundledCandidates(tool, options));
  candidates.push(...pathCandidates(tool, options));

  if (tool === 'mpv') {
    if (platform === 'darwin') {
      candidates.push(
        '/opt/homebrew/bin/mpv',
        '/opt/local/bin/mpv',
        '/usr/local/bin/mpv',
        '/usr/bin/mpv',
        '/Applications/mpv.app/Contents/MacOS/mpv',
        homeDirectory && path.join(homeDirectory, 'Applications', 'mpv.app', 'Contents', 'MacOS', 'mpv')
      );
    } else if (platform === 'linux') {
      candidates.push('/usr/bin/mpv', '/usr/local/bin/mpv', '/snap/bin/mpv');
    } else if (platform === 'win32') {
      const programFiles = env.ProgramFiles || env.PROGRAMFILES;
      const localAppData = env.LOCALAPPDATA;
      const userProfile = env.USERPROFILE;
      const chocolatey = env.ChocolateyInstall;
      if (programFiles) candidates.push(path.join(programFiles, 'mpv', filename));
      if (localAppData) candidates.push(path.join(localAppData, 'Programs', 'mpv', filename));
      if (userProfile) candidates.push(path.join(userProfile, 'scoop', 'apps', 'mpv', 'current', filename));
      if (chocolatey) candidates.push(path.join(chocolatey, 'bin', filename));
    }
  }

  return unique(candidates);
}

function findMediaToolPath(tool, options = {}) {
  const isExecutable = options.isExecutable || (candidate =>
    executableExists(candidate, {fs: options.fs, platform: options.platform})
  );
  return mediaToolCandidates(tool, options).find(isExecutable) || null;
}

function mpvCandidates(options = {}) {
  return mediaToolCandidates('mpv', options);
}

function findMpvPath(options = {}) {
  return findMediaToolPath('mpv', options);
}

function isInside(candidate, directory) {
  if (!candidate || !directory) return false;
  const relative = path.relative(directory, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function isBundledPath(candidate, options = {}) {
  return isInside(candidate, packagedMediaRoot(options)) ||
    isInside(candidate, stagedMediaRoot(options));
}

function samePath(first, second, platform = process.platform) {
  if (!first || !second) return false;
  const normalize = value => path.resolve(String(value));
  const left = normalize(first);
  const right = normalize(second);
  return platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function mediaToolSource(tool, candidate, options = {}) {
  if (!candidate) return 'missing';
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  if (samePath(candidate, env[overrideName(tool)], platform)) return 'override';
  if (isInside(candidate, packagedMediaRoot(options))) return 'packaged';
  if (isInside(candidate, stagedMediaRoot(options))) return 'staged';
  return 'system';
}

const ffmpegPath = findMediaToolPath('ffmpeg');
const ffprobePath = findMediaToolPath('ffprobe');
const mpvPath = findMpvPath();

function status(options = {}) {
  const paths = {
    ffmpeg: findMediaToolPath('ffmpeg', options),
    ffprobe: findMediaToolPath('ffprobe', options),
    mpv: findMediaToolPath('mpv', options)
  };
  return {
    ffmpeg: {
      path: paths.ffmpeg,
      available: executableExists(paths.ffmpeg, {fs: options.fs, platform: options.platform}),
      bundled: isBundledPath(paths.ffmpeg, options),
      source: mediaToolSource('ffmpeg', paths.ffmpeg, options)
    },
    ffprobe: {
      path: paths.ffprobe,
      available: executableExists(paths.ffprobe, {fs: options.fs, platform: options.platform}),
      bundled: isBundledPath(paths.ffprobe, options),
      source: mediaToolSource('ffprobe', paths.ffprobe, options)
    },
    mpv: {
      path: paths.mpv,
      available: executableExists(paths.mpv, {fs: options.fs, platform: options.platform}),
      bundled: isBundledPath(paths.mpv, options),
      source: mediaToolSource('mpv', paths.mpv, options)
    }
  };
}

async function probeFile(filename, options = {}) {
  const binaryPath = options.ffprobePath || ffprobePath;
  if (!binaryPath) {
    throw new Error('FFprobe executable is unavailable');
  }

  const result = await runExecutable(binaryPath, [
    '-v', 'error',
    '-show_format',
    '-show_streams',
    '-print_format', 'json',
    filename
  ], {
    env: options.env,
    maxBuffer: options.maxBuffer,
    timeout: options.timeout
  });

  try {
    return JSON.parse(result.stdout);
  } catch(error) {
    const parseError = new Error(`FFprobe returned invalid JSON: ${error.message}`);
    parseError.stdout = result.stdout;
    parseError.stderr = result.stderr;
    throw parseError;
  }
}

function runExecutable(binaryPath, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    if (!binaryPath) {
      reject(new Error('Executable path is unavailable'));
      return;
    }
    execFile(binaryPath, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      maxBuffer: options.maxBuffer || 10 * 1024 * 1024,
      timeout: options.timeout || 30000,
      windowsHide: true
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({stdout: String(stdout || ''), stderr: String(stderr || '')});
    });
  });
}

module.exports = {
  builderPlatform,
  bundledCandidates,
  executableExists,
  ffmpegPath,
  ffprobePath,
  findMediaToolPath,
  findMpvPath,
  isBundledPath,
  mediaToolSource,
  mediaToolCandidates,
  mpvCandidates,
  mpvPath,
  packagedMediaRoot,
  pathCandidates,
  probeFile,
  runExecutable,
  stagedMediaRoot,
  status
};
