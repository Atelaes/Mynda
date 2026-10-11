// This file runs as the temporary Electron app's main process. The parent
// runner sets userData before src/main/index.js constructs the Library store,
// so the smoke test cannot read or overwrite the user's real library.
const fs = require('fs');
const path = require('path');
const {pathToFileURL} = require('url');
const {app, dialog, shell, BrowserWindow} = require('electron');
const {browserDriver, wait} = require('./BrowserDriver');
const {consoleMessage} = require('./ConsoleMessage');
const {inspectArtworkDrop} = require('./ArtworkDropJourney');
const {inspectArtworkAvailability} = require('./ArtworkAvailabilityJourney');
const {videos, ids} = require('./LibraryJourneyFixtures');
const {createSmokeTerminator,rejectUnexpectedDialogs,closeAndVerify} = require('./SmokeLifecycle.js');
const {inspectExternalContent,observePermissionDecisions} = require('./ExternalContentJourney.js');
const browserLinks = [];
const permissionDecisions = [];
const observedSessions = new WeakSet();
shell.openExternal = async url => { browserLinks.push(url); };

const RESULT_PREFIX = 'MYNDA_ELECTRON_SMOKE_RESULT:';
const userData = process.env.MYNDA_E2E_USER_DATA;
const timeoutMs = Number(process.env.MYNDA_E2E_TIMEOUT_MS) || 45000;
let mainWindowFound = false;
let activeStage='window-timeout';
let library;
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

// A single local fixture gives the real bundled editor a saved tagging report.
// All setup stays in main; the renderer has only production capabilities.
const libraryFile = require.resolve(path.join(app.getAppPath(), 'src/library/Library.js'));
const RealLibrary = require(libraryFile);
require.cache[libraryFile].exports = class extends RealLibrary {
  constructor(...args) {
    super(...args); library = this;
    const directory = path.join(userData, 'media');
    fs.mkdirSync(directory, {recursive:true});
    const video = videos(directory)[0];
    fs.writeFileSync(video.filename, 'Mynda save journey fixture 0');
    video.imdbID = 'tt1234567'; video.autotag_tried = true;
    video.taggingEvidence = {kind:'movie', imdbID:'tt1234567', catalogTitle:'Alpha',
      seriesID:'tt7654321', original:{title:'Alpha', series:'Fixture series'}};
    const data = JSON.parse(JSON.stringify(this.getSaveObject()));
    data.media = [video]; data.settings.watchfolders = [{path:directory, kind:'movie'}];
    this.applyLibraryData(data); this.save();
  }
};

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
    const ui = browserDriver(window);
    // did-finish-load does not imply the snapshot and React startup finished.
    await ui.start();
    await wait(() => ui.exists(ui.row(ids[0])), 'initial library snapshot');
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

    activeStage='external-content';
    const externalContent = await inspectExternalContent({app, BrowserWindow, window,
      opened:browserLinks, permissionDecisions, videoId:ids[0]});

    activeStage='artwork-drop';
    const artworkDrop = await inspectArtworkDrop({app, dialog, window, videoId:ids[0], userData, library});
    activeStage='artwork-availability';
    const artworkAvailability = await inspectArtworkAvailability({window, videoId:ids[0], userData, library});

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
    await ui.settings();
    const rendererSave=await ui.inspect(() => {
      const input=document.querySelectorAll('#settings-prefs-libraryexclusions input')[0];
      input.click(); return {value:input.checked};
    });
    const libraryPath=path.join(userData,'Library','library.json');
    const readSaved=()=>JSON.parse(fs.readFileSync(libraryPath,'utf8'));
    await wait(() => library.settings.preferences.exclude_samples_from_library===rendererSave.value &&
      readSaved().settings.preferences.exclude_samples_from_library===rendererSave.value,
      'confirmed renderer settings edit');
    const replica=await ui.inspect(() => window.mynda.library.snapshot());
    if (replica.data.settings.preferences.exclude_samples_from_library!==rendererSave.value) {
      throw new Error('The committed settings edit was not available through the isolated bridge.');
    }
    rendererSave.confirmed=true;

    // Leave the genuine Settings debounce pending, then close immediately.
    // The production close hook must flush it without an injected test hook.
    const shutdownSave=await ui.inspect(() => {
      const input=document.querySelectorAll('#settings-prefs-libraryexclusions input')[1];
      input.click(); return {value:input.checked};
    });
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
        externalContent,
        artworkDrop,
        artworkAvailability,
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
  // This event runs inside the BrowserWindow constructor, before production
  // installs its policy. Keep the real handler and only record its answers.
  const session = window.webContents.session;
  if (!observedSessions.has(session)) {
    observedSessions.add(session);
    observePermissionDecisions(session, permissionDecisions);
  }
  window.webContents.on('console-message', (...args) => {
    rendererConsole.push(consoleMessage(...args));
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

require(path.join(app.getAppPath(), 'src', 'main', 'index.js'));
