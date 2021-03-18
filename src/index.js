const electron = require('electron');
const { ipcMain, dialog } = require('electron');
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const {v4: uuidv4} = require('uuid');
const Library = require("./Library.js");
const dl = require('./download');
const _ = require('lodash');
const ffprobe = require('ffprobe');
const ffprobeStatic = require('ffprobe-static');

let library = new Library;
const app = electron.app;
const BrowserWindow = electron.BrowserWindow;
let libFileTree = {name:'root', folders:[]}; // where we store video and subtitle information we find in the watchfolders prior to adding the videos to the library
let parsing = {}; // this is just to keep track of when we're done looking through all the watchfolders for videos
let addVideoTimeout; // just a delay for adding the videos to the library once we're done parsing, to make sure it only happens once

app.whenReady().then(start);

function start() {
  eraseTempImages();
  checkWatchFolders();
  createWindow();
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
      console.log(`trying to delete ${file}`);
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
  const win = new BrowserWindow({
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

function checkWatchFolders() {
  // setTimeout(() => {
  //   console.log(JSON.stringify(libFileTree));
  // },20000);


  let folders = library.settings.watchfolders;
  for (let i=0; i<folders.length; i++) {
    let thisFolder = folders[i];
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

// recursively maps out the folder structure and files (only videos/DVDs and subtitle files)
// storing the whole thing in libFolderTree;
// once this is done, we'll traverse the tree, adding all the videos to the library
function findVideosFromFolder(folderNode) {
  const id = uuidv4();
  parsing[id] = true;

  const folder = folderNode.path;
  const kind = folderNode.kind;

  const videoExtensions = [
    '3g2', '3gp',  'amv',  'asf', 'avchd', 'avi', 'divx', 'drc',  'f4a',  'f4b', 'f4p',
    'f4v', 'flv',  'm2ts', 'm2v', 'm4p', 'm4v', 'mkv',  'mov',  'mp2', 'mp4',
    'mpe', 'mpeg', 'mpg',  'mpv', 'mts', 'mxf', 'nsv',  'ogg',  'ogv', 'qt',
    'rm',  'rmvb', 'roq',  'svi', 'ts', 'viv', 'webm', 'wmv', 'xvid', 'yuv'
  ]

  const subtitleExtensions = [
    'srt', 'ass', 'ssa', 'vtt', 'usf', 'ttml'
  ];

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
          console.log(`${compAddress} is a DVD rip`);
          folderNode.videos.push({dvd:compAddress}); // add the DVD to libFileTree
        } else {
          // if it's not, recurse on it as a folder
          recursed = true;
          folderNode.folders.push({path:compAddress, kind:kind, folders:[], videos:[], subtitles:[]});
          findVideosFromFolder(folderNode.folders[folderNode.folders.length-1]);
        }
      } else {
        // otherwise, it must be a file
        let fileExt = path.extname(component.name).replace('.', '').toLowerCase();

        if (videoExtensions.includes(fileExt)) {
          // if it's a video file, add it as a video
          console.log(`${compAddress} is a regular video file`);
          folderNode.videos.push(compAddress); // add the video to this node of the libFileTree
          // addVideoFile(folderNode, rootWatchFolder, kind, compAddress, false);
        } else if (subtitleExtensions.includes(fileExt)) {
          // if it's a subtitle file, add it as a subtitle
          console.log(`${compAddress} is a subtitle file`);
          folderNode.subtitles.push(compAddress); // add the subtitles file to this node of the libFileTree
        }
      }
    }

    // folderNode.videos.map(video => {
    //   addVideoFile(folderNode, rootWatchFolder, kind, video, false);
    // });
    parsing[id] = false;
    let stillGoing = false;
    for (let call of Object.keys(parsing)) {
      if (parsing[call] === true) {
        stillGoing = true;
        break;
      }
    }
    if (!stillGoing) addVideosToLibrary();
  });
}

function removeVideosFromLibrary(path) {
  console.log('REMOVING videos from library in ' + path);
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

//Takes a full directory address and adds it to library
// function addDVDRip(rootWatchFolder, folder, kind) {
//   if (isAlreadyInLibrary(folder)) {
//     return;
//   } else {
//     let vidObj = _.cloneDeep(videoTemplate);
//     vidObj.filename = folder;
//     vidObj.title = path.basename(folder);
//     vidObj.kind = kind;
//     vidObj.id = uuidv4();
//     vidObj.dateadded = Math.floor(Date.now() / 1000);
//     library.add('media.push', vidObj);
//
//     console.log('Added DVD rip: ' + vidObj.title);
//   }
// }

function addVideosToLibrary() {
  clearTimeout(addVideoTimeout);
  addVideoTimeout = setTimeout(() => {
    console.log("PARSING IS DONE: ADDING VIDEOS TO LIBRARY!!");

    // walk through libFileTree, adding all the videos to the library
    // (and making our best guess as to which subtitles go with which videos)
    for (let folderNode of libFileTree.folders) {
      addVideosFromFolder(folderNode, folderNode.path);
    }
  },500);
}

function addVideosFromFolder(folderNode, rootFolder) {
  if (folderNode.folders && folderNode.folders.length > 0) {
    for (let childFolder of folderNode.folders) {
      addVideosFromFolder(childFolder, rootFolder);
    }
  }
  if (folderNode.videos && folderNode.videos.length > 0) {
    for (let video of folderNode.videos) {
      addVideoFile(folderNode, video, rootFolder);
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
function addVideoFile(folderNode, file, rootWatchFolder) {
  let isDVD;
  if (file.dvd) {
    isDVD = true;
    file = file.dvd;
  }
  let fileBasename = path.basename(file,path.extname(file));
  console.log(`Adding ${path.basename(file)}${isDVD ? ' (DVD)':''}`);

  // first check for subtitles
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

  // if the video is already in the library, update the subtitles
  // and update the video in the library and then we're done
  let vidIndex = indexOfVideoInLibrary(file);
  if (vidIndex !== null) {
    let video = library.media[vidIndex];
    if (!_.isEqual(video.subtitles,subtitles)) {
      video.subtitles = subtitles;
      library.replace(`media.${vidIndex}`,video);
    }
  } else {
    // otherwise, add the video from scratch
    let vidObj = _.cloneDeep(videoTemplate);
    vidObj.filename = file;
    // let fileExt = path.extname(file);
    // vidObj.title = isDVD ? path.basename(file) : path.basename(file, fileExt);
    vidObj.title = fileBasename;
    vidObj.kind = folderNode.kind;
    vidObj.id = uuidv4();
    vidObj.subtitles = subtitles;
    vidObj.dateadded = Math.floor(Date.now() / 1000); // this will be overwritten by the date of the file's creation, if the OS gives it to us

    // get the date the file was added, from the OS
    fs.stat(file,(err, stats) => {
      if (err) {
        console.log(`Error. Could not retrieve file stats for ${file} : ${err}`);
      } else {
        console.log(`GOT STATS FOR ${file}`);
        console.log(JSON.stringify(stats));

        try {
          vidObj.dateadded = Math.floor(stats.birthtimeMs / 1000);
        } catch(e) {
          console.log(`Unable to add dateadded to file: ${e}`);
        }
      }

      // get video data from the file itself (duration, codec, dimensions, whatever)
      ffprobe(file, { path: ffprobeStatic.path }).then(data => {
        console.log(data);
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
          } catch(err) {
            console.log(`Error storing metadata for ${file}: ${err}`);
          }
        }

      }).catch(err => {
        console.log(`Error retrieving video metadata from ${file} : ${err}`);
      }).finally(() => {
        // add video to library, and add its ID to its watchfolder
        console.log('Adding Movie: ' + JSON.stringify(vidObj));
        library.add('media.push', vidObj);
        library.settings.watchfolders.map((folder,index) => {
          if (folder.path === rootWatchFolder) {
            folder.videos.push(vidObj.id);
            console.log('index is ' + index);
            library.replace('settings.watchfolders.' + index, library.settings.watchfolders[index]);
          }
        });
      });
    });
  }
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
function indexOfVideoInLibrary(address) {
  let allMedia = library.media;
  for (let i=0; i<allMedia.length; i++) {
    let currentMedia = allMedia[i];
    if (currentMedia.filename === address) {
      return i;
    }
  }
  return null;
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
      library.add('settings.watchfolders.push', {"path" : path, "kind" : kind, "videos" : []}, () => {
        checkWatchFolders();
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
              'This will remove all videos in this folder from the library (but will save the metadata in case you decide to add the folder again)'
  };
  dialog.showMessageBox(options).then(result => {
    let removed = false;

    // if the user said okay
    if (result.response === 1) {
      try {
        let index;
        library.settings.watchfolders.map((folder,i) => {
          if (folder.path === path) {
            index = i;
          }
        });
        library.remove(`settings.watchfolders.${index}`);
        removeVideosFromLibrary(path);
        removed = true;
      } catch(err) {
        console.log(err);
      }
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
})})

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
  console.log('save-video-confirm!!!');
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
