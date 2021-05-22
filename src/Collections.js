// const { Collection } = require('./Collection.js');
const electron = require('electron');
// const path = require('path');
// const fs = require('fs');
const _ = require('lodash');
// const { ipcRenderer } = require('electron');
// alert(JSON.stringify(Collection));

class Collections {
  constructor(collections) {
    this.c = collections;
    // this.sortAll();
  }

  getAll(copy) {
    return copy ? _.cloneDeep(this.c) : this.c;
  }

  // finds and returns a collection object from its id
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
    return result;
  }

  ensureExists(address) {
    //console.log(`Collections at start of ensure for ${name}: ${JSON.stringify(this.c)}`);
    let target = this.c;
    let topLevel = true;
    for (let layer of address) {
      //console.log(`Current target is ${JSON.stringify(target)}`);
      //console.log(`Current layer is ${layer}`);
      //console.log(`topLevel is ${topLevel}`);
      if (topLevel) {
        if (target.filter(c => c.name === layer).length === 0) {
          let newCollection = {name: layer};
          target = this.addCollection(newCollection, this.c);
        } else {
          target = target.filter(c => c.name === layer)[0];
        }
      } else {
        if (!target.collections || target.collections.filter(c => c.name === layer).length === 0) {
          target = this.addChild(target, layer);
        } else {
          target = target.collections.filter(c => c.name === layer)[0];
        }
      }
      topLevel = false;
    }
    return target;
  }

  // return a flat array of every terminal collection;
  // if includeBarren is true, we also include collections
  // that have neither child collections nor videos
  getAllTerminal(includeBarren) {
    //console.log('GET ALL TERMINAL')
    let results = [];

    this.c.map(c => {
      if (!c) return;
      // c = new Collection(c);
      // console.log(c.id + ' t==' + c.isTerminal);
      if (c.videos || (includeBarren ? (!c.collections || c.collections.length===0) : false)) {
        // console.log('push!');
        results.push(c);
      } else if (c.collections) {
        // console.log('recurse on children')
        let children = new Collections(c.collections);
        results = [...results, ...children.getAllTerminal(includeBarren)];
      }
    });

    //console.log(JSON.stringify(results)/*.map(c => c.name)*/);

    return results;
  }

  // get all collections that the video (of id 'id') is a member of;
  // returns an object of key/value pairs where the key is the id of a collection
  // that the given video participates in, and the value is the order of that video
  // in that collection
  getVideoCollections(id) {
    try {
      let vidCollections = {};
      this.c.map(col => {
        if (!col) return;
        // let col = new Collection(c);
        if (!col.videos) {
          // let children = new Collections(col.getChildren());
          // let positiveChildren = children.c ? children.getVideoCollections(id) : {};
          //
          // vidCollections = {...vidCollections, ...positiveChildren};
          if (col.collections) {
            let children = new Collections(col.collections);
            let childrenResults = children.getVideoCollections(id);
            vidCollections = {...vidCollections, ...childrenResults};
          }
        } else if (this.containsVideo(col,id)) {
          vidCollections[col.id] = this.getVidOrder(col,id);
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
        if (parent) this.removeChild(parent,id);
        console.log('PARENT AFTER DELETE:\n' + JSON.stringify(parent));
      } catch(err) {
        console.error(err);
      }
    // otherwise, it is a top-level collection,
    // so we delete it directly
    } else {
      this.c = this.c.filter(c => !c || c.id !== id);
    }
  }

  addCollection(collection,topLevel) {
    // if the collection we were passed was a Collection class object
    // extract it
    // if (collection.c) {
    //   collection = collection.c;
    // }

    console.log("Collections length: " + this.c.length);

    // create the id based on the highest id of the existing collections;
    // if there are no collections, then we can't create an id,
    // because we have no idea what the id should be
    let noGarbage = this.c.filter(c => !!c);
    console.log("Collections length (minus any garbage entries): " + noGarbage.length);
    if (noGarbage.length > 0) {
      let idArray = noGarbage[0].id.split('-');
      idArray.splice(-1,1,noGarbage.length);
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
      console.error('Error: cannot add a collection to an empty Collections object (unless it is the top-level Collections object); pass the parent collection to Collections.addChild() instead');
      return false;
    }
    this.c.push(collection);

    this.sort();

    // return this.get(collection.id);
    // return new Collection(this.c[this.c.length-1]);
    return this.c.filter(c => c && c.name === collection.name)[0];
  }

  sort() {
    //console.log('Sorting: ' + this.c.map(col => '\n' + (col ? col.name : String(col))))
    // sort the collections array alphabetically (ignoring leading articles)
    this.c.sort((a,b) => {
      // force null values to the end
      if (a === null) return 1;
      if (b === null) return -1;

      // otherwise, sort as normal
      const a_sort = a ? a.name.toLowerCase().replace(/^the\s|^a\s/,'') : '';
      const b_sort = b ? b.name.toLowerCase().replace(/^the\s|^a\s/,'') : '';
      if (a_sort > b_sort)    return 1;
      if (a_sort == b_sort)  return 0;
      if (a_sort < b_sort)    return -1;
    });
    // then we have to adjust their ids (and their children's ids)
    this.c.map((c,i) => {
      if (!c) return;
      const depth = c.id.split('-').length - 1;
      // let col = new Collection(c);
      this.changeID(c,depth,i);
    });

    //console.log('Sorted!!!: ' + this.c.map(col => '\n' + (col ? col.name : String(col))))
  }

  // sorts recursively
  sortAll() {
    this.sort();
    this.c.map(col => {
      if (!col) return;
      if (col.collections) {
        let children = new Collections(col.collections);
        children.sortAll();
      }
    });
  }

  /*******************************************/
  /*******************************************/
  /******** SINGLE COLLECTION METHODS ********/
  /*******************************************/
  /*******************************************/
  // these methods work on a collection object 'c'
  // passed to the method as the first parameter

  // change the id of this collection;
  // id's are descriptive of the collections structure, e.g. the second child
  // of the first child of the 3rd top-level collection will have the id '2-0-1'
  // when we delete or add a new collection, we may need to alter the ids of other
  // collections to preserve this descriptive property;
  // the 'depth' parameter is like an index of which depth to alter in the id;
  // for instance, a value of 1 would indicate that we should change the second
  // number in the id (in our example, the 0); the 'value' parameter is what to change it to;
  // in addition to that, we need to do the same alteration to all of this collections
  // children, grandchildren, etc., so we simply call the same function recursively
  changeID(c,depth,value) {
    if (!c) {
      console.error(`Error: cannot change id of ${c}`);
      return;
    }

    let arrayID = c.id.split('-');
    arrayID[depth] = value;
    c.id = arrayID.join('-');

    if (c.collections) {
      c.collections.map(child => {
        this.changeID(child,depth,value);
      });
    }
  }

  // ---------------------------------- //
  // ---------- METHODS FOR ----------- //
  // ---- NON-TERMINAL COLLECTIONS ---- //
  // ---------------------------------- //

  addChild(c,name) {
    if (!c || c.videos) return; // if c has videos, it is terminal, and a child cannot be added

    console.log(`Adding child to '${c.name}'`);

    let child = {
      id : `${c.id}-${c.collections ? c.collections.length : 0}`,
      name : name || ''
    }

    // if this collection doesn't already have any children
    // we simply add the new collection and return it
    if (!c.collections) {
      c.collections = [];
      c.collections.push(child);
      return c.collections[0];
    } else {
      // if we DO already have some children, then
      // we need to make sure the new collection gets sorted
      // into the correct position (adjusting the ids as necessary);
      // we do that by using a method of the Collections class which handles all that
      let cols = new Collections(c.collections);
      let added = cols.addCollection(child);
      c.collections = cols.getAll();
      return added;
    }
  }

  // only removes an immediate child
  // (though that obviously includes all the descendants of that child)
  // decrements the ID's of all the collections following the deleted child
  removeChild(c,id) {
    // if c has videos, it is terminal, so there is no child to be removed
    // or if it has no collections, same thing
    if (!c || c.videos || !c.collections) return;

    // this.c.collections = this.c.collections.filter(c => c.id !== id);
    let temp = [];
    let afterFlag = false;
    for (let i=0; i < c.collections.length; i++) {
      let col = _.cloneDeep(c.collections[i]);
      if (col.id !== id) {
        if (afterFlag) {
          let idArray = col.id.split('-');
          let depth = idArray.length - 1;
          console.log('idArray: ' + idArray)
          console.log('depth: ' + depth);
          console.log('value: ' + (idArray[depth] - 1));
          this.changeID(col,depth,idArray[depth] - 1);
        }
        temp.push(col);
      } else {
        afterFlag = true;
      }
    }
    if (temp.length > 0) {
      c.collections = temp;
    } else {
      delete c.collections;
    }
  }

  // -------------------------------- //
  // --------- METHODS FOR ---------- //
  // ----- TERMINAL COLLECTIONS ----- //
  // -------------------------------- //


  containsVideo(c,id) {
    if (!c || !c.videos) return false;

    return c.videos.filter(v => v.id === id).length > 0;
  }

  getVidOrder(c,id) {
    if (!c || !c.videos) return;

    try {
      return c.videos.filter(v => v.id === id)[0].order;
    } catch(err) {
      console.log(`Collections.getVidOrder failed to find the order of video ${id}: ${err}`);
      return;
    }
  }

  // id is the video id
  updateOrder(c,id,order) {
    if (!c || !c.videos) return;

    try {
      // this.videos.filter(v => v.id === id)[0].order = order;
      if (this.removeVideo(c,id)) {
        return this.addVideo(c,id,order);
      }
    } catch(err) {
      console.log(`Collections.updateOrder failed to update order of video ${id}: ${err}`);
      return;
    }
    return false;
  }

  // index and order and oldOrder are all optional;
  // in the case of a user drag-n-drop action, we want to respect the index that
  // the user dropped the video at, and adjust the order accordingly
  // (of both the video added and the subsequent videos in the array)
  //
  // if there's no order and no index, we make an order and index by just sticking the video on the end
  // if there's an index but no order, create an order by looking at the surrounding videos (and if there's an oldOrder, we use info from that too, to preserve decimal information where possible)
  // if there's an order but no index, find the index based on the order and the order of the surrounding videos
  addVideo(c, id, order, index, oldOrder) {
    if (!c) return;

    if (!c.videos) {
      // if this collection has child collections, then it cannot become a terminal collection
      // and so we cannot add a video
      if (c.collections) {
        return;
      } else {
        // if it does not have child collections,
        // then we can convert it to a terminal collection
        // by creating a videos array
        c.videos = [];
      }
    }

    // if we don't have an order or an index, we'll stick it on the end,
    // so make the order (an integer) 1 greater than the highest ordered video
    if (!order && (typeof index === 'undefined' || index === null)) {
      let highest = 0;
      c.videos.map(v => {
        if (v.order > highest) {
          highest = v.order;
        }
      });
      order = Math.floor(highest + 1);
    } else if (!order) {
      // if we have an index but NOT an order, make an order based on index

      // if there's a video before this one (that has an order)
      // we'll base it off that
      if (index > 0 && c.videos[index - 1] && c.videos[index - 1].order) {
        let prevOrder = c.videos[index - 1].order;

        // if the video is being dropped between two decimal orders of the same integer value
        if (c.videos[index] && Math.floor(prevOrder) === Math.floor(c.videos[index].order)) {
          // set the new order to 0.1 higher than the previous video
          order = prevOrder + 0.1;

          // otherwise if we have an oldOrder and the old order is not an integer, we want to try to preserve its decimal value
        } else if (oldOrder && !Number.isInteger(oldOrder)) {
          // set the new order either to the integer part of the previous video plus the decimal part of the old order of this video,
          // or to 0.1 higher than the previous video, whichever is higher
          order = Math.max(prevOrder + 0.1,oldOrder - Math.floor(oldOrder) + Math.floor(prevOrder));
        } else {
          // set the video to 1 higher than the previous video
          order = Math.floor(prevOrder) + 1;
        }
      } else {
        // we could not find an order for any previous video, so set the order to 1
        order = 1;
      }
    }

    order = Math.round(Number(order) * 10) / 10;

    // now we should definitely have an order, but we may not have an index,
    // so if we don't, find one based on order
    if (typeof index === 'undefined' || index === null) {
      index = c.videos.length;
      for (let i=0; i<c.videos.length; i++) {
        if (c.videos[i] && c.videos[i].order > order) {
          index = i;
          break;
        }
      }
    }

    // create video object
    let video = {
      id:id,
      order:order
    };

    // place the video at the index
    c.videos.splice(index,0,video);

    // now loop through all the *subsequent* videos and adjust their order property
    // if necessary
    for (let i=index+1; i<c.videos.length; i++) {
      while (c.videos[i].order <= c.videos[i-1].order) {
        // if the order of the latter video is an integer
        if (c.videos[i].order === Math.floor(c.videos[i].order)) {
          console.log("this vid (integer): " + c.videos[i].order);
          console.log("prev vid: " + c.videos[i-1].order);
          // we want to keep it as an integer,
          // so set it to the next greatest integer after the previous video
          // e.g.  #1: 5.4      #1: 5.4
          //       #2: 2    =>  #2: 6
          c.videos[i].order = Math.floor(c.videos[i-1].order) + 1;
        }
        // if the order of the latter video is NOT an integer, we want to preserve
        // the decimal part of the order (or increment it if necessary)
        else {
          console.log("this vid (decimal): " + c.videos[i].order);
          console.log("prev vid: " + c.videos[i-1].order);
          // if the integer part of the latter is less than the former, set the
          // integer part to 1 greater than the former, preserving the decimal part
          // e.g.  #1: 3          #1: 3
          //       #2: 2.1  =>    #2: 4.1
          if (Math.floor(c.videos[i].order) < Math.floor(c.videos[i-1].order)) {
            console.log("integer part is smaller");
            c.videos[i].order += Math.floor(c.videos[i-1].order) - Math.floor(c.videos[i].order) + 1;
          }
          // if the integer part of the latter is the same as the former, set the
          // increment the decimal part
          // e.g.  #1: 2.5        #1: 2.5
          //       #2: 2.1  =>    #2: 2.2 (ultimately reaching 2.6 by the end of the while loop)
          else if (Math.floor(c.videos[i].order) === Math.floor(c.videos[i-1].order)) {
            console.log("integer part is equal");
            c.videos[i].order += .1;
          }
        }
        console.log('new value: ' + c.videos[i].order);
      }
      // round to fix any goofy floating point issues
      c.videos[i].order = Math.round(c.videos[i].order * 10) / 10;
    }

    return true;
  }

  removeVideo(c,id) {
    if (!c || !c.videos) return;
    let index = this._getVidIndex(c,id);
    console.log("index: " + index);
    if (index === -1) return false;

    // let order = this.videos[index].order;

    c.videos.splice(index,1);

    if (c.videos.length === 0) {
      this.convertToNonTerminal(c);
    }

    return true;
  }

  // param should either be an order or a video id
  getNextVideo(c,param) {
    if (!c || !c.videos) return;

    let order;

    if (typeof param === 'string') {
      // then we were given an id
      order = this.getVidOrder(c,param);
      if (typeof order === 'undefined') {
        console.log(`Could not find order of video with id ${param} in ${c.name}`);
        return false;
      }
    } else if (Number.isFinite(param) && param > 0) {
      // then we were given an order
      // in this case we actually don't care if there is a video
      // with that exact order or not; we just want to find and return
      // the id of the video with the next greatest order, if there is one,
      order = param;
    } else {
      console.log('2nd parameter must either be a video id or an order (number > 0)')
      return false;
    }

    let sorted = this._sortVidsByOrder(c);

    for (let video of sorted) {
      if (video.order > order) {
        return video.id;
      }
    }

    console.log(`No videos were found with an order greater than ${order}`)
    return false;
  }

  convertToNonTerminal(c) {
    if (!c) return;

    console.log(`Converting '${c.name}' to non-terminal`)
    delete c.videos;
    // c.isTerminal = false;
  }

  _getVidIndex(c,id) {
    if (!c) return;

    if (!c.videos) return -1;
    // console.log('id: ' + id);
    // console.log('videos: ' + JSON.stringify(this.videos));

    for (let i=0; i<c.videos.length; i++) {
      if (c.videos[i].id === id) {
        return i;
      }
    }

    return -1;
  }

  _sortVidsByOrder(c) {
    if (!c || !c.videos) return;

    return c.videos.sort((a,b) => a.order > b.order ? 1 : (a.order === b.order ? 0 : -1));
  }

  // _sortCollections(c) {
  //   if (c.collections && c.collections.length > 1) {
  //     let cols = new Collections(c.collections);
  //     // let cols = Object.create(Collections.prototype);
  //     // Collections.apply(cols, this.c.collections);
  //     cols.sort();
  //   }
  // }
}


// expose the class
module.exports = Collections;
