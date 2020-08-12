const electron = require('electron');
const app = electron.app;
const BrowserWindow = electron.BrowserWindow;
const cp = require('child_process');
const ReadWrite = require("./ReadWrite.js");

app.whenReady().then(createWindow);

function createWindow() {
  const win = new BrowserWindow({
    width: 800,
    height: 600
  })
  let userData = new ReadWrite({configName: 'userData', defaults: {}});
  console.log('Is Anyone Listening?');
  userData.set('working', 'Hell yeah!');
  win.webContents.openDevTools()
  //var child = cp.spawn('ffplay', ['E:\\DVD Movies\\Moana.mp4']);

  win.loadFile('index.html')

}
