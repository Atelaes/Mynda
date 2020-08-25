
const electron = require('electron');
const path = require('path');
const fs = require('fs');

class ReadWrite {
  constructor(opts) {
    // Renderer process has to get `app` module via `remote`, whereas the main process can get it directly
    // app.getPath('userData') will return a string of the user's app data directory path.
    const userDataPath = (electron.app || electron.remote.app).getPath('userData');
    console.log(userDataPath);
    // We'll use the `configName` property to set the file name and path.join to bring it all together as a string
    this.path = path.join(userDataPath, opts.configName + '.' + opts.extension);

    this.data = this._parseDataFile(this.path, opts.defaults);
  }

  // This will just return the property on the `data` object
  get(key) {
    return this.data[key];
  }

  // ...and this will set it
  set(key, val) {
    this.data[key] = val;
    try {
      fs.writeFileSync(this.path, JSON.stringify(this.data));
    } catch(e) {
      console.log("Error writing to file: " + e.toString());
    }
  }

  _parseDataFile(filePath, defaults) {
    // We'll try/catch it in case the file doesn't exist yet, which will be the case on the first application run.
    // `fs.readFileSync` will return a JSON string which we then parse into a Javascript object
    try {
      return JSON.parse(fs.readFileSync(filePath));
    } catch(error) {
      // if there was some kind of error, return the passed in defaults instead.
      console.log("No file found, creating default file");

      // Object.keys(defaults).forEach((key) => {
      //   this.set(key, defaults[key]);
      // });
      try {
        fs.writeFileSync(this.path, JSON.stringify(defaults));
      } catch(e) {
        console.log("Error writing to file: " + e.toString());
      }


      return defaults;
    }
  }
}

// expose the class
module.exports = ReadWrite;
