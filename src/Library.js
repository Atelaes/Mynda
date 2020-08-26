
const electron = require('electron');
const path = require('path');
const fs = require('fs');

class Library {
  constructor(opts) {
    this.env = electron.app ? 'server' : 'browser';
    const dataPath = (electron.app || electron.remote.app).getPath('userData');
    // We'll use the `configName` property to set the file name and path.join to bring it all together as a string
    this.path = path.join(dataPath, "library.json");

    const data = this.load();
    ['settings', 'playlists', 'collections', 'media'].map((key) => {this[key] = data[key]});

    this.test = 'initial';
  }

  // Takes a string address in dot format, and adds "addition" to that location.
  add(address, addition) {
    try {
      let addArr = address.split('.');
      let dest = this;
      for (let i=0; i<addArr.length-1; i++) {
        if (Array.isArray(dest)) {
          dest = dest[parseInt(addArr[i])];
        } else {
          dest = dest[addArr[i]];
        }
      }
      if (Array.isArray(dest)) {
        if (Array.isArray(dest[parseInt(addArr[-1])])) {
          dest[parseInt(addArr[-1])].push(addition);
        } else {
          dest[parseInt(addArr[-1])] = addition;
        }
      } else {
        if (Array.isArray(dest[addArr[-1]])) {
          dest[addArr[-1]].push(addition);
        } else {
          dest[addArr[-1]] = (addition);
        }
      }
      sync('add', address, addition)
    } catch(e) {
      console.log("Error with library add event.  Address(" + address + "), Addition(" + addition + ") "  + e.toString());
    }
  }

  // Takes a string address in dot format, and replaces whatever is there with "replacement".
  replace(address, replacement) {

  }

  // Takes a string address in dot format, and removes whatever is there.
  remove(address) {

  }

  // Takes an operation type, a string address in dot format, and optionally an item.
  // Communicates to counterpart library that a change has been made.
  sync(operation, address, item = null) {

  }

  // Takes an operation type, a string address in dot format, and optionally an item.
  // Communicates to counterpart library that it has received and implemented the
  // requested change.
  confirm(operation, address, item = null) {

  }

  //Loads all data into an object and saves that object to file location.
  save() {
    try {
      let saveObj = {};
      ['settings', 'playlists', 'collections', 'media'].map((key) => {saveObj[key] = this[key]});
      fs.writeFileSync(this.path, JSON.stringify(saveObj));
    } catch(e) {
      console.log("Error writing to file: " + e.toString());
    }
  }

  //Loads all data from save file to object.
  load() {
    // We'll try/catch it in case the file doesn't exist yet, which will be the case on the first application run.
    // `fs.readFileSync` will return a JSON string which we then parse into a Javascript object
    try {
      return JSON.parse(fs.readFileSync(this.path));
    } catch(error) {
      // if there was some kind of error, return the passed in defaults instead.
      console.log("No file found, creating default file");
      try {
        fs.writeFileSync(this.path, JSON.stringify(defaultLibrary));
      } catch(e) {
        console.log("Error writing to file: " + e.toString());
      }


      return defaults;
    }
  }

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

// expose the class
module.exports = Library;
