// This file runs as the temporary Electron app's main process. The parent
// runner sets userData before src/index.js constructs either Library instance,
// so the smoke test cannot read or overwrite the user's real library.
const fs = require('fs');
const path = require('path');
const {app, BrowserWindow} = require('electron');

const RESULT_PREFIX = 'MYNDA_ELECTRON_SMOKE_RESULT:';
const userData = process.env.MYNDA_E2E_USER_DATA;
const timeoutMs = Number(process.env.MYNDA_E2E_TIMEOUT_MS) || 45000;
let finished = false;
let mainWindowFound = false;
const rendererConsole = [];

if (!userData) {
  throw new Error('MYNDA_E2E_USER_DATA was not provided');
}

fs.mkdirSync(userData, {recursive: true});
app.setPath('userData', userData);
app.commandLine.appendSwitch('disable-background-timer-throttling');

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function rendererDiagnostics() {
  return rendererConsole.slice(-25);
}

function finish(ok, details) {
  if (finished) return;
  finished = true;
  clearTimeout(overallTimeout);
  const result = Object.assign({ok}, details || {});
  process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(result)}\n`);
  try {
    BrowserWindow.getAllWindows().forEach(window => window.destroy());
  } catch(err) {}
  setTimeout(() => app.exit(ok ? 0 : 1), 20);
}

async function inspectMainWindow(window) {
  try {
    await delay(300);
    const initial = await window.webContents.executeJavaScript(`(() => ({
      title: document.title,
      rootChildren: document.getElementById('root') ? document.getElementById('root').children.length : 0,
      grid: Boolean(document.getElementById('grid-container')),
      navigation: Boolean(document.getElementById('nav-pane')),
      library: Boolean(document.getElementById('library-pane')),
      settingsButton: Boolean(document.getElementById('settings-button'))
    }))()`);

    const initialReady = initial.rootChildren > 0 && initial.grid && initial.navigation &&
      initial.library && initial.settingsButton;
    if (!initialReady) {
      finish(false, {
        stage: 'initial-render',
        initial,
        rendererConsole: rendererDiagnostics()
      });
      return;
    }

    await window.webContents.executeJavaScript(
      `document.getElementById('settings-button').click(); true`
    );
    await delay(250);
    const settings = await window.webContents.executeJavaScript(`(() => ({
      pane: Boolean(document.getElementById('settings-pane')),
      tabs: Boolean(document.getElementById('settings-tabs')),
      foldersTab: Boolean(document.getElementById('settings-tab-folders')),
      libraryTab: Boolean(document.getElementById('settings-tab-library')),
      closeButton: Boolean(document.querySelector('#settings-pane .openable-close-btn'))
    }))()`);
    if (!settings.pane || !settings.tabs || !settings.foldersTab ||
        !settings.libraryTab || !settings.closeButton) {
      finish(false, {stage: 'open-settings', initial, settings});
      return;
    }

    await window.webContents.executeJavaScript(
      `document.querySelector('#settings-pane .openable-close-btn').click(); true`
    );
    await delay(150);
    const settingsClosed = await window.webContents.executeJavaScript(
      `!document.getElementById('settings-pane')`
    );
    const libraryCreated = fs.existsSync(path.join(userData, 'Library', 'library.json'));
    if (!settingsClosed || !libraryCreated) {
      finish(false, {
        stage: 'close-settings-or-library-create',
        initial,
        settings,
        settingsClosed,
        libraryCreated
      });
      return;
    }

    finish(true, {
      stage: 'complete',
      initial,
      settings,
      settingsClosed,
      libraryCreated
    });
  } catch(err) {
    finish(false, {
      stage: 'inspection-exception',
      error: err && err.stack ? err.stack : String(err),
      rendererConsole: rendererDiagnostics()
    });
  }
}

const overallTimeout = setTimeout(() => {
  finish(false, {
    stage: mainWindowFound ? 'renderer-timeout' : 'window-timeout',
    error: `Mynda did not finish the Electron smoke test within ${timeoutMs} ms`
  });
}, timeoutMs);

app.on('browser-window-created', (event, window) => {
  window.webContents.on('console-message', (consoleEvent, level, message, line, sourceId) => {
    rendererConsole.push({
      level,
      message: String(message || '').slice(0, 2000),
      line,
      source: String(sourceId || '').slice(0, 1000)
    });
    if (rendererConsole.length > 100) rendererConsole.shift();
  });
  window.webContents.on('did-fail-load', (loadEvent, errorCode, errorDescription, validatedURL) => {
    if (validatedURL && validatedURL.includes('/src/index.html')) {
      finish(false, {
        stage: 'did-fail-load',
        errorCode,
        errorDescription,
        validatedURL,
        rendererConsole: rendererDiagnostics()
      });
    }
  });
  window.webContents.on('render-process-gone', (goneEvent, details) => {
    if (mainWindowFound) finish(false, {
      stage: 'render-process-gone',
      details,
      rendererConsole: rendererDiagnostics()
    });
  });
  window.webContents.on('did-finish-load', () => {
    const loadedUrl = window.webContents.getURL();
    if (!loadedUrl.includes('/src/index.html') || mainWindowFound) return;
    mainWindowFound = true;
    inspectMainWindow(window);
  });
});

process.on('uncaughtException', error => {
  finish(false, {stage: 'uncaught-exception', error: error && error.stack ? error.stack : String(error)});
});
process.on('unhandledRejection', error => {
  finish(false, {stage: 'unhandled-rejection', error: error && error.stack ? error.stack : String(error)});
});

require('./src/index.js');
