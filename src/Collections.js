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
          throw `Could not find collection object: failed at element (depth) ${index} of [${map}]. ${err}`;
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
    try {
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
    } catch(err) {
      console.log(err);
    }
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

  addCollection(collection,topLevel) {
    // if the collection we were passed was a Collection class object
    // extract it
    if (collection.c) {
      collection = collection.c;
    }

    console.log("Collections length: " + this.c.length);

    // create the id based on the highest id of the existing collections;
    // if there are no collections, then we can't create an id,
    // because we have no idea what the id should be
    if (this.c.length > 0) {
      let idArray = this.c[0].id.split('-');
      idArray.splice(-1,1,this.c.length);
      collection.id = idArray.join('-');
    } else if (topLevel) {
      // unless topLevel is true;
      // if we're here, we're adding the first collection
      // to the top level collections object, so the id is simply 0
      collection.id = '0';
    } else {
      // if we're here, we're trying to add a collection to an empty collections object
      // (that isn't the top level object); we can't do that, because we don't know
      // what the id should be, so we do nothing; in this scenario, the Collection.addChild
      // method should be used on the parent collection instead
      console.error('Error: cannot add a collection to an empty Collections object (unless it is the top-level Collections object); use Collection.addChild on the parent collection instead');
      return false;
    }
    this.c.push(collection);
    // return this.get(collection.id);
    return new Collection(this.c[this.c.length-1]);
  }

}


// expose the class
module.exports = Collections;
