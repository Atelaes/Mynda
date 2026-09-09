#!/usr/bin/env node
const path = require('path');
const {spawnSync} = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');

function preparationCommand(options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const scriptsDirectory = options.scriptsDirectory || __dirname;

  if (platform === 'darwin' && arch === 'arm64') {
    return {
      command: 'bash',
      args: [path.join(scriptsDirectory, 'prepare-media-tools-macos.sh')],
      target: 'mac-arm64'
    };
  }
  if (platform === 'win32' && arch === 'x64') {
    return {
      command: 'powershell.exe',
      args: [
        '-NoLogo',
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', path.join(scriptsDirectory, 'prepare-media-tools-windows.ps1')
      ],
      target: 'win-x64'
    };
  }
  if (platform === 'linux' && arch === 'x64') {
    return {
      command: 'bash',
      args: [path.join(scriptsDirectory, 'prepare-media-tools-linux.sh')],
      target: 'linux-x64'
    };
  }

  const error = new Error(
    `Mynda cannot prepare bundled media tools for ${platform}-${arch}. ` +
    'Supported preparation hosts are Apple Silicon macOS, x64 Windows, and x64 Linux.'
  );
  error.code = 'MYNDA_MEDIA_PLATFORM_UNSUPPORTED';
  throw error;
}

function main() {
  const selected = preparationCommand();
  console.log(`Preparing Mynda media tools for ${selected.target}...`);
  const result = spawnSync(selected.command, selected.args, {
    cwd: PROJECT_ROOT,
    env: process.env,
    stdio: 'inherit'
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status || 1;
}

if (require.main === module) {
  try {
    main();
  } catch(error) {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  }
}

module.exports = {
  preparationCommand
};
