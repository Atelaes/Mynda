// This file runs as the temporary Electron app's main process. The parent
// runner sets userData before src/main/index.js constructs the Library store,
// so the smoke test cannot read or overwrite the user's real library.
const fs = require('fs');
const path = require('path');
const {pathToFileURL} = require('url');
const {app, dialog} = require('electron');
const {createSmokeTerminator,rejectUnexpectedDialogs,closeAndVerify} = require('./SmokeLifecycle.js');

const RESULT_PREFIX = 'MYNDA_ELECTRON_SMOKE_RESULT:';
const userData = process.env.MYNDA_E2E_USER_DATA;
const timeoutMs = Number(process.env.MYNDA_E2E_TIMEOUT_MS) || 45000;
let mainWindowFound = false;
let activeStage='window-timeout';
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

const finish=createSmokeTerminator({app,
  clearDeadline:()=>clearTimeout(overallTimeout),
  // A synchronous write retains the failure result before terminating the
  // isolated process, even if its renderer or normal shutdown path is broken.
  writeResult:result=>fs.writeSync(process.stdout.fd || 1,`${RESULT_PREFIX}${JSON.stringify(result)}\n`)
});
rejectUnexpectedDialogs(dialog,finish);

function rendererLibrary() {
  return `require(${JSON.stringify(path.join(app.getAppPath(),'src','renderer','RendererRuntime.js'))}).library`;
}

async function inspectAssets(window) {
  const imageDirectory = path.join(app.getAppPath(), 'images');
  function imageFiles(directory) {
    return fs.readdirSync(directory, {withFileTypes: true}).flatMap(entry => {
      const filename = path.join(directory, entry.name);
      return entry.isDirectory() ? imageFiles(filename) : /\.(png|gif)$/i.test(filename) ? [filename] : [];
    });
  }
  const urls = imageFiles(imageDirectory).map(filename => pathToFileURL(filename).href);
  return window.webContents.executeJavaScript(`(async () => {
    const loadImage = url => new Promise((resolve, reject) => {
      const image = new Image();
      const timeout = setTimeout(() => reject(new Error('Image timed out: ' + url)), 8000);
      image.onload = () => { clearTimeout(timeout); resolve(); };
      image.onerror = () => { clearTimeout(timeout); reject(new Error('Image failed: ' + url)); };
      image.src = url;
    });
    const main = [...document.styleSheets].find(sheet => sheet.href && sheet.href.endsWith('/renderer/styles/main.css'));
    if (!main || !main.cssRules.length) throw new Error('Main stylesheet did not load');
    const themes = [...main.cssRules].filter(rule => rule.type === CSSRule.IMPORT_RULE);
    if (themes.length !== 2 || themes.some(rule => !rule.styleSheet || !rule.styleSheet.cssRules.length)) {
      throw new Error('Bundled appearance/layout themes did not load');
    }
    const families = ['HKGrotesk', 'SourceCodePro', 'BalooTamma2', 'Dorsa', 'WireOne'];
    for (const family of families) {
      const faces = await document.fonts.load('16px ' + family);
      if (!faces.length || faces.some(face => face.status !== 'loaded')) throw new Error('Font failed: ' + family);
    }
    const variables = ['--inputicon-filled', '--searchicon-empty', '--scanicon-image', '--settingsicon-image'];
    const icons = [];
    for (const variable of variables) {
      const element = document.createElement('div');
      element.className = 'mynda-smoke-asset';
      // Insert into main.css so URL resolution matches the actual UI rules.
      const index = main.insertRule('.mynda-smoke-asset { background-image: var(' + variable + '); display: none; }', main.cssRules.length);
      document.body.appendChild(element);
      const value = getComputedStyle(element).backgroundImage;
      const match = value.match(/url\\(["']?(.*?)["']?\\)/);
      element.remove();
      main.deleteRule(index);
      if (!match) throw new Error('Theme icon has no image: ' + variable);
      icons.push(match[1]);
    }
    await Promise.all(${JSON.stringify(urls)}.concat(icons).map(loadImage));
    if (getComputedStyle(document.getElementById('grid-container')).display !== 'grid') {
      throw new Error('Main layout rules were not applied');
    }
    return {ok: true, images: ${urls.length}, fonts: families.length, icons: icons.length};
  })()`);
}

async function inspectMainWindow(window) {
  try {
    activeStage='initial-render';
    // did-finish-load does not imply that the asynchronous library snapshot or
    // React startup has finished. Await the actual client initialization.
    await window.webContents.executeJavaScript(`(async()=>{
      await ${rendererLibrary()}.ready;
      await new Promise(resolve=>requestAnimationFrame(resolve));
      return true;
    })()`);
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

    let assets;
    try {
      activeStage='renderer-assets';
      assets = await inspectAssets(window);
    } catch (error) {
      finish(false, {stage: 'renderer-assets', initial, error: error.message, rendererConsole: rendererDiagnostics()});
      return;
    }

    activeStage='open-settings';
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

    activeStage='library-statistics';
    await window.webContents.executeJavaScript(
      `document.getElementById('settings-tab-library').click(); true`
    );
    await delay(250);
    const libraryStats = await window.webContents.executeJavaScript(`(() => ({
      pane: Boolean(document.getElementById('settings-library')),
      viewing: Boolean(document.querySelector('#settings-library .viewing-table')),
      kinds: Boolean(document.querySelector('#settings-library .kinds-stats')),
      resolution: Boolean(document.querySelector('#settings-library .resolution-table')),
      duplicates: Boolean(document.querySelector('#settings-library .duplicates-stats'))
    }))()`);
    if (!libraryStats.pane || !libraryStats.viewing || !libraryStats.kinds ||
        !libraryStats.resolution || !libraryStats.duplicates) {
      finish(false, {
        stage: 'library-statistics',
        initial,
        settings,
        libraryStats,
        rendererConsole: rendererDiagnostics()
      });
      return;
    }

    activeStage='close-settings';
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
        libraryStats,
        settingsClosed,
        libraryCreated
      });
      return;
    }

    activeStage='renderer-save';
    const rendererSave=await window.webContents.executeJavaScript(`(async()=>{
      const library=${rendererLibrary()};
      const value=!library.settings.preferences.exclude_samples_from_library;
      await library.replace('settings.preferences.exclude_samples_from_library',value);
      return {value,confirmed:library.settings.preferences.exclude_samples_from_library===value,path:library.path};
    })()`);
    const libraryPath=path.join(userData,'Library','library.json');
    const readSaved=()=>JSON.parse(fs.readFileSync(libraryPath,'utf8'));
    if (!rendererSave.confirmed || path.resolve(rendererSave.path)!==path.resolve(libraryPath) ||
        readSaved().settings.preferences.exclude_samples_from_library!==rendererSave.value) {
      throw new Error('The renderer save was not confirmed in the isolated library file.');
    }

    // Register an actual deferred renderer save. It must be flushed by the
    // production graceful-close handshake before the window may close.
    const shutdownSave=await window.webContents.executeJavaScript(`(()=>{
      const library=${rendererLibrary()};
      const value=!library.settings.preferences.exclude_trailers_from_library;
      library.onBeforeClose(()=>library.replace('settings.preferences.exclude_trailers_from_library',value));
      return {value};
    })()`);
    activeStage='graceful-close';
    closeAndVerify(window,()=>{
      const saved=readSaved();
      if (saved.settings.preferences.exclude_samples_from_library!==rendererSave.value ||
          saved.settings.preferences.exclude_trailers_from_library!==shutdownSave.value) {
        throw new Error('Closing the app lost a confirmed edit or failed to flush its deferred renderer save.');
      }
      return {
        stage: 'complete',
        initial,
        settings,
        libraryStats,
        settingsClosed,
        libraryCreated,
        assets,
        rendererSave,
        shutdownSave,
        saveConfirmed:true,
        gracefulClose:true
      };
    },finish);
  } catch(err) {
    finish(false, {
      stage: activeStage,
      error: err && err.stack ? err.stack : String(err),
      rendererConsole: rendererDiagnostics()
    });
  }
}

const overallTimeout = setTimeout(() => {
  finish(false, {
    stage: activeStage,
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
    if (validatedURL && validatedURL.includes('/src/renderer/index.html')) {
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
    if (activeStage==='graceful-close' && details.reason==='clean-exit') return;
    if (mainWindowFound) finish(false, {
      stage: 'render-process-gone',
      details,
      rendererConsole: rendererDiagnostics()
    });
  });
  window.webContents.on('did-finish-load', () => {
    const loadedUrl = window.webContents.getURL();
    if (!loadedUrl.includes('/src/renderer/index.html') || mainWindowFound) return;
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

require('./src/main/index.js');
