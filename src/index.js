const electron = require('electron');
const { ipcMain, dialog } = require('electron')
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const ReadWrite = require("./ReadWrite.js");

const app = electron.app;
const BrowserWindow = electron.BrowserWindow;
const videoFileExtentions = ['mp4', 'mkv']


app.whenReady().then(createWindow);

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    webPreferences: {
        nodeIntegration: true
    }
  })
  //let userData = new ReadWrite({configName: 'userData', defaults: {}});
  //console.log(app.getPath('userData'));  //userData.set('working', 'Hell yeah!');
  win.webContents.openDevTools()
  //var child = cp.spawn('ffplay', ['E:\\DVD Movies\\Moana.mp4']);

  win.loadFile('src/index.html')

}

function findVideosFromFile(file) {
  fs.readdir(file, {withFileTypes : true}, function (err, subfiles) {
    //handling error
    if (err) {
        return console.log('Unable to scan directory: ' + err);
    }
    //listing all files using forEach
    /* files.forEach(function (file, default) {
        // Do whatever you want to do with the file
        console.log(file);
    });*/
    for (let i=0; i<subfiles.length; i++) {
      let subfile = subfiles[i];
      if (subfile.isDirectory()) {
        //console.log('Going through a DVD folder');
        let subAddress = path.join(file, subfile.name);
        const getDirectories = fs.readdirSync(subAddress, { withFileTypes: true })
        getDirectories.map(subsubItem => {
            if (subsubItem.isDirectory()) {
              //console.log('Going through a DVD subfolder');
              if (!['VIDEO_TS', 'AUDIO_TS', 'JACKET_P', 'common', 'win'].includes(subsubItem.name)) {
                console.log('Found a non-audio/video folder: ' + subsubItem.name + ' in ' + subfile.name);
              } else {
                //console.log('exp');
              }
            }
          })
      }
    }
  });
}

function isDVDRip(folder) {
  
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
  findVideosFromFile(arg['address'], arg['type']);
})
