const Collection = require('./Collection.js');
const electron = require('electron');
// const path = require('path');
// const fs = require('fs');
const _ = require('lodash');
// const { ipcRenderer } = require('electron');
// alert(JSON.stringify(Collection));

class Collections {
  constructor(collections) {
    this.c = collections;
  }

  getAll(copy) {
    return copy ? _.cloneDeep(this.c) : this.c;
  }

  // finds and returns a collection object in <collectionsRoot> from its id (<id>);
  get(id) {
    // initially set collections to the root of the master collections array
    // then we'll walk down the tree using the id, which is descriptive of the tree structure
    let collections = this.c;

    // split the id into an array that we can loop over
    const map = id.split('-');

    // find the collection object by traversing the id
    let result;
    try {
      map.map((nodeIndex, index) => {
        try {
          result = collections[nodeIndex];
          if (collections[nodeIndex].collections) {
            collections = collections[nodeIndex].collections;
          }
        } catch (err) {
          throw `Could not find collection object: failed at element ${index} of ${map}. ${err}`;
        }
      });
    } catch(err) {
      console.error(err);
      // in case of error, return nothing
      return;
    }

    // return the collection
    return new Collection(result);
  }

  // get all collections that the video (of id 'id') is a member of;
  // returns an object of key/value pairs where the key is the id of a collection
  // that the given video participates in, and the value is the order of that video
  // in that collection
  getVideoCollections(id) {
    let vidCollections = {};
    this.c.map(c => {
      let col = new Collection(c);
      if (!col.isTerminal) {
        let children = new Collections(col.getChildren());
        let positiveChildren = children ? children.getVideoCollections(id) : {};

        vidCollections = {...vidCollections, ...positiveChildren};
      } else if (col.containsVideo(id)) {
        vidCollections[col.id] = col.getVidOrder(id);
      }
    });
    return vidCollections;
  }

  deleteCollection(id) {
    // if the id contains a dash, it's not a top-level collection
    if (/-/.test(id)) {
      try {
        // so we delete it by finding its parent and calling the removeChild method
        const parentID = id.match(/[\d-]+(?=-\d+$)/)[0];
        const parent = this.get(parentID);
        console.log('PARENT:\n' + JSON.stringify(parent));
        if (parent) parent.removeChild(id);
        console.log('PARENT AFTER DELETE:\n' + JSON.stringify(parent));
      } catch(err) {
        console.error(err);
      }
    // otherwise, it is a top-level collection,
    // so we delete it directly
    } else {
      this.c = this.c.filter(c => c.id !== id);
    }
  }

}


// expose the class
module.exports = Collections;
