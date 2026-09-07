const fs = require('fs');
const path = require('path');
const {spawn} = require('child_process');
const {
  assert,
  createSuite,
  runSuite,
  temporaryDirectory,
  removeDirectory
} = require('../helpers/TestHarness.js');

const projectRoot = path.resolve(__dirname, '..', '..');
const suite = createSuite(
  'Real Electron startup and Settings interaction',
  'end-to-end',
  'Launches a disposable Mynda copy with an isolated user-data directory; a window briefly appears.'
);

function copyDirectory(source, destination) {
  fs.mkdirSync(destination, {recursive: true});
  fs.readdirSync(source, {withFileTypes: true}).forEach(entry => {
    if (entry.name === '.DS_Store') return;
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(sourcePath, destinationPath);
    } else if (entry.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(sourcePath), destinationPath);
    } else {
      fs.copyFileSync(sourcePath, destinationPath);
    }
  });
}

function tail(value, maximum = 12000) {
  const text = String(value || '');
  return text.length <= maximum ? text : text.slice(text.length - maximum);
}

function linkProjectDirectoryIfPresent(name, appDirectory) {
  const source = path.join(projectRoot, name);
  if (!fs.existsSync(source)) return;
  fs.symlinkSync(
    source,
    path.join(appDirectory, name),
    process.platform === 'win32' ? 'junction' : 'dir'
  );
}

function launchElectron(executable, appDirectory, userData) {
  return new Promise((resolve, reject) => {
    const args = [appDirectory];
    if (process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0) {
      args.push('--no-sandbox');
    }
    const child = spawn(executable, args, {
      cwd: appDirectory,
      env: Object.assign({}, process.env, {
        MYNDA_E2E_USER_DATA: userData,
        MYNDA_E2E_TIMEOUT_MS: '45000',
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
      }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch(err) {}
      reject(new Error(`Electron smoke-test runner timed out.\n${tail(stdout)}\n${tail(stderr)}`));
    }, 60000);

    child.stdout.on('data', data => { stdout = tail(stdout + data.toString(), 100000); });
    child.stderr.on('data', data => { stderr = tail(stderr + data.toString(), 100000); });
    child.once('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const markerLine = stdout.split(/\r?\n/)
        .filter(line => line.startsWith('MYNDA_ELECTRON_SMOKE_RESULT:'))
        .pop();
      if (!markerLine) {
        reject(new Error(
          `Electron exited with code ${code} without reporting a result.\n` +
          `STDOUT:\n${tail(stdout)}\nSTDERR:\n${tail(stderr)}`
        ));
        return;
      }
      let result;
      try {
        result = JSON.parse(markerLine.slice('MYNDA_ELECTRON_SMOKE_RESULT:'.length));
      } catch(err) {
        reject(new Error(`Electron returned malformed smoke-test data: ${markerLine}`));
        return;
      }
      if (code !== 0 || !result.ok) {
        reject(new Error(
          `Electron smoke test failed at ${result.stage || 'unknown stage'}: ` +
          `${JSON.stringify(result)}\nSTDERR:\n${tail(stderr)}`
        ));
        return;
      }
      resolve(result);
    });
  });
}

suite.test('starts Mynda, renders its shell, opens Settings, and closes Settings', async () => {
  const nodeModules = path.join(projectRoot, 'node_modules');
  assert(fs.existsSync(nodeModules), 'node_modules is missing; run npm install before the Electron test');

  let electronExecutable;
  try {
    electronExecutable = require('electron');
  } catch(err) {
    throw new Error(`Electron is not installed correctly; run npm install first. ${err.message}`);
  }
  assert(
    typeof electronExecutable === 'string' && fs.existsSync(electronExecutable),
    'Electron\'s executable is missing; run npm install so Electron can finish downloading'
  );

  const temporaryRoot = temporaryDirectory('electron-smoke');
  const appDirectory = path.join(temporaryRoot, 'app');
  const userData = path.join(temporaryRoot, 'user-data');
  try {
    fs.mkdirSync(appDirectory, {recursive: true});
    copyDirectory(path.join(projectRoot, 'src'), path.join(appDirectory, 'src'));
    fs.copyFileSync(path.join(__dirname, 'SmokeBootstrap.js'), path.join(appDirectory, 'SmokeBootstrap.js'));
    fs.writeFileSync(path.join(appDirectory, 'omdb.js'), "module.exports = {key: 'test-only-key'};\n");
    fs.writeFileSync(path.join(appDirectory, 'package.json'), JSON.stringify({
      name: 'mynda-electron-smoke',
      version: '1.0.0',
      main: 'SmokeBootstrap.js'
    }, null, 2));
    fs.symlinkSync(
      nodeModules,
      path.join(appDirectory, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    // These links are read-only inputs to the disposable app. Including them
    // makes its CSS and development-extension environment match a source run
    // without copying megabytes into every smoke-test directory.
    linkProjectDirectoryIfPresent('themes', appDirectory);
    linkProjectDirectoryIfPresent('devtools', appDirectory);

    const result = await launchElectron(electronExecutable, appDirectory, userData);
    assert.strictEqual(result.libraryCreated, true);
    assert.strictEqual(result.settingsClosed, true);
    assert.strictEqual(result.initial.grid, true);
  } finally {
    removeDirectory(temporaryRoot);
  }
});

runSuite(suite);
