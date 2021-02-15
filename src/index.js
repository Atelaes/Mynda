const electron = require('electron');
const { ipcMain, dialog } = require('electron');
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const {v4: uuidv4} = require('uuid');
const Library = require("./Library.js");
const dl = require('./download');
const _ = require('lodash');

let library = new Library;
const app = electron.app;
const BrowserWindow = electron.BrowserWindow;

app.whenReady().then(start);

function start() {
  eraseTempImages();
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

}

function checkWatchFolders() {
  let folders = library.settings.watchfolders;
  for (let i=0; i<folders.length; i++) {
    let thisFolder = folders[i];
    findVideosFromFolder(thisFolder.path, thisFolder.type);
  }
}

//Takes a full folder address and looks for videos in it,
//adding any it finds to the library
function findVideosFromFolder(folder, kind) {
  const videoExtensions = [
    '3g2', '3gp',  'amv',  'asf', 'avchd', 'avi', 'drc',  'f4a',  'f4b', 'f4p',
    'f4v', 'flv',  'm2ts', 'm2v', 'm4p', 'm4v', 'mkv',  'mov',  'mp2', 'mp4',
    'mpe', 'mpeg', 'mpg',  'mpv', 'mts', 'mxf', 'nsv',  'ogg',  'ogv', 'qt',
    'rm',  'rmvb', 'roq',  'svi', 'ts', 'viv', 'webm', 'wmv',  'yuv'
  ]
  if (isDVDRip(folder)) {
    addDVDRip(folder, kind);
  } else {
    fs.readdir(folder, {withFileTypes : true}, function (err, components) {
      //handling error
      if (err) {
          return console.log('Unable to scan directory: ' + err);
      }
      for (let i=0; i<components.length; i++) {
        let component = components[i];
        let compAddress = path.join(folder, component.name);
        if (component.isDirectory()) {
          findVideosFromFolder(compAddress, kind);
        } else {
          let fileExt = path.extname(component.name).replace('.', '').toLowerCase();
          if (videoExtensions.includes(fileExt)) {
            addVideoFile(compAddress, kind);
          }
        }
      }
    });
  }
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
    "duration" : 0,
    "country" : '',
    "languages" : [],
    "boxoffice" : 0,
    "rated" : '',
    "ratings" : {},
    "dateadded" : '',
    "lastseen" : '',
    "kind" : '',
    "artwork" : '',
    "filename" : ''
  }

//Takes a full directory address and adds it to library
function addDVDRip(folder, kind) {
  if (isAlreadyInLibrary(folder)) {
    return;
  } else {
    addObj = _.cloneDeep(videoTemplate);
    addObj.filename = folder;
    addObj.title = path.basename(folder);
    addObj.kind = kind;
    addObj.id = uuidv4();
    addObj.dateadded = Math.floor(Date.now() / 1000);
    library.add('media.push', addObj);
    console.log('Added DVD rip: ' + addObj.title);
  }
}

//Takes a full file address and adds it to library
function addVideoFile(file, kind) {
  if (isAlreadyInLibrary(file)) {
    return;
  } else {
    addObj = _.cloneDeep(videoTemplate);
    addObj.filename = file;
    let fileExt = path.extname(file)
    addObj.title = path.basename(file, fileExt);
    addObj.kind = kind;
    addObj.id = uuidv4();
    addObj.dateadded = Math.floor(Date.now() / 1000);
    console.log('Added Movie: ' + JSON.stringify(addObj));
    library.add('media.push', addObj);

  }
}

//Takes a full address for a file/folder and checks to see if
//we already have it in the library.
function isAlreadyInLibrary(address) {
  let allMedia = library.media;
  for (let i=0; i<allMedia.length; i++) {
    let currentMedia = allMedia[i];
    if (currentMedia.filename === address) {
      return true;
    }
  }
  return false;
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
      library.add('settings.watchfolders.push', {"path" : path, "kind" : kind});
      findVideosFromFolder(path, kind);
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
    console.log("CALLBACK!!!");
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
