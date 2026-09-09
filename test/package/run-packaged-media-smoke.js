const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawn} = require('child_process');

const projectRoot = path.resolve(__dirname, '..', '..');
const distDirectory = path.join(projectRoot, 'dist');
const RESULT_PREFIX = 'MYNDA_PACKAGED_MEDIA_SMOKE_RESULT:';

function removeDirectory(directory) {
  if (!directory || !fs.existsSync(directory)) return;
  if (typeof fs.rmSync === 'function') {
    fs.rmSync(directory, {recursive: true, force: true});
    return;
  }
  fs.readdirSync(directory).forEach(entry => {
    const entryPath = path.join(directory, entry);
    const stats = fs.lstatSync(entryPath);
    if (stats.isDirectory()) removeDirectory(entryPath);
    else fs.unlinkSync(entryPath);
  });
  fs.rmdirSync(directory);
}

function directoriesMatching(prefix) {
  if (!fs.existsSync(distDirectory)) return [];
  return fs.readdirSync(distDirectory, {withFileTypes: true})
    .filter(entry => entry.isDirectory() && entry.name.startsWith(prefix))
    .map(entry => path.join(distDirectory, entry.name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}

function packagedExecutable() {
  if (process.platform === 'darwin') {
    for (const directory of directoriesMatching('mac')) {
      const applications = fs.readdirSync(directory, {withFileTypes: true})
        .filter(entry => entry.isDirectory() && entry.name.endsWith('.app'));
      for (const application of applications) {
        const executableDirectory = path.join(
          directory,
          application.name,
          'Contents',
          'MacOS'
        );
        if (!fs.existsSync(executableDirectory)) continue;
        const executable = fs.readdirSync(executableDirectory)
          .map(name => path.join(executableDirectory, name))
          .find(filename => fs.statSync(filename).isFile());
        if (executable) return executable;
      }
    }
  }

  if (process.platform === 'win32') {
    for (const directory of directoriesMatching('win')) {
      const executable = fs.readdirSync(directory)
        .filter(name => name.toLowerCase().endsWith('.exe'))
        .map(name => path.join(directory, name))
        .find(filename => fs.statSync(filename).isFile());
      if (executable) return executable;
    }
  }

  for (const directory of directoriesMatching('linux')) {
    const preferred = path.join(directory, 'mynda');
    if (fs.existsSync(preferred) && fs.statSync(preferred).isFile()) return preferred;
    const executable = fs.readdirSync(directory)
      .map(name => path.join(directory, name))
      .find(filename => {
        try {
          return fs.statSync(filename).isFile() && (fs.statSync(filename).mode & 0o111) !== 0;
        } catch(err) {
          return false;
        }
      });
    if (executable) return executable;
  }

  throw new Error(`Could not find the packaged ${process.platform} application under ${distDirectory}`);
}

function tail(value, maximum = 16000) {
  const text = String(value || '');
  return text.length <= maximum ? text : text.slice(text.length - maximum);
}

function launch(executable, userData) {
  return new Promise((resolve, reject) => {
    const args = [`--user-data-dir=${userData}`];
    if (process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0) {
      args.push('--no-sandbox');
    }
    const cleanEnvironment = Object.assign({}, process.env, {
      // The smoke test must prove that the app is self-contained. An empty
      // search path prevents a Homebrew/MacPorts copy from masking a missing
      // packaged sidecar. Every tested executable is launched by absolute path.
      PATH: '',
      MYNDA_FFMPEG_PATH: '',
      MYNDA_FFPROBE_PATH: '',
      MYNDA_MPV_PATH: '',
      MYNDA_PACKAGED_MEDIA_SMOKE: '1',
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
    });
    const child = spawn(executable, args, {
      cwd: path.dirname(executable),
      env: cleanEnvironment,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch(err) {}
      reject(new Error(
        `Packaged media smoke test timed out.\nSTDOUT:\n${tail(stdout)}\nSTDERR:\n${tail(stderr)}`
      ));
    }, 60000);

    child.stdout.on('data', data => { stdout = tail(stdout + data.toString(), 100000); });
    child.stderr.on('data', data => { stderr = tail(stderr + data.toString(), 100000); });
    child.once('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const marker = stdout.split(/\r?\n/)
        .filter(line => line.startsWith(RESULT_PREFIX))
        .pop();
      if (!marker) {
        reject(new Error(
          `Packaged Mynda exited with ${signal ? `signal ${signal}` : `code ${code}`} without reporting media results.` +
          `\nSTDOUT:\n${tail(stdout)}\nSTDERR:\n${tail(stderr)}`
        ));
        return;
      }

      let result;
      try {
        result = JSON.parse(marker.slice(RESULT_PREFIX.length));
      } catch(error) {
        reject(new Error(`Packaged Mynda returned malformed media results: ${marker}`));
        return;
      }
      if (code !== 0 || !result.ok) {
        reject(new Error(
          `Packaged media dependencies failed: ${JSON.stringify(result, null, 2)}` +
          `\nSTDERR:\n${tail(stderr)}`
        ));
        return;
      }
      resolve(result);
    });
  });
}

async function main() {
  const executable = packagedExecutable();
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mynda-packaged-smoke-'));
  try {
    const result = await launch(executable, userData);
    console.log('  • packaged media smoke test passed');
    ['ffmpeg', 'ffprobe', 'mpv'].forEach(name => {
      const value = result.checks[name] && result.checks[name].value;
      if (value && value.version) console.log(`    ${name}: ${value.version}`);
    });
    console.log('    source: Mynda Resources/media-tools (PATH deliberately empty)');
    console.log('    policy: standalone FFmpeg/FFprobe are LGPL-only; MPV reports dvd:// support');
    const player = result.checks.nodeMpv && result.checks.nodeMpv.value || {};
    console.log(
      `    node-mpv: connected over JSON IPC and rendered generated video through ` +
      `${player.videoOutput}/${player.gpuContext}`
    );
  } finally {
    removeDirectory(userData);
  }
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
