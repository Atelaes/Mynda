const electron = require('electron');
const { ipcMain, dialog } = require('electron')
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
//const ReadWrite = require("./ReadWrite.js");
const Library = require("./Library.js");

const app = electron.app;
/*let library = new Library;
console.log(library.test);
library.add(1, 0);
console.log(library.test);*/

const BrowserWindow = electron.BrowserWindow;

app.whenReady().then(createWindow);

function loadLibrary() {
  /*
  let defaultLibrary = {
    "settings" : {
      "watchfolders" : [],
      "themes" : {
        "appearances" : [
          {
            "name" : "Dark Theme",
            "path" : "../themes/appearances/dark-theme.css",
            "dependencies" : {
              "fonts" : [],
              "images" : []
            }
          }
        ],
        "layouts" : [
          {
            "name" : "Default Layout Theme",
            "path" : "../themes/layouts/default-layout-theme.css",
            "dependencies" : {}
          }
        ]
      },
      "kinds" : [
        "movie",
        "show"
      ]
    },
    "playlists" : [
      {
        "id" : 0,
        "name" : "Movies",
        "filterFunction" : "video.kind === 'movie'",
        "view" : "flat"
      },
      {
        "id" : 1,
        "name" : "Shows",
        "filterFunction" : "video.kind === 'show'",
        "view" : "hierarchical"
      }
    ],
    "collections" : [],
    "media" : []
  };

  let trialLibrary = new TrialLibraryClass();
  console.log('Library trial: ' + trialLibrary.env);
  // load library; if no library is found, create default library
  library = new ReadWrite({configName: 'library', extension: 'json', defaults: defaultLibrary });
  console.log(app.getPath('userData'));  //userData.set('working', 'Hell yeah!');
  // library.set('settings',['hi','there']);*/
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
  win.webContents.on('did-finish-load', () => {
    //win.webContents.send('lib-init-load', library)
  });

}

//Takes a full folder address and looks for videos in it,
//adding any it finds to the library
function findVideosFromFolder(folder, type) {
  const videoExtensions = [
    '3g2', '3gp',  'amv',  'asf', 'avchd', 'avi', 'drc',  'f4a',  'f4b', 'f4p',
    'f4v', 'flv',  'm2ts', 'm2v', 'm4p', 'm4v', 'mkv',  'mov',  'mp2', 'mp4',
    'mpe', 'mpeg', 'mpg',  'mpv', 'mts', 'mxf', 'nsv',  'ogg',  'ogv', 'qt',
    'rm',  'rmvb', 'roq',  'svi', 'ts', 'viv', 'webm', 'wmv',  'yuv'
  ]
  if (isDVDRip(folder)) {
    addDVDRip(folder, type);
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
          //console.log('Going through a DVD folder');
          findVideosFromFolder(compAddress, type);
        } else {
          let fileExt = path.extname(component.name).replace('.', '').toLowerCase();
          if (videoExtensions.includes(fileExt)) {
            addVideoFile(compAddress);
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

//Takes a full directory address and adds it to library
function addDVDRip(folder, type) {
  if (isAlreadyInLibrary(folder)) {
    return;
  } else {
    addObj = {};
    addObj.filename = folder;
    addObj.title = path.basename(folder);
    addObj.kind = type;
    library.data.media.push(addObj);
    library.set('media', library.data.media)
    console.log('Added DVD rip: ' + addObj.title);
  }
}

//Takes a full file address and adds it to library
function addVideoFile(file, type) {
  if (isAlreadyInLibrary(file)) {
    return;
  } else {
    addObj = {};
    addObj.filename = file;
    let fileExt = path.extname(file)
    addObj.title = path.basename(file, fileExt);
    addObj.kind = type;
    library.data.media.push(addObj);
    library.set('media', library.data.media)
    console.log('Added Movie: ' + addObj.title);

  }
}

//Takes a full address for a file/folder and checks to see if
//we already have it in the library.
function isAlreadyInLibrary(address) {
  let allMedia = library.data.media;
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

ipcMain.on('settings-watchfolder-add', (event, arg) => {
  //Add to library
  findVideosFromFolder(arg['address'], arg['type'].toLowerCase());
})

ipcMain.on('load-library', (event) => {
  console.log(JSON.stringify(library.data));
  event.returnValue = library.data;
})
