
const electron = require('electron');
const path = require('path');
const fs = require('fs');
const _ = require('lodash');
const { ipcRenderer } = require('electron');

class Library {
  constructor() {
    this.env = (electron.app) ? 'server' : 'browser';
    this.browser = null;
    if (this.env === 'server') {
      electron.ipcMain.on('lib-sync-op', (event, message) => {
        message.origin = event.sender;
        this.alter(message)
      });
      electron.ipcMain.on('lib-confirm', (event, message) => {
        this.getConfirm(message)
      });
      electron.ipcMain.on('lib-beacon', (event, message) => {
        this.browser = event.sender;
      });
    } else {
      ipcRenderer.on('lib-sync-op', (event, message) => {
        this.alter(message)
      });
      ipcRenderer.on('lib-confirm', (event, message) => {
        // console.log(`waitConfirm collections is ${JSON.stringify(this.waitConfirm.entry.collections)}`);
        this.getConfirm(message)
      });
      ipcRenderer.send('lib-beacon');
    }

    this.dataPath = (electron.app || electron.remote.app).getPath('userData');
    this.path = path.join(this.dataPath, "Library", "library.json");

    const data = this.load();
    ['settings', 'playlists', 'collections', 'media'].map((key) => {this[key] = data[key]});

    this.Queue = [];
    this.waitConfirm = null;
    // this.lastUpdate = Date.now();
  }

  // Master changing function used by add, replace, and remove.
  //opType: the type of operation (add, replace, remove)
  //address: the location of the operation
  //entry: the item to be placed, not used in remove
  //sync, whether this was prompted by counterpart library
  alter({opType=null, address=null, entry=null, sync=false, origin=null, cb=()=>{}} = {}) {
    console.log(`alter(${opType}, ${address}, ${JSON.stringify(entry)}, ${sync}, ${origin})`);
    try {
      //Start with some basic validation
      if (!['add', 'replace', 'remove'].includes(opType)) {
        throw 'Unrecognized operation type.';
      } else if (['add', 'replace'].includes(opType) && typeof entry === "undefined") {
        throw 'Add or replace operations require entry';
      } else if (opType === 'remove' && entry) {
        throw 'Remove operations should not contain an entry';
      }
      //Get one step away from the location specified by address
      //Most operations won't work if we go all the way
      let addArr = address.split('.');
      let dest = this;
      let addEnd = addArr[addArr.length-1];
      for (let i=0; i<addArr.length-1; i++) {
        dest = dest[addArr[i]];
      }
      //Figure out what we have to do and do it
      //Start with operations on an array
      //Push is used as address terminus if we're just adding to end of array
      if (Array.isArray(dest)) {
        if (addEnd === 'push') {
          switch(opType) {
            case 'add':
              dest.push(entry);
              break;
            default:
              throw "Push can only be used with add.";
          }
        } else {
          switch (opType) {
            case 'add':
              dest.splice(addEnd, 0, entry);
              break;
            case 'replace':
              dest[addEnd] = entry;
              break;
            case 'remove':
              dest.splice(addEnd, 1);
          }
        }
      } else {
        //If we're not in array, then we're in an object
        switch(opType) {
          case 'add':
            if (dest[addEnd]) {
              throw 'Something already exists at that location, use replace.';
            } else {
              dest[addEnd] = entry;
            }
            break;
          case 'replace':
            if (typeof dest[addEnd] !== "undefined") {
              dest[addEnd] = entry;
            } else {
              throw 'Nothing to replace, use add.';
            }
            break;
          case 'remove':
            delete dest[addEnd];
        }
      }
      //If we haven't errored out yet, save to file, communicate with partner library
      if (sync) {
        //If this was requested by other library, let them know we did it
        this.confirm({opType: opType, address: address, entry: entry, sync: sync, origin: origin});
      } else {
        // Start by saving to file.
        this.save();

        //If this was a local operation, request other library mirror it
        this.sync({opType: opType, address: address, entry: entry, sync: sync, origin: origin});

        // execute callback;
        cb();
      }

      // let React know that we've done a save, so that it can perform whatever re-rendering it needs to
      if (this.env === 'browser') {
        savedPing.saved(address);
      }
    } catch(e) {
      console.log(`Error with library alter event.  op: ${opType}, add: ${address}, value: ${JSON.stringify(entry)}, sync: ${sync}, origin: ${origin} - ${e}`);
    }


  }

  // Takes a string address in dot format, and adds "addition" to that location.
  add(address, addition, cb) {
    console.log('adding...')
    this.addToQueue({opType: 'add', address: address, entry: addition, sync: false, origin: null, cb:cb});
  }

  // Takes a string address in dot format, and replaces whatever is there with "replacement".
  replace(address, replacement, cb) {
    this.addToQueue({opType: 'replace', address: address, entry: replacement, sync: false, origin: null, cb:cb});
  }

  // Takes a string address in dot format, and removes whatever is there.
  remove(address, cb) {
    this.addToQueue({opType: 'remove', address: address, entry: null, sync: false, origin: null, cb:cb});
  }

  addToQueue(argObj) {
    if (this.waitConfirm) {
      console.log('Something already in pipeline, adding to queue...')
      this.Queue.push(argObj);
    } else {
      console.log('Nothing in pipeline, performing operation now...')
      this.alter(argObj);
    }
  }

  // Takes an operation type, a string address in dot format, and optionally an item.
  // Communicates to counterpart library that a change has been made that should be mirrored.
  sync(argObj) {
    // tell partner to replicate the action.
    argObj.sync = true;
    if (this.waitConfirm) {
      console.log("Trying to create confirm, but something already at waitConfirm.");
    } else {
      this.waitConfirm = _.cloneDeep(argObj);
      // console.log(`waitConfirm collections is ${JSON.stringify(this.waitConfirm.entry.collections)}`);
    }
    if (this.env === 'server') {
      try {
        console.log('Sending a mirror request to browser');
        this.browser.send('lib-sync-op', argObj);
      } catch(err) {
        console.log('Browser does not exist yet or did not send beacon. Continuing server operation without sending sync operation.');
        this.getConfirm(); // manually call getConfirm to proceed to the next item in queue
      }
    } else {
      console.log('Sending a mirror request to server');
      ipcRenderer.send('lib-sync-op', argObj);
    }
    // console.log(`waitConfirm collections is ${JSON.stringify(this.waitConfirm.entry.collections)}`);
  }

  // Takes an operation type, a string address in dot format, and optionally an item.
  // Communicates to counterpart library that it has received and implemented the
  // requested change.
  confirm(argObj) {
    if (this.env === 'server') {
      let origin = argObj.origin;
      argObj.origin = null;  //This is only added on syncOps received by server.
      origin.send('lib-confirm', argObj);
    } else {
      ipcRenderer.send('lib-confirm', argObj);
    }
  }

  getConfirm(argObj) {
    // console.log(`waitConfirm collections is ${JSON.stringify(this.waitConfirm.entry.collections)}`);
    if (_.isEqual(argObj, this.waitConfirm)) {
      console.log("Got a valid confirmation back, sync operation successful!")
    } else if (typeof argObj === "undefined") {
      // sync op was aborted, getConfirm was called manually by the server (from the sync() function) to move to the next queue item
    } else {
      console.log("Got a confirmation that didn't match what was expected.")
      console.log(argObj);
      console.log(this.waitConfirm);
    }

    this.waitConfirm = null;
    if (this.Queue.length > 0) {
      console.log(`${this.Queue.length} items left in queue, moving to next item...`);
      let nextOp = this.Queue.shift();
      this.alter(nextOp);
    }
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
        let libDir = path.join(this.dataPath, "Library");
        let artDir = path.join(libDir, "Artwork");
        if (!fs.existsSync(libDir)) {
          fs.mkdirSync(libDir);
          fs.mkdirSync(artDir);
        }
        fs.writeFileSync(this.path, JSON.stringify(defaultLibrary));
      } catch(e) {
        console.log("Error writing to file: " + e.toString());
      }


      return defaultLibrary;
    }
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
    "preferences" : {
      "defaultcolumns" : {
        "used" : [
          "title",
          "year",
          "director",
          "genre",
          "seen",
          "ratings_user",
          "dateadded"
        ],
        "unused" : [
          "kind",
          "lastseen",
          "ratings_rt",
          "ratings_imdb",
          "ratings_mc",
          "ratings_avg",
          "boxoffice",
          "rated",
          "country",
          "languages",
          "duration"
        ]
      },
      "defaultdefaultcolumns" : {
        "used" : [
          "title",
          "year",
          "director",
          "genre",
          "seen",
          "ratings_user",
          "dateadded"
        ],
        "unused" : [
          "kind",
          "lastseen",
          "ratings_rt",
          "ratings_imdb",
          "ratings_mc",
          "ratings_avg",
          "boxoffice",
          "rated",
          "country",
          "languages",
          "duration"
        ]
      },
      "hide_description" : "show",
      "override_dialogs" : {},
      "include_user_rating_in_avg": false,
      "include_new_vids_in_playlists": true
    },
    "used" : {
      "kinds" : [
        "movie",
        "show"
      ],
      "genres" : [],
      "tags" : []
    }
  },
  "playlists" : [
    {
      "id" : "new",
      "name" : "New",
      "filter_function" : "video.new === true",
      "view" : "flat",
      "tab" : true,
      "flatDefaultSort" : "dateadded",
      "columns" : [
        "title",
        "dateadded",
        "seen",
        "ratings_user"
      ]
    },
    {
      "id" : "1",
      "name" : "Movies",
      "filter_function" : "video.kind === 'movie'",
      "view" : "flat",
      "tab" : true,
      "columns" : [
        "title",
        "year",
        "director",
        "genre",
        "seen",
        "ratings_user",
        "dateadded"
      ]
    },
    {
      "id" : "2",
      "name" : "Shows",
      "filter_function" : "video.kind === 'show'",
      "view" : "hierarchical",
      "tab" : true,
      "columns" : [
        "title",
        "year",
        "director",
        "genre",
        "seen",
        "ratings_user",
        "dateadded"
      ]
    }
  ],
  "collections" : [],
  "media" : [],
  "inactive_media": []
};

// expose the class
module.exports = Library;
