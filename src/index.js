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
const ffmpeg = require('fluent-ffmpeg');
const ffprobe = require('ffprobe');
const ffprobeStatic = require('ffprobe-static');
const test = require('./test.js');

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
let parsing = {}; // this is just to keep track of when we're done looking through all the watchfolders for videos
let addVideoTimeout; // just a delay for adding the videos to the library once we're done parsing, to make sure it only happens once
let numNewVids = 0; // the number of new videos found whenever we check the watchfolders
let newIDs = [];

app.whenReady().then(start);

async function start() {
  createWindow();  //createWindow needs to come first else we get a big delay.
  eraseTempImages();
  await cleanLibrary();
  checkWatchFolders();
}

function eraseTempImages() {
  let folderPath = path.join((electron.app || electron.remote.app).getPath('userData'),'temp');

  fs.readdir(folderPath, (err, files) => {
    if (err) {
      return console.error('Can\'t delete temp images. Unable to scan directory: ' + err);
    }

    // loop over all the files in the temp folder and delete them
    files.forEach(file => {
      // Do whatever you want to do with the file
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

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    webPreferences: {
        nodeIntegration: true
    }
  })
  win.webContents.openDevTools();
  //var child = cp.spawn('ffplay', ['E:\\DVD Movies\\Moana.mp4']);
  win.loadFile('src/index.html');
  // win.loadFile('src/player.html');
}

// get rid of any null values in media, inactive_media, watchfolders, etc.
function cleanLibrary() {
  return new Promise((resolve,reject) => {
    // library.media.map();
    resolve();
  });
}

function checkWatchFolders() {
  // reset libFileTree
  libFileTree = {name:'root', folders:[]};

  /*
  // first, search library for videos whose files are gone (whether moved, renamed, or deleted)
  // if any are missing, move the video object from library.media to library.inactive_media,
  // where it can be recovered if the file is added back or rediscovered (in the case that it was moved or renamed)
  console.log('-- Checking for deleted/renamed/moved files...');
  let numRemovedVids = 0;
  library.media.map((video, index) => {
    if (!video) return;

    if (!fs.existsSync(video.filename)) {
      numRemovedVids++;

      console.log(`${video.filename} no longer exists...`);
        removeVideo(video, index).catch(err => {
          console.log(err);
        });
    } else {
      // console.log(`${video.filename} still exists!`);

      // erase any duplicate entries of this video that may be in library.inactive_media
      // there shouldn't ever be any, but you never know...
      library.inactive_media.map((i_video, i_index) => {
        if (i_video && i_video.id === video.id) {
          console.log(`Found duplicate entry of ${video.filename} in library.inactive_media under the filename ${i_video.filename}`);
          deleteFromInactive(i_video,i_index);
        }
      });
    }
  });
  console.log(`Done checking for removed files (${numRemovedVids} found).`);*/

  // next, search watchfolders for new files and add any new videos to the library
  console.log(`-- Parsing watchfolder structure, looking for video and subtitle files...`);
  numNewVids = 0; // reset the number of new videos found
  let folders = library.settings.watchfolders;
  for (let i=0; i<folders.length; i++) {
    let thisFolder = folders[i];
    if (thisFolder) {
      let thisNode;
      let filtered = libFileTree.folders.filter(folder => folder.name === thisFolder.path);
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
  if (folders.length === 0) console.log('Done parsing. No watchfolders found.');
}

// recursively maps out the folder structure and files (only videos/DVDs and subtitle files)
// storing the whole thing in libFolderTree;
// once this is done, we'll traverse the tree, adding all the videos to the library
function findVideosFromFolder(folderNode) {
  const id = uuidv4();
  parsing[id] = true;

  const folder = folderNode.path;
  const kind = folderNode.kind;

  // read the contents of this folder
  fs.readdir(folder, {withFileTypes : true}, function (err, components) {
    // handling error
    if (err) {
        return console.log('Unable to scan directory: ' + err);
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
          folderNode.videos.push({dvd:compAddress}); // add the DVD to libFileTree
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

        if (videoExtensions.includes(fileExt)) {
          //console.log(`We're about to add ${component.name} to libTree.`);
          // if it's a video file, add it as a video
          // console.log(`${compAddress} is a regular video file`);
          folderNode.videos.push(compAddress); // add the video to this node of the libFileTree
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

function removeWatchfolder(path) {
  // in case we're currently adding media, we need to delete the removed
  // watchfolder from libFileTree, otherwise videos may get re-added as they get removed
  libFileTree.folders = libFileTree.folders.filter(wf => wf.path !== path);
  console.log('Removing watchfolder from libFileTree');
  console.log(JSON.stringify(libFileTree));

  // remove videos
  removeWatchfolderVideosFromLibrary(path);

  // remove the watchfolder
  try {
    let index;
    library.settings.watchfolders.map((folder,i) => {
      if (folder && folder.path === path) {
        index = i;
      }
    });
    library.remove(`settings.watchfolders.${index}`);

    return true;
  } catch(err) {
    console.log(err);
    return false;
  }
}



async function removeWatchfolderVideosFromLibrary(folder) {
  console.log('REMOVING videos from library in ' + folder);

  let vidIDs;
  try {
    vidIDs = library.settings.watchfolders.filter(wf => wf && wf.path === folder)[0].videos;
  } catch(err) {
    console.log(`Could not find video manifest for the watchfolder ${folder}: ${err}\nGetting list of videos from the library itself`);
    vidIDs = library.media.filter(v => v && new RegExp('^' + folder).test(v.filename)).map(v => v.id);
  }

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

    // remove from library.media
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

  //Recursive function which takes a built libFileTree and figures out collections
  // for videos based on file structure.
  function divineCollections(node, pathStack) {
    if (pathStack.length === 0) {
      //If we're here, then we're looking at root, this should only happen once.
      //console.log(`libTree before divination:  ${JSON.stringify(libFileTree)}`);
    }
    let toDivine = true;
    let count = 0;
    if (toDivine) {
      for (let i=0; i<node.folders.length; i++) {
        let folder = node.folders[i];
        let parentFolder = (node.path) ? node.path + path.sep : '';
        let stackAppend = folder.path.replace(parentFolder, '');
        count += divineCollections(folder, pathStack.concat(stackAppend));
      }
      count += (node.videos) ? node.videos.length : 0;
      if (count > 1 && pathStack.length > 1) {
        node.collection = pathStack.slice(1).join(':');
      }
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
  for (let h=0; h<library.media.length; h++) {
    let video = library.media[h];
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
      for (let i=0; i<library.settings.watchfolders.length; i++) {
        let watchfolder = library.settings.watchfolders[i];
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
        pathComp = pathComp + pathAdd
        let lastOne =  (j === pathComps.length - 1) ? true : false;
        if (!lastOne) {
          for (let k=0; k<libTreeLoc.folders.length; k++) {
            if (libTreeLoc.folders[k].path === pathComp) {
              libTreeLoc = libTreeLoc.folders[k];
              problem = false
              break;
            }
          }
        } else {
          for (let k=0; k<libTreeLoc.videos.length; k++) {
            if (libTreeLoc.videos[k] === filename || libTreeLoc.videos[k].dvd && libTreeLoc.videos[k].dvd === filename) {
              // If we've gotten here, then we have confirmed the video exists,
              // so delete it from libFileTree
              libTreeLoc.videos.splice(k, 1);
              problem = false;
              // Let's also check its subtitles (it would probably be faster)
              // to find these in libFileTree, but that's just too much to code.
              for (let l=0; l<video.subtitles.length; l++) {
                let subAddress = video.subtitles[l];
                if (!fs.existsSync(subAddress)) {
                  library.remove(`media.${h}.subtitles.${l}`);
                }
              }
              break;
            }
          }
        }
        if (problem) {throw true}
      }

    } catch {
      // A thrown error means we didn't find the video where we expected to,
      // so move it to inactive media.
      console.log(`${filename} appears to have disappeared, moving to inactive media.`)
      removeVideo(video);
    }
  }
  //console.log(`libTree after confirm: \n ${JSON.stringify(libFileTree)}`);
  addVideosToLibrary();
}

function addVideosToLibrary() {
  clearTimeout(addVideoTimeout);
  addVideoTimeout = setTimeout(() => {
    console.log("Parsing done, checking parsed tree for new videos/subtitles...");
    //console.log(JSON.stringify(libFileTree));

    // walk through libFileTree, adding all the videos to the library
    // (and making our best guess as to which subtitles go with which videos)
    for (let folderNode of libFileTree.folders) {
      addVideosFromFolder(folderNode, folderNode.path);
    }
  },500);
}

function addVideosFromFolder(folderNode, rootFolder) {
  // If there is a collection assigned to this folder, make sure it exists,
  // and if not, make it.
  if (folderNode.collection) {
    if (!collections.ensureExists(folderNode.collection)) {
      console.log(`We had a problem ensuring collection ${folderNode.collection}.`)
    } else {
      library.replace('collections', collections.getAll());
    }
  }
  if (folderNode.folders && folderNode.folders.length > 0) {
    for (let childFolder of folderNode.folders) {
      addVideosFromFolder(childFolder, rootFolder);
    }
  }
  if (folderNode.videos && folderNode.videos.length > 0) {
    for (let videoFilename of folderNode.videos) {

      addVideoFile(folderNode, videoFilename, rootFolder).catch((err) => {console.log(err)});
    }
  }
}

// Takes a full file address and adds it to library
//    folderNode : the node of libFileTree of the folder enclosing this video;
//                 e.g. {name:'/shows/firefly/season01/', folders: [], videos:[...some videos including this one], subtitles:[...any subtitle files in this folder]}
//                 (DVD folders should be in the videos array, not the folders array)
//    rootWatchFolder : the watch folder in which this video was found
//    file : the path to this file/DVD folder
//    kind : the media kind (e.g. movie, show) determined by the watch folder default
//    isDVD : boolean, is this video a DVD (as opposed to a video file, such as an .mp4)
//    numSisters : for files (not DVD folders), how many other videos are in this same folder (helpful for determining which subtitles may belong to this video)
async function addVideoFile(folderNode, file, rootWatchFolder) {
  let isDVD = false;
  if (file.dvd) {
    isDVD = true;
    file = file.dvd;
  } else {
    //console.log(`addVideoFile called on ${file} and it's not a DVD.`)
  }
  let fileBasename = path.basename(file,path.extname(file));

  // first create the id for this file
  let id = await createVideoID(file);
  //console.log(`Got past hashing on ${file}`)
  // then check for subtitles
  let allSubs = getSubs(folderNode); // get all subtitles from this clade
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

  // If we've divined a collection for videos in this folder, make sure that this
  // video is in it.
  if (folderNode.collection) {
    let folderAddress = folderNode.collection
    // If there are subfolders, we need to ensure a terminal collection for this
    // video to go into named "Other".
    if (folderNode.folders.length > 0) {
      folderAddress = folderNode.collection + `:Other`;
    }
    //Ensure collection exists, add the video to it if not already there, and update.
    if (collections.ensureExists(folderAddress)) {
      let targetCollection = collections.ensureExists(folderAddress);
      if (!collections.containsVideo(targetCollection, id)) {
        collections.addVideo(targetCollection, id);
        library.replace('collections', collections.getAll());
      }
    }
  }

  //########### VIDEO IS ALREADY IN LIBRARY ###########//

  // if the video is already in the library, update the subtitles
  // and update the video in the library, check to make sure the id
  // is in the watchfolder manifest, and then we're done
  let vidIndex = indexOfVideoInLibrary(id);
  if (vidIndex !== null) {
    let video = library.media[vidIndex];
    if (!_.isEqual(video.subtitles,subtitles)) {
      console.log(`Subtitle files have changed for ${fileBasename}. Updating subtitles.`);
      // eventually here, we need to be more sophisticated. We don't want to
      // remove any subtitles the user has manually added from other locations,
      // but we do want to remove any subtitles from the searched folders that
      // no longer exist (as well as adding any new ones);
      // for the moment, all this does is add new ones

      // add any new subtitles, removing duplicates
      video.subtitles = [...new Set([...video.subtitles, ...subtitles])];
      library.replace(`media.${vidIndex}`,video);
    }

    // if the id for this video isn't already in its watchfolder, add it
    // (this shouldn't really ever happen, but just in case)
    library.settings.watchfolders.map((wf,i) => {
      if (!wf) return;
      if (wf.path === rootWatchFolder) {
        if (wf.videos.filter(wf_id => wf_id === id).length === 0) {
          library.add(`settings.watchfolders.${i}.videos.push`,id, (err) => {
            if (err) console.log(`Could not add ${fileBasename}'s id to watchfolder manifest: ${err}`);
          });
        }
      }
    });

    return;
  }

  // If we have another new video with the same id, just skip it for now.
  //Long term we want to mention to user and figure out which to use.
  if (newIDs.includes(id)) {return}
  newIDs.push(id);

  //########### VIDEO IS ** NOT ** ALREADY IN LIBRARY ###########//

  let vidObj;

  // check if the video already has an object in library.inactive_media
  // (this would be the case if it was previously in the library, but was moved/deleted/renamed, or its watchfolder was removed)
  let inactiveVidIndex = indexOfVideoInInactiveMedia(id);
  if (inactiveVidIndex !== null) {
    // ------------- VIDEO IS IN LIBRARY.INACTIVE_MEDIA ------------- //

    // remove the video object from inactive media (it will be added to active media below)
    console.log(`There is a video object for ${fileBasename} in library.inactive_media. Moving to library.media...`);



    try {
      vidObj = _.cloneDeep(library.inactive_media[inactiveVidIndex]);
      vidObj.filename = file; // this is important because the file may have been renamed

      try {
        // update the video's kind based on the watchfolder's default kind;
        // in case the user has changed the default kind, we want to update it when re-adding the video
        vidObj.kind = library.settings.watchfolders.filter(wf => wf && wf.path === rootWatchFolder)[0].kind;
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
    console.log(`Found new video: ${path.basename(file)}${isDVD ? ' (DVD)':''} -- Adding to library`);

    // start creating the video object
    vidObj = _.cloneDeep(videoTemplate);
    vidObj.filename = file;
    // let fileExt = path.extname(file);
    // vidObj.title = isDVD ? path.basename(file) : path.basename(file, fileExt);
    vidObj.title = fileBasename;
    vidObj.kind = folderNode.kind;
    vidObj.id = id;
    try {
      // get the date the file was added, from the OS
      vidObj.dateadded = await getFileBirthtime(file);
    } catch(err) {
      // if we couldn't get the file creation/added date from the OS, just use now
      vidObj.dateadded = Math.floor(Date.now() / 1000);
      console.log(err);
    }

    // get video data from the file itself (duration, codec, dimensions, whatever)
    try {
      // vidObj.metadata = await getVideoMetadata(file);
      let data = await ffprobe(file, { path: ffprobeStatic.path });

      //console.log(data);

      for (const stream of data.streams) {
        try {
          if (stream.codec_type === 'video') {
            vidObj.metadata.codec = stream.codec_name;
            vidObj.metadata.duration = Number(stream.duration);
            vidObj.metadata.width = stream.width;
            vidObj.metadata.height = stream.height;
            vidObj.metadata.aspect_ratio = stream.display_aspect_ratio;
            let f = stream.avg_frame_rate.split('/');
            vidObj.metadata.framerate = Math.round(Number(f[0]) / Number(f[1]) * 100) / 100;
          }
          if (stream.codec_type === 'audio') {
            vidObj.metadata.audio_codec = stream.codec_name;
            vidObj.metadata.audio_layout = stream.channel_layout;
            vidObj.metadata.audio_channels = stream.channels;
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
          console.log(`Error storing metadata for ${file}: ${err}`);
        }
      }

      // some files (.mkv) will give us metadata, but do not store the duration for some reason;
      // in this case, we analyze the file with ffmpeg to obtain the duration
      // (which will be added to the video object later in a separate library call)
      if (!vidObj.metadata.duration) { // value could be either 0 (in case of error) or undefined, if we didn't get a duration
        getDurationFromFFmpeg(file,id);
      }

    } catch(err) {
      console.log(`Unable to retrieve metadata for ${file}: ${err}`);
    }
  }

  //########### ADD VIDEO TO (ACTIVE) LIBRARY ###########//
  //#### BOTH FOR NEW VIDEOS AND FOR INACTIVE VIDEOS ####//

  if (typeof vidObj === 'object' && vidObj !== null) {
    // add any new subtitles, removing duplicates
    vidObj.subtitles = [...new Set([...vidObj.subtitles, ...subtitles])];

    // add video to library, and add its ID to its watchfolder
    console.log('Adding Movie: ' + JSON.stringify(vidObj));
    library.add('media.push', vidObj, (err) => {
      if (err) {
        console.log(err);
      } else {
        // add video's id to its watchfolder's manifest
        library.settings.watchfolders.map((folder,index) => {
          if (!folder) return;
          if (folder.path === rootWatchFolder) {
            folder.videos.push(vidObj.id);
            //console.log('index is ' + index);
            library.replace('settings.watchfolders.' + index, folder);
          }
        });

        // count the new video and tell the browser how many have been added so far
        numNewVids++;
        win.webContents.send('videos_added',numNewVids);
      }
    });
  }
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

function getSubs(folderNode) {
  let subs = [];
  // get subtitles from this folder
  if (folderNode.subtitles) {
    subs = [...folderNode.subtitles];
  }
  // get subtitles from all child folders
  if (folderNode.folders) {
    for (let folder of folderNode.folders) {
      subs = [...subs,...getSubs(folder)];
    }
  }
  return subs;
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

function getDurationFromFFmpeg(filepath,id) {
  try {
    //console.log('Could not find duration with ffprobe, trying with ffmpeg...');
    //console.log(filepath);

    let tempFile = `temp-${uuidv4()}.mkv`;

    // var outStream = fs.createWriteStream('output.mkv');

    let cmd = ffmpeg(filepath, {
      // timeout:600
    }).on('codecData', (data) => {
      cmd.kill();

      //console.log('==== FFMPEG codecData ====');
      //console.log(JSON.stringify(data));
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

        // update video in library with new duration.
        for (let i=0; i<library.media.length; i++) {
          if (library.media[i].id === id) {
            //console.log(`Saving duration of ${seconds} seconds to library for ${library.media[i].title}`);
            library.replace(`media.${i}.metadata.duration`,seconds);
            break;
          }
        }

      }
    }).on('end', (stdout, stderr) => {
      //console.log('==== FFMPEG end ====');
      //console.log(stdout);
    }).on('error', (err) => {
      // console.log('==== FFMPEG error ====');
      console.log(err.message);
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
    console.log('----- Error in getDurationFromFFmpeg: ' + err);
  }
}


ipcMain.on('settings-watchfolder-select', (event) => {
  let options = {properties: ['openDirectory']};
  dialog.showOpenDialog(null, options).then(result => {
  event.sender.send('settings-watchfolder-selected', result.filePaths[0]);
}).catch(err => {
  console.log(err)
})})

ipcMain.on('settings-watchfolder-add', (event, args) => {
  const path = args['address'];
  const kind = args['kind'].toLowerCase();

  // check if path exists and is a folder, not a file
  fs.lstat(path, (err, stats) => {
    // if path exists and is a folder
    if(!err && stats.isDirectory()) {
      // add to library
      let folderObject = {"path" : path, "kind" : kind, "videos" : []};
      library.add('settings.watchfolders.push', folderObject, () => {
        checkWatchFolders();
        // tell the client side what happened
        // event.sender.send('settings-watchfolder-added', _.cloneDeep(folderObject), numNewVids);
      });
      // findVideosFromFolder(path, path, kind);
    } else {
      // if not, display an error dialog
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
              'This will remove all videos in this folder from the library (but will save the video information in case you decide to add the folder again)'
  };
  dialog.showMessageBox(options).then(result => {
    let removed = false;

    // if the user said okay
    if (result.response === 1) {
      removed = removeWatchfolder(path);
    } else {
      // if the user canceled
      console.log('User canceled the folder removal');
    }

    // tell the client side what happened
    event.sender.send('settings-watchfolder-remove', path, removed);
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
  let response = {success:false, message:''};
  // event.sender.send('cancel-download', dl.canceller, "hi");
  dl.download(url,destination, (args) => {
    try {
      // if successful, we'll receive an object with the path at "path"
      if (args.hasOwnProperty('path')) {
        response.success = true;
        response.message = args.path;
        // console.log("successfully downloaded file");
      } else {
        // console.log(JSON.stringify(args));
        response.success = false;
        response.message = args;
      }
    } catch(error) {
      response.success = false;
      response.message = error;
      // console.log(error);
    }
    event.sender.send('downloaded', response);
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
