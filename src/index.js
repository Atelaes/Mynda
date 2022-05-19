const electron = require('electron');
const { ipcMain, dialog } = require('electron');
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const {v4: uuidv4, v5: uuidv5} = require('uuid');
const crypto = require('crypto');
const Library = require("./Library.js");
const Collections = require("./Collections.js");
const dl = require('./download');
const _ = require('lodash');
const pathToFFmpeg = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');
ffmpeg.setFfmpegPath(pathToFFmpeg);
const ffprobe = require('ffprobe');
let ffprobeStatic = {};
try {
  ffprobeStatic = require('ffprobe-static');
} catch(err) {console.log('Warning: ffprobe-static not installed')}
const OmdbHelper = require('./OmdbHelper.js');
//const { lsDevices } = require('fs-hard-drive');
const checkDiskSpace = require('check-disk-space').default
//const { default: installExtension, REACT_DEVELOPER_TOOLS } = require('electron-devtools-installer');

const appID = '7f1eec5b-a20d-400a-8876-cad667efe08f';
const videoExtensions = [
  '3g2', '3gp',  'amv',  'asf', 'avchd', 'avi', 'divx', 'drc',  'f4a',  'f4b', 'f4p',
  'f4v', 'flv',  'm2ts', 'm2v', 'm4p', 'm4v', 'mkv',  'mov',  'mp2', 'mp4',
  'mpe', 'mpeg', 'mpg',  'mpv', 'mts', 'mxf', 'nsv',  'ogg',  'ogv', 'qt',
  'rm',  'rmvb', 'roq',  'svi', 'ts', 'viv', 'webm', 'wmv', 'xvid', 'yuv'
]
const subtitleExtensions = [
  'srt', 'ass', 'ssa', 'vtt', 'usf', 'ttml'
];

let win;
let library = new Library;
let collections = new Collections(library.collections);
const app = electron.app;
const BrowserWindow = electron.BrowserWindow;
let libFileTree; // where we store video and subtitle information we find in the watchfolders prior to adding the videos to the library
let libMulch = [];  //After libFileTree has been created and chewed up, this is the flattened version
let parsing = {}; // this is just to keep track of when we're done looking through all the watchfolders for videos
let addVideoTimeout; // just a delay for adding the videos to the library once we're done parsing, to make sure it only happens once
let newIDs = [];
let ffMpegQueue = [];
let videoAddTimers = [];
let appStartTime = new Date();

app.whenReady().then(start);

async function start() {
  //Tutorial at https://www.electronjs.org/docs/tutorial/devtools-extension
  //You need to install React Dev tools in Chrome before this will work, also, double-check the location.
  try {
    let reactToolsLoc;
    if (process.platform === "win32") {
      console.log('Windows');
      reactToolsLoc = 'C:\\Users\\atela\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Extensions\\fmkadmapgofadopljbjfkapdkoienihi\\4.12.3_0';
    } else {
      console.log('Not Windows');
      reactToolsLoc = path.join('~/Library/Application Support/Google/Chrome/Default/Extensions/fmkadmapgofadopljbjfkapdkoienihi/4.12.3_0');
    }
    //await electron.session.defaultSession.loadExtension(reactToolsLoc)
  } catch (err) {
    console.log(`Couldn't load React tools.`);
    console.log(err);
  }
  await createWindow();  //createWindow needs to come first else we get a big delay.
  eraseTempImages();
  await cleanLibrary();
  checkWatchFolders();

  // testNotify(0);
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
      return console.error('Can\'t delete temp images. Unable to scan directory: ' + err);
    }

    // loop over all the files in the temp folder and delete them
    files.forEach(file => {
      //console.log(`trying to delete ${file}`);
      try {
        fs.unlink(path.join(folderPath, file), (err) => {
          if (err) {
            console.error(`An error ocurred deleting the temp file ${file}\n${err.message}`);
            return;
          }
          console.log(`...successfully deleted ${file}`);
        });
      } catch(err) {
        console.error(err);
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
  console.log('Removing watchfolder from libFileTree');
  console.log(JSON.stringify(libFileTree));

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
  console.log('REMOVING videos from library in ' + folder);

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
      console.log(`Deleting ${video.filename} from library.inactive_media`);
      address = 'inactive_media';
    } else {
      console.log(`Removing ${video.filename} from library.media and adding to library.inactive_media`);
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
      }

      if (!fromInactive) {
        // add the video to library.inactive_media
        library.add('inactive_media.push',video);

        // remove video id from its watchfolder's list of video ids
        library.settings.watchfolders.map((wf, i) => {
          if (!wf) return;

          if (new RegExp('^' + wf.path).test(video.filename)) {
            console.log(`${video.filename} is part of the watchfolder ${wf.path}; removing from the watchfolder's list of id's`);
            wf.videos = wf.videos.filter(id => id !== video.id);
            library.replace(`settings.watchfolders.${i}`, library.settings.watchfolders[i], (err) => {
              if (err) {
                reject(`Error: could not update watchfolder manifest: ${err}`);
              } else {
                resolve();
              }
            });
          }
        });
      }
    });
  });
}
function deleteFromInactive(video, index) {
  return removeVideo(video, index, true);
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
    "kind" : '',
    "artwork" : '',
    "subtitles" : [],
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
  win.webContents.send('status-update', {action: 'check'});
  // reset libFileTree
  libFileTree = {name:'root', folders:[]};

  // Search watchfolders for new files and add any new videos to the library
  console.log(`-- Parsing watchfolder structure, looking for video and subtitle files...`);
  numNewVids = 0; // reset the number of new videos found
  let folders = library.settings.watchfolders;
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
    console.log('Done parsing. No watchfolders found.');
    win.webContents.send('status-update', {action: ''});
  }
}

// recursively maps out the folder structure and files (only videos/DVDs and subtitle files)
// storing the whole thing in libFolderTree;
// once this is done, we'll traverse the tree, adding all the videos to the library
function findVideosFromFolder(folderNode) {
  // the id here (and the <parsing> object it gets put into)
  // is just to keep track of all the recursive branches of this function,
  // so we'll know when they're all finished
  const id = uuidv4();
  parsing[id] = true;

  const folder = folderNode.path;
  const kind = folderNode.kind;

  // read the contents of this folder
  fs.readdir(folder, {withFileTypes : true}, function (err, components) {
    // handling error
    if (err) {
        console.log('Unable to scan directory: ' + err);
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
          folderNode.videos.push({dvd: true, filename: compAddress, kind: kind}); // add the DVD to libFileTree
        } else {
          // if it's not, recurse on it as a folder
          recursed = true;
          folderNode.folders.push({path:compAddress, kind:kind, folders:[], videos:[], subtitles:[]});
          findVideosFromFolder(folderNode.folders[folderNode.folders.length-1]);
        }
      } else if (!/^\./.test(component.name)) {
        //If it's a hidden file, as evidenced by a filename starting with a dot
        //Then skip it
        //console.log(`We came across ${component.name}.`);
        // otherwise, it must be a file
        let fileExt = path.extname(component.name).replace('.', '').toLowerCase();

        if (videoExtensions.includes(fileExt) && !isSampleVideo(compAddress)) {
          //console.log(`We're about to add ${component.name} to libTree.`);
          // if it's a video file, add it as a video
          // console.log(`${compAddress} is a regular video file`);
          folderNode.videos.push({filename: compAddress, kind: kind}); // add the video to this node of the libFileTree
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
    if (!stillGoing) divineCollections(libFileTree, []);
  });
}

function isSampleVideo(filepath) {
  let fileBasename = path.basename(filepath,path.extname(filepath));
  let size;
  try {
    size = fs.statSync(filepath).size;
  } catch(err) {
    console.log(`Could not determine file size of ${filepath}: ${err}`);
    return false;
  }

  // if the filename ends with 'sample' or 'Sample' and it's less than 100 MB, we say it's a sample video
  if (/sample$/.test(fileBasename.toLowerCase()) && size < 100000000) {
    console.log('Ignoring "SAMPLE" video: ' + filepath);
    return true;
  }
  return false;
}

//Recursive function which takes a built libFileTree and figures out collections
// for videos based on file structure.
function divineCollections(node, pathStack) {
  //console.log('pathStack:');
  //console.log(pathStack);
  if (pathStack.length === 0) {
    //If we're here, then we're looking at root, this should only happen once.
    //console.log(`libTree before divination:  ${JSON.stringify(libFileTree)}`);
  }

  let parentFolder = node.path ? (node.path + path.sep) : '';
  let count = 0;
  for (let i=0; i<node.folders.length; i++) {
    let folder = node.folders[i];
    let stackAppend = folder.path.replace(parentFolder, '');
    count += divineCollections(folder, pathStack.concat(stackAppend));
  }
  count += (node.videos) ? node.videos.length : 0;
  if (count > 1 && pathStack.length > 1) {
    node.collection = pathStack.slice(1);
  }

  if (pathStack.length === 0) {
    //Again, we're on root.
    //console.log(`libTree after divination:  ${JSON.stringify(libFileTree)}`);
    confirmCurrentVideos();
  } else {
    return count;
  }
}

function confirmCurrentVideos() {
  //Once libFileTree is built, check videos in library and make sure they're
  // all there, removing from libFileTree as we go
  //console.log(`libTree before confirm:  ${JSON.stringify(libFileTree)}`);
  console.log(`Running confirmCurrentVideos.`)
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
              updateVideoSubs(video.subtitles,getVideoSubs(path.basename(filename,path.extname(filename)), libTreeLoc),h);

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
      console.log(err)
      // A thrown error means we didn't find the video where we expected to,
      // so move it to inactive media.
      console.log(`${filename} appears to have disappeared, moving to inactive media.`)
      removeVideo(video);
    }
  }
  //console.log(`libTree after confirm: \n ${JSON.stringify(libFileTree)}`);
  console.log("Parsing done, checking parsed tree for new videos/subtitles...");
  //console.log(JSON.stringify(libFileTree));

  // walk through libFileTree, adding all the videos to the library
  // (and making our best guess as to which subtitles go with which videos)
  mulchVideoTree(libFileTree);
  addVideoController();
}

function mulchVideoTree(folderNode) {
  win.webContents.send('status-update', {action: 'add'});
  // If there is a collection assigned to this folder, make sure it exists,
  // and if not, make it.
  if (folderNode.collection) {
    if (!collections.ensureExists(folderNode.collection)) {
      console.log(`We had a problem ensuring collection ${folderNode.collection}.`)
    } else {
      //library.replace('collections', collections.getAll());
    }
  }
  if (folderNode.folders && folderNode.folders.length > 0) {
    for (let childFolder of folderNode.folders) {
      mulchVideoTree(childFolder);
    }
  }
  if (folderNode.videos && folderNode.videos.length > 0) {
    for (let video of folderNode.videos) {

      let fileBasename = path.basename(video.filename,path.extname(video.filename));

      // then check for subtitles
      video.subtitles = getVideoSubs(fileBasename,folderNode);

      // If we've divined a collection for videos in this folder, make sure that this
      // video is in it.
      if (folderNode.collection) {
        let collectionAddress = folderNode.collection
        // If there are subfolders, we need to ensure a terminal collection for this
        // video to go into named "Other".
        if (folderNode.folders.length > 0) {
          collectionAddress = folderNode.collection.concat(`Other`);
        }
        video.collection = collectionAddress;
      }

      libMulch.push(video);
      //addVideoFile(folderNode, videoFilename, rootFolder).catch((err) => {console.log(err)});
    }
  }
  //Now that we have a flat array, make sure that the window is up and running, and start adding them.
}

async function addVideoController() {
  let addStart = new Date();
  let newMedia = [];
  let numNewVids = 0;
  win.webContents.send('status-update', {action: 'add', numTotal: libMulch.length});
  for (let i=0; i<libMulch.length; i++) {
    win.webContents.send('status-update', {action: 'add', numCurrent: i+1, numTotal: libMulch.length});
    let video = libMulch[i];
    let procVideo = await addVideoFile(video);
    if (procVideo) {
      newMedia.push(procVideo);
      numNewVids++;
    }
  }
  let addEnd = new Date();
  console.log(`Adding ${newMedia.length} new videos took ${addEnd-addStart}ms.`);
  let combinedMedia = library.media.concat(newMedia);
  library.replace('media', combinedMedia, (err) => {

  });

  // replace collections with updated version
  library.replace('collections', collections.getAll());

  // tell the user how many videos we added
  win.webContents.send('videos_added',numNewVids);

  // now let's try and get some metadata.
  // eventually we want to do all this after the above media replacement library call
  // has finished; currently we can only accomplish that with a callback, which doesn't
  // allow us to use await with the getMetadata() call below; the ideal solution is to
  // modify Library.js to work with promises, but in the meantime, a workable solution is
  // to use the combinedMedia object we created above to base our metadata search on,
  // so that even if the library call hasn't finished, we're not using an outdated media object here
  let metaStart = new Date();
  let unchecked = combinedMedia.filter(v => v !== null && !v.metadata.checked); // all videos in the library that haven't already been checked for metadata
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
      let metadata = await getMetadata(v);
      if (metadata.hasOwnProperty('checked') && Object.keys(metadata).length > 1) numSuccessful++; // count how many videos we actually got some data for, just to notify the user
      metadataToAdd[v.id] = metadata;
    }
  }

  // now update the actual videos with their metadata
  // (here we have to use library.media instead of combinedMedia [see comment above],
  // because the whole idea of waiting to add the metadata all at once is that it will incorporate
  // any changes the user might have made in the meantime; so until we get Library.js working with
  // promises so we can await the library save above, we will just hope that that library save
  // will have finished by this point; not ideal, but it probably has??)
  let updatedMedia = library.media.map(v => {
    if (v && metadataToAdd[v.id]) {
      v.metadata = metadataToAdd[v.id];
    }
    return v;
  });

  // save to library
  library.replace('media', updatedMedia, (err) => {
    win.webContents.send('status-update', {action: 'metadata_save', numTotal: numSuccessful});
    console.log(`Added metadata for ${numSuccessful} videos`)

    setTimeout(() => {
      win.webContents.send('status-update', {action: ''});
    },3000);
  });
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
      console.log(`=========Video Already in Library=======`);
      console.log(`${fileBasename} has the same id as ${library.media[indexOfVideoInLibrary(id)].title}`);
      let vidIndex = indexOfVideoInLibrary(id);
      let libraryVideo = library.media[vidIndex];
      updateVideoSubs(libraryVideo.subtitles,video.subtitles,vidIndex);
      return;

    case 2:
      // If we have another new video with the same id, just skip it for now.
      //Long term we want to mention to user and figure out which to use.
      return;

    case 3:
    case 4:
      if (situation === 3) {
        // ------------- VIDEO IS IN LIBRARY.INACTIVE_MEDIA ------------- //
        // remove the video object from inactive media (it will be added to active media below)
        console.log(`There is a video object for ${fileBasename} in library.inactive_media. Moving to library.media...`);
        let inactiveVidIndex = indexOfVideoInInactiveMedia(id);

        try {
          vidObj = _.cloneDeep(library.inactive_media[inactiveVidIndex]);
          vidObj.filename = file; // this is important because the file may have been renamed

          try {
            // update the video's kind based on the watchfolder's default kind;
            // in case the user has changed the default kind, we want to update it when re-adding the video
            // vidObj.kind = library.settings.watchfolders.filter(wf => wf && wf.path === rootWatchFolder)[0].kind;
            vidObj.kind = video.kind;
          } catch(err) {
            console.log('Could not update kind based on watchfolder default kind: ' + err);
          }

          library.remove(`inactive_media.${inactiveVidIndex}`,(err) => {
            if (err) {
              throw err;
              console.log(err);
            }
          });

        } catch(err) {
          console.log(`Error: found video object for ${fileBasename} in library.inactive_media but could not remove: ${err}`);
          return;
        }
      } else {
        // ------------- VIDEO IS BRAND NEW ------------- //
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
          console.log(err);
        }
      }

      //########### ADD VIDEO TO (ACTIVE) LIBRARY ###########//
      //#### BOTH FOR NEW VIDEOS AND FOR INACTIVE VIDEOS ####//

      //Start by adding (or readding in case 3) video to any relevant collections.
      if (video.collection) {
        //Ensure collection exists, add the video to it if not already there
        if (collections.ensureExists(video.collection)) {
          let targetCollection = collections.ensureExists(video.collection);
          if (!collections.containsVideo(targetCollection, id)) {
            if (video.kind === 'show') {
              let seasonEpisode = findSeasonEpisode(video, fileBasename);
              //If we got results from findSeasonEpisode, store info in video object
              //unless it already has data (case 3).
              vidObj.series = vidObj.series || seasonEpisode.series || undefined;
              vidObj.season = vidObj.season || seasonEpisode.season || undefined;
              vidObj.episode = vidObj.episode || seasonEpisode.episode || undefined;
            }
            if (vidObj.episode) {
              collections.addVideo(targetCollection, id, vidObj.episode);
            } else {
              collections.addVideo(targetCollection, id);
            }
          }
        }
        delete video.collection;
      }

      if (typeof vidObj === 'object' && vidObj !== null) {
        // add any new subtitles, removing duplicates
        vidObj.subtitles = [...new Set([...vidObj.subtitles, ...video.subtitles])];
        return vidObj;
      }
    }
}

async function getMetadata(video) {
  // get video data from the file itself (duration, codec, dimensions, whatever)
  let file = video.filename;
  let returnObj = {};
  returnObj.checked = true;
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
        console.log(`Error storing ffprobe metadata for ${file}: ${err}`);
      }
    }
  } catch(err) {
    console.log(`Unable to retrieve metadata with ffprobe for ${file}: ${err}`);
  }

  // some files (.mkv) will give us metadata, but do not store the duration for some reason;
  // in this case, we analyze the file with ffmpeg to obtain the duration
  if (!returnObj.duration) { // value could be either 0 (in case of error) or undefined, if we didn't get a duration
    try {
      let ffmpegData = await getMetadataFromFFmpeg(file,video.id);
      console.log(ffmpegData);
      returnObj = {...ffmpegData, ...returnObj};
    } catch(err) {
      console.log(`Unable to retrieve metadata with ffmpeg for ${file}: ${err}`);
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
              console.log(err);
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
  console.log(folder);
  let files = [];
  let contents = [];
  try {
    contents = fs.readdirSync(folder);
  } catch(err) {
    console.log(err);
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
      console.log(err);
    }
  }
  return files;
}


// get subtitles for the given video from its clade in libFileTree,
// (which ones depend on whether it's the only video in that clade or not)
function getVideoSubs(fileBasename, folderNode) {
  let allSubs = getNodeSubs(folderNode); // get all subtitles from this clade
  let subtitles = [];
  if (folderNode.videos.length === 1) {
    // if this is the only video in this folder
    // we assume any subtitle file belongs to this video
    // in this folder and in any subfolders
    subtitles = allSubs;
  } else {
    // otherwise, we'll only consider subtitle files that have the same filename
    // or whose filenames contain the video's filename as a substring
    for (let sub of allSubs) {
      if (new RegExp('^' + fileBasename).test(path.basename(sub))) {
        subtitles.push(sub);
      }
    }
  }

  return subtitles
}

// get all subtitles from a given clade in libFileTree
function getNodeSubs(folderNode) {
  let subs = [];
  // get subtitles from this folder
  if (folderNode.subtitles) {
    subs = [...folderNode.subtitles];
  }
  // get subtitles from all child folders
  if (folderNode.folders) {
    for (let folder of folderNode.folders) {
      subs = [...subs,...getNodeSubs(folder)];
    }
  }
  return subs;
}

function updateVideoSubs(librarySubs, libFileTreeSubs, libVidIndex) {

    if (!_.isEqual(libFileTreeSubs,librarySubs)) {
      console.log(`Subtitle files have changed for ${path.basename(library.media[libVidIndex].filename)}. Updating subtitles.`);
      // We don't want to
      // remove any subtitles the user has manually added from other locations,
      // but we do want to remove any subtitles from the searched folders that
      // no longer exist (as well as adding any new ones);

      // remove any subtitles that no longer exist
      for (let i=librarySubs.length-1; i>=0; i--) {
        let subAddress = librarySubs[i];
        try {
          if (!fs.existsSync(subAddress)) {
            librarySubs.splice(i,1);
            // library.remove(`media.${libVidIndex}.subtitles.${i}`);
          }
        } catch(err) {
          console.log(`problem checking existence of/removing ${subAddress}: ${err}`);
        }
      }

      // add any new subtitles, removing duplicates
      librarySubs = [...new Set([...librarySubs, ...libFileTreeSubs])];

      // update library
      library.replace(`media.${libVidIndex}.subtitles`,librarySubs);
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

function getMetadataFromFFmpeg(filepath,id) {
  return new Promise((resolve, reject) => {
    try {
      console.log('Could not find duration with ffprobe, trying with ffmpeg...');
      console.log(filepath);

      let tempFile = `temp-${uuidv4()}.mkv`;

      // var outStream = fs.createWriteStream('output.mkv');

      let cmd = ffmpeg(filepath, {
        // timeout:600
      }).on('codecData', (data) => {
        cmd.kill();

        console.log('==== FFMPEG codecData ====');
        console.log(JSON.stringify(data));
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
        console.log('==== FFMPEG error ====');
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
      console.log('----- Error in getMetadataFromFFmpeg -----');
      reject(err);
    }
  });
}

function findSeasonEpisode(video, fileBasename) {
  let seRegexes = [/[s]?(\d{1,3})(?:[. _]|(?:episode|ep|e)|[. _](?:episode|ep|e))[ _]?(\d{1,3})/i];
  let eRegexes = [/(?:episode|ep|e)?([0-9]{1,3})/i];
  let result = {};
  if (video.collection) {
    //console.log(`findSeasonEpisode: video collection for ${fileBasename} is ${video.collection}`);
    if (video.collection[video.collection.length-1].match(/episode/i)) {
      if (video.collection[video.collection.length-2].match(/season/i)) {
        if (video.collection.length > 2) {
          result.series = video.collection[video.collection.length-3];
        }
      } else if (video.collection.length > 1) {
        result.series = video.collection[video.collection.length-2];
      }
    } else if (video.collection[video.collection.length-1].match(/season/i) && video.collection.length > 1) {
      result.series = video.collection[video.collection.length-2];
    }
  }
  for (let i=0; i<seRegexes.length; i++) {
    let regex  = seRegexes[i];
    let match = fileBasename.match(regex);
    if (match) {
      result.season = match[1].replace(/^0+/, '');
      result.episode = match[2].replace(/^0+/, '');
      //console.log(`seasonEpisode result for ${fileBasename} is ${JSON.stringify(result)}`);
      return result;
    }
  }
  for (let j=0; j<eRegexes.length; j++) {
    let regex  = eRegexes[j];
    let match = fileBasename.match(regex);
    if (match) {
      result.season = null;
      result.episode = match[1].replace(/^0+/, '');
      return result;
    }
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
        if (args.hasOwnProperty('path')) {
          response.success = true;
          response.message = args.path;
          resolve(response);
          // console.log("successfully downloaded file");
        } else {
          // console.log(JSON.stringify(args));
          response.success = false;
          response.message = args;
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

async function autoTag() {
  win.webContents.send('status-update', {action: 'autotag'});
  let newMedia = library.media.filter(medium => (medium.new && !medium.autotag_tried));
  let autoStats = {totalVideos: newMedia.length};
  let autoLog = [];
  let batchSave = []; // we'll batch several videos at a time in this array before saving to the library

  // entire library loop
  for (let i=0; i<newMedia.length; i++) {
    // tell the user what number we're on
    win.webContents.send('status-update', {action: 'autotag', numCurrent: i+1, numTotal: newMedia.length});

    // create new video object
    let newVideo = newMedia[i];
    console.log(`Running autotag on ${newVideo.title}.`);

    // get search results
    let disposition = '';
    let resultsObject = await OmdbHelper.search(newVideo);

    // check results
    if (resultsObject.success) {
      let results = resultsObject.data;
      // if we got more than one result (or an empty array of results, I suppose?)
      if (Array.isArray(results)) {
        // if there were between 1 and 4 results (inclusive), pick the first one
        if (results.length > 0 && results.length <= 4) {
          // in order to pick the first result, we get the imdbID and search again using that
          newVideo.imdbID = results[0].imdbID;
          resultsObject = await OmdbHelper.search(newVideo);
          results = resultsObject.data;
          // if successful in picking the first result, save it
          if (resultsObject.success && !Array.isArray(results)) {
            results.new = false;
            batchSave.push(results);
            // library.replace(`media.id=${newVideo.id}`, results);
            disposition = 'Success';
          } else {
            disposition = 'Failure after getting imdb id??';
          }
        } else {
          // there were too many results (or an empty array of results?)
          // but we still want to save the video object so we can set autotag_tried to true
          //This means we've tried and failed in a predicted manner, let's not try again.
          newVideo.autotag_tried = true;
          batchSave.push(newVideo);
          // library.replace(`media.id=${newVideo.id}`, newVideo);
          disposition = 'Too many results';
        }
      } else {
        // we got just a single result, so save it
        results.new = false;
        batchSave.push(results);
        // library.replace(`media.id=${newVideo.id}`, results);
        disposition = 'Success';
      }
    } else if (resultsObject.failure === 'No results') {
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
      saveBatch(batchSave);
      batchSave = []; // empty batchShave for the next batch
    }

    // some debug logging
    autoStats[disposition] = autoStats[disposition] ? autoStats[disposition] + 1 : 1;
    autoLog.push(`${newVideo.title}: ${disposition}`);
  } // end library loop

  // save any leftovers at the end
  if (batchSave.length > 0) {
    saveBatch(batchSave);
  }

  autoLog.sort();
  console.log('===AutoTag Finished===');
  console.log(JSON.stringify(autoStats));
  console.log(autoLog.join('\n'));

  // clear the user notification
  win.webContents.send('status-update', {action: ''});
}

function saveBatch(batch) {
  let saveMedia = library.media;
  batch.map(newVid => {
    for (let i=0; i<saveMedia.length; i++) {
      if (saveMedia[i].id === newVid.id) {
        saveMedia[i] = newVid;
        break;
      }
    }
  });
  // I don't THINK the following is necessary, because saveMedia is not cloned,
  // but we do need to make sure library.media is getting updated as we go,
  // otherwise queued library saves will overwrite each other's updates
  library.media = saveMedia;
  library.replace('media',saveMedia);
}

async function exportFiles(drive) {
  win.webContents.send('status-update', {action: 'export'});
  console.log(`Starting exportFiles.`);
  let fileLocation = path.join(drive, "Mynda Manifest.json");
  let manifest;
  if (fs.existsSync(fileLocation)) {
    manifest = JSON.parse(fs.readFileSync(fileLocation));
    //console.log('Loaded manifest.')
  } else {
    manifest = {media: []};
    console.log("Couldn't load manifest, assuming all new.")
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
  console.log(`Found ${matchedMedia.length} matches, and ${unmatchedMedia.length} files to export.`);
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
    console.log(availableSpace);
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
        console.log(`${video.title} was copied to ${drive} successfully.`);
      } catch (e) {
        console.log(`There was a problem copying ${video.title} to ${drive}.`);
        console.log(e);
      }
    } else {
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
  console.log(err)
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

        if (err) console.log(err);
      });
    } else {
      // if the user canceled
      console.log('User canceled the folder removal');
      event.sender.send('settings-watchfolder-remove', path, false);
    }

  }).catch(err => {
    console.log(err)
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
  console.log(err)
})});

ipcMain.on('editor-subtitle-select', (event) => {
  let options = {
    filters: [{name: 'Subtitles', extensions: subtitleExtensions}],
    properties: ['openFile']
  };
  dialog.showOpenDialog(null, options).then(result => {
    event.sender.send('editor-subtitle-selected', result.filePaths);
  }).catch(err => {
    console.log(err)
  })
});

ipcMain.on('download', (event, url, destination) => {
    downloadFile(url, destination)
      .then(response => event.sender.send('downloaded', response))
      .catch(response => event.sender.send('downloaded', response))
})

ipcMain.on('autotag', (event) => {
  autoTag();
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
  console.log(err)
})})

ipcMain.on('generic-confirm', (event, returnTo, opts, data) => {
  console.log('generic-confirm!!!');

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
  console.log(err)
})})

ipcMain.on('delete-collection-confirm', (event, collection) => {
  console.log('delete-collection-confirm!!!');

  const id = collection.id;

  let options = {
    type : 'question',
    buttons : ['Remove Videos','Delete Collection(s)','Cancel'],
    message : 'Do you want to delete this entire collection and all its child collections (bearing in mind, it may contain videos that are not in this playlist)?\n\n' +
              'Or would you like to just remove the videos in this playlist from the collection?'
  };

  dialog.showMessageBox(options).then(result => {
  event.sender.send('delete-collection-confirm', result.response, id);
}).catch(err => {
  console.log(err)
})})

ipcMain.on('exportFiles', (event, drive) => {
  exportFiles(drive);
});
