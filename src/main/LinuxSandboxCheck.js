'use strict';

const fs = require('fs');

// Release smoke check for the installed Linux executable. These are kernel
// observations, not just BrowserWindow's requested `sandbox: true` setting.
const DISABLING_SWITCHES = [
  'no-sandbox', 'disable-seccomp-filter-sandbox',
  'disable-namespace-sandbox', 'single-process'
];

function parseStatus(text) {
  const fields = Object.fromEntries(String(text).trim().split('\n').map(line => {
    const colon = line.indexOf(':');
    return [line.slice(0, colon), line.slice(colon + 1).trim()];
  }));
  const integer = name => /^\d+$/.test(fields[name] || '') ? Number(fields[name]) : null;
  return {
    seccomp: integer('Seccomp'),
    filters: integer('Seccomp_filters'),
    noNewPrivileges: integer('NoNewPrivs'),
    namespacePids: /^\d+(?:\s+\d+)*$/.test(fields.NSpid || '') ? fields.NSpid.split(/\s+/).map(Number) : []
  };
}

function assertSandboxStatus(mainText, rendererText) {
  const main = parseStatus(mainText);
  const renderer = parseStatus(rendererText);
  const problems = [];
  if (renderer.seccomp !== 2) problems.push('renderer seccomp filtering is not enabled');
  if (renderer.noNewPrivileges !== 1) problems.push('renderer NoNewPrivs is not enabled');
  // A container may already filter the entire application. Require an
  // additional renderer filter so that inherited restrictions cannot pass.
  if (main.filters === null || renderer.filters === null || renderer.filters <= main.filters) {
    problems.push('no additional renderer seccomp filter was observed');
  }
  if (main.namespacePids.length === 0 || renderer.namespacePids.length <= main.namespacePids.length) {
    problems.push('no additional renderer PID namespace was observed');
  }
  if (problems.length) {
    throw new Error(`Linux sandbox check failed: ${problems.join('; ')}. Observed: ${JSON.stringify({main, renderer})}`);
  }
  return {main, renderer};
}

async function run({app, BrowserWindow, platform = process.platform,
  uid = typeof process.getuid === 'function' ? process.getuid() : null,
  readFileSync = fs.readFileSync} = {}) {
  if (platform !== 'linux') throw new Error('The installed sandbox check requires Linux.');
  if (uid === 0 || uid === null) throw new Error('Run the installed sandbox check as your normal desktop user, without sudo.');
  const disabled = DISABLING_SWITCHES.filter(name => app.commandLine.hasSwitch(name));
  if (disabled.length) throw new Error(`Sandbox-disabling switches are present: ${disabled.join(', ')}`);

  const window = new BrowserWindow({
    show: false,
    webPreferences: {sandbox: true, contextIsolation: true, nodeIntegration: false}
  });
  try {
    await window.loadURL('data:text/html,<title>Mynda sandbox verification</title>');
    const pid = window.webContents.getOSProcessId();
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
      throw new Error('The sandbox probe did not start a separate renderer process.');
    }
    const evidence = assertSandboxStatus(
      readFileSync('/proc/self/status', 'utf8'),
      readFileSync(`/proc/${pid}/status`, 'utf8')
    );
    return {pid, ...evidence};
  } finally {
    if (!window.isDestroyed()) window.destroy();
  }
}

module.exports = {run, parseStatus, assertSandboxStatus, DISABLING_SWITCHES};
