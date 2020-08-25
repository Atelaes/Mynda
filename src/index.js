const electron = require('electron');
const { ipcMain, dialog } = require('electron')
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const ReadWrite = require("./ReadWrite.js");
let counter = 0;

const app = electron.app;
let library = {} //{"settings" : {}, "playlists" : [], "collections" : [], "media" : []};
const BrowserWindow = electron.BrowserWindow;

app.whenReady().then(loadLibrary).then(createWindow);

function loadLibrary() {
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

  // load library; if no library is found, create default library
  library = new ReadWrite({configName: 'library', extension: 'json', defaults: defaultLibrary });
  console.log(app.getPath('userData'));  //userData.set('working', 'Hell yeah!');
  // library.set('settings',['hi','there']);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    webPreferences: {
        nodeIntegration: true
    }
  })
  win.webContents.openDevTools()
  //var child = cp.spawn('ffplay', ['E:\\DVD Movies\\Moana.mp4']);

  win.loadFile('src/index.html')

}

//Takes a full folder address and looks for videos in it,
//adding any it finds to the library
function findVideosFromFolder(folder) {
  const videoExtensions = ['mp4', 'mkv', 'avi', 'webm', 'mov', 'wmv', 'flv', 'avchd', 'ogv', 'ogg', 'drc', 'mts', 'm2ts', 'ts', 'qt', 'yuv', 'rm', 'rmvb', 'viv', 'asf', 'amv', 'm4p', 'm4v', 'mpg', 'mp2', 'mpeg', 'mpe', 'mpv', 'm2v', 'svi', '3gp', '3g2', 'mxf', 'roq', 'nsv', 'f4v', 'f4p', 'f4a', 'f4b']
  if (isDVDRip(folder)) {
    addDVDRip(folder)
    counter++;
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
          findVideosFromFolder(compAddress);
        } else {
          let fileExt = path.extname(component.name).replace('.', '').toLowerCase();
          if (videoExtensions.includes(fileExt)) {
            addVideoFile(compAddress);
            counter++;
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
function addDVDRip(folder) {
  if (isAlreadyInLibrary(folder)) {
    return;
  } else {
    addObj = {};
    addObj.filename = folder;
    addObj.title = path.basename(folder);
    library.data.media.push(addObj);
    library.set('media', library.data.media)
    console.log('Added DVD rip (' + counter + '): ' + addObj.title);
  }
}

//Takes a full file address and adds it to library
function addVideoFile(file) {
  if (isAlreadyInLibrary(file)) {
    return;
  } else {
    addObj = {};
    addObj.filename = file;
    let fileExt = path.extname(file)
    addObj.title = path.basename(file, fileExt);
    library.data.media.push(addObj);
    library.set('media', library.data.media)
    console.log('Added Movie (' + counter + '): ' + addObj.title);

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
  findVideosFromFolder(arg['address'], arg['type']);
})

ipcMain.on('load-library', (event) => {
  console.log(JSON.stringify(library.data));
  event.returnValue = library.data;
})
