const electron = require('electron');
const { ipcMain, dialog } = require('electron');
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const {v4: uuidv4, v5: uuidv5} = require('uuid');
const crypto = require('crypto');
const Library = require("./Library.js");
const {
  subtitleExtensions,
  prepareSubtitleMatches,
  buildLegacySubtitleCounts,
  reconcileVideoSubtitles
} = require('./SubtitleMatcher.js');
const dl = require('./download');
const _ = require('lodash');
const pathToFFmpeg = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');
ffmpeg.setFfmpegPath(pathToFFmpeg);
const ffprobe = require('ffprobe');
let ffprobeStatic = {};
let ffprobeStaticLoadError = null;
try {
  ffprobeStatic = require('ffprobe-static');
} catch(err) {
  ffprobeStaticLoadError = err;
}
const Logger = require('./Logger.js');
const OmdbHelper = require('./OmdbHelper.js');
const MovieSearch = require('./MovieSearch.js');
const VideoExclusion = require('./VideoExclusion.js');
const VideoRuntimeVerifier = require('./VideoRuntimeVerifier.js');
//const { lsDevices } = require('fs-hard-drive');
const checkDiskSpace = require('check-disk-space').default
//const { default: installExtension, REACT_DEVELOPER_TOOLS } = require('electron-devtools-installer');

const appID = '7f1eec5b-a20d-400a-8876-cad667efe08f';
const MIN_SCAN_RESULT_STATUS_MS = 2000;
const videoExtensions = [
  '3g2', '3gp',  'amv',  'asf', 'avchd', 'avi', 'divx', 'drc',  'f4a',  'f4b', 'f4p',
  'f4v', 'flv',  'm2ts', 'm2v', 'm4p', 'm4v', 'mkv',  'mov',  'mp2', 'mp4',
  'mpe', 'mpeg', 'mpg',  'mpv', 'mts', 'mxf', 'nsv',  'ogg',  'ogv', 'qt',
  'rm',  'rmvb', 'roq',  'svi', 'ts', 'viv', 'webm', 'wmv', 'xvid', 'yuv'
]
let win;
let library = new Library;
const app = electron.app;
const BrowserWindow = electron.BrowserWindow;
const backendLog = Logger.child('Backend');
const scanLog = Logger.child('WatchfolderScan');
const metadataLog = Logger.child('Metadata');
const autoTagLog = Logger.child('AutoTag');
const exportLog = Logger.child('Export');
const videoExclusionLog = Logger.child('VideoExclusion');
let libFileTree; // where we store video and subtitle information we find in the watchfolders prior to adding the videos to the library
let libMulch = [];  //After libFileTree has been created and chewed up, this is the flattened version
let parsing = {}; // this is just to keep track of when we're done looking through all the watchfolders for videos
let unavailableWatchFolders = new Set(); // watchfolders whose scan failed; preserve their library entries for this scan
let subtitleReconciliationContext = {detectedOwners: new Map(), legacyCounts: new Map()};
let addVideoTimeout; // just a delay for adding the videos to the library once we're done parsing, to make sure it only happens once
let newIDs = [];
let ffMpegQueue = [];
let videoAddTimers = [];
let appStartTime = new Date();
let autoTagRunning = false;
let autoTagRequestPending = false;
let autoTagCancelRequested = false;
let autoTagCancellationDecision = null;
let autoTagScope = 'library';
const videoRuntimeVerifier = new VideoRuntimeVerifier({
  ffmpegPath: pathToFFmpeg
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

app.whenReady().then(start);

async function start() {
  Logger.initialize({
    app: app,
    ipcMain: ipcMain
  });
  backendLog.info('Mynda backend starting', {
    version: app.getVersion(),
    platform: process.platform,
    architecture: process.arch
  });
  if (ffprobeStaticLoadError) {
    metadataLog.debug('ffprobe-static is unavailable; FFmpeg metadata fallback will be used', {
      error: ffprobeStaticLoadError
    });
  }

  // Library construction happens before Electron is ready, when it is too
  // early to display a native dialog. Once ready, resolve any recorded load
  // problem before opening the renderer or starting a watchfolder scan; either
  // could otherwise save provisional data over the unreadable primary.
  if (!await resolveLibraryLoadIssue()) {
    return;
  }

  // Ensure an existing valid library gets its first restore point immediately,
  // even if this session never performs another save.
  library.maybeCreateAutomaticBackup();

  //Tutorial at https://www.electronjs.org/docs/tutorial/devtools-extension
  //You need to install React Dev tools in Chrome before this will work, also, double-check the location.
  try {
    let reactToolsLoc;
    if (process.platform === "win32") {
      reactToolsLoc = 'C:\\Users\\atela\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Extensions\\fmkadmapgofadopljbjfkapdkoienihi\\4.12.3_0';
    } else {
      reactToolsLoc = path.join('~/Library/Application Support/Google/Chrome/Default/Extensions/fmkadmapgofadopljbjfkapdkoienihi/4.12.3_0');
    }
    backendLog.debug('React developer-tools extension path selected', {
      platform: process.platform,
      extensionPath: reactToolsLoc
    });
    //await electron.session.defaultSession.loadExtension(reactToolsLoc)
  } catch (err) {
    backendLog.warn('Could not load React developer tools', {error: err});
  }

  // make the temp folder if it doesn't already exist
  const tempFolder = path.join((electron.app || electron.remote.app).getPath('userData'),'temp');
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
  checkWatchFolders();

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
  let folderPath = path.join((electron.app || electron.remote.app).getPath('userData'),'temp');

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
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    //frame: false,
    webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        enableRemoteModule: true
    }
  })

  win.webContents.openDevTools();
  await win.loadFile('src/index.html');
  // win.loadFile('src/player.html');
}

// get rid of any null values in media, inactive_media, watchfolders, etc.
function cleanLibrary() {
  return new Promise((resolve,reject) => {
    // library.media.map();
    resolve();
  });
}

function removeWatchfolder(path,cb) {
  // in case we're currently adding media, we need to delete the removed
  // watchfolder from libFileTree, otherwise videos may get re-added as they get removed
  libFileTree.folders = libFileTree.folders.filter(wf => wf.path !== path);
  scanLog.info('Removing watchfolder', {watchfolder: path});
  scanLog.debug('Removed watchfolder from the current scan tree', {
    watchfolder: path,
    remainingWatchfolders: libFileTree.folders.length
  });

  // remove videos
  removeWatchfolderVideosFromLibrary(path);

  // remove the watchfolder
  let index;
  library.settings.watchfolders.map((folder,i) => {
    if (folder && folder.path === path) {
      index = i;
    }
  });
  library.remove(`settings.watchfolders.${index}`,cb);
}



async function removeWatchfolderVideosFromLibrary(folder) {
  scanLog.info('Moving videos from removed watchfolder to inactive media', {
    watchfolder: folder
  });

  let vidIDs;
  // try {
  //   vidIDs = library.settings.watchfolders.filter(wf => wf && wf.path === folder)[0].videos;
  // } catch(err) {
  //   console.log(`Could not find video manifest for the watchfolder ${folder}: ${err}\nGetting list of videos from the library itself`);
    vidIDs = library.media.filter(v => v && new RegExp('^' + folder).test(v.filename)).map(v => v.id);
  // }

  let removedMedia = [];
  let keptMedia = library.media.filter(v => {
    if (!v) return false;
    if (!vidIDs.includes(v.id)) return true;
    removedMedia.push(_.cloneDeep(v));
    return false;
  });
  let inactiveMedia = [...library.inactive_media, ...removedMedia];

  library.replace('media',keptMedia);
  library.replace('inactive_media',inactiveMedia);
}

function removeVideo(video, index, fromInactive) {
  return new Promise((resolve,reject) => {
    let address;
    if (fromInactive) {
      scanLog.debug('Deleting video from inactive media', {
        filename: video.filename,
        id: video.id
      });
      address = 'inactive_media';
    } else {
      scanLog.debug('Moving video from active to inactive media', {
        filename: video.filename,
        id: video.id
      });
      address = 'media';
    }

    // if we weren't given an index, find it
    if (typeof index === "undefined") {
      index = indexOfVideoInLibrary(video.id,fromInactive); // if the second parameter is true, indexOfVideoInLibrary checks inactive_media instead of media
    }

    // remove from library.media or library.inactive_media
    library.remove(`${address}.${index}`, (err) => {
      if (err) {
        reject(`Error removing ${video.title} (${video.filename}); given bad index (index === ${index}) or could not find video in library.${address}:\n${err}`);
        return;
      }

      if (!fromInactive) {
        // add the video to library.inactive_media
        library.add('inactive_media.push',video, (err) => {
          if (err) {
            reject(`Error: could not add ${video.filename} to inactive_media: ${err}`);
            return;
          } else {
            resolve();
          }
        });


        // // remove video id from its watchfolder's list of video ids
        // library.settings.watchfolders.map((wf, i) => {
        //   if (!wf) return;
        //
        //   if (new RegExp('^' + wf.path).test(video.filename)) {
        //     console.log(`${video.filename} is part of the watchfolder ${wf.path}; removing from the watchfolder's list of id's`);
        //     wf.videos = wf.videos.filter(id => id !== video.id);
        //     library.replace(`settings.watchfolders.${i}`, library.settings.watchfolders[i], (err) => {
        //       if (err) {
        //         reject(`Error: could not update watchfolder manifest: ${err}`);
        //       } else {
        //         resolve();
        //       }
        //     });
        //   }
        // });
      } else {
        resolve();
      }
    });
  });
}
function deleteFromInactive(video, index) {
  return removeVideo(video, index, true);
}

// Promise wrapper for Library.replace(), so callers can wait until a queued
// replacement has actually been applied to the local library object.
function replaceLibrary(address, replacement) {
  return new Promise((resolve, reject) => {
    library.replace(address, replacement, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
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

function checkWatchFolders() {
  // These values describe one scan only. Leaving them populated causes files
  // from earlier scans to be treated as members of the current batch.
  parsing = {};
  libMulch = [];
  newIDs = [];
  unavailableWatchFolders = new Set();
  subtitleReconciliationContext = {detectedOwners: new Map(), legacyCounts: new Map()};
  videoExclusion.reset();

  win.webContents.send('status-update', {action: 'check'});
  // reset libFileTree
  libFileTree = {name:'root', folders:[]};

  // Search watchfolders for new files and add any new videos to the library
  numNewVids = 0; // reset the number of new videos found
  let folders = library.settings.watchfolders;
  scanLog.info('Watchfolder scan started', {
    watchfolderCount: folders.filter(Boolean).length
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
  }
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
        //If it's a hidden file, as evidenced by a filename starting with a dot
        //Then skip it
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
  for (let h=library.media.length-1; h>=0; h--) {
    let video = library.media[h];
    if (!video) {
      // library.remove(`media.${h}`);
      continue;
    }

    let filename = video.filename;
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
        if (filename.includes(watchfolder.path)) {
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
              updateVideoSubs(video, libTreeLoc.videos[k].subtitles);

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
        break;
      case 'duplicate-batch':
        candidateOutcomes.batchDuplicates++;
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

  let combinedMedia = library.media.concat(newMedia);
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
    replaceLibrary('media', combinedMedia),
    minimumResultStatus
  ]);

  // tell the user how many videos we added
  win.webContents.send('videos_added',newMedia.length);

  // now let's try and get some metadata.
  // eventually we want to do all this after the above media replacement library call
  // has finished; currently we can only accomplish that with a callback, which doesn't
  // allow us to use await with the getMetadata() call below; the ideal solution is to
  // modify Library.js to work with promises, but in the meantime, a workable solution is
  // to use the combinedMedia object we created above to base our metadata search on,
  // so that even if the library call hasn't finished, we're not using an outdated media object here
  let metaStart = new Date();
  let unchecked = combinedMedia.filter(v =>
    v !== null && !v.metadata.checked && !isInUnavailableWatchFolder(v.filename)
  ); // all available videos in the library that haven't already been checked for metadata
  let numTotal = unchecked.length;
  let numChecked = 0;
  let numSuccessful = 0;

  // we have to store the metadata in an object (metadataToAdd) instead of just adding it directly to each video as we go,
  // because getting the metadata takes a while and we don't want to overwrite any other edits the user may make
  // to the videos during the process; then after we've got all the data, we'll add them all to their
  // respective videos in the library and update it at once, which should happen quickly enough not to
  // disturb anything the user is doing
  let metadataToAdd = {};

  // loop through all the unchecked videos and check them,
  // storing the metadata in the metadataToAdd object with the video's id as the key
  for (let v of unchecked) {
    if (v !== null && !v.metadata.checked) {
      numChecked++;
      win.webContents.send('status-update', {action: 'metadata', numCurrent: numChecked, numTotal: numTotal});
      let metadata = await getMetadata(v, {
        purpose: 'populate technical metadata for unchecked library video'
      });
      if (metadata.hasOwnProperty('checked') && Object.keys(metadata).length > 1) numSuccessful++; // count how many videos we actually got some data for, just to notify the user
      metadataToAdd[v.id] = metadata;
    }
  }

  // now update the actual videos with their metadata. The media replacement
  // above has been awaited, so library.media includes all newly added or
  // rescued videos before this snapshot is made.
  let updatedMedia = library.media.map(v => {
    if (v && metadataToAdd[v.id]) {
      v.metadata = metadataToAdd[v.id];
    }
    return v;
  });

  // save to library
  await replaceLibrary('media', updatedMedia);
  win.webContents.send('status-update', {action: 'metadata_save', numTotal: numSuccessful});
  backendLog.info('Video metadata scan finished', {
    videosChecked: numChecked,
    videosWithMetadata: numSuccessful,
    elapsedMs: new Date()-metaStart
  });

  setTimeout(() => {
    win.webContents.send('status-update', {action: ''});
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
  // Now that we've checked whether this video id is in our current batch, put it there.
  newIDs.push(id);
  let vidObj;

  switch(situation) {
    //########### VIDEO IS ALREADY IN LIBRARY ###########//

    // if the video is already in the library, update the subtitles
    // and update the video in the library, check to make sure the id
    // is in the watchfolder manifest, and then we're done
    case 1:
      let vidIndex = indexOfVideoInLibrary(id);
      let libraryVideo = library.media[vidIndex];
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
      updateVideoSubs(libraryVideo, duplicateDetectedSubtitles);
      return {disposition: 'duplicate-active'};

    case 2:
      // If we have another new video with the same id, just skip it for now.
      //Long term we want to mention to user and figure out which to use.
      scanLog.debug('Rejected duplicate within the current watchfolder scan', {
        filename: file,
        id: id
      });
      return {disposition: 'duplicate-batch'};

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
          vidObj.filename = file; // this is important because the file may have been renamed

          // === DO NOT UPDATE THE KIND BASED ON WATCHFOLDER DEFAULT KIND ===
          // try {
          //   // update the video's kind based on the watchfolder's default kind;
          //   // in case the user has changed the default kind, we want to update it when re-adding the video
          //   // vidObj.kind = video.kind;
          // } catch(err) {
          //   console.log('Could not update kind based on watchfolder default kind: ' + err);
          // }

          await deleteFromInactive(vidObj, inactiveVidIndex);

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
        updateVideoSubs(vidObj, video.subtitles);
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
  let returnObj = {};
  returnObj.checked = true;
  metadataLog.debug('Video metadata retrieval started', logContext);
  try {
    // vidObj.metadata = await getVideoMetadata(file);
    if (typeof ffprobeStatic.path === "undefined") {
      // then ffprobeStatic did not install ffprobe
      throw new Error('ffprobe could not be found (not installed by ffprobe-static)');
    }

    let data = await ffprobe(file, { path: ffprobeStatic.path });

    //console.log(data);

    for (const stream of data.streams) {
      try {
        if (stream.codec_type === 'video') {
          returnObj.codec = stream.codec_name;
          returnObj.duration = Number(stream.duration);
          returnObj.width = stream.width;
          returnObj.height = stream.height;
          returnObj.aspect_ratio = stream.display_aspect_ratio;
          let f = stream.avg_frame_rate.split('/');
          returnObj.framerate = Math.round(Number(f[0]) / Number(f[1]) * 100) / 100;
        }
        if (stream.codec_type === 'audio') {
          returnObj.audio_codec = stream.codec_name;
          returnObj.audio_layout = stream.channel_layout;
          returnObj.audio_channels = stream.channels;
        }
        // if we didn't get a duration already,
        // grab one from whatever stream has one
        // (e.g. mkv files don't seem to store duration
        // in the video or audio streams, but may have it in a subtitle stream)
        // if (!vidObj.metadata.duration) {
        //   console.log(`Taking duration (${stream.duration}) from ${stream.codec_type} stream`);
        //   vidObj.metadata.duration = Number(stream.duration);
        // }
      } catch(err) {
        metadataLog.debug('Could not store one ffprobe metadata stream', {
          ...logContext,
          error: err
        });
      }
    }
  } catch(err) {
    // ffprobe-static is optional in this build and FFmpeg is the normal
    // fallback on installations where its bundled binary is unavailable.
    metadataLog.debug('ffprobe metadata retrieval failed; trying FFmpeg fallback', {
      ...logContext,
      error: err
    });
  }

  // some files (.mkv) will give us metadata, but do not store the duration for some reason;
  // in this case, we analyze the file with ffmpeg to obtain the duration
  if (!returnObj.duration) { // value could be either 0 (in case of error) or undefined, if we didn't get a duration
    try {
      let ffmpegData = await getMetadataFromFFmpeg(file, video.id, {purpose: purpose});
      metadataLog.debug('FFmpeg metadata retrieved', {
        ...logContext,
        metadata: ffmpegData
      });
      returnObj = {...ffmpegData, ...returnObj};
    } catch(err) {
      metadataLog.warn('Could not retrieve video metadata with FFmpeg', {
        ...logContext,
        error: err
      });
    }
  }


  //Replace the library entry with our new version.
  //Even if everything failed, we've set metadata.checked to true, so we don't
  //waste time trying again.
  //library.replace(`media.id=${video.id}`, video);
  return returnObj;
}


// create a uuid based on a hash of the video file; this will be the video's id in the library
async function createVideoID(filepath) {
  return new Promise((resolve,reject) => {
    let baseStats;
    try {
      baseStats = fs.lstatSync(filepath)
    } catch (e) {
      reject(`Error when trying to create id for ${filepath}, could not read path to determine if it was a directory or a file. Not adding video.\n${err}`);
    }
    let hashPath = filepath;

    // If the path points to a directory, we're dealing with a DVD rip
    // Find the appropriate file and hash it
    if(baseStats.isDirectory()) {
      try {
        if (fs.existsSync(path.join(filepath, 'VIDEO_TS', 'VIDEO_TS.IFO'))) {
          hashPath = path.join(filepath, 'VIDEO_TS', 'VIDEO_TS.IFO');
        } else if (fs.existsSync(path.join(filepath, 'VIDEO_TS', 'VTS_01_1.VOB'))) {
          hashPath = path.join(filepath, 'VIDEO_TS', 'VTS_01_1.VOB');
        } else if (fs.existsSync(path.join(filepath, 'VTS_01_1.VOB'))) {
          hashPath = path.join(filepath, 'VTS_01_1.VOB');
        } else {
          let files = getFilesRecursive(filepath);
          let biggestSize = 0;
          let biggestFile;
          for (let file of files) {
            let size = 0;
            try {
              size = fs.statSync(file).size;
            } catch(err) {
              scanLog.warn('Could not read a DVD file while selecting content for hashing', {
                filename: file,
                error: err
              });
            }
            if (size > biggestSize) {
              biggestSize = size;
              biggestFile = file;
            }
          }
          if (biggestFile) {
            hashPath = biggestFile;
          } else {
            reject(`DVD folder ${filepath} does not have the correct file to hash.`)
          }
        }
      } catch (e) {
        reject(`Error when trying to create id for DVD rip ${filepath}.\n${e}`);
      }
    }

    fs.createReadStream(hashPath, { end: 65535, encoding: 'hex'}).
      pipe(crypto.createHash('sha1').setEncoding('hex')).
      on('finish', function () {
        filehash = this.read();
        // console.log(`Hash for ${filepath.split('/').pop()} is ${filehash}`) // the hash
        const id = uuidv5(filehash, appID);

        resolve(id);
        // callback(id);
      }).
      on('error', (err) => {
        reject(`Error (from fs module) when creating/finding id for ${filepath}\nNot adding video\n${err}`);
      })
  });
}

function getFilesRecursive(folder) {
  scanLog.debug('Scanning DVD directory for hashable content', {directory: folder});
  let files = [];
  let contents = [];
  try {
    contents = fs.readdirSync(folder);
  } catch(err) {
    scanLog.warn('Could not read DVD directory', {
      directory: folder,
      error: err
    });
  }
  for (let content of contents) {
    let fullPath = path.join(folder, content);
    try {
      if (fs.lstatSync(fullPath).isDirectory()) {
        files = [...files,...getFilesRecursive(fullPath)];
      } else {
        files.push(fullPath);
      }
    } catch(err) {
      scanLog.warn('Could not inspect DVD directory entry', {
        filename: fullPath,
        error: err
      });
    }
  }
  return files;
}


function updateVideoSubs(video, detectedSubtitles) {
  if (reconcileVideoSubtitles(video, detectedSubtitles || [], subtitleReconciliationContext)) {
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
  return new Promise((resolve, reject) => {
    let purpose = metadataPurpose(options);
    let logContext = {filename: filepath, purpose: purpose};
    try {
      metadataLog.debug('Starting FFmpeg metadata fallback', {
        ...logContext,
        id: id
      });

      let tempFile = `temp-${uuidv4()}.mkv`;

      // var outStream = fs.createWriteStream('output.mkv');

      let cmd = ffmpeg(filepath, {
        // timeout:600
      }).on('codecData', (data) => {
        cmd.kill();

        metadataLog.debug('FFmpeg codec data received', {
          ...logContext,
          codecData: data
        });
        let metadata = {};

        // get duration
        if (data.duration) {
          let timeArr = data.duration.split(':');
          let seconds = 0;
          if (timeArr.length >= 3) {
            seconds += timeArr[0] * 60 * 60;
            seconds += timeArr[1] * 60;
            seconds += timeArr[2] * 1;
          } else if (!isNaN(Number(data.duration))) {
            seconds = Number(data.duration);
          }
          metadata.duration = seconds;
        }

        // get video codec
        if (data.video) {
          metadata.codec = data.video;
        }

        // get other video details
        if (data.video_details && Array.isArray(data.video_details)) {
          data.video_details.map(detail => {
            // width and height
            let match = detail.match(/\b(\d{2,5})x(\d{2,5})\b/);
            if (match && match.length >= 3) {
              metadata.width = match[1];
              metadata.height = match[2];
              return;
            }
            // framerate
            match = detail.match(/^(\d+\.?\d*)\sfps$/);
            if (match && match.length >= 2) {
              metadata.framerate = Number(match[1]);
              return;
            }
            // aspect ratio
            match = detail.match(/DAR\s+(\d+:\d+)/);
            if (match && match.length >= 2) {
              metadata.aspect_ratio = match[1];
              return;
            }

          });
        }

        // get audio codec
        if (data.audio) {
          metadata.audio_codec = data.audio;
        }

        // get other audio details
        if (data.audio_details && Array.isArray(data.audio_details)) {
          // audio layout and audio channels
          data.audio_details.map(detail => {
            let poss_values = {
              'mono' : 1,
              'stereo' : 2,
              '2.0' : 2,
              '2.1' : 3,
              '5.1' : 6,
              '6.1' : 7,
              '7.1' : 8
            }
            if (Object.keys(poss_values).includes(detail)) {
              metadata.audio_layout = detail;
              metadata.audio_channels = poss_values[detail];
            }
          });
        }


        resolve(metadata);

      }).on('end', (stdout, stderr) => {
        //console.log('==== FFMPEG end ====');
        //console.log(stdout);
      }).on('error', (err) => {
        metadataLog.debug('FFmpeg metadata fallback process failed', {
          ...logContext,
          error: err
        });
        reject(err.message);
        fs.unlink(tempFile, () => {
          //console.log('deleted temp file used by ffmpeg');
        });
      }).save(tempFile);

      // .save('~/Documents/Coding/Mynda/sandbox/Mynda Example Watchfolders/temp_output.mkv');

      // let stream = cmd.pipe();
      // stream.on('data', (chunk) => {
      //   console.log('ffmpeg just wrote ' + chunk.length + ' bytes');
      // });

    } catch(err) {
      metadataLog.debug('Could not start FFmpeg metadata fallback', {
        ...logContext,
        error: err
      });
      reject(err);
    }
  });
}

function titleCaseDetectedTitle(title) {
  // Preserve intentional capitalization in mixed-case titles and acronyms.
  // The filenames that need correction are the ones whose letters are all
  // lowercase; exact-basename fallbacks never reach this function.
  if (!/[a-z]/.test(title) || /[A-Z]/.test(title)) {
    return title;
  }

  const minorWords = new Set([
    'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'into',
    'nor', 'of', 'on', 'onto', 'or', 'over', 'per', 'so', 'the', 'to', 'up',
    'via', 'vs', 'with', 'yet'
  ]);
  const uppercaseWords = new Set(['ac3', 'dvd', 'er', 'fs', 'sfm', 'ws']);
  const romanNumerals = /^(?:i|ii|iii|iv|v|vi|vii|viii|ix|x|xi|xii|xiii|xiv|xv|xvi|xvii|xviii|xix|xx)$/;
  const wordRegex = /[a-z][a-z0-9]*(?:['’][a-z0-9]+)*/g;
  const words = title.match(wordRegex) || [];
  let wordIndex = 0;

  return title.replace(wordRegex, (word, offset) => {
    const isFirst = wordIndex === 0;
    const isLast = wordIndex === words.length-1;
    wordIndex++;

    const previousCharacter = title[offset-1];
    const nextCharacter = title[offset+word.length];
    const isDottedInitial = word.length === 1 &&
      (previousCharacter === '.' || nextCharacter === '.');
    const beginsSubtitle = /(?:[:–—]|(?:^|\s)-)\s*$/.test(title.slice(0, offset));

    if (isDottedInitial || romanNumerals.test(word) || uppercaseWords.has(word)) {
      return word.toUpperCase();
    }
    if (!isFirst && !isLast && !beginsSubtitle && minorWords.has(word)) {
      return word;
    }
    return word.charAt(0).toUpperCase() + word.slice(1);
  });
}

function findEpisodeTitle(fileBasename, extrasDetected) {
  const fallback = fileBasename;
  const titleMarkers = [
    // S02E03, including multi-part forms such as S02E03-E04,
    // S02E03&E04, S02E03&04, or S02E03X02.
    /(?:^|[^a-z0-9])s\d{1,3}[. _-]*e[. _-]*\d{1,3}(?:(?:[. _-]*e[. _-]*\d{1,3})|(?:&[. _-]*e?[. _-]*\d{1,3})|(?:x\d{1,2}))*(?!\d)/i,
    // Season 2 Episode 3.
    /season[. _-]*\d{1,3}[. _-]*(?:episode|ep|e)[. _-]*\d{1,3}(?:-\d{1,3})?(?!\d)/i,
    // 2x03.
    /(?:^|[^\d])\d{1,2}[ _-]*x[ _-]*\d{1,2}(?:-\d{1,2})?(?!\d)/i,
    // 02.03 at the beginning, but not a title or date such as 11.22.63.
    /^\d{1,2}\.\d{1,3}(?![.\d])/,
    // A compact code such as 203 when followed by a title separator.
    /(?:^|-\s*)[1-9]\d{2}(?=\s*-\s)/,
    // Episode 3, Ep03, or E03.
    /(?:^|[^a-z0-9])(?:episode|ep|e)[. _-]*\d{1,3}(?:-\d{1,3})?(?!\d)/i
  ];

  if (extrasDetected) {
    // Strong extras formats found in the real TV folder inventory.
    titleMarkers.push(
      /(?:^|[^a-z0-9])extras?[. _-]+season[. _-]*\d{1,3}(?!\d)/i,
      /season[. _-]*\d{1,3}[. _-]+extras?[. _-]*\d{1,3}(?!\d)/i
    );
  }

  // A leading episode number followed by a clear title separator.
  titleMarkers.push(/^\d{1,4}(?!\d)(?:\s*[-–—]\s+|[._](?!\d))/);

  let marker = null;
  for (let regex of titleMarkers) {
    marker = fileBasename.match(regex);
    if (marker) {
      break;
    }
  }
  if (!marker) {
    return fallback;
  }

  let title = fileBasename.slice(marker.index + marker[0].length);
  title = title.replace(/^[\s_\-\]\)–—]+/, '');
  // A single dot is commonly a filename separator. Preserve an ellipsis or a
  // leading decimal that may genuinely be part of the title.
  if (/^\.(?=[a-z])/i.test(title)) {
    title = title.slice(1).replace(/^\s+/, '');
  }

  const hasReleaseDetails = value => {
    return /(?:^|[\s._-])(?:\d{3,4}[pi]|\d{3,4}x\d{3,4}|web[ ._-]?(?:dl|rip)|blu[ ._-]?ray|(?:bd|br|dvd)[ ._-]?rip|hdtv|remux|repack|proper|[hx][ ._-]?26[45]|hevc|xvid|10[ ._-]?bit|aac|ac3|eac3|ddp)(?![a-z0-9])/i.test(value);
  };

  // Remove trailing bracketed groups only when they contain unmistakable
  // technical details. Keep title details such as "(1)" or "(1948)".
  let previousTitle;
  do {
    previousTitle = title;
    title = title.replace(/\s*(?:\(([^()]*)\)|\[([^\[\]]*)\])\s*$/, (whole, parenContents, bracketContents) => {
      return hasReleaseDetails(parenContents || bracketContents) ? '' : whole;
    });
  } while (title !== previousTitle);

  // This exact suffix occurs in the 11.22.63 release and is clearly not part
  // of any episode title.
  title = title.replace(/\s+-\s+mini[ -]?series\b.*$/i, '');

  // Stop at the first unbracketed technical release marker. Deliberately do
  // not strip generic years, words, or parenthetical text.
  let releaseMatch = title.match(/(?:^|[\s._\[(,\-])(?:\d{3,4}[pi]|\d{3,4}x\d{3,4}|web[ ._-]?(?:dl|rip)|blu[ ._-]?ray|(?:bd|br|dvd)[ ._-]?rip|hdtv|remux|repack|proper|[hx][ ._-]?26[45]|hevc|xvid|10[ ._-]?bit)(?![a-z0-9])/i);
  if (releaseMatch) {
    title = title.slice(0, releaseMatch.index);
  }

  title = title.replace(/_/g, ' ').trim();

  // Release-formatted titles often use dots as spaces. Only replace them when
  // the candidate contains no real spaces, while preserving ellipses, dotted
  // initials such as M.I.A., and dotted-number titles such as 11.22.63.
  const isDottedInitialism = /^(?:[a-z]\.){2,}(?:[a-z]\.?)?$/i.test(title);
  const isDottedNumber = /^\d+(?:\.\d+){2,}$/.test(title);
  if (!/\s/.test(title) && title.includes('.') && !isDottedInitialism && !isDottedNumber) {
    let protectedDots = [];
    title = title.replace(/\.{2,}/g, dots => {
      protectedDots.push(dots);
      return `\u0000${protectedDots.length-1}\u0000`;
    });
    title = title.replace(/\./g, ' ');
    title = title.replace(/\u0000(\d+)\u0000/g, (whole, index) => protectedDots[Number(index)]);
  }

  title = title.replace(/\s{2,}/g, ' ').replace(/^[\s_\-\]\)–—]+|[\s_\-–—]+$/g, '');

  // If the marker had no title after it, or only a short release label was
  // left, retain the complete basename instead of guessing.
  if (!/[a-z0-9]/i.test(title) || /^(?:fs|dsr|ws|multi|web|repack|proper)$/i.test(title)) {
    return fallback;
  }
  return titleCaseDetectedTitle(title);
}

// Find the most specific watchfolder containing a video's current path. The
// longest match matters when users configure nested watchfolders. path.relative
// avoids false positives such as treating "/Movies 2" as part of "/Movies".
function findContainingWatchfolder(filename, watchfolders = library.settings.watchfolders) {
  if (typeof filename !== 'string' || filename === '' || !Array.isArray(watchfolders)) {
    return null;
  }

  return watchfolders
    .filter(watchfolder => {
      if (!watchfolder || typeof watchfolder.path !== 'string' || watchfolder.path === '') {
        return false;
      }
      const relativePath = path.relative(path.resolve(watchfolder.path), path.resolve(filename));
      return relativePath === '' ||
        (relativePath !== '..' && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath));
    })
    .sort((a, b) => path.resolve(b.path).length - path.resolve(a.path).length)[0] || null;
}

// Build, but do not save, the changes for the editor's "Reset from Filename"
// action. This deliberately starts identification from the file path instead
// of the video's current title/series values, so a bad OMDb match cannot feed
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

  // OMDb adds these catalog fields. Clear them so the next manual search or
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

function findSeasonEpisode(video, fileBasename) {
  const normalizeNumber = value => value.replace(/^0+(?=\d)/, '');
  let seRegexes = [
    // S02E03, S02-E03, S02 E03, etc.
    /(?:^|[^a-z0-9])s(\d{1,3})[. _-]*e[. _-]*(\d{1,3})(?!\d)/i,
    // Season 2 Episode 3, Season_2_Ep_3, etc.
    /season[. _-]*(\d{1,3})[. _-]*(?:episode|ep|e)[. _-]*(\d{1,3})(?!\d)/i,
    // 2x03, 2 X 03, etc. Limit both numbers to two digits so codecs such as x264 are ignored.
    /(?:^|[^\d])(\d{1,2})[ _-]*x[ _-]*(\d{1,2})(?!\d)/i,
    // 02.03 at the beginning of a filename, but not a date such as 11.22.63.
    /^(\d{1,2})\.(\d{1,3})(?![.\d])/,
    // 203 surrounded by separators means season 2, episode 03.
    /(?:^|-\s*)([1-9])(\d{2})(?=\s*-\s)/
  ];
  let eRegexes = [/(?:^|[^a-z0-9])(?:episode|ep|e)[. _-]*(\d{1,3})(?!\d)/i];
  let seasonRegexes = [
    /season[. _-]*(\d{1,3})(?!\d)/i,
    /(?:^|[^a-z0-9])s(\d{1,3})(?!\d)/i,
    /(\d{1,3})(?:st|nd|rd|th)[. _-]*season/i
  ];
  let result = {};

  function findSeasonNumber(value) {
    // A range describes several seasons, so it cannot provide one season number.
    if (/season[. _-]*\d{1,3}\s*(?:-\s*|to\s+)\d{1,3}/i.test(value) ||
        /(?:^|[^a-z0-9])s\d{1,3}\s*-\s*s?\d{1,3}(?!\d)/i.test(value)) {
      return null;
    }
    for (let regex of seasonRegexes) {
      let match = value.match(regex);
      if (match) {
        return normalizeNumber(match[1]);
      }
    }
    return null;
  }

  function cleanSeriesName(folderName) {
    let name = folderName.trim();
    const originalName = name;
    let releaseDetailsRemoved = false;

    // A release folder such as "11.22.63 - Stephen King 8 Part Mini Series..."
    // normally puts the actual title before the first separator.
    let miniSeriesMatch = name.match(/^(.+?)\s+-\s+.*\b(?:mini[ -]?series|miniseries)\b.*$/i);
    if (miniSeriesMatch) {
      name = miniSeriesMatch[1];
      releaseDetailsRemoved = true;
    }

    // Remove only explicit release markers. Avoid generic removal of years,
    // resolutions, or punctuation that could legitimately be part of a title.
    let releaseSuffixes = [
      /[\s._-]*(?:\(|\[)?complete(?:[ ._-]+original)?(?:[ ._-]+tv)?[ ._-]+series\b.*$/i,
      /[\s._-]+(?:complete[\s._-]+)?seasons?[\s._-]*\d{1,3}(?!\d).*$/i,
      /[\s._-]+s\d{1,3}(?!\d)(?:\s*-\s*s?\d{1,3})?\b.*$/i,
      /\s+BD\s*\(\d{3,4}x\d{3,4}\).*$/i
    ];
    for (let regex of releaseSuffixes) {
      let cleanedName = name.replace(regex, '');
      if (cleanedName !== name) {
        name = cleanedName;
        releaseDetailsRemoved = true;
      }
    }

    // Remove release-year ranges. A single trailing year is removed only when
    // another explicit release marker has already established that it is metadata.
    name = name.replace(/\s*[\[(](?:19|20)\d{2}\s*-\s*(?:19|20)\d{2}[\])]\s*$/, '');
    name = name.replace(/[\s._-]+(?:19|20)\d{2}\s*-\s*(?:19|20)\d{2}\s*$/, '');
    if (releaseDetailsRemoved) {
      name = name.replace(/[\s._-]+(?:19|20)\d{2}\s*$/, '');
    }

    // Dot/underscore replacement is limited to clearly release-formatted names,
    // so a title such as "11.22.63" keeps its punctuation.
    if (/\.(?:season|s\d{1,3}|complete)(?:\.|$)/i.test(originalName)) {
      name = name.replace(/[._]+/g, ' ');
    }

    name = name.replace(/^[\s._-]+|[\s._-]+$/g, '').replace(/\s{2,}/g, ' ');
    return name || folderName.trim();
  }

  function normalizeCategoryName(value) {
    return value.toLowerCase().replace(/[._-]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  }

  function isExtrasFolderName(folderName) {
    const name = normalizeCategoryName(folderName);

    // Mixed release folders such as "Season 1 + Extras" are only a weak
    // signal. A strong SxxEyy-style filename below will still take priority.
    if (/(?:\+|&|\band\b)\s*extras?\b/.test(name)) {
      return true;
    }

    // Match category-like folder names and suffixes, but do not treat a
    // generic occurrence of words such as "special" as an extras marker.
    return /(?:^| )(?:extras?|featurettes?|special features?|specials|bonus(?: features?| material| content| disc)?|deleted scenes?|behind the scenes|making of|bloopers?|gag reels?|supplements?|interviews?|trailers?)$/.test(name);
  }

  function isExtrasFilename(filename) {
    const name = normalizeCategoryName(filename);

    // Filename detection is intentionally narrower than folder detection.
    // These phrases are strong evidence for bonus material; ordinary uses of
    // "special", "interview", or "trailer" are left alone.
    return /(?:^| )(?:featurettes?|special features?|bonus(?: features?| material| content)|deleted scenes?|behind the scenes|making of|bloopers?|gag reels?|supplements?)(?: |$)/.test(name) ||
      /^extras?(?: \d{1,3})?(?: |$)/.test(name) ||
      /(?:^| )dvd extras?(?: |$)/.test(name);
  }

  let extrasDetected = false;

  if (Array.isArray(video.folderParts) && video.folderParts.length > 0) {
    const folders = video.folderParts;
    // The first folder beneath a show watchfolder is its most reliable series
    // grouping, even when files are directly inside it or nested under Extras.
    result.series = cleanSeriesName(folders[0]);

    // The first folder is the series name, so only examine folders beneath it
    // for an extras category. This avoids misclassifying a show actually named
    // "Extras" or "Specials".
    extrasDetected = folders.slice(1).some(isExtrasFolderName);

    // Use the closest folder that describes one specific season. This also
    // works when the video is inside an Extras or Episodes subfolder.
    for (let i=folders.length-1; i>=0; i--) {
      let folderSeason = findSeasonNumber(folders[i]);
      if (folderSeason !== null) {
        result.season = folderSeason;
        break;
      }
    }
  }
  if (!extrasDetected) {
    extrasDetected = isExtrasFilename(fileBasename);
  }
  result.title = findEpisodeTitle(fileBasename, extrasDetected);

  // Explicit filename numbering is stronger evidence than an extras folder.
  // This preserves real season-zero entries such as Specials/S00E01.
  for (let i=0; i<seRegexes.length; i++) {
    let regex  = seRegexes[i];
    let match = fileBasename.match(regex);
    if (match) {
      result.season = normalizeNumber(match[1]);
      result.episode = normalizeNumber(match[2]);
      //console.log(`seasonEpisode result for ${fileBasename} is ${JSON.stringify(result)}`);
      return result;
    }
  }

  // When no explicit season/episode pair was found, an extras category takes
  // priority over a numbered season inherited from a parent release folder.
  if (extrasDetected) {
    result.season = 'extras';
  }

  // This primarily covers DVD-rip folders whose own name contains the season.
  if (!result.season) {
    let basenameSeason = findSeasonNumber(fileBasename);
    if (basenameSeason !== null) {
      result.season = basenameSeason;
    }
  }

  for (let j=0; j<eRegexes.length; j++) {
    let regex  = eRegexes[j];
    let match = fileBasename.match(regex);
    if (match) {
      result.episode = normalizeNumber(match[1]);
      return result;
    }
  }

  // A number at the beginning followed by a title separator is an episode
  // number. If it is a compact season/episode code (201, 801, etc.), use the
  // season found in the folder to separate the two numbers.
  let leadingMatch = fileBasename.match(/^(\d{1,4})(?!\d)(?:\s*[-–—]\s+|[._](?!\d))/);
  if (leadingMatch) {
    let leadingNumber = leadingMatch[1];
    let episode = leadingNumber;
    if (result.season && leadingNumber.startsWith(result.season) &&
        leadingNumber.length-result.season.length === 2) {
      episode = leadingNumber.slice(result.season.length);
    } else if (leadingNumber.length > 3) {
      return result;
    }
    result.episode = normalizeNumber(episode);
  }
  //console.log(`seasonEpisode result for ${fileBasename} is ${JSON.stringify(result)}`);
  return result;
}

function downloadFile(url, destination) {
  return new Promise(function(resolve, reject) {
    let response = {success:false, message:''};
    // event.sender.send('cancel-download', dl.canceller, "hi");
    dl.download(url,destination, (args) => {
      try {
        // if successful, we'll receive an object with the path at "path"
        if (args && Object.prototype.hasOwnProperty.call(args, 'path')) {
          response.success = true;
          response.message = args.path;
          resolve(response);
          // console.log("successfully downloaded file");
        } else {
          // console.log(JSON.stringify(args));
          response.success = false;
          response.message = args && args.message ? args.message : args;
          response.status = args && args.status;
          response.statusText = args && args.statusText;
          reject(response);
        }
      } catch(error) {
        response.success = false;
        response.message = error;
        reject(response);
        // console.log(error);
      }
    });
  });
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
// OMDb's season/episode endpoint accepts only whole-number coordinates. Keep
// those videos valid in the library while excluding them from coordinate-based
// Auto-Tag requests that could otherwise target the wrong ordinary episode.
function hasUsableOMDbShowEpisodeFields(video) {
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

function prepareSuccessfulAutoTagResult(video) {
  // A successful video has already had its automatic attempt even when the
  // user prefers to leave it in New for manual review.
  video.autotag_tried = true;
  if (library.settings.preferences.remove_autotagged_from_new) {
    video.new = false;
  }
  return video;
}

async function requestAutoTag() {
  if (autoTagRunning || autoTagRequestPending) {
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
      detail: "Mynda will search OMDb for every video in the 'New' playlist (unless it has already been auto-tagged). Successful matches will overwrite most existing metadata. This may take a very long time when many videos are eligible."
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
  if (autoTagRunning || autoTagRequestPending) {
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
    // A just-completed editor Save may still be mirroring to the main process.
    // Wait for that transaction before taking the authoritative selected-video
    // snapshot used by the confirmation and tagging run.
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
      video.kind === 'show' && !hasUsableOMDbShowEpisodeFields(video)
    ).length;
    const keepInNew = !library.settings.preferences.remove_autotagged_from_new;
    let detail =
      `Only these ${selected.length} selected videos will be processed, even if they are not in New or have been tried before. ` +
      'Successful matches will overwrite most existing catalog metadata; unmatched or ambiguous videos will keep their existing visible metadata, although Mynda will record the attempt. ' +
      `Successfully tagged videos will ${keepInNew ? 'remain in' : 'be removed from'} New.`;

    if (seriesBatch) {
      detail += `\n\nAll selected videos are episodes of “${seriesBatch.series}”. Before processing any episode, Mynda will settle on one parent series ID for the whole batch. If OMDb finds more than one matching series, Mynda will ask you once; if the series cannot be resolved, no selected videos will be changed.`;
    } else {
      detail += '\n\nBecause this is not a single-series show batch, ambiguous matches will be skipped without another prompt.';
    }
    if (incompleteShows > 0) {
      detail += `\n\n${incompleteShows} selected show${incompleteShows === 1 ? '' : 's'} currently lack${incompleteShows === 1 ? 's' : ''} a usable series or whole-number season/episode for OMDb and cannot be tagged by coordinates. Tag a fractional episode individually by entering its exact IMDb ID.`;
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
  if (!autoTagRunning || autoTagCancelRequested) {
    return Promise.resolve(false);
  }
  if (autoTagCancellationDecision) {
    return autoTagCancellationDecision;
  }

  autoTagCancellationDecision = dialog.showMessageBox({
    type: 'warning',
    buttons: ['Continue', 'Cancel'],
    defaultId: 0,
    cancelId: 0,
    title: 'Cancel Auto-Tag',
    message: 'Cancel auto-tagging?',
    detail: autoTagScope === 'selected' ?
      'Mynda will finish and save the video currently being processed, then stop. It may continue to say Canceling briefly while those saves finish synchronizing. Unprocessed selected videos will be left unchanged; select them and use Auto-Tag Selected again if you want to continue.' :
      'Mynda will finish and save the video currently being processed, then stop. It may continue to say Canceling briefly while those saves finish synchronizing. Videos that have not been processed will remain eligible for the next Auto-Tag run, which will pick up where it left off.'
  }).then(result => {
    if (result.response !== 1) {
      autoTagLog.info('Automatic tagging cancellation declined by user');
      return false;
    }
    if (!autoTagRunning) {
      autoTagLog.info('Automatic tagging finished before cancellation was confirmed');
      return false;
    }

    autoTagCancelRequested = true;
    autoTagLog.info('Automatic tagging cancellation confirmed by user');
    win.webContents.send('status-update', {action: 'autotag', cancelRequested: true});
    return true;
  }).catch(err => {
    autoTagLog.error('Could not confirm automatic tagging cancellation', {
      error: err && err.stack ? err.stack : String(err)
    });
    return false;
  }).finally(() => {
    autoTagCancellationDecision = null;
  });

  return autoTagCancellationDecision;
}

async function autoTag(options = {}) {
  if (autoTagRunning) return;

  options = options || {};
  autoTagRunning = true;
  autoTagCancelRequested = false;
  autoTagScope = options.scope === 'selected' ? 'selected' : 'library';
  win.webContents.send('status-update', {action: 'autotag'});
  let newMedia = Array.isArray(options.videos) ?
    options.videos.map(video => _.cloneDeep(video)) : getAutoTagCandidates();
  const seriesBatch = options.seriesBatch || null;
  let sharedSeriesImdbID = seriesBatch && validSeriesImdbID(seriesBatch.storedSeriesImdbID) ?
    seriesBatch.storedSeriesImdbID.trim() : '';
  if (sharedSeriesImdbID) {
    newMedia.forEach(video => { video.seriesImdbID = sharedSeriesImdbID; });
  }
  let autoStats = {totalVideos: newMedia.length};
  let autoLog = [];
  let batchSave = []; // we'll batch several videos at a time in this array before saving to the library
  // A title-verified adjacent-season match can make later episodes of the same
  // series try that offset first. This map is scoped to one Auto-Tag run and is
  // only a request-order hint; OmdbHelper still verifies every episode title.
  let seasonOffsetHints = new Map();
  let processedVideos = 0;
  let seriesSelectionCanceled = false;
  let seriesPreflightFailure = null;

  autoTagLog.info('Automatic tagging batch started', {
    totalVideos: newMedia.length,
    scope: autoTagScope,
    sameSeriesShowBatch: Boolean(seriesBatch),
    series: seriesBatch && seriesBatch.series,
    storedSeriesImdbID: sharedSeriesImdbID || undefined,
    conflictingStoredSeriesIDs: Boolean(seriesBatch && seriesBatch.conflictingStoredSeriesIDs)
  });

  try {
    // A homogeneous show batch must have one authoritative parent ID before
    // any episode can enter a save batch. This looks across the full selection
    // for a usable representative, so even ten or more incomplete episodes at
    // the beginning cannot be flushed with stale/conflicting IDs before a later
    // episode resolves the series.
    if (seriesBatch && !sharedSeriesImdbID) {
      autoTagLog.info('Selected automatic tagging series preflight started', {
        totalVideos: newMedia.length,
        series: seriesBatch.series,
        conflictingStoredSeriesIDs: seriesBatch.conflictingStoredSeriesIDs,
        storedSeriesIDs: seriesBatch.storedSeriesIDs
      });

      let preflightResult;
      try {
        preflightResult = await OmdbHelper.resolveSeriesForBatch(newMedia);
      } catch(err) {
        preflightResult = {success: false, failure: 'Error', data: err};
      }

      if (preflightResult && preflightResult.success &&
          validSeriesImdbID(preflightResult.data)) {
        sharedSeriesImdbID = preflightResult.data.trim();
      } else if (preflightResult && preflightResult.choiceType === 'series' &&
                 Array.isArray(preflightResult.choices) && preflightResult.choices.length > 0) {
        const selectedSeries = await chooseSeriesForSelectedBatch(
          seriesBatch, preflightResult.choices, newMedia.length
        );
        if (selectedSeries) {
          sharedSeriesImdbID = selectedSeries.imdbID.trim();
        } else {
          seriesSelectionCanceled = true;
        }
      } else {
        seriesPreflightFailure = Object.assign({}, preflightResult || {}, {
          success: false,
          failure: preflightResult && preflightResult.failure ?
            preflightResult.failure : 'Series resolution failed'
        });
      }

      if (sharedSeriesImdbID) {
        newMedia.forEach(video => { video.seriesImdbID = sharedSeriesImdbID; });
        autoTagLog.info('Selected automatic tagging series preflight finished', {
          totalVideos: newMedia.length,
          series: seriesBatch.series,
          seriesImdbID: sharedSeriesImdbID
        });
      } else if (seriesSelectionCanceled) {
        autoTagLog.info('Selected automatic tagging stopped at the preflight series choice', {
          totalVideos: newMedia.length,
          series: seriesBatch.series
        });
      } else {
        autoTagLog.warn('Selected automatic tagging stopped because series preflight failed', {
          totalVideos: newMedia.length,
          series: seriesBatch.series,
          failure: seriesPreflightFailure.failure,
          permanentFailure: Boolean(seriesPreflightFailure.permanentFailure)
        });
      }
    }

    // entire library loop
    for (let i=0; !seriesSelectionCanceled && !seriesPreflightFailure && i<newMedia.length; i++) {
      // If a cancellation confirmation is open, do not begin another video
      // until the user chooses whether to stop or continue.
      if (autoTagCancellationDecision) {
        await autoTagCancellationDecision;
      }

      // Cancellation is cooperative: finish and save the current video, then
      // stop before beginning another one.
      if (autoTagCancelRequested) break;

      // tell the user what number we're on
      win.webContents.send('status-update', {action: 'autotag', numCurrent: i+1, numTotal: newMedia.length});

      // create new video object
      let newVideo = newMedia[i];
      autoTagLog.debug('Automatic tagging started for video', {
        position: i+1,
        totalVideos: newMedia.length,
        id: newVideo.id,
        filename: newVideo.filename,
        title: newVideo.title,
        kind: newVideo.kind,
        year: newVideo.year,
        series: newVideo.series,
        seriesImdbID: newVideo.seriesImdbID,
        season: newVideo.season,
        episode: newVideo.episode,
        imdbID: newVideo.imdbID
      });

      // get search results
      let disposition = '';
      let searchOptions = {seasonOffsetHints: seasonOffsetHints};
      if (sharedSeriesImdbID) {
        searchOptions.seriesImdbID = sharedSeriesImdbID;
      }
      let resultsObject = await OmdbHelper.search(newVideo, searchOptions);

      // The preflight has already established this value for homogeneous show
      // batches. Retain this guard so an exact episode response can normalize
      // and reaffirm the persisted ID without changing mixed-batch behavior.
      if (seriesBatch && resultsObject && resultsObject.success &&
          !Array.isArray(resultsObject.data) && resultsObject.data &&
          validSeriesImdbID(resultsObject.data.seriesImdbID)) {
        sharedSeriesImdbID = resultsObject.data.seriesImdbID.trim();
        newMedia.forEach(video => { video.seriesImdbID = sharedSeriesImdbID; });
        resultsObject.data.seriesImdbID = sharedSeriesImdbID;
      }

      // check results
      if (resultsObject.success) {
        let results = resultsObject.data;
        // A result array represents choices for the editor, not permission for
        // unattended code to pick whichever OMDb happened to list first. The
        // helper now resolves a uniquely validated movie itself and returns a
        // video object; any remaining array is genuinely ambiguous. Record the
        // attempt and leave the video in New for the user to choose manually.
        if (Array.isArray(results)) {
          newVideo.autotag_tried = true;
          batchSave.push(newVideo);
          disposition = results.length > 0 ? 'Ambiguous results' : 'No results';
        } else {
          // we got just a single result, so save it
          results = prepareSuccessfulAutoTagResult(results);
          batchSave.push(results);
          // library.replace(`media.id=${newVideo.id}`, results);
          disposition = 'Success';
        }
      } else if (resultsObject.failure === 'No results' || resultsObject.permanentFailure) {
        // we got no results, but we still want to save the video object so we can set autotag_tried to true
        //This means we've tried and failed in a predicted manner, let's not try again.
        newVideo.autotag_tried = true;
        batchSave.push(newVideo);
        // library.replace(`media.id=${newVideo.id}`, newVideo);
        disposition = resultsObject.failure;
      } else {
        // some other failure mode, do not save
        disposition = resultsObject.failure;
      }

      // if we've accumulated enough videos to save, save them
      if (batchSave.length >= 10) {
        const completedBatch = batchSave;
        batchSave = []; // start a fresh batch while retaining this one for the awaited save
        await saveBatch(completedBatch);
      }

      // some debug logging
      autoStats[disposition] = autoStats[disposition] ? autoStats[disposition] + 1 : 1;
      autoLog.push(`${newVideo.title}: ${disposition}`);

      let resultLog = {
        id: newVideo.id,
        filename: newVideo.filename,
        title: newVideo.title,
        disposition: disposition,
        failure: resultsObject.failure,
        failureData: resultsObject.success ? undefined : resultsObject.data,
        permanentFailure: Boolean(resultsObject.permanentFailure)
      };
      if (disposition === 'Success') {
        autoTagLog.debug('Automatic tagging finished for video', resultLog);
      } else if (!resultsObject.success &&
                 !['No results', 'Not enough data', 'Ambiguous results', 'Ambiguous series', 'Episode mismatch'].includes(resultsObject.failure)) {
        autoTagLog.error('Automatic tagging failed for video', resultLog);
      } else {
        autoTagLog.warn('Automatic tagging did not tag video', resultLog);
      }

      processedVideos = i + 1;
    } // end library loop

    // save any leftovers at the end, including a completed video that was in
    // progress when the user requested cancellation
    if (batchSave.length > 0) {
      await saveBatch(batchSave);
    }

    // A Library operation's callback fires after the local atomic write and
    // IPC send. Wait for the renderer to confirm the final mirror operation as
    // well, so the status banner cannot disappear while older Auto-Tag data is
    // still capable of overwriting a subsequent editor reset.
    autoTagLog.debug('Waiting for automatic tagging saves to synchronize', {
      processedVideos: processedVideos
    });
    await library.whenIdle();
    autoTagLog.debug('Automatic tagging saves synchronized', {
      processedVideos: processedVideos
    });

    autoStats.processedVideos = processedVideos;
    autoStats.remainingVideos = newMedia.length - processedVideos;
    if (sharedSeriesImdbID) autoStats.seriesImdbID = sharedSeriesImdbID;
    autoLog.sort();

    const canceled = autoTagCancelRequested;
    let completionStatus;
    if (seriesSelectionCanceled) {
      completionStatus = 'series-selection-canceled';
      autoTagLog.info('Automatic tagging batch stopped without a series selection', {
        scope: autoTagScope,
        statistics: autoStats
      });
    } else if (seriesPreflightFailure) {
      completionStatus = 'series-preflight-failed';
      autoTagLog.warn('Automatic tagging batch stopped before processing because series preflight failed', {
        scope: autoTagScope,
        failure: seriesPreflightFailure.failure,
        permanentFailure: Boolean(seriesPreflightFailure.permanentFailure),
        statistics: autoStats
      });
    } else if (canceled) {
      completionStatus = 'canceled';
      autoTagLog.info('Automatic tagging batch canceled by user', {
        scope: autoTagScope,
        statistics: autoStats
      });
    } else {
      completionStatus = 'finished';
      autoTagLog.info('Automatic tagging batch finished', {
        scope: autoTagScope,
        statistics: autoStats
      });
    }
    autoTagLog.debug('Automatic tagging batch diagnostics', {
      scope: autoTagScope,
      status: completionStatus,
      statistics: autoStats,
      videoResults: autoLog
    });
    return {
      statistics: autoStats,
      canceled: canceled,
      seriesSelectionCanceled: seriesSelectionCanceled,
      seriesPreflightFailure: seriesPreflightFailure
    };
  } finally {
    autoTagRunning = false;
    autoTagCancelRequested = false;
    autoTagScope = 'library';

    // clear the user notification whether the batch completed, was canceled,
    // or stopped because of an unexpected error
    win.webContents.send('status-update', {action: ''});
  }
}

function saveBatch(batch) {
  const replacements = batch.map(video => _.cloneDeep(video));
  autoTagLog.debug('Saving automatic tagging batch', {
    videoCount: replacements.length
  });

  // Submit only the videos in this batch. Library.js merges them into the
  // freshest media array when the queued operation actually executes, avoiding
  // the stale full-array snapshots that previously survived past cancellation.
  return new Promise((resolve, reject) => {
    library.replaceMediaBatch(replacements, (err) => {
      if (err) {
        autoTagLog.error('Could not save automatic tagging batch', {
          videoCount: replacements.length,
          error: String(err)
        });
        reject(err);
        return;
      }
      autoTagLog.debug('Automatic tagging batch saved locally', {
        videoCount: replacements.length
      });
      resolve();
    });
  });
}

async function exportFiles(drive) {
  win.webContents.send('status-update', {action: 'export'});
  exportLog.info('Media export started', {destination: drive});
  let fileLocation = path.join(drive, "Mynda Manifest.json");
  let manifest;
  if (fs.existsSync(fileLocation)) {
    manifest = JSON.parse(fs.readFileSync(fileLocation));
    //console.log('Loaded manifest.')
  } else {
    manifest = {media: []};
    exportLog.info('No export manifest found; treating all media as new', {
      manifestPath: fileLocation
    });
  }
  let matchedMedia = [];
  let unmatchedMedia = [];
  for (let i=0; i<library.media.length; i++) {
    let homeVideo = library.media[i];
    let match = null;
    for (let j=0; j<manifest.media.length; j++) {
      let awayVideo = manifest.media[j];
      if (homeVideo.id === awayVideo.id) {
        match = {id : homeVideo.id, file : homeVideo.filename}
        matchedMedia.push(match);
        break;
      }
    }
    if (match === null) {
      unmatchedMedia.push(homeVideo);
    }
  }
  exportLog.info('Export manifest comparison finished', {
    alreadyExportedVideos: matchedMedia.length,
    videosToExport: unmatchedMedia.length
  });
  unmatchedMedia.sort((a,b) => {return b.dateadded - a.dateadded});
  for (let k=0; k<unmatchedMedia.length; k++) {
    let video = unmatchedMedia[k];
    //console.log(`Starting export process on ${video.title}`);
    if (video.dvd) {
      continue;
    }
    let filename = video.filename;
    let conWatchFolder = '';
    for (let l=0; l<library.settings.watchfolders.length; l++) {
      let watchfolder = library.settings.watchfolders[l];
      //console.log(`Checking watchfolder ${watchfolder.path}`)
      if (filename.includes(watchfolder.path)) {
        conWatchFolder = watchfolder.path;
        break;
      }
    }
    //console.log(`Found watchfolder ${conWatchFolder}.`);
    if (conWatchFolder === '') {
      continue;
    }
    let filePathTrim = conWatchFolder.replace(path.basename(conWatchFolder), '');
    let subtitles = video.subtitles;
    let totalSize = fs.lstatSync(filename).size;
    for (let m=0; m<subtitles.length; m++) {
      let subtitle = subtitles[m];
      totalSize += fs.lstatSync(subtitle).size;
    }
    let diskSpace = await checkDiskSpace(drive);
    let availableSpace = diskSpace.free;
    exportLog.debug('Checked export destination capacity', {
      destination: drive,
      availableBytes: availableSpace,
      requiredBytes: totalSize,
      videoID: video.id
    });
    //console.log(`Found ${availableDrives.length} drives.`)

    if (availableSpace > totalSize) {
      //console.log(`There's ${availableSpace} bytes, and we need ${totalSize} bytes.`);

      try {
        let destFile = path.join(drive, filename.replace(filePathTrim, ''));
        //console.log(`Going to try copying video to ${destFile}.`);
        let destDir = destFile.replace(path.basename(destFile), '');
        fs.mkdirSync(destDir, { recursive: true });
        fs.copyFileSync(filename, destFile, fs.constants.COPYFILE_EXCL);
        for (let m=0; m<subtitles.length; m++) {
          let subtitle = subtitles[m];
          let subDestFile = path.join(drive, subtitle.replace(filePathTrim, ''));
          let subDestDir = subDestFile.replace(path.basename(subDestFile), '');
          fs.mkdirSync(subDestDir, { recursive: true });
          fs.copyFileSync(subtitle, subDestFile, fs.constants.COPYFILE_EXCL);
        }
        exportLog.info('Video exported successfully', {
          id: video.id,
          title: video.title,
          destination: drive
        });
      } catch (e) {
        exportLog.error('Could not export video', {
          id: video.id,
          title: video.title,
          destination: drive,
          error: e
        });
      }
    } else {
      exportLog.warn('Export stopped because the destination has insufficient space', {
        destination: drive,
        availableBytes: availableSpace,
        requiredBytes: totalSize,
        nextVideoID: video.id
      });
      break;
    }
  }
  win.webContents.send('status-update', {action: ''});
}

ipcMain.on('settings-folder-select', (event) => {
  let options = {properties: ['openDirectory']};
  dialog.showOpenDialog(null, options).then(result => {
  event.sender.send('settings-folder-selected', result.filePaths[0]);
}).catch(err => {
  backendLog.error('Could not open folder-selection dialog', {error: err});
})})

ipcMain.on('settings-watchfolder-add', (event, args) => {
  const folder = args['address'];
  const kind = args['kind'].toLowerCase();

  // check if path exists and is a folder, not a file
  fs.lstat(folder, (err, stats) => {
    // if path exists and is a folder
    if(!err && stats.isDirectory()) {

      // if we don't already have this watchfolder, add it
      if (library.settings.watchfolders.filter(wf => path.resolve(wf.path) === path.resolve(folder)).length === 0) {
        // add to library
        let folderObject = {"path" : folder, "kind" : kind, "videos" : []};
        library.add('settings.watchfolders.push', folderObject, () => {
          checkWatchFolders();

          // tell the client side what happened
          event.sender.send('settings-watchfolder-added', _.cloneDeep(folderObject));
        });
      } else {
        // if this folder is already a watchfolder, display a dialog
        dialog.showMessageBox({
          type : 'warning',
          buttons : ['Ok'],
          message : 'This directory is already a watchfolder!'
        });
      }

    } else {
      // if not a directory or we got an error, display an error dialog
      dialog.showMessageBox({
        type : 'error',
        buttons : ['Ok'],
        message : 'Error: not a valid directory'
      });
    }
  });

})

ipcMain.on('settings-watchfolder-remove', (event, path) => {

  // first, show the user a confirmation dialog
  const options = {
    type : 'warning',
    buttons : ['Cancel','Remove Folder'],
    message : 'Are you sure you want to remove following folder from the library?\n\n' +
              path + '\n\n' +
              'This will remove all videos in this folder from the library (but will save any video information you\'ve edited in case you decide to add the folder again later)'
  };
  dialog.showMessageBox(options).then(result => {
    // if the user said okay
    if (result.response === 1) {
      // remove watchfolder, and pass callback function.
      // the callback function will return only after the watchfolder
      // has actually been removed from the library, so we can tell the front end
      // whether we succeeded or not, and it can use the info to update itself
      removeWatchfolder(path,(err) => {
        // tell the client side what happened
        event.sender.send('settings-watchfolder-remove', path, !err); // <-- pass !err to the front end, which expects a boolean for success or failure

        if (err) {
          backendLog.error('Could not remove watchfolder', {
            watchfolder: path,
            error: err
          });
        }
      });
    } else {
      // if the user canceled
      backendLog.debug('User canceled watchfolder removal', {watchfolder: path});
      event.sender.send('settings-watchfolder-remove', path, false);
    }

  }).catch(err => {
    backendLog.error('Could not display watchfolder-removal confirmation', {
      watchfolder: path,
      error: err
    });
  });
})

ipcMain.on('editor-artwork-select', (event) => {
  let options = {
    filters: [{name: 'Images', extensions: ['jpg', 'png', 'gif']}],
    properties: ['openFile']
  };
  dialog.showOpenDialog(null, options).then(result => {
  event.sender.send('editor-artwork-selected', result.filePaths[0]);
}).catch(err => {
  backendLog.error('Could not open artwork-selection dialog', {error: err});
})});

ipcMain.on('editor-subtitle-select', (event) => {
  let options = {
    filters: [{name: 'Subtitles', extensions: subtitleExtensions}],
    properties: ['openFile']
  };
  dialog.showOpenDialog(null, options).then(result => {
    event.sender.send('editor-subtitle-selected', result.filePaths);
  }).catch(err => {
    backendLog.error('Could not open subtitle-selection dialog', {error: err});
  })
});

ipcMain.on('download', (event, url, destination, requestedResponseChannel) => {
    // Artwork downloads use private reply channels so concurrent downloads
    // cannot resolve one another. Keep the original shared channel as the
    // fallback for existing callers.
    let responseChannel = typeof requestedResponseChannel === 'string' &&
      /^downloaded-(?:omdb|editor-artwork)-\d+-\d+$/.test(requestedResponseChannel) ?
      requestedResponseChannel : 'downloaded';
    downloadFile(url, destination)
      .then(response => event.sender.send(responseChannel, response))
      .catch(response => event.sender.send(responseChannel, response))
})

ipcMain.on('autotag', () => {
  requestAutoTag().catch(err => {
    autoTagLog.error('Could not start automatic tagging', {
      error: err && err.stack ? err.stack : String(err)
    });
  });
})

ipcMain.on('autotag-selected', (event, videoIDs) => {
  requestSelectedAutoTag(videoIDs).catch(err => {
    autoTagLog.error('Could not start selected automatic tagging', {
      requestedVideos: Array.isArray(videoIDs) ? videoIDs.length : 0,
      error: err && err.stack ? err.stack : String(err)
    });
  });
})

ipcMain.on('autotag-cancel', () => {
  requestAutoTagCancellation();
})

ipcMain.on('reset-from-filename', (event, requestedResponseChannel, videos) => {
  // The renderer creates a private one-use channel for each request. Restrict
  // its shape before reflecting it back through IPC, just as artwork download
  // replies do, rather than accepting an arbitrary renderer-supplied channel.
  if (typeof requestedResponseChannel !== 'string' ||
      !/^reset-from-filename-\d+-\d+$/.test(requestedResponseChannel)) {
    backendLog.warn('Rejected filename reset with an invalid response channel');
    return;
  }

  const sourceVideos = Array.isArray(videos) ? videos.filter(Boolean) : [];
  if (sourceVideos.length === 0) {
    backendLog.warn('Filename-reset request did not include any videos');
    event.sender.send(requestedResponseChannel, {
      confirmed: false,
      error: 'No videos were supplied for reset'
    });
    return;
  }

  // Auto-Tag owns a sequence of media writes in the main process. Its running
  // flag now remains true until the renderer has confirmed the final write, so
  // refusing this conflicting action closes the window in which an older
  // Auto-Tag snapshot could land after—and undo—the user's reset.
  if (autoTagRunning) {
    backendLog.warn('Rejected filename reset while automatic tagging was still active', {
      videoCount: sourceVideos.length
    });
    event.sender.send(requestedResponseChannel, {
      confirmed: false,
      error: 'Auto-Tag is still running or finishing its saves. Cancel it or wait for it to finish, then try Reset from Filename again.'
    });
    return;
  }

  backendLog.info('Filename-derived editor reset requested', {
    videoCount: sourceVideos.length
  });

  let patches;
  try {
    patches = sourceVideos.map(video => deriveFilenameResetChanges(video));
  } catch(err) {
    backendLog.error('Could not derive filename metadata for editor reset', {
      error: err && err.stack ? err.stack : String(err)
    });
    event.sender.send(requestedResponseChannel, {
      confirmed: false,
      error: err && err.message ? err.message : String(err)
    });
    return;
  }

  const count = patches.length;
  const missingWatchfolders = patches.filter(patch => !patch.watchfolderFound).length;
  const resetFields = Array.from(new Set(
    patches.flatMap(patch => Object.keys(patch.changes || {}))
  )).sort();
  backendLog.info('Prepared filename-derived editor reset patches', {
    videoCount: count,
    missingWatchfolders: missingWatchfolders,
    resetFields: resetFields
  });
  let detail =
    'Mynda will re-detect title, series, season, and episode from each filename and its folders. ' +
    'It will restore the watchfolder\'s default kind, clear the IMDb ID, artwork reference, and other OMDb catalog fields, ' +
    'mark the video as New, and allow Auto-Tag to try it again.\n\n' +
    'Tags, subtitles, watched status, playback position, technical metadata, and your rating will be kept. ' +
    'Nothing is written to the library until you click Save in the editor.';

  if (missingWatchfolders > 0) {
    detail += `\n\nMynda could not identify a containing watchfolder for ${missingWatchfolders} ` +
      `video${missingWatchfolders === 1 ? '' : 's'}; for those, it will use the filename alone and keep the current kind.`;
  }

  dialog.showMessageBox({
    type: 'warning',
    buttons: ['Cancel', 'Reset from Filename'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    message: count === 1 ?
      'Reset this video from its filename?' :
      `Reset ${count} videos from their filenames?`,
    detail: detail
  }).then(result => {
    backendLog.info(result.response === 1 ?
      'Filename-derived editor reset confirmed' :
      'Filename-derived editor reset canceled', {
        videoCount: count,
        returnedPatchCount: result.response === 1 ? patches.length : 0
      });
    event.sender.send(requestedResponseChannel, {
      confirmed: result.response === 1,
      patches: result.response === 1 ? patches.map(({id, changes}) => ({id, changes})) : []
    });
  }).catch(err => {
    backendLog.error('Could not display filename reset confirmation', {
      error: err && err.stack ? err.stack : String(err)
    });
    event.sender.send(requestedResponseChannel, {
      confirmed: false,
      error: err && err.message ? err.message : String(err)
    });
  });
})

ipcMain.on('save-video-confirm', (event, changes, video, showSkipDialog) => {
  //console.log('save-video-confirm!!!');
  // create message
  let message = 'Are you sure you want to ';
  if (Object.keys(changes).length === 1) { // changing only one property
    let property = Object.keys(changes)[0];
    let value = changes[property];
    if (property === 'ratings') {
      value = value.user; // for now let's assume that if we're changing the rating, we're only changing the user rating, i.e. from the table view
      message += `rate ${video.title} ${value} star${value > 1 ? 's' : ''}?`
    } else if (property === 'seen') {
      message += `mark ${video.title} as ${value ? 'seen' : 'unseen'}?`
    } else {
      message += `change the [${property}] of ${video.title} to ${JSON.stringify(value)}?`
    }
  } else { // changing multiple properties
    message += `make the following changes to ${video.title}?\n\n`
    Object.keys(changes).forEach(key => {
      message += `${key} : ${changes[key]}\n`
    });
  }

  let options = {
    type : 'question',
    buttons : ['Yes','No'],
    message : message
  };

  if (showSkipDialog) {
    options.checkboxLabel = `Don't show this dialog again`;
  }

  dialog.showMessageBox(options).then(result => {
  event.sender.send('save-video-confirm', result.response, changes, video, result.checkboxChecked);
}).catch(err => {
  backendLog.error('Could not display video-save confirmation', {error: err});
})})

ipcMain.on('generic-confirm', (event, returnTo, opts, data) => {
  backendLog.debug('Generic confirmation requested', {returnChannel: returnTo});

  let options = {
    type : 'question',
    buttons : ['Yes','No'],
  };

  // if the opts parameter is a string
  // then we assume it's just a message
  if (typeof opts === 'string') {
    options.message = opts;
  }

  // if it's an object, add its data to the options
  if (typeof opts === 'object' && opts !== null) {
    options = {...options, ...opts};
  }

  dialog.showMessageBox(options).then(result => {
  event.sender.send(returnTo, result.response, data, result.checkboxChecked);
}).catch(err => {
  backendLog.error('Could not display generic confirmation', {
    returnChannel: returnTo,
    error: err
  });
})})

ipcMain.on('exportFiles', (event, drive) => {
  exportFiles(drive).catch(err => {
    exportLog.error('Media export failed', {
      destination: drive,
      error: err
    });
    win.webContents.send('status-update', {action: ''});
  });
});
