const electron = require('electron');
const { ipcMain, dialog } = require('electron');
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const {findSeasonEpisode, findContainingWatchfolder} = require('../scanning/ShowDetection.js');
const {v4: uuidv4} = require('uuid');
const ContentFingerprint = require('../library/ContentFingerprint.js');
const Library = require("../library/Library.js");
const {
  subtitleExtensions,
  prepareSubtitleMatches,
  buildLegacySubtitleCounts,
  reconcileVideoSubtitles
} = require('../scanning/SubtitleMatcher.js');
const _ = require('lodash');
const ffmpeg = require('fluent-ffmpeg');
const MediaTools = require('../media/MediaTools.js');
const MediaMetadata = require('../media/MediaMetadata.js');
if (MediaTools.ffmpegPath) ffmpeg.setFfmpegPath(MediaTools.ffmpegPath);
if (MediaTools.ffprobePath) ffmpeg.setFfprobePath(MediaTools.ffprobePath);
const Logger = require('../platform/Logger.js');
const TaggingService = require('../tagging/TaggingService.js');
const {requireFeature} = require('./FeatureAccess');
const MetadataConnection = require('./MetadataConnection');
const MovieSearch = require('../tagging/MovieSearch.js');
const VideoExclusion = require('../scanning/VideoExclusion.js');
const VideoRuntimeVerifier = require('../scanning/VideoRuntimeVerifier.js');
const {ScanDuplicateTracker} = require('../library/LibraryDuplicates.js');
const {containsPath} = require('../library/LibraryScanOperations.js');
const ShareService = require('../sharing/ShareService.js');
const ShareManifest = require('../sharing/ShareManifest.js');
const loadReactDeveloperTools = require('./ReactDevTools.js');
const {installExternalContentPolicy} = require('./ExternalContent.js');
const {installRendererBridge} = require('./RendererBridge');
const {validateRendererCommit} = require('../library/LibraryRendererPolicy');
const {createPlaybackService} = require('./PlaybackService');
const {createEditorService} = require('./EditorService');
const {createDesktopService} = require('./DesktopService');
const {createTaskMethods} = require('./TaskService');
const checkDiskSpace = require('check-disk-space').default
const MIN_SCAN_RESULT_STATUS_MS = 2000;
const videoExtensions = [
  '3g2', '3gp',  'amv',  'asf', 'avchd', 'avi', 'divx', 'drc',  'f4a',  'f4b', 'f4p',
  'f4v', 'flv',  'm2ts', 'm2v', 'm4p', 'm4v', 'mkv',  'mov',  'mp2', 'mp4',
  'mpe', 'mpeg', 'mpg',  'mpv', 'mts', 'mxf', 'nsv',  'ogg',  'ogv', 'qt',
  'rm',  'rmvb', 'roq',  'svi', 'ts', 'viv', 'webm', 'wmv', 'xvid', 'yuv'
]
let win;
const app = electron.app;
const BrowserWindow = electron.BrowserWindow;
const backendLog = Logger.child('Backend');
const externalContent = installExternalContentPolicy({
  ipcMain, shell: electron.shell, log: backendLog,
  rendererPath: path.join(app.getAppPath(), 'src', 'renderer', 'index.html')
});
const library = new Library({authorizeRenderer:externalContent.isTrustedSender});

const scanLog = Logger.child('WatchfolderScan');
const metadataLog = Logger.child('Metadata');
const autoTagLog = Logger.child('AutoTag');
const {createAutoTagRunner} = require('../tagging/AutoTagRunner');
const reportAutoTagFailure = require('./AutoTagFailure').createFailureReporter({
  dialog, log:autoTagLog, getLibraryPath:() => library.path,
  getWindow:() => win && !win.isDestroyed() ? win : null
});
const shareLog = Logger.child('Share');
const videoExclusionLog = Logger.child('VideoExclusion');
let libraryClose;
let libFileTree; // where we store video and subtitle information we find in the watchfolders prior to adding the videos to the library
let libMulch = [];  //After libFileTree has been created and chewed up, this is the flattened version
let parsing = {}; // this is just to keep track of when we're done looking through all the watchfolders for videos
let unavailableWatchFolders = new Set(); // watchfolders whose scan failed; preserve their library entries for this scan
let subtitleReconciliationContext = {detectedOwners: new Map(), legacyCounts: new Map()};
let addVideoTimeout; // just a delay for adding the videos to the library once we're done parsing, to make sure it only happens once
let newIDs = [];
let scanActivationBaselines = new Map();
let ffMpegQueue = [];
let videoAddTimers = [];
let appStartTime = new Date();
let watchfolderScanRunning = false;
let watchfolderScanQueued = false;
const autoTagState = {running:false, cancelRequested:false, cancellationDecision:null, scope:'library'};
let autoTagRequestPending = false;




function confirmationDialogIsDisabled(dialogName) {
  return Boolean(
    library.settings &&
    library.settings.preferences &&
    library.settings.preferences.override_dialogs &&
    library.settings.preferences.override_dialogs[dialogName] === true
  );
}

function disableConfirmationDialog(dialogName, log = backendLog) {
  if (!dialogName || confirmationDialogIsDisabled(dialogName)) return;

  log.debug('User disabled a confirmation dialog', {dialog: dialogName});
  const overrideDialogs = library.settings &&
    library.settings.preferences &&
    library.settings.preferences.override_dialogs;
  const address = overrideDialogs ?
    `settings.preferences.override_dialogs.${dialogName}` :
    'settings.preferences.override_dialogs';
  const value = overrideDialogs ? true : {[dialogName]: true};
  library.replace(address, value, err => {
    if (err) {
      log.error('Could not save confirmation-dialog preference', {
        dialog: dialogName,
        error: err
      });
    }
  });
}

const videoRuntimeVerifier = new VideoRuntimeVerifier({
  ffmpegPath: MediaTools.ffmpegPath
});
const videoExclusion = new VideoExclusion({
  library: library,
  probeMetadata: video => getMetadata(video, {
    purpose: 'get duration for sample/trailer exclusion'
  }),
  verifyMinimumRuntime: options => videoRuntimeVerifier.hasMinimumRuntime(options),
  isExclusionEnabled: kind => {
    let preferences = library.settings && library.settings.preferences || {};
    if (kind === 'trailer') {
      return preferences.exclude_trailers_from_library !== false;
    }
    return preferences.exclude_samples_from_library !== false;
  },
  log: videoExclusionLog
});

function sendShareProgress(progress) {
  if (!win || win.isDestroyed() || !win.webContents) return;
  win.webContents.send('share-progress', progress);

  if (!progress || progress.busy === false || !progress.phase) {
    win.webContents.send('status-update', {action: ''});
    // A watchfolder added from another Settings tab during Share gets one
    // fresh scan after the filesystem operation releases its lock.
    if (watchfolderScanQueued && !watchfolderScanRunning) {
      watchfolderScanQueued = false;
      setImmediate(() => checkWatchFolders('watchfolder-added-queued'));
    }
    return;
  }

  const actionForPhase = {
    request: 'share_request',
    'fulfillment-plan': 'share_plan',
    fulfill: 'share_fulfill',
    'import-plan': 'share_plan',
    import: 'share_import'
  };
  win.webContents.send('status-update', {
    action: actionForPhase[progress.phase] || 'share_plan',
    numCurrent: progress.numCurrent,
    numTotal: progress.numTotal,
    cancelRequested: progress.cancelRequested
  });
}

const shareService = new ShareService({
  library: library,
  log: shareLog,
  checkDiskSpace: checkDiskSpace,
  sendProgress: sendShareProgress,
  conflictingOperationActive: () =>
    watchfolderScanRunning || autoTagState.running || autoTagRequestPending
});

const playback = createPlaybackService({library,log:Logger.child('Player'),publish:state => {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('playback:state',state);
}});
const editor = createEditorService({library,catalog:TaggingService,dialog,app,requireFeature,
  deriveFilenameResetChanges,isAutoTagRunning:()=>autoTagState.running,
  notifyLookup:(owner,status) => {
    const contents = electron.webContents.fromId(owner);
    if (contents && !contents.isDestroyed()) contents.send('editor:lookup-status',status);
  },
  confirmationDialogIsDisabled,disableConfirmationDialog,log:backendLog});
const desktop = createDesktopService({app,dialog,shell:electron.shell,library,getWindow:()=>win,
  scan:checkWatchFolders,removeWatchfolder,shareService,
  confirmationDialogIsDisabled,disableConfirmationDialog,log:backendLog,shareLog,scanLog});
library.validateRendererCommit = (request,event) => validateRendererCommit(request,{library,
  authorizeSubtitle:file=>editor.authorizeSubtitle(file,event.sender.id),
  authorizeArtwork:file=>editor.authorizeArtwork(file,event.sender.id)});
installRendererBridge({ipcMain,isTrustedSender:externalContent.isTrustedSender,log:backendLog,
  methods:{...desktop.methods, ...MetadataConnection.methods,
    ...createTaskMethods({scan:requestWatchfolderScan,startTagging:requestAutoTag,requireFeature,
      startSelectedTagging:requestSelectedAutoTag,cancelTagging:requestAutoTagCancellation,
      reportFailure:reportAutoTagFailure}),
    ...Object.fromEntries(['search','select','cancelSearch','resetFromFilename','prepareArtwork','inspectArtwork',
      'downloadArtwork','validateSubtitles','confirm']
      .map(name=>['editor.'+name,(event,input)=>editor[name](input,event.sender.id)])),
    'editor.chooseArtwork':event=>editor.chooseArtwork(event.sender.id),
    'editor.chooseSubtitles':event=>editor.chooseSubtitles(event.sender.id),
    'playback.play':(_event,id)=>playback.play(id),
    'playback.stop':()=>playback.stop(),
    'playback.getState':()=>playback.getState(),
    'logs.write':(_event,entry)=>{
      if (!entry || typeof entry!=='object' || !['info','warn','error'].includes(entry.level) ||
          typeof entry.scope!=='string' || entry.scope.length>200 ||
          typeof entry.message!=='string' || entry.message.length>50000 ||
          typeof entry.details!=='string' || entry.details.length>50000) throw new Error('Invalid log entry.');
      Logger.receiveRenderer(entry);return {accepted:true};
    }
  }});

app.whenReady().then(start);

async function start() {
  await MetadataConnection.initialize();
  Logger.initialize({
    app: app,
    ipcMain: ipcMain,
    forwardedEntries: false
  });
  backendLog.info('Mynda backend starting', {
    version: app.getVersion(),
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    architecture: process.arch
  });
  const mediaToolStatus = MediaTools.status();
  metadataLog.info('Media dependency status', mediaToolStatus);
  if (!mediaToolStatus.ffprobe.available) {
    metadataLog.warn('Bundled FFprobe is unavailable; FFmpeg metadata fallback will be used', {
      path: mediaToolStatus.ffprobe.path,
      error: mediaToolStatus.loadError
    });
  }
  if (!mediaToolStatus.ffmpeg.available) {
    metadataLog.error('Bundled FFmpeg is unavailable', {
      path: mediaToolStatus.ffmpeg.path,
      error: mediaToolStatus.loadError
    });
  }

  // Library construction happens before Electron is ready, when it is too
  // early to display a native dialog. Once ready, resolve any recorded load
  // problem before opening the renderer or starting a watchfolder scan; either
  // could otherwise save provisional data over the unreadable primary.
  const identityIssue = library.getIdentityIssue();
  if (identityIssue) {
    const loadIssue = library.getLoadIssue();
    const source = loadIssue && loadIssue.latestBackupPath || library.path;
    backendLog.error('Library video ID format prevents startup', {...identityIssue, path: source});
    await dialog.showMessageBox({
      type: 'info', buttons: ['Quit Mynda'], defaultId: 0, cancelId: 0,
      title: 'Library Update Required', message: identityIssue.message,
      detail: `Your saved library has not been changed. Follow the one-time conversion instructions in MIGRATING_VIDEO_IDS.md in the Mynda project folder.\n\nLibrary to convert:\n${source}`
    });
    return quitAfterLibraryLoadIssue();
  }
  if (!await resolveLibraryLoadIssue()) {
    return;
  }

  // Ensure an existing valid library gets its first restore point immediately,
  // even if this session never performs another save.
  library.maybeCreateAutomaticBackup();

  // The optional React extension is development-only; packaged apps skip it.
  await loadReactDeveloperTools({
    app: app,
    session: electron.session,
    log: backendLog
  });

  // make the temp folder if it doesn't already exist
  const tempFolder = path.join(app.getPath('userData'),'temp');
  fs.mkdir(tempFolder, (err) => {
    if (err && err.code === 'EEXIST') {
      backendLog.debug('Temporary image directory already exists', {path: tempFolder});
    } else if (err) {
      backendLog.error('Could not create temporary image directory', {
        path: tempFolder,
        error: err
      });
    }
  });

  await createWindow();  //createWindow needs to come first else we get a big delay.
  eraseTempImages();
  await cleanLibrary();
  checkWatchFolders('startup');

  // testNotify(0);
}

async function quitAfterLibraryLoadIssue() {
  // This path is reached when the user chooses the safe "Quit Mynda" option or
  // when a requested recovery action fails. Give already-queued diagnostic log
  // entries a chance to reach disk before terminating the otherwise windowless
  // startup process.
  try {
    await Logger.flush();
  } catch(err) {}
  app.quit();
  return false;
}

// A second-line failure dialog. We get here only after the user explicitly
// requested restoration or empty-library creation and that filesystem action
// threw—for example because the disk is full or the directory is read-only.
async function showLibraryRecoveryFailure(action, err) {
  backendLog.error(`Could not ${action} after a library load failure`, {
    error: err && err.stack ? err.stack : String(err)
  });
  await dialog.showMessageBox({
    type: 'error',
    buttons: ['Quit Mynda'],
    defaultId: 0,
    cancelId: 0,
    title: 'Library Recovery Failed',
    message: `Mynda could not ${action}.`,
    detail: 'Mynda will quit without making further changes to the unreadable library.'
  });
  return quitAfterLibraryLoadIssue();
}

// Resolve the loadIssue recorded synchronously by Library.load(). This runs
// before createWindow(), making recovery an all-or-nothing startup gate rather
// than allowing the rest of Mynda to operate on provisional data.
async function resolveLibraryLoadIssue() {
  const issue = library.getLoadIssue();

  // Normal startup: the primary parsed and validated, so no dialog is needed.
  if (!issue) return true;

  // Record the full technical diagnosis in the backend log. The dialog below
  // uses friendlier language while retaining the exact paths and error for
  // later troubleshooting.
  backendLog.error('Mynda could not load the primary library', issue);

  // Best recovery scenario: Library.load() found and provisionally loaded the
  // newest structurally valid automatic snapshot.
  if (issue.latestBackupPath) {
    const backupDate = new Date(issue.latestBackupDate).toLocaleString();

    // A newer file can exist but fail validation (for example, after disk
    // damage). Tell the user when Mynda intentionally fell back past one or
    // more such files instead of silently implying the newest file was used.
    const skippedBackups = issue.invalidNewerBackups > 0 ?
      ` Mynda skipped ${issue.invalidNewerBackups} newer backup${issue.invalidNewerBackups === 1 ? '' : 's'} that could not be validated.` : '';
    const result = await dialog.showMessageBox({
      type: 'error',
      buttons: ['Quit Mynda', 'Restore Backup'],
      defaultId: 1,
      cancelId: 0,
      title: 'Library Recovery',
      message: 'Mynda could not read your library.',
      detail: `The unreadable file has not been changed. A valid automatic backup from ${backupDate} is available.${skippedBackups}\n\nIf you restore it, Mynda will preserve the unreadable file in the Library/Recovery folder before replacing it.`
    });

    // Cancel, Escape, or "Quit Mynda" takes this branch. No recovery method has
    // run yet, so the unreadable primary remains byte-for-byte unchanged.
    if (result.response !== 1) {
      backendLog.warn('User declined automatic library recovery', issue);
      return quitAfterLibraryLoadIssue();
    }

    try {
      // "Restore Backup" preserves the unreadable primary in Recovery, then
      // atomically commits the already-validated and migrated backup data.
      const recovery = library.restoreLatestAutomaticBackup();
      backendLog.warn('Restored automatic library backup', recovery);
      await dialog.showMessageBox({
        type: 'info',
        buttons: ['Continue'],
        defaultId: 0,
        title: 'Library Restored',
        message: `Mynda restored the automatic backup from ${backupDate}.`,
        detail: `The unreadable library was preserved at:\n${recovery.preservedLibraryPath}`
      });
      return true;
    } catch(err) {
      // Do not continue into the application after a partial or failed recovery
      // attempt. The recovery method keeps or reinstates its save guard.
      return showLibraryRecoveryFailure('restore the automatic library backup', err);
    }
  }

  // Worst recovery scenario: the primary failed and no automatic backup passed
  // validation. Quitting is the default. Creating an empty library is offered
  // only as an explicit opt-in, with the damaged original preserved first.
  const result = await dialog.showMessageBox({
    type: 'error',
    buttons: ['Quit Mynda', 'Create Empty Library'],
    defaultId: 0,
    cancelId: 0,
    title: 'Library Recovery',
    message: 'Mynda could not read your library, and no valid automatic backup was found.',
    detail: 'The unreadable file has not been changed. You can quit and attempt a manual recovery, or create a new empty library. If you create an empty library, Mynda will first preserve the unreadable file in the Library/Recovery folder.'
  });

  // The user wants to investigate or repair the original manually. Since no
  // mutation has happened, quitting leaves the primary where it was.
  if (result.response !== 1) {
    backendLog.warn('User quit after library recovery found no valid backup', issue);
    return quitAfterLibraryLoadIssue();
  }

  try {
    // The user accepted the destructive-looking option, but the implementation
    // is still recoverable: exact damaged bytes are copied to Recovery before
    // a validated empty primary is atomically written.
    const recovery = library.createEmptyLibraryAfterLoadFailure();
    backendLog.warn('Created an empty library after preserving an unreadable library', recovery);
    await dialog.showMessageBox({
      type: 'info',
      buttons: ['Continue'],
      defaultId: 0,
      title: 'Empty Library Created',
      message: 'Mynda created a new empty library.',
      detail: `The unreadable library was preserved at:\n${recovery.preservedLibraryPath}`
    });
    return true;
  } catch(err) {
    // As with failed restoration, never open Mynda after failing to establish a
    // valid primary library.
    return showLibraryRecoveryFailure('create a new empty library', err);
  }
}

function testNotify(i) {
  let max = 250;
  win.webContents.send('status-update', {action: 'add', numCurrent: i, numTotal: max});

  // if (i === 0) win.webContents.send('status-update', {action: 'add'});
  if (i < max) {
    setTimeout(() => testNotify(i+1),20);
  } else {
    win.webContents.send('status-update', {action: ''});
  }
}

function eraseTempImages() {
  let folderPath = path.join(app.getPath('userData'),'temp');

  fs.readdir(folderPath, (err, files) => {
    if (err) {
      backendLog.warn('Could not scan temporary image directory for cleanup', {
        path: folderPath,
        error: err
      });
      return;
    }

    // loop over all the files in the temp folder and delete them
    files.forEach(file => {
      try {
        fs.unlink(path.join(folderPath, file), (err) => {
          if (err) {
            backendLog.warn('Could not delete temporary image', {
              filename: file,
              error: err
            });
            return;
          }
          backendLog.debug('Deleted temporary image', {filename: file});
        });
      } catch(err) {
        backendLog.warn('Could not start temporary image deletion', {
          filename: file,
          error: err
        });
      }
    });
  });
}

async function createWindow() {
  const iconFilename = process.platform === 'darwin' ? 'mynda-icon-mac.png' : 'mynda-icon.png';
  const appIcon = path.join(app.getAppPath(), 'images', iconFilename);
  // Packaged macOS apps use their embedded ICNS. Source launches otherwise
  // inherit Electron's Dock icon; Windows/Linux use the window icon below.
  if (process.platform === 'darwin' && !app.isPackaged && app.dock) {
    app.dock.setIcon(appIcon);
  }
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    icon: appIcon,
    //frame: false,
    webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        preload: path.join(app.getAppPath(), 'src', 'preload', 'generated', 'preload.js'),
        webviewTag: false,
        nodeIntegrationInSubFrames: false,
        nodeIntegrationInWorker: false,
        webSecurity: true,
        allowRunningInsecureContent: false
    }
  })
  externalContent.protectWindow(win);
  const owner = win.webContents.id;
  win.webContents.once('destroyed',()=>{
    editor.dispose(owner); desktop.dispose(owner);
    playback.stop().catch(error=>backendLog.error('Could not finish playback after interface closure',{error}));
  });
  if (!libraryClose) libraryClose = require('./LibraryClose.js').installLibraryClose({
    app,ipcMain,dialog,library,getWindow:()=>win,log:backendLog
  });
  libraryClose.attachWindow(win);

  if (!app.isPackaged) {
    win.webContents.openDevTools();
  }
  await win.loadFile(path.join(app.getAppPath(), 'src', 'renderer', 'index.html'));
  // win.loadFile('src/legacy/player.html');
}

// get rid of any null values in media, inactive_media, watchfolders, etc.
function cleanLibrary() {
  return new Promise((resolve,reject) => {
    // library.media.map();
    resolve();
  });
}

function removeWatchfolder(folder,cb) {
  // Move current records and remove the folder in one durable operation. Do
  // not change the in-progress scan tree if that save fails.
  scanLog.info('Removing watchfolder', {watchfolder: folder});
  library.transaction([{opType:'remove-watchfolder',path:folder}],error => {
    if (!error && libFileTree && Array.isArray(libFileTree.folders)) {
      libFileTree.folders = libFileTree.folders.filter(wf => wf.path !== folder);
    }
    if (cb) cb(error);
  },{priority:'interactive'});
}

function removeVideo(video, index, fromInactive) {
  return library.moveMedia([video.id], fromInactive ? 'inactive_media' : 'media',
    fromInactive ? null : 'inactive_media', undefined,
    {priority:'background',expectedFilenames:{[video.id]:video.filename}});
}

// Each background producer awaits its bounded commit. No scan/probe/network
// work runs inside the authoritative library's commit queue.
function patchScannedVideos(patches) {
  if (!patches.length) return Promise.resolve();
  return library.patchMediaBatch(patches, undefined, {priority:'background',conflict:'skip'});
}

async function saveScanAdditions(videos, duplicateTracker) {
  for (let start=0; start<videos.length; start+=10) {
    await library.upsertMediaBatch(videos.slice(start,start+10).map(video => {
      const baseline = scanActivationBaselines.get(video.id);
      return baseline ? {video,baseline} : video;
    }),undefined,{priority:'background',requireWatchfolder:true});
  }
  // Only duplicates are changed here; the scan must never replace the whole
  // current media array or restore stale titles/playback state.
  const baseline = library.media;
  const discovered = duplicateTracker.apply(baseline);
  const patches = discovered.flatMap((video,index) => video && !_.isEqual(video.duplicates,baseline[index].duplicates) ?
    [{id:video.id,baseline:baseline[index],changes:{duplicates:video.duplicates}}] : []);
  for (let start=0;start<patches.length;start+=10) await patchScannedVideos(patches.slice(start,start+10));
}

//Takes a complete file address of a directory.
// Returns a boolean on whether it thinks this is a DVD rip folder.
function isDVDRip(folder) {
  let positiveEvidence = false;
  let contents = fs.readdirSync(folder, { withFileTypes: true })
  if (contents.length > 30) {
    return false;
  }
  for (let i=0; i<contents.length; i++) {
    let content = contents[i];
    if (content.isDirectory()) {
      if (content.name === 'VIDEO_TS') {
        positiveEvidence = true;
      } /*else if (!['VIDEO_TS', 'AUDIO_TS', 'JACKET_P', 'common', 'win'].includes(content.name)) {
        return false;
      }*/
    } else {
      if (path.extname(content.name) === '.VOB') {
        positiveEvidence = true;
      }
    }
  }
  return positiveEvidence;
}

let videoTemplate =   {
    "id" : '',
    "imdbID" : '',
    "title" : '',
    "year" : '',
    "series" : '',
    "seriesImdbID" : '',
    "season" : '',
    "episode" : '',
    "director" : '',
    "directorsort" : '',
    "cast" : [],
    "description" : '',
    "genre" : '',
    "tags" : [],
    "seen" : false,
    "position" : 0,
    "country" : '',
    "languages" : [],
    "boxoffice" : 0,
    "rated" : '',
    "ratings" : {},
    "dateadded" : '',
    "lastseen" : '',
    "watchlater" : false,
    "kind" : '',
    "artwork" : '',
    "subtitles" : [],
    "detected_subtitles" : [],
    "manual_subtitles" : [],
    "ignored_subtitles" : [],
    "subtitle_tracking_initialized" : true,
    "filename" : '',
    "duplicates" : [],
    "new" : true,
    "metadata" : {
      "codec" : "",
      "duration" : 0,
      "width" : 0,
      "height" : 0,
      "aspect_ratio" : "",
      "framerate" : 0,
      "audio_codec" : "",
      "audio_layout" : "",
      "audio_channels" : 0
    }
  }

function finishWatchfolderScan() {
  watchfolderScanRunning = false;

  // A watchfolder added during an existing scan must get one fresh pass. A
  // single queued scan is enough even if several folders were added, because
  // it reads the current settings when it starts.
  if (watchfolderScanQueued) {
    watchfolderScanQueued = false;
    checkWatchFolders('watchfolder-added-queued');
  }
}

async function checkWatchFolders(trigger = 'automatic') {
  if (library.getIdentityIssue()) {
    scanLog.error('Refused a scan of an incompatible library', library.getIdentityIssue());
    return false;
  }
  if (shareService.isBusy()) {
    if (trigger === 'watchfolder-added' || trigger === 'watchfolder-added-queued') {
      watchfolderScanQueued = true;
      scanLog.info('Queued watchfolder scan until the Share operation finishes', {
        trigger: trigger,
        sharePhase: shareService.getState().phase
      });
    } else {
      scanLog.info('Ignored watchfolder scan request because Share is active', {
        trigger: trigger,
        sharePhase: shareService.getState().phase
      });
    }
    return false;
  }

  // The scanner uses shared tree/reconciliation state, so overlapping passes
  // would corrupt one another. An added watchfolder needs a later pass; a
  // repeated manual/startup request does not, because the active pass already
  // represents a scan in progress for the user.
  if (watchfolderScanRunning) {
    if (trigger === 'watchfolder-added' || trigger === 'watchfolder-added-queued') {
      watchfolderScanQueued = true;
      scanLog.info('Queued watchfolder scan until the current scan finishes', {
        trigger: trigger
      });
    } else {
      scanLog.info('Ignored watchfolder scan request because a scan is already running', {
        trigger: trigger
      });
    }
    return false;
  }

  watchfolderScanRunning = true;

  try {
    // Let an editor/settings save already in the Library queue settle before
    // taking snapshots that will later be written back during reconciliation.
    await library.whenIdle();

    // These values describe one scan only. Leaving them populated causes files
    // from earlier scans to be treated as members of the current batch.
    parsing = {};
    libMulch = [];
    newIDs = [];
    scanActivationBaselines = new Map();
    unavailableWatchFolders = new Set();
    subtitleReconciliationContext = {detectedOwners: new Map(), legacyCounts: new Map()};
    videoExclusion.reset();

    win.webContents.send('status-update', {action: 'check'});
    // reset libFileTree
    libFileTree = {name:'root', folders:[]};

    // Search watchfolders for new files and add any new videos to the library
    numNewVids = 0; // reset the number of new videos found
    let folders = Array.isArray(library.settings.watchfolders) ?
      library.settings.watchfolders.filter(Boolean) : [];
    scanLog.info('Watchfolder scan started', {
      trigger: trigger,
      watchfolderCount: folders.length
    });
    for (let i=0; i<folders.length; i++) {
      let thisFolder = folders[i];
      if (thisFolder) {
        let thisNode;
        let filtered = libFileTree.folders.filter(folder => folder.path === thisFolder.path);
        if (filtered.length === 0) {
          let child = {path: thisFolder.path, kind: thisFolder.kind, folders: [], videos: [], subtitles: []};
          libFileTree.folders.push(child);
          thisNode = libFileTree.folders[libFileTree.folders.length-1];
        } else {
          thisNode = filtered[0];
        }
        findVideosFromFolder(thisNode);
      }
    }
    if (folders.length === 0) {
      scanLog.info('Watchfolder scan finished; no watchfolders are configured');
      win.webContents.send('status-update', {action: ''});
      finishWatchfolderScan();
    }
  } catch(err) {
    scanLog.error('Could not start watchfolder scan', {
      trigger: trigger,
      error: err && err.stack ? err.stack : String(err)
    });
    win.webContents.send('status-update', {action: ''});
    finishWatchfolderScan();
  }

  return true;
}

// recursively maps out the folder structure and files (only videos/DVDs and subtitle files)
// storing the whole thing in libFolderTree;
// once this is done, we'll traverse the tree, adding all the videos to the library
function findVideosFromFolder(folderNode, rootWatchFolder = folderNode.path) {
  // the id here (and the <parsing> object it gets put into)
  // is just to keep track of all the recursive branches of this function,
  // so we'll know when they're all finished
  const id = uuidv4();
  parsing[id] = true;

  const folder = folderNode.path;
  const kind = folderNode.kind;

  // read the contents of this folder
  fs.readdir(folder, {withFileTypes : true}, async function (err, components) {
    // handling error
    if (err) {
        unavailableWatchFolders.add(rootWatchFolder);
        scanLog.warn('Skipping unavailable watchfolder', {
          watchfolder: rootWatchFolder,
          directory: folder,
          error: err
        });
        components = []; // in case of error, components will be undefined, so we make it an empty array instead
    }

    // loop through all the folder contents
    for (let i=0; i<components.length; i++) {
      let component = components[i];
      let compAddress = path.join(folder, component.name);

      // Never scan Mynda's atomic Share-import staging directory: an
      // interrupted DVD copy may already contain VIDEO_TS while incomplete.
      // Other hidden directories retain the scanner's existing behavior.
      if (component.name === ShareManifest.IMPORT_STAGING_DIRECTORY) {
        continue;
      }

      // if we found a directory, find out if it's a DVD rip or not
      if (component.isDirectory()) {
        if (isDVDRip(compAddress)) {
          // if it is, add it as a video
          // console.log(`${compAddress} is a DVD rip`);
          folderNode.videos.push({
            dvd: true,
            filename: compAddress,
            kind: kind,
            folderParts: path.relative(rootWatchFolder, folder).split(path.sep).filter(Boolean)
          }); // add the DVD to libFileTree
        } else {
          // if it's not, recurse on it as a folder
          recursed = true;
          folderNode.folders.push({path:compAddress, kind:kind, folders:[], videos:[], subtitles:[]});
          findVideosFromFolder(folderNode.folders[folderNode.folders.length-1], rootWatchFolder);
        }
      } else if (!/^\./.test(component.name)) {
        // Hidden files have always been ignored by the watchfolder scanner.
        //console.log(`We came across ${component.name}.`);
        // otherwise, it must be a file
        let fileExt = path.extname(component.name).replace('.', '').toLowerCase();

        if (videoExtensions.includes(fileExt)) {
          // Only filenames/folders with explicit sample, garbage, or trailer
          // evidence need a runtime probe. Await it before adding the file to
          // libFileTree so a rejected video never enters the library, even on
          // the first watchfolder scan.
          if (!await videoExclusion.shouldExclude(compAddress)) {
            //console.log(`We're about to add ${component.name} to libTree.`);
            // if it's a video file, add it as a video
            // console.log(`${compAddress} is a regular video file`);
            folderNode.videos.push({
              filename: compAddress,
              kind: kind,
              folderParts: path.relative(rootWatchFolder, folder).split(path.sep).filter(Boolean)
            }); // add the video to this node of the libFileTree
          }
        } else if (subtitleExtensions.includes(fileExt)) {
          // if it's a subtitle file, add it as a subtitle
          // console.log(`${compAddress} is a subtitle file`);
          folderNode.subtitles.push(compAddress); // add the subtitles file to this node of the libFileTree
        }
      }
    }

    parsing[id] = false;
    let stillGoing = false;
    for (let call of Object.keys(parsing)) {
      if (parsing[call] === true) {
        stillGoing = true;
        break;
      }
    }
    if (!stillGoing) {
      confirmCurrentVideos().catch(err => {
        scanLog.error('Watchfolder reconciliation failed', {error: err});
        win.webContents.send('status-update', {action: ''});
        finishWatchfolderScan();
      });
    }
  });
}

function isInUnavailableWatchFolder(filepath) {
  for (let watchfolder of unavailableWatchFolders) {
    let relativePath = path.relative(watchfolder, filepath);
    if (relativePath === '' ||
        (relativePath !== '..' && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath))) {
      return true;
    }
  }
  return false;
}

async function confirmCurrentVideos() {
  //Once libFileTree is built, check videos in library and make sure they're
  // all there, removing from libFileTree as we go
  scanLog.debug('Reconciling scanned files with the current library');

  // Match subtitles while the complete scanned tree is still intact. Doing
  // this once, subtitle-first, lets us use folder structure and all candidate
  // videos instead of recursively handing one video every subtitle beneath it.
  const preparedSubtitles = prepareSubtitleMatches(libFileTree, unavailableWatchFolders);
  subtitleReconciliationContext = {
    detectedOwners: preparedSubtitles.detectedOwners,
    legacyCounts: buildLegacySubtitleCounts(library.media, library.inactive_media)
  };
  scanLog.info('Subtitle matching finished', {
    subtitleFiles: preparedSubtitles.stats.numSubtitles,
    matchedSubtitleFiles: preparedSubtitles.stats.matchedSubtitles.size,
    sharedSubtitleFiles: preparedSubtitles.stats.multiplyAssignedSubtitles.size,
    unmatchedSubtitleFiles: preparedSubtitles.stats.unmatched.length
  });
  if (preparedSubtitles.stats.unmatched.length > 0) {
    scanLog.debug('Subtitle files left unmatched', {
      files: preparedSubtitles.stats.unmatched
    });
  }
  const scannedMedia = _.cloneDeep(library.media);
  for (let h=scannedMedia.length-1; h>=0; h--) {
    let video = scannedMedia[h];
    if (!video) {
      // library.remove(`media.${h}`);
      continue;
    }

    let filename = video.filename;
    let matchingSubtitles;
    // We put the whole thing in a try block, as we'll be traversing
    // nodes that aren't guaranteed to exist, and are expected not to if the
    // video has moved or been removed.
    try {
      // A number of these steps will fail gracefully by nature, but we don't
      // want them to, the problem variable lets us throw errors when things
      // don't work the way they should.
      let problem = true;
      // Start by figuring out which watchfolder the video is in
      let conWatchFolder;
      for (let watchfolder of library.settings.watchfolders) {
        if (containsPath(watchfolder.path, filename)) {
          conWatchFolder = watchfolder.path;
          problem = false;
          break;
        }
      }
      if (problem) {throw true}
      // A failed scan means we do not know whether any file in this
      // watchfolder is present. Preserve its library entries until a later,
      // successful scan can determine that safely.
      if (unavailableWatchFolders.has(conWatchFolder)) {
        continue;
      }
      // Then traverse the libFileTree nodes based on the video's filepath.
      let libTreeLoc = libFileTree
      let pathComps = [conWatchFolder].concat(filename.replace(conWatchFolder + path.sep, '').split(path.sep));
      let pathComp = '';
      for (let j=0; j<pathComps.length; j++) {
        problem = true;
        let pathAdd =  (j===0) ? pathComps[j] : path.sep + pathComps[j];
        pathComp = pathComp + pathAdd;
        let lastOne = j === (pathComps.length - 1);
        if (!lastOne) {
          for (let k=0; k<libTreeLoc.folders.length; k++) {
            if (libTreeLoc.folders[k].path === pathComp) {
              libTreeLoc = libTreeLoc.folders[k];
              problem = false;
              break;
            }
          }
        } else {
          for (let k=0; k<libTreeLoc.videos.length; k++) {
            if (libTreeLoc.videos[k].filename === filename) {

              // before deleting existing video from libFileTree, check for any subtitle changes
              matchingSubtitles = libTreeLoc.videos[k].subtitles || [];

              // If we've gotten here, then we have confirmed the video exists,
              // so delete it from libFileTree
              libTreeLoc.videos.splice(k, 1);
              problem = false;

              break;
            }
          }
        }
        if (problem) {throw true}
      }

    } catch(err) {
      // A thrown error means we didn't find the video where we expected to,
      // so move it to inactive media.
      scanLog.info('Video was not found during a successful watchfolder scan; moving it to inactive media', {
        filename: filename,
        id: video.id,
        reconciliationReason: err
      });
      await removeVideo(video);
    }
    // Save failures must escape reconciliation; they are not evidence that a
    // file vanished and must never send a present video to inactive media.
    if (matchingSubtitles) await updateVideoSubs(video, matchingSubtitles);
  }
  scanLog.debug('Watchfolder tree reconciliation finished; checking unmatched videos');

  // walk through libFileTree, adding all the videos to the library
  // (and making our best guess as to which subtitles go with which videos)
  mulchVideoTree(libFileTree);
  await addVideoController();
}

function mulchVideoTree(folderNode) {
  // Do not add, remove, or update anything from an incomplete watchfolder scan.
  if (folderNode.path && unavailableWatchFolders.has(folderNode.path)) {
    return;
  }
  if (folderNode.folders && folderNode.folders.length > 0) {
    for (let childFolder of folderNode.folders) {
      mulchVideoTree(childFolder);
    }
  }
  if (folderNode.videos && folderNode.videos.length > 0) {
    for (let video of folderNode.videos) {
      libMulch.push(video);
      //addVideoFile(folderNode, videoFilename, rootFolder).catch((err) => {console.log(err)});
    }
  }
  //Now that we have a flat array, make sure that the window is up and running, and start adding them.
}

async function addVideoController() {
  let checkStart = new Date();
  let newMedia = [];
  // A complete scan rebuilds duplicate paths from what is actually present.
  // Paths beneath an unavailable watchfolder are retained because this pass
  // has no evidence that those files disappeared.
  const duplicateTracker = new ScanDuplicateTracker(
    library.media,
    isInUnavailableWatchFolder
  );
  let candidateOutcomes = {
    newVideos: 0,
    reactivatedVideos: 0,
    activeDuplicates: 0,
    batchDuplicates: 0,
    failedVideos: 0
  };
  for (let i=0; i<libMulch.length; i++) {
    // libMulch contains paths that were not matched by filename during the
    // scan, not necessarily new videos. Keep this phase labeled as checking
    // until each file's content-derived ID establishes whether it is new,
    // inactive, or a duplicate of an active/current-batch video.
    win.webContents.send('status-update', {
      action: 'check',
      numCurrent: i+1,
      numTotal: libMulch.length
    });
    let video = libMulch[i];
    let result = await addVideoFile(video);
    switch(result && result.disposition) {
      case 'new':
      case 'reactivated':
        if (result.video) {
          newMedia.push(result.video);
          candidateOutcomes[result.disposition === 'new' ? 'newVideos' : 'reactivatedVideos']++;
        } else {
          candidateOutcomes.failedVideos++;
        }
        break;
      case 'duplicate-active':
        candidateOutcomes.activeDuplicates++;
        duplicateTracker.record(result.duplicateOfID, result.duplicatePath);
        break;
      case 'duplicate-batch':
        candidateOutcomes.batchDuplicates++;
        duplicateTracker.record(result.duplicateOfID, result.duplicatePath);
        // Preserve subtitles found next to a same-scan duplicate just as the
        // active-library duplicate branch already does.
        const batchPrimary = newMedia.find(video =>
          video && video.id === result.duplicateOfID
        );
        if (batchPrimary) {
          await updateVideoSubs(batchPrimary, [
            ...(batchPrimary.detected_subtitles || []),
            ...(result.detectedSubtitles || [])
          ]);
        }
        break;
      default:
        candidateOutcomes.failedVideos++;
    }
  }
  let duplicateVideos = candidateOutcomes.activeDuplicates + candidateOutcomes.batchDuplicates;
  let checkEnd = new Date();
  backendLog.info('Watchfolder video candidates checked', {
    candidateVideos: libMulch.length,
    videosToAdd: newMedia.length,
    duplicateVideos: duplicateVideos,
    activeDuplicates: candidateOutcomes.activeDuplicates,
    batchDuplicates: candidateOutcomes.batchDuplicates,
    newVideos: candidateOutcomes.newVideos,
    reactivatedVideos: candidateOutcomes.reactivatedVideos,
    failedVideos: candidateOutcomes.failedVideos,
    elapsedMs: checkEnd-checkStart
  });

  let minimumResultStatus = Promise.resolve();
  if (newMedia.length > 0 || duplicateVideos > 0) {
    // The potentially slow content-ID work is complete, so this total now
    // describes videos that will really enter active media and duplicates that
    // were really skipped. Run the minimum display time alongside the save: a
    // slow save adds no delay, while a fast one cannot make the result summary
    // flash by unreadably.
    win.webContents.send('status-update', {
      action: 'add',
      numTotal: newMedia.length,
      duplicateVideos: duplicateVideos
    });
    minimumResultStatus = new Promise(resolve => {
      setTimeout(resolve, MIN_SCAN_RESULT_STATUS_MS);
    });
  }
  await Promise.all([
    saveScanAdditions(newMedia, duplicateTracker),
    minimumResultStatus
  ]);

  // tell the user how many videos we added
  win.webContents.send('videos_added',newMedia.length);

  // File probes run outside the commit queue. Commit small field-scoped
  // batches as results become ready so user edits can run between them.
  let metaStart = new Date();
  let unchecked = _.cloneDeep(library.media).filter(v =>
    v !== null && MediaMetadata.needsMetadataScan(v.metadata) && !isInUnavailableWatchFolder(v.filename)
  ); // Include one recheck of legacy MJPEG metadata that may describe cover art.
  let numTotal = unchecked.length;
  let numChecked = 0;
  let numSuccessful = 0;

  let metadataPatches = [];

  // loop through all the unchecked videos and check them,
  // submitting metadata-only changes against each probe's original filename
  for (let v of unchecked) {
    if (v !== null && MediaMetadata.needsMetadataScan(v.metadata)) {
      numChecked++;
      win.webContents.send('status-update', {action: 'metadata', numCurrent: numChecked, numTotal: numTotal});
      let metadata = await getMetadata(v, {
        purpose: v.metadata && v.metadata.checked ?
          'recheck legacy video metadata that may describe cover art' :
          'populate technical metadata for unchecked library video'
      });
      if (MediaMetadata.hasTechnicalMetadata(metadata)) numSuccessful++;
      metadataPatches.push({id:v.id,baseline:v,expected:{filename:v.filename},changes:{metadata}});
      if (metadataPatches.length >= 10) {
        await patchScannedVideos(metadataPatches);
        metadataPatches = [];
      }
    }
  }

  await patchScannedVideos(metadataPatches);
  win.webContents.send('status-update', {action: 'metadata_save', numTotal: numSuccessful});
  backendLog.info('Video metadata scan finished', {
    videosChecked: numChecked,
    videosWithMetadata: numSuccessful,
    elapsedMs: new Date()-metaStart
  });

  setTimeout(() => {
    win.webContents.send('status-update', {action: ''});
    finishWatchfolderScan();
  },3000);
}

// Takes a video object and fills it out
async function addVideoFile(video) {
  // console.log(video)
  let file = video.filename;
  let fileBasename = path.basename(file,path.extname(file));
  let id = await createVideoID(video.filename);

  //There are four major possibilities for this video's situation:
  //1. We already have this video in the library (either because:
    //confirmCurrentVideos missed it or
    //We have multiple copies of an identical file in our watchfolder
  //2. We don't have it in the library, but have another copy in libFileTree
  //3. We have it in inactive media, probably because file was moved.
  //4. We don't have it anywhere, it's new.
  //So, find out what the situation is, and then perform the appropriate action.
  //Sitations 3 & 4 share a bunch of code, so there will be a second fork to split them.
  let situation;
  if (indexOfVideoInLibrary(id) !== null) {
    situation = 1;
  } else if (newIDs.includes(id)) {
    situation = 2;
  } else if (indexOfVideoInInactiveMedia(id) !== null) {
    situation = 3;
  } else {
    situation = 4;
  }
  let vidObj;

  switch(situation) {
    //########### VIDEO IS ALREADY IN LIBRARY ###########//

    // if the video is already in the library, update the subtitles
    // and update the video in the library, check to make sure the id
    // is in the watchfolder manifest, and then we're done
    case 1:
      let vidIndex = indexOfVideoInLibrary(id);
      let libraryVideo = _.cloneDeep(library.media[vidIndex]);
      scanLog.debug('Rejected duplicate of an active library video', {
        filename: file,
        duplicateOfID: libraryVideo.id,
        duplicateOfTitle: libraryVideo.title
      });
      // The same content may exist at more than one path. Keep subtitles
      // detected beside the already-confirmed copy as well as this duplicate.
      const duplicateDetectedSubtitles = [
        ...(libraryVideo.detected_subtitles || []),
        ...(video.subtitles || [])
      ];
      await updateVideoSubs(libraryVideo, duplicateDetectedSubtitles);
      return {
        disposition: 'duplicate-active',
        duplicateOfID: libraryVideo.id,
        duplicatePath: file
      };

    case 2:
      // If we have another new video with the same id, just skip it for now.
      //Long term we want to mention to user and figure out which to use.
      scanLog.debug('Rejected duplicate within the current watchfolder scan', {
        filename: file,
        id: id
      });
      return {
        disposition: 'duplicate-batch',
        duplicateOfID: id,
        duplicatePath: file,
        detectedSubtitles: video.subtitles || []
      };

    case 3:
    case 4:
      if (situation === 3) {
        // ------------- VIDEO IS IN LIBRARY.INACTIVE_MEDIA ------------- //
        // remove the video object from inactive media (it will be added to active media below)
        let inactiveVidIndex = indexOfVideoInInactiveMedia(id);
        scanLog.info('Reactivating video found in inactive media', {
          filename: file,
          id: id,
          inactiveIndex: inactiveVidIndex
        });

        try {
          vidObj = _.cloneDeep(library.inactive_media[inactiveVidIndex]);
          scanActivationBaselines.set(id, _.cloneDeep(vidObj));
          vidObj.filename = file; // this is important because the file may have been renamed

          // === DO NOT UPDATE THE KIND BASED ON WATCHFOLDER DEFAULT KIND ===
          // try {
          //   // update the video's kind based on the watchfolder's default kind;
          //   // in case the user has changed the default kind, we want to update it when re-adding the video
          //   // vidObj.kind = video.kind;
          // } catch(err) {
          //   console.log('Could not update kind based on watchfolder default kind: ' + err);
          // }

          // Removal from inactive and insertion into active are one later commit.

        } catch(err) {
          scanLog.error('Could not reactivate video from inactive media', {
            filename: file,
            id: id,
            error: err
          });
          return {disposition: 'failed'};
        }
      } else {
        // ------------- VIDEO IS BRAND NEW ------------- //
        scanLog.debug('New video found', {filename: file, id: id});

        // otherwise, add the video from scratch

        // start creating the video object
        vidObj = _.cloneDeep(videoTemplate);
        vidObj.filename = file;
        // let fileExt = path.extname(file);
        // vidObj.title = isDVD ? path.basename(file) : path.basename(file, fileExt);
        vidObj.title = fileBasename;
        vidObj.kind = video.kind;
        vidObj.id = id;
        if (video.dvd) {
          vidObj.dvd = video.dvd;
        }
        try {
          // get the date the file was added, from the OS
          vidObj.dateadded = await getFileBirthtime(file);
        } catch(err) {
          // if we couldn't get the file creation/added date from the OS, just use now
          vidObj.dateadded = Math.floor(Date.now() / 1000);
          scanLog.warn('Could not read video creation time; using the current time', {
            filename: file,
            error: err
          });
        }
      }

      //########### ADD VIDEO TO (ACTIVE) LIBRARY ###########//
      //#### BOTH FOR NEW VIDEOS AND FOR INACTIVE VIDEOS ####//

      // Infer show information from the relative folder path and filename.
      // Keep any values already stored on a rescued video.
      if (vidObj.kind === 'show') {
        let seasonEpisode = findSeasonEpisode(video, fileBasename);
        vidObj.series = vidObj.series || seasonEpisode.series || '';
        vidObj.season = vidObj.season || seasonEpisode.season || '';
        vidObj.episode = vidObj.episode || seasonEpisode.episode || '';
        // Only assign a detected title when creating a brand-new video.
        // A rescued video keeps the title already stored in the library.
        if (situation === 4) {
          vidObj.title = seasonEpisode.title || fileBasename;
        }
      }
      delete video.folderParts;

      if (typeof vidObj === 'object' && vidObj !== null) {
        await updateVideoSubs(vidObj, video.subtitles);
        // Register only successful additions. A failed first candidate must
        // not cause a later copy in the same scan to be discarded as though a
        // usable primary video already existed.
        newIDs.push(id);
        return {
          disposition: situation === 3 ? 'reactivated' : 'new',
          video: vidObj
        };
      }
    }
  return {disposition: 'failed'};
}

function metadataPurpose(options) {
  let purpose = options && options.purpose;
  return typeof purpose === 'string' && purpose.trim() ?
    purpose.trim() : 'retrieve video metadata';
}

async function getMetadata(video, options = {}) {
  // get video data from the file itself (duration, codec, dimensions, whatever)
  let file = video.filename;
  let purpose = metadataPurpose(options);
  let logContext = {filename: file, purpose: purpose};
  metadataLog.debug('Video metadata retrieval started', logContext);
  return MediaMetadata.retrieveMetadata({
    probe: () => MediaTools.probeFile(file),
    fallback: () => getMetadataFromFFmpeg(file, video.id, {purpose}),
    previous: video.metadata,
    log: metadataLog,
    context: logContext
  });
}


// The scanner and one-time migration share this exact scheme-2 recipe.
async function createVideoID(filepath) {
  return (await ContentFingerprint.fingerprintPath(filepath)).id;
}


async function updateVideoSubs(video, detectedSubtitles) {
  const baseline = _.cloneDeep(video);
  if (reconcileVideoSubtitles(video, detectedSubtitles || [], subtitleReconciliationContext)) {
    if (library.media.some(current => current && current.id === video.id)) {
      const expected = Object.fromEntries(['filename','subtitles','detected_subtitles','manual_subtitles',
        'ignored_subtitles','subtitle_tracking_initialized'].map(field => [field,baseline[field]]));
      await patchScannedVideos([{id:video.id,baseline,expected,replacement:video}]);
    }
    scanLog.debug('Detected subtitle changes for video', {
      filename: video.filename,
      subtitleCount: Array.isArray(video.subtitles) ? video.subtitles.length : 0
    });
  }
}

//Takes a full address for a file/folder and checks to see if
//we already have it in the library. Returns index in library
// if checkInactive is true, return the index from library.inactive_media
// instead of from library.media
function indexOfVideoInLibrary(id, checkInactive) {
  let media = checkInactive ? library.inactive_media : library.media;
  for (let i=0; i<media.length; i++) {
    // if (media[i].filename === filepath) {
    if (media[i] && media[i].id === id) {
      return i;
    }
  }
  return null;
}
function indexOfVideoInInactiveMedia(id) {
  return indexOfVideoInLibrary(id,true);
}

function getFileBirthtime(file) {
  return new Promise((resolve, reject) => {
    fs.stat(file,(err, stats) => {
      if (err) {
        reject(`Error. Could not retrieve file stats for ${file} : ${err}`);
      } else {
        //console.log(`GOT STATS FOR ${file}`);
        //console.log(JSON.stringify(stats));

        let dateadded;
        try {
          dateadded = Math.floor(stats.birthtimeMs / 1000);
        } catch(e) {
          reject(`Unable to add dateadded to file: ${e}`);
        }

        if (typeof dateadded !== "undefined") {
          resolve(dateadded);
        }
      }
    });
  });
}

function getMetadataFromFFmpeg(filepath, id, options = {}) {
  return MediaMetadata.readFfmpegMetadata(filepath, {
    ffmpeg, app, identifier: uuidv4(), log: metadataLog,
    context: {filename: filepath, id, purpose: metadataPurpose(options)}
  });
}

// Build, but do not save, the changes for the editor's "Reset from Filename"
// action. This deliberately starts identification from the file path instead
// of the video's current title/series values, so a bad catalog match cannot feed
// back into the retry. It reuses findSeasonEpisode(), keeping manual and batch
// reset behavior identical to the detector used when a show is first added.
function deriveFilenameResetChanges(video, watchfolders = library.settings.watchfolders) {
  if (!video || typeof video.id !== 'string' || typeof video.filename !== 'string') {
    throw new Error('Cannot reset a video without an id and filename');
  }

  const watchfolder = findContainingWatchfolder(video.filename, watchfolders);
  const detectedKind = watchfolder && watchfolder.kind ? watchfolder.kind : (video.kind || '');
  const fileBasename = path.basename(video.filename, path.extname(video.filename));
  const containingFolder = path.dirname(video.filename);
  const folderParts = watchfolder ?
    path.relative(watchfolder.path, containingFolder).split(path.sep).filter(Boolean) : [];

  // Tagging adds these catalog fields. Clear them so the next manual search or
  // Auto-Tag pass starts cleanly. User-owned state—tags, subtitles, watched
  // state, playback position, dates, and technical metadata—is absent from
  // this patch and therefore survives unchanged in the editor.
  const changes = {
    imdbID: '',
    seriesImdbID: '',
    title: fileBasename,
    year: '',
    series: '',
    season: '',
    episode: '',
    director: '',
    directorsort: '',
    cast: [],
    description: '',
    genre: '',
    country: '',
    languages: [],
    boxoffice: 0,
    rated: '',
    artwork: '',
    kind: detectedKind,
    new: true,
    autotag_tried: false,
    ratings: {
      ...((video.ratings && typeof video.ratings === 'object') ? _.cloneDeep(video.ratings) : {}),
      imdb: '',
      rt: '',
      mc: ''
    }
  };

  if (detectedKind === 'show') {
    const detected = findSeasonEpisode({folderParts: folderParts}, fileBasename);
    changes.title = detected.title || fileBasename;
    changes.series = detected.series || '';
    changes.season = detected.season || '';
    changes.episode = detected.episode || '';
  }

  return {
    id: video.id,
    changes: changes,
    watchfolderFound: Boolean(watchfolder)
  };
}

function getAutoTagCandidates() {
  return library.media.filter(medium => (medium.new && !medium.autotag_tried));
}

function validSeriesImdbID(value) {
  return typeof value === 'string' && /^tt\d+$/.test(value.trim());
}

function normalizedBatchSeries(value) {
  return typeof value === 'string' ?
    value.trim().replace(/\s+/g, ' ').toLocaleLowerCase() : '';
}

// Mynda may store manually interlaced episode positions such as 3.5, but
// The metadata server's season/episode endpoint accepts only whole-number coordinates. Keep
// those videos valid in the library while excluding them from coordinate-based
// Auto-Tag requests that could otherwise target the wrong ordinary episode.
function hasUsableEpisodeCoordinates(video) {
  return Boolean(video && video.kind === 'show' &&
    String(video.series || '').trim() &&
    /^\d+$/.test(String(video.season).trim()) &&
    /^\d+(?:\.0)?$/.test(String(video.episode).trim()));
}

// Resolve renderer-supplied IDs against the main process's freshest library.
// Preserve the selection order, ignore duplicates, and never trust complete
// renderer video objects for a workflow that writes catalog metadata.
function getSelectedAutoTagVideos(videoIDs) {
  if (!Array.isArray(videoIDs)) return [];

  const mediaByID = new Map(
    library.media.filter(Boolean).map(video => [video.id, video])
  );
  const seen = new Set();
  const selected = [];
  for (const id of videoIDs) {
    if (typeof id !== 'string' || seen.has(id) || !mediaByID.has(id)) continue;
    seen.add(id);
    selected.push(_.cloneDeep(mediaByID.get(id)));
  }
  return selected;
}

// A single series choice can safely govern a selection only when every item
// is a show and every normalized, non-empty series name is the same. One stored
// parent ID is enough to reuse the user's earlier decision across the batch;
// conflicting stored IDs force a fresh conservative resolution.
function sameSeriesShowBatch(videos) {
  if (!Array.isArray(videos) || videos.length === 0 ||
      videos.some(video => !video || video.kind !== 'show')) {
    return null;
  }

  const firstSeries = typeof videos[0].series === 'string' ? videos[0].series.trim() : '';
  const seriesKey = normalizedBatchSeries(firstSeries);
  if (!seriesKey || videos.some(video => normalizedBatchSeries(video.series) !== seriesKey)) {
    return null;
  }

  const storedIDs = Array.from(new Set(
    videos
      .map(video => validSeriesImdbID(video.seriesImdbID) ? video.seriesImdbID.trim() : '')
      .filter(Boolean)
  ));

  return {
    series: firstSeries,
    seriesKey: seriesKey,
    storedSeriesImdbID: storedIDs.length === 1 ? storedIDs[0] : '',
    conflictingStoredSeriesIDs: storedIDs.length > 1,
    storedSeriesIDs: storedIDs
  };
}



async function requestAutoTag() {
  if (shareService.isBusy()) {
    await dialog.showMessageBox({
      type: 'info',
      buttons: ['OK'],
      defaultId: 0,
      title: 'Auto-Tag',
      message: 'Auto-Tag cannot start while Share is working.',
      detail: 'Wait for Share to finish or cancel it, then try again.'
    });
    return;
  }

  if (watchfolderScanRunning) {
    await dialog.showMessageBox({
      type: 'info',
      buttons: ['OK'],
      defaultId: 0,
      title: 'Auto-Tag',
      message: 'Auto-Tag cannot start while a watchfolder scan is running.',
      detail: 'Wait for the scan to finish, then try again.'
    });
    return;
  }

  if (autoTagState.running || autoTagRequestPending) {
    await dialog.showMessageBox({
      type: 'info',
      buttons: ['OK'],
      defaultId: 0,
      title: 'Auto-Tag',
      message: 'Auto-Tag is already running or awaiting confirmation.'
    });
    return;
  }

  autoTagRequestPending = true;
  try {
    const eligibleCount = getAutoTagCandidates().length;
    const plural = eligibleCount === 1 ? '' : 's';

    if (eligibleCount === 0) {
      await dialog.showMessageBox({
        type: 'info',
        buttons: ['OK'],
        defaultId: 0,
        title: 'Auto-Tag',
        message: 'There are no eligible videos to auto-tag.',
        detail: "Eligible videos must be in the 'New' playlist and must not already have had an Auto-Tag attempt. Edit a video to reset its Auto-Tag status if you want to try again."
      });
      return;
    }

    const result = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['Cancel', 'Auto-Tag'],
      defaultId: 0,
      cancelId: 0,
      title: 'Auto-Tag',
      message: `Auto-tag ${eligibleCount} video${plural}?`,
      detail: "Mynda will search the catalog for every video in the 'New' playlist (unless it has already been auto-tagged). Successful matches will overwrite most existing metadata. This may take a very long time when many videos are eligible."
    });

    if (result.response === 1) {
      await autoTag();
    } else {
      autoTagLog.info('Automatic tagging canceled by user', {eligibleVideos: eligibleCount});
    }
  } finally {
    autoTagRequestPending = false;
  }
}

async function chooseSeriesForSelectedBatch(seriesBatch, choices, videoCount) {
  const uniqueChoices = [];
  const seenIDs = new Set();
  for (const choice of Array.isArray(choices) ? choices : []) {
    if (!choice || !validSeriesImdbID(choice.imdbID) || seenIDs.has(choice.imdbID)) continue;
    seenIDs.add(choice.imdbID);
    uniqueChoices.push(choice);
  }
  if (uniqueChoices.length === 0) return null;

  const buttons = ['Cancel'].concat(uniqueChoices.map(choice => {
    const title = choice.Title || seriesBatch.series;
    const year = choice.Year || 'year unknown';
    return `${title} (${year}) — ${choice.imdbID}`;
  }));
  const result = await dialog.showMessageBox({
    type: 'question',
    buttons: buttons,
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: 'Choose Series',
    message: `Which “${seriesBatch.series}” series should these episodes use?`,
    detail: `Mynda found more than one matching series. Your choice will be used only for these ${videoCount} selected videos and saved as their parent series IMDb ID when they are processed.`
  });

  return result.response > 0 ? uniqueChoices[result.response - 1] : null;
}

async function showSelectedAutoTagSummary(result) {
  if (!result || !result.statistics) return;

  const stats = result.statistics;
  const tagged = stats.Success || 0;
  const processed = stats.processedVideos || 0;
  const notTagged = Math.max(0, processed - tagged);
  const remaining = stats.remainingVideos || 0;
  let message = `Auto-Tag finished for the selected videos.`;
  let detail = `${tagged} tagged successfully; ${notTagged} processed without a match; ${remaining} left unprocessed.`;
  if (result.seriesSelectionCanceled) {
    message = 'Selected Auto-Tag stopped because no series was chosen.';
    detail = 'No selected videos were processed or changed.';
  } else if (result.seriesPreflightFailure) {
    const reason = result.seriesPreflightFailure.failure || 'Series resolution failed';
    message = 'Selected Auto-Tag stopped because the series could not be resolved.';
    detail = `No selected videos were processed or changed. Preflight result: ${reason}.`;
  } else if (result.canceled) {
    message = 'Selected Auto-Tag was canceled.';
  }

  await dialog.showMessageBox({
    type: 'info',
    buttons: ['OK'],
    defaultId: 0,
    title: 'Auto-Tag Selected',
    message: message,
    detail: detail
  });
}

async function requestSelectedAutoTag(videoIDs) {
  if (shareService.isBusy()) {
    await dialog.showMessageBox({
      type: 'info',
      buttons: ['OK'],
      defaultId: 0,
      title: 'Auto-Tag Selected',
      message: 'Auto-Tag cannot start while Share is working.',
      detail: 'Wait for Share to finish or cancel it, then try again.'
    });
    return;
  }

  if (watchfolderScanRunning) {
    await dialog.showMessageBox({
      type: 'info',
      buttons: ['OK'],
      defaultId: 0,
      title: 'Auto-Tag Selected',
      message: 'Auto-Tag cannot start while a watchfolder scan is running.',
      detail: 'Wait for the scan to finish, then try again.'
    });
    return;
  }

  if (autoTagState.running || autoTagRequestPending) {
    await dialog.showMessageBox({
      type: 'info',
      buttons: ['OK'],
      defaultId: 0,
      title: 'Auto-Tag Selected',
      message: 'Auto-Tag is already running or awaiting confirmation.'
    });
    return;
  }

  autoTagRequestPending = true;
  try {
    // Settle already submitted commits before choosing the authoritative
    // selected-video snapshot for confirmation. Lookups never occupy this queue.
    await library.whenIdle();
    const selected = getSelectedAutoTagVideos(videoIDs);
    if (selected.length === 0) {
      await dialog.showMessageBox({
        type: 'info',
        buttons: ['OK'],
        defaultId: 0,
        title: 'Auto-Tag Selected',
        message: 'None of the selected videos could be found in the library.'
      });
      return;
    }

    const seriesBatch = sameSeriesShowBatch(selected);
    const incompleteShows = selected.filter(video =>
      video.kind === 'show' && !hasUsableEpisodeCoordinates(video)
    ).length;
    const keepInNew = !library.settings.preferences.remove_autotagged_from_new;
    let detail =
      `Only these ${selected.length} selected videos will be processed, even if they are not in New or have been tried before. ` +
      'Successful matches will overwrite most existing catalog metadata; unmatched or ambiguous videos will keep their existing visible metadata, although Mynda will record the attempt. ' +
      `Successfully tagged videos will ${keepInNew ? 'remain in' : 'be removed from'} New.`;

    if (seriesBatch) {
      detail += `\n\nAll selected videos are episodes of “${seriesBatch.series}”. Before processing any episode, Mynda will settle on one parent series ID for the whole batch. If the catalog finds more than one matching series, Mynda will ask you once; if the series cannot be resolved, no selected videos will be changed.`;
    } else {
      detail += '\n\nBecause this is not a single-series show batch, ambiguous matches will be skipped without another prompt.';
    }
    if (incompleteShows > 0) {
      detail += `\n\n${incompleteShows} selected show${incompleteShows === 1 ? '' : 's'} currently lack${incompleteShows === 1 ? 's' : ''} a usable series or whole-number season/episode for catalog lookups and cannot be tagged by coordinates. Tag a fractional episode individually by entering its exact IMDb ID.`;
    }

    const confirmation = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['Cancel', 'Auto-Tag Selected'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: 'Auto-Tag Selected',
      message: `Auto-tag ${selected.length} selected video${selected.length === 1 ? '' : 's'}?`,
      detail: detail
    });

    if (confirmation.response !== 1) {
      autoTagLog.info('Selected automatic tagging canceled before starting', {
        selectedVideos: selected.length
      });
      return;
    }

    const result = await autoTag({
      videos: selected,
      scope: 'selected',
      seriesBatch: seriesBatch
    });
    await showSelectedAutoTagSummary(result);
  } finally {
    autoTagRequestPending = false;
  }
}

function requestAutoTagCancellation() {
  if (!autoTagState.running || autoTagState.cancelRequested) {
    return Promise.resolve(false);
  }
  if (autoTagState.cancellationDecision) {
    return autoTagState.cancellationDecision;
  }

  const confirmationPreference = 'MynAutoTag-confirm-cancel';
  const cancelAutoTag = () => {
    if (!autoTagState.running) {
      autoTagLog.info('Automatic tagging finished before cancellation was requested');
      return false;
    }

    autoTagState.cancelRequested = true;
    const canceledWait = autoTagState.cancelCapacityWait && autoTagState.cancelCapacityWait();
    autoTagLog.info('Automatic tagging cancellation requested by user');
    win.webContents.send('status-update', {action: 'autotag', cancelRequested: true, canceledWait:Boolean(canceledWait)});
    return true;
  };

  if (confirmationDialogIsDisabled(confirmationPreference)) {
    return Promise.resolve(cancelAutoTag());
  }

  autoTagState.cancellationDecision = dialog.showMessageBox({
    type: 'warning',
    buttons: ['Continue', 'Cancel'],
    defaultId: 0,
    cancelId: 0,
    title: 'Cancel Auto-Tag',
    message: 'Cancel auto-tagging?',
    checkboxLabel: `Don't show this message again`,
    detail: autoTagState.capacityWaiting ?
      'Mynda will stop waiting and keep the results already saved. The pending video and remaining videos will be left unchanged and can be tagged again later.' : autoTagState.scope === 'selected' ?
      'Mynda will finish and save the video currently being processed, then stop. It may continue to say Canceling briefly while those saves finish synchronizing. Unprocessed selected videos will be left unchanged; select them and use Auto-Tag Selected again if you want to continue.' :
      'Mynda will finish and save the video currently being processed, then stop. It may continue to say Canceling briefly while those saves finish synchronizing. Videos that have not been processed will remain eligible for the next Auto-Tag run, which will pick up where it left off.'
  }).then(result => {
    if (result.response !== 1) {
      autoTagLog.info('Automatic tagging cancellation declined by user');
      return false;
    }

    if (result.checkboxChecked) {
      disableConfirmationDialog(confirmationPreference, autoTagLog);
    }
    return cancelAutoTag();
  }).catch(err => {
    autoTagLog.error('Could not confirm automatic tagging cancellation', {
      error: err && err.stack ? err.stack : String(err)
    });
    return false;
  }).finally(() => {
    autoTagState.cancellationDecision = null;
  });

  return autoTagState.cancellationDecision;
}

async function autoTag(options = {}) {
  return createAutoTagRunner({
    state: autoTagState, catalog: TaggingService, log: autoTagLog, requireFeature,
    getCandidates: getAutoTagCandidates, save: saveBatch,
    getLibraryVideos: () => library.media,
    notifyStatus: status => win.webContents.send('status-update', status),
    chooseSeries: chooseSeriesForSelectedBatch, preferences: library.settings.preferences,
    whenIdle: () => library.whenIdle()
  })(options);
}

function saveBatch(batch, options = {}) {
  const replacements = batch.map(video => _.cloneDeep(video));
  autoTagLog.debug('Saving automatic tagging batch', {
    videoCount: replacements.length
  });

  const patches = replacements.map((replacement,index) => ({
    id:replacement.id, replacement, baseline:options.baselines && options.baselines[index]
  }));
  return new Promise((resolve, reject) => {
    library.patchMediaBatch(patches, (err, result) => {
      if (err) {
        autoTagLog.error('Could not save automatic tagging batch', {
          videoCount: replacements.length,
          code: err.code,
          libraryPath: library.path,
          error: err.message || String(err)
        });
        reject(err);
        return;
      }
      autoTagLog.debug('Automatic tagging batch saved locally', {
        videoCount: replacements.length
      });
      resolve(result);
    }, {priority:'background',conflict:'skip',coherent:true,source:'autotag'});
  });
}

function requestWatchfolderScan() {
  if (shareService.isBusy()) {
    scanLog.info('Manual watchfolder scan request rejected while Share is active', {
      sharePhase: shareService.getState().phase
    });
    dialog.showMessageBox({
      type: 'info',
      buttons: ['OK'],
      defaultId: 0,
      title: 'Scan Watchfolders',
      message: 'A watchfolder scan cannot start while Share is working.',
      detail: 'Wait for Share to finish or cancel it, then try again.'
    }).catch(err => {
      backendLog.error('Could not display the Share/watchfolder-scan conflict dialog', {
        error: err && err.stack ? err.stack : String(err)
      });
    });
    return;
  }

  if (autoTagState.running || autoTagRequestPending) {
    scanLog.info('Manual watchfolder scan request rejected while Auto-Tag is active');
    dialog.showMessageBox({
      type: 'info',
      buttons: ['OK'],
      defaultId: 0,
      title: 'Scan Watchfolders',
      message: 'A watchfolder scan cannot start while Auto-Tag is running.',
      detail: 'Wait for Auto-Tag to finish or cancel it, then try again.'
    }).catch(err => {
      backendLog.error('Could not display the watchfolder-scan conflict dialog', {
        error: err && err.stack ? err.stack : String(err)
      });
    });
    return;
  }

  checkWatchFolders('manual');
}
