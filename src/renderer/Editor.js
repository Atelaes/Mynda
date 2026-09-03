// Editor pane, OMDb search workflow, and the complete edit form.
const React = require('react');
const electron = require('electron');
const {ipcRenderer} = require('electron');
const _ = require('lodash');
const fs = require('fs');
const path = require('path');
const {v4: uuidv4} = require('uuid');
const accounting = require('accounting');
const hashObject = require('object-hash');
const OmdbHelper = require('../OmdbHelper.js');
const {
  library,
  editorLog,
  artworkLog,
  placeholderImage,
  sendLocalStatusUpdate
} = require('./RendererRuntime.js');
const {
  editorSelectionKey,
  parseEditableEpisodeNumber,
  editorRatingValuesEqual,
  updateEditorChangedField,
  validateVideo,
  isValidURL
} = require('./RendererUtils.js');
const {
  MynOpenablePane,
  MynOverflowTextMarquee,
  MynParagraphFolder
} = require('./SharedComponents.js');
const {
  MynEditRatings,
  MynEditText,
  MynEditArtwork,
  MynEditSeenWidget,
  MynEditWatchlaterWidget,
  MynEditRatingWidget,
  MynEditPositionWidget,
  MynEditListWidget,
  MynEditAddToList,
  MynEditInlineAddListWidget,
  MynEditSubtitles,
  MynEditDateWidget
} = require('./EditorFields.js');

let nextFilenameResetNumber = 0;

// ###### Editor: overlayed pane for editing video information (tagging) ###### //
class MynEditor extends MynOpenablePane {
  constructor(props) {
    super(props)

    this._isMounted = false;

    this.state = {
      paneID: 'editor-pane',
      placeholderImage: placeholderImage,
      valid: {},
      changed: new Set(),

      // Batch fields normally hold one value that is applied to every video.
      // A filename reset is different: each episode gets its own detected
      // title/season/episode. Keep those individual patches here until Save.
      pendingFilenameResetPatches: {},

      // The main process derives the patches and owns the native confirmation
      // dialog. While that round trip is pending, prevent a form submission
      // from racing ahead and saving before the patches reach the renderer.
      resetFromFilenamePending: false,

      // This remains true after confirmation until Save or Revert. It also
      // covers single-video resets, which apply their patch directly to the
      // editable video rather than storing a per-video batch patch.
      filenameResetStaged: false
    }

    this.render = this.render.bind(this);
    this.handleChange = this.handleChange.bind(this);
    this.revertChanges = this.revertChanges.bind(this);
    this.requestResetFromFilename = this.requestResetFromFilename.bind(this);
    this.saveChanges = this.saveChanges.bind(this);
    this.reportValid = this.reportValid.bind(this);
  }

  reportValid(property,valid) {
    if (typeof valid === 'boolean' && property !== undefined) {
      this.state.valid[property] = valid;
    }
  }

  // handleChange(value,prop) {
  //   // console.log('Editing ' + prop);
  //   let update = this.state.video;
  //   update[prop] = value;
  //   this._isMounted && this.setState({data : update});
  // }

  handleChange(...args) {
    // console.log("UPDATING");

    let update;
    let suppliedChanges;
    const previousSeries = this.state.video && this.state.video.series;
    const previousKind = this.state.video && this.state.video.kind;
    // if we were passed two arguments, treat them as prop,value
    if (args.length == 2 && typeof args[0] === "string") {
      suppliedChanges = {[args[0]]: args[1]};
      update = this.state.video;
      update[args[0]] = args[1];

      updateEditorChangedField(
        this.state.changed,
        this.state.video,
        this.state.batchObjectUnedited,
        args[0],
        args[1]
      );
    }
    // if we were passed one argument, it should be an object, where
    // the keys are video props, and the values are those props' values
    else if (args.length == 1 && typeof args[0] === "object") {
      //console.log(JSON.stringify(args[0]));
      suppliedChanges = args[0];
      update = { ...this.state.video, ...args[0] };
      //console.log(JSON.stringify(update));

      Object.keys(args[0]).map(field => {
        updateEditorChangedField(
          this.state.changed,
          this.state.video,
          this.state.batchObjectUnedited,
          field,
          args[0][field]
        );
      });
    } else {
      throw 'Incorrect parameters passed to handleChange in MynEditor';
    }

    // seriesImdbID identifies the parent show represented by `series`. A
    // manual series rename makes the old ID unsafe, and changing a video's
    // kind away from show makes it meaningless. Explicit OMDb results include
    // their own seriesImdbID and therefore are not cleared here.
    const suppliedSeries = Object.prototype.hasOwnProperty.call(suppliedChanges, 'series');
    const suppliedSeriesID = Object.prototype.hasOwnProperty.call(suppliedChanges, 'seriesImdbID');
    const seriesChanged = suppliedSeries && suppliedChanges.series !== previousSeries;
    const kindChangedAwayFromShow =
      Object.prototype.hasOwnProperty.call(suppliedChanges, 'kind') &&
      suppliedChanges.kind !== previousKind && suppliedChanges.kind !== 'show';
    const batchWillSaveSeries = this.state.video && this.state.video.id === 'batch' ?
      this.state.changed.has('series') : true;

    if ((seriesChanged && !suppliedSeriesID && batchWillSaveSeries) || kindChangedAwayFromShow) {
      update.seriesImdbID = '';
      // Empty values are normally removed from the batch changed set. This
      // empty value is an intentional clear and must be applied to every video
      // whose series/kind edit invalidated the old parent ID.
      this.state.changed.add('seriesImdbID');
    }

    this._isMounted && this.setState({video : update});

    // just for debugging:
    let changedFields = []
    this.state.changed.forEach(field => {changedFields.push(field)});
    editorLog.debug('Editor changed fields updated', {
      videoID: this.state.video && this.state.video.id,
      changedFields: changedFields.sort()
    });
  }

  revertChanges() {
    this.componentDidUpdate({video:null});

  }

  // Ask the main process to rerun the same conservative filename/folder
  // detector used for brand-new videos. The native confirmation explains the
  // wider reset (IMDb/catalog fields are cleared), and a private response
  // channel prevents simultaneous editor actions from hearing one another.
  requestResetFromFilename(event) {
    if (event) event.preventDefault();
    if (!this.state.video) return;
    if (this.state.resetFromFilenamePending) {
      editorLog.warn('Ignored duplicate filename-reset request while the first request was pending');
      return;
    }

    let sourceVideos;
    if (this.state.video.id === 'batch') {
      sourceVideos = (this.props.batch || []).map(video => {
        const source = _.cloneDeep(video);

        // Ratings are one object in the editor, but only the external catalog
        // ratings are reset. Carry a pending batch user-rating edit into every
        // source object so the backend can preserve that unsaved value too.
        const batchUserRatingChanged = this.state.video.ratings &&
          this.state.batchObjectUnedited && this.state.batchObjectUnedited.ratings &&
          !editorRatingValuesEqual(
            this.state.video.ratings.user,
            this.state.batchObjectUnedited.ratings.user
          );
        if (batchUserRatingChanged) {
          source.ratings = source.ratings || {};
          source.ratings.user = this.state.video.ratings.user;
        }
        return source;
      });
    } else {
      sourceVideos = [this.state.video];
    }
    if (!sourceVideos || sourceVideos.length === 0) return;

    const requestedSelectionKey = editorSelectionKey(this.state.video, this.props.batch);
    const responseChannel = `reset-from-filename-${process.pid}-${++nextFilenameResetNumber}`;
    this.setState({resetFromFilenamePending: true});
    editorLog.info('Requesting filename-derived editor reset', {
      videoCount: sourceVideos.length,
      selectionType: this.state.video.id === 'batch' ? 'batch' : 'single',
      changedFieldsBeforeReset: Array.from(this.state.changed).sort()
    });

    const handleResetResponse = (ipcEvent, response) => {
      // The native dialog can remain open while the renderer changes for other
      // reasons. Never apply its eventual response to a different selection.
      const currentSelectionKey = editorSelectionKey(this.state.video, this.props.batch);
      if (currentSelectionKey !== requestedSelectionKey) {
        editorLog.warn('Ignored filename-reset response because the editor selection changed', {
          requestedSelectionKey: requestedSelectionKey,
          currentSelectionKey: currentSelectionKey
        });
        this._isMounted && this.setState({resetFromFilenamePending: false});
        return;
      }

      if (response && response.error) {
        editorLog.error('Filename-derived editor reset failed', {
          error: response.error
        });
        this.setState({resetFromFilenamePending: false});
        alert(`Mynda could not reset the video information: ${response.error}`);
        return;
      }
      if (!response || !response.confirmed || !Array.isArray(response.patches)) {
        editorLog.info('Filename-derived editor reset canceled', {
          videoCount: sourceVideos.length
        });
        this.setState({resetFromFilenamePending: false});
        return;
      }

      const patchesByID = {};
      response.patches.forEach(item => {
        if (item && item.id && item.changes) {
          patchesByID[item.id] = item.changes;
        }
      });
      const patches = Object.values(patchesByID);
      if (patches.length === 0) {
        editorLog.warn('Filename-reset response contained no usable patches', {
          requestedVideoCount: sourceVideos.length
        });
        this.setState({resetFromFilenamePending: false});
        return;
      }

      const resetFields = new Set();
      patches.forEach(patch => Object.keys(patch).forEach(field => resetFields.add(field)));

      // A reset deliberately replaces any unsaved edits to fields that it
      // controls. Changes to unrelated user fields, notably tags, remain in
      // the ordinary changed set and will still be applied at Save time.
      const changed = new Set(
        Array.from(this.state.changed).filter(field => !resetFields.has(field))
      );

      if (this.state.video.id !== 'batch') {
        const patch = patchesByID[this.state.video.id];
        if (!patch) {
          editorLog.warn('Filename-reset response did not contain the open video', {
            requestedVideoCount: sourceVideos.length,
            receivedPatchCount: patches.length
          });
          this.setState({resetFromFilenamePending: false});
          return;
        }

        Object.keys(patch).forEach(field => changed.add(field));
        this.setState({
          video: {...this.state.video, ..._.cloneDeep(patch)},
          changed: changed,
          pendingFilenameResetPatches: {},
          resetFromFilenamePending: false,
          filenameResetStaged: true
        });
        editorLog.info('Staged filename-derived reset in the editor', {
          videoCount: 1,
          patchCount: 1,
          resetFields: Array.from(resetFields).sort(),
          changedFieldsAfterReset: Array.from(changed).sort()
        });
        return;
      }

      // The batch form can display only values shared by every video. Build a
      // preview of the reset fields using the same intersection rules as the
      // original batch object, while retaining every per-video patch for Save.
      const commonPatch = {};
      resetFields.forEach(field => {
        let commonValue = _.cloneDeep(patches[0][field]);
        for (let i=1; i<patches.length; i++) {
          const value = patches[i][field];
          if (Array.isArray(commonValue) && Array.isArray(value)) {
            commonValue = commonValue.filter(item => value.includes(item));
          } else if (commonValue && typeof commonValue === 'object' && value && typeof value === 'object') {
            Object.keys(commonValue).forEach(key => {
              if (!_.isEqual(commonValue[key], value[key])) commonValue[key] = '';
            });
          } else if (!_.isEqual(commonValue, value)) {
            commonValue = '';
          }
        }
        commonPatch[field] = commonValue;
      });

      this.setState({
        video: {...this.state.video, ...commonPatch},
        changed: changed,
        pendingFilenameResetPatches: patchesByID,
        resetFromFilenamePending: false,
        filenameResetStaged: true
      });
      editorLog.info('Staged filename-derived batch reset in the editor', {
        requestedVideoCount: sourceVideos.length,
        receivedPatchCount: patches.length,
        resetFields: Array.from(resetFields).sort(),
        changedFieldsAfterReset: Array.from(changed).sort()
      });
    };

    ipcRenderer.once(responseChannel, handleResetResponse);
    try {
      ipcRenderer.send('reset-from-filename', responseChannel, sourceVideos);
    } catch(err) {
      ipcRenderer.removeListener(responseChannel, handleResetResponse);
      this.setState({resetFromFilenamePending: false});
      editorLog.error('Could not request filename-derived editor reset', {
        error: err && err.stack ? err.stack : String(err)
      });
    }
  }

  saveChanges(event) {
    if (event) {
      event.preventDefault();
    }

    // A form can still submit via Enter even when its visible submit button is
    // disabled. Refuse that race explicitly so Save cannot run between the
    // reset request and the arrival of its per-video patches.
    if (this.state.resetFromFilenamePending) {
      editorLog.warn('Blocked editor save while filename reset was pending');
      alert('Please wait for the filename reset to finish before saving.');
      return;
    }

    /* make sure all the fields are valid before submitting */
    // console.log("VALID: " + JSON.stringify(this.state.valid));
    let valid = true;
    let invalidFields = [];
    for (var i=0, keys=Object.keys(this.state.valid); i<keys.length; i++) {
      if (this.state.valid[keys[i]] == false) {
        valid = false;
        invalidFields.push(keys[i]);
      }
    }
    if (!valid) {
      alert("Invalid Input in " + invalidFields);
      return;
    }

    // Before saving, we need to move the artwork image to the appropriate
    // folder in the user data. In the case of a new image, it may either be
    // in its original location on the user's local drive (in the case that
    // the user browsed to it or entered its path manually), or it may be
    // saved in a temp folder (in the case that it was downloaded from a URL)
    if (this._isMounted && typeof this.state.video.artwork === 'string' && this.state.video.artwork !== '') {
      let fileExt;
      try {
        fileExt = this.state.video.artwork.match(/.\w{3,4}$/)[0];
      } catch(err) {
        fileExt = '.jpg'; // just use .jpg as the extension if we can't find one, i guess?
      }

      const artworkFolder = path.join((electron.app || electron.remote.app).getPath('userData'),'Library','Artwork');
      const oldArtworkPath = path.resolve(__dirname, this.state.video.artwork); // create the correct absolute path, in case it was a relative one
      // if the file is not already in the Artwork folder,
      // copy it there and update the reference to it in the video object
      if (path.resolve(path.dirname(oldArtworkPath)) !== path.resolve(artworkFolder)) {
        const newArtworkPath = path.join(artworkFolder, uuidv4() + fileExt);
        fs.copyFile(oldArtworkPath, newArtworkPath, (err) => {
          if (err) {
            artworkLog.error('Could not copy editor artwork into the library artwork folder', {
              source: oldArtworkPath,
              destination: newArtworkPath,
              error: err
            });
          } else {
            artworkLog.info('Editor artwork copied into the library artwork folder', {
              destination: newArtworkPath
            });
          }
        });
        // this.handleChange({'artwork':newArtworkPath}); // <-- I think this was happening too slowly (part of the function is async), so the new path was not being saved
        this.state.video.artwork = newArtworkPath;
        artworkLog.debug('Editor artwork path updated', {
          videoID: this.state.video.id,
          artwork: this.state.video.artwork
        });
      } else {
        artworkLog.debug('Editor artwork already uses the library artwork folder', {
          videoID: this.state.video.id,
          artwork: oldArtworkPath
        });
      }
    }

    /* Submit */
    // console.log('saving...');

    // When a batch is saved, this object remains non-null until the final
    // queued library operation reports completion. The edited videos are
    // prepared individually below, but Library commits the resulting media
    // array with one atomic write instead of rewriting library.json per video.
    let batchSaveProgress = null;
    let batchVideosToSave = [];

    // if we're editing multiple videos
    // find the edited fields, and apply only those changes to
    // the videos in the batch
    if (this.state.video.id === 'batch') {
      // Reminder: this.state.video is the edited 'batch object',
      // initially containing the values of the elements all the videos have in common,
      // and now also containing any changes the user made in the editor,
      // which we will now apply to the videos and then save them

      editorLog.debug('Batch save requested', {
        videoCount: this.props.batch ? this.props.batch.length : 0,
        changedFields: Array.from(this.state.changed).sort()
      });
      if (this.props.batch) { // <-- this should always be true if this.state.video.id === 'batch', this is just for safety
        const changedFields = Array.from(this.state.changed).sort();
        const filenameResetPatches = this.state.pendingFilenameResetPatches || {};
        const filenameResetPatchCount = Object.keys(filenameResetPatches).length;

        // A confirmed batch reset must have one private patch per selected
        // video. If that invariant is ever broken, stop instead of silently
        // saving only the user's ordinary overrides (the original symptom).
        if (this.state.filenameResetStaged && filenameResetPatchCount !== this.props.batch.length) {
          editorLog.error('Blocked batch save because staged filename-reset patches were incomplete', {
            videoCount: this.props.batch.length,
            filenameResetPatchCount: filenameResetPatchCount,
            changedFields: changedFields
          });
          alert('The filename reset data is incomplete, so Mynda has not saved this batch. Please use Reset from Filename again.');
          return;
        }

        editorLog.info('Preparing editor batch save', {
          videoCount: this.props.batch.length,
          filenameResetStaged: Boolean(this.state.filenameResetStaged),
          filenameResetPatchCount: filenameResetPatchCount,
          changedFields: changedFields
        });

        batchSaveProgress = {
          numCurrent: 0,
          numTotal: this.props.batch.length
        };

        // Show the banner before the first synchronous file write begins. With
        // only numTotal supplied, MynNotify initially says "Saving N videos";
        // subsequent callbacks add the familiar "X of N" counter.
        if (batchSaveProgress.numTotal > 0) {
          sendLocalStatusUpdate({
            action: 'batch_save',
            numTotal: batchSaveProgress.numTotal
          });
        }

        // loop through the videos we're editing
        this.props.batch.map(video => {
          // Unlike ordinary batch edits, this reset contains a different
          // derived title/season/episode for each file. Apply that video's
          // private patch first; any fields the user edited afterwards are
          // applied by the normal changed-fields loop below and therefore win.
          const filenameResetPatch = filenameResetPatches[video.id];
          if (filenameResetPatch) {
            Object.assign(video, _.cloneDeep(filenameResetPatch));
          }

          // loop through each property of this video
          Object.keys(video).map(prop => {
            if (prop === 'id' || prop === 'metadata') return;

            // if this property was changed
            if (this.state.changed.has(prop)) {
              if (Array.isArray(this.state.video[prop])) {
                // if this property is an array, we need to compare individual array elements

                // deleted any of the common elements that the user deleted
                let deleted = this.state.batchObjectUnedited[prop].filter(el => !this.state.video[prop].includes(el));
                video[prop] = video[prop].filter(el => !deleted.includes(el));

                // add any new elements the user added
                let added = this.state.video[prop].filter(el => !this.state.batchObjectUnedited[prop].includes(el)).filter(el => !video[prop].includes(el));
                video[prop] = [...video[prop], ...added];

              } else if (typeof this.state.video[prop] === 'object' && this.state.video[prop] !== null) {
                // if this property is an object, we need to compare individual object properties

                let original = this.state.batchObjectUnedited[prop];
                let altered = this.state.video[prop];

                // any props that were in the original batch object (common to all videos)
                // and were changed, add the change to this video
                Object.keys(original).map(subProp => {
                  const subPropChanged = prop === 'ratings' ?
                    !editorRatingValuesEqual(altered[subProp], original[subProp]) :
                    altered[subProp] !== original[subProp];
                  if (subPropChanged) {
                    video[prop][subProp] = altered[subProp];
                  }
                });
                // any props that were not in the original batch object but were added,
                // add the change to this video
                Object.keys(altered).map(subProp => {
                  const newlyAddedRatingIsEmpty = prop === 'ratings' &&
                    editorRatingValuesEqual(altered[subProp], original[subProp]);
                  if (typeof original[subProp] === "undefined" && !newlyAddedRatingIsEmpty) {
                    video[prop][subProp] = altered[subProp];
                  }
                });

              } else {
                // this property is not an array or an object,
                // so we simply replace the old value with the edited value
                video[prop] = this.state.video[prop];
              }
            }
          });
          editorLog.debug('Prepared edited video for batch save', {
            videoID: video.id,
            title: video.title,
            changedFields: changedFields
          });

          // Prepare this video's final replacement. Do not submit it yet:
          // replaceMediaBatch() will merge every prepared video into the
          // freshest media array and commit that array with one library write.
          let temp = _.cloneDeep(video);
          temp.seriesImdbID = temp.kind === 'show' &&
            typeof temp.seriesImdbID === 'string' ? temp.seriesImdbID : '';
          temp.autotag_tried = false; // reset this flag whenever a video is saved
          // Transient signal for Library.js; it is removed before saving.
          temp.__mynda_subtitles_edited = this.state.changed.has('subtitles');
          batchVideosToSave.push(temp);
        });

        if (batchVideosToSave.length > 0) {
          library.replaceMediaBatch(batchVideosToSave, (err) => {
            if (err) {
              editorLog.error('Editor video batch save failed', {
                videoCount: batchVideosToSave.length,
                filenameResetPatchCount: filenameResetPatchCount,
                error: err && err.stack ? err.stack : String(err)
              });
            } else {
              // The complete media-array write has finished. Jump the counter
              // to N of N and leave it visible until the queued settings save
              // below also completes.
              batchSaveProgress.numCurrent = batchSaveProgress.numTotal;
              editorLog.info('Editor video batch saved', {
                videoCount: batchVideosToSave.length,
                filenameResetPatchCount: filenameResetPatchCount,
                changedFields: changedFields
              });
            }
            sendLocalStatusUpdate({
              action: 'batch_save',
              numCurrent: batchSaveProgress.numCurrent,
              numTotal: batchSaveProgress.numTotal
            });
          });
        }

      } else {
        editorLog.error('The editor batch did not include its source video objects');
      }
    } else {
      // SINGLE VIDEO
      // save the video data in library.media
      let temp = _.cloneDeep(this.state.video);
      temp.seriesImdbID = temp.kind === 'show' &&
        typeof temp.seriesImdbID === 'string' ? temp.seriesImdbID : '';
      temp.autotag_tried = false; // reset this flag whenever a video is saved
      // Transient signal for Library.js; it is removed before saving.
      temp.__mynda_subtitles_edited = this.state.changed.has('subtitles');
      let index = library.media.findIndex((video) => video && video.id === this.props.video.id);
      library.replace("media." + index, temp);
    }

    // then, add any new tags to the library.settings.used.tags list so they'll be available
    // as options for the next video the user edits
    let tags = [...this.props.settings.used.tags];
    tags = tags.concat(this.state.video.tags.filter(tag => tags.indexOf(tag) < 0)).sort();

    // and then do the same for genres
    let genres = [...this.props.settings.used.genres];
    const saveNewGenre = this.state.video.genre !== '' && genres.indexOf(this.state.video.genre) < 0;

    // Whichever settings operation is last owns the completion callback. The
    // callback is omitted for ordinary single-video saves, whose behavior and
    // lack of a progress banner remain unchanged.
    const finishBatchSave = batchSaveProgress && batchSaveProgress.numTotal > 0 ? (err) => {
      // Tags and genres are queued after the one media-array replacement. Keep
      // the completed "N of N" message visible until the final settings
      // operation finishes, then release the banner for the next task.
      if (err) {
        editorLog.error('Could not finish editor batch settings save', {
          videoCount: batchSaveProgress.numTotal,
          error: err && err.stack ? err.stack : String(err)
        });
      } else {
        editorLog.info('Editor batch save finished', {
          videoCount: batchSaveProgress.numTotal
        });
      }
      sendLocalStatusUpdate({action: ''});
    } : undefined;

    library.replace("settings.used.tags", tags, saveNewGenre ? undefined : finishBatchSave);

    if (saveNewGenre) {
      // library.add("settings.used.genres.0",this.state.video.genre);
      genres.push(this.state.video.genre);
      genres.sort();
      library.replace("settings.used.genres", genres, finishBatchSave);
    }

    // console.log('object when saving:');
    // console.log(this.state.video);

    // save hash so that later we can check if the video has changed
    // (in order to ask the user if they want to save before exiting)
    // and reset the 'changed' set (which keeps track of which fields
    // are changed before saving)
    this.setState({
      saveHash: hashObject(this.state.video),
      changed: new Set(),
      pendingFilenameResetPatches: {},
      resetFromFilenamePending: false,
      filenameResetStaged: false
    });
  }

  componentDidUpdate(oldProps) {
    if (!_.isEqual(oldProps.video, this.props.video)) {
      const oldSelectionKey = editorSelectionKey(oldProps.video, oldProps.batch);
      const currentSelectionKey = editorSelectionKey(this.props.video, this.props.batch);

      // Parent-level library updates recreate the batch summary object. Before
      // this guard, such a same-selection refresh unconditionally replaced the
      // editor state and erased the confirmed per-video reset patches. Preserve
      // the local reset transaction until the user explicitly Saves, Reverts,
      // or moves to a genuinely different video selection.
      if (oldSelectionKey === currentSelectionKey &&
          (this.state.resetFromFilenamePending || this.state.filenameResetStaged)) {
        editorLog.info('Preserved staged filename reset during same-selection refresh', {
          selectionType: this.props.video && this.props.video.id === 'batch' ? 'batch' : 'single',
          videoCount: this.props.video && this.props.video.id === 'batch' ?
            (this.props.batch || []).length : 1,
          resetRequestPending: Boolean(this.state.resetFromFilenamePending),
          filenameResetPatchCount: Object.keys(this.state.pendingFilenameResetPatches || {}).length,
          changedFields: Array.from(this.state.changed || []).sort()
        });
        return;
      }

      let videoEditPrepped = _.cloneDeep(this.props.video);

      if (videoEditPrepped) {
        if (videoEditPrepped.id !== 'batch' &&
            this.props.settings.preferences.remove_edited_from_new === true) {
          // Preserve the legacy opt-in behavior: the editable checkbox shows
          // that Save will remove an individual video from New unless the user
          // explicitly checks it again. The default preference leaves the
          // video's existing value untouched, just as batch editing does.
          videoEditPrepped.new = false;
        }

        validateVideo(videoEditPrepped);

        // validateVideo fills missing ratings sources (and any other legacy
        // fields) for the controlled form. Capture the batch baseline after
        // that normalization so a type-then-delete round trip can truly match
        // the untouched value again.
        if (videoEditPrepped.id === 'batch') {
          this.state.batchObjectUnedited = _.cloneDeep(videoEditPrepped);
        }

        this.setState({
          video: videoEditPrepped,
          changed: new Set(),
          pendingFilenameResetPatches: {},
          resetFromFilenamePending: false,
          filenameResetStaged: false,
          saveHash: hashObject(videoEditPrepped)
        });
      }
    }
  }

  isBatchEdit() {
    // Check both sources so a control from the preceding render cannot navigate
    // during the brief props/state handoff into or out of a batch selection.
    return Boolean(
      (this.props.video && this.props.video.id === 'batch') ||
      (this.state.video && this.state.video.id === 'batch')
    );
  }

  goToPrevious() {
    if (this.isBatchEdit()) return;
    if (this.props.detailRowBoundaryFlag !== 'first') {
      if (this.state.changed.size > 0)
        this.saveChanges();
      this.props.goToPrevious();
    }
  }

  goToNext() {
    if (this.isBatchEdit()) return;
    if (this.props.detailRowBoundaryFlag !== 'last') {
      if (this.state.changed.size > 0)
        this.saveChanges();
      this.props.goToNext();
    }
  }


  componentDidMount() {
    this._isMounted = true;
  }

  componentWillUnmount() {
    this._isMounted = false;
  }

  createContentJSX() {
    // <MynEditorLookup
    //   video={this.state.video}
    // />

    const hasUnsavedChanges = Boolean(this.state.video) && (
      this.state.saveHash !== hashObject(this.state.video) ||
      this.state.resetFromFilenamePending ||
      Object.keys(this.state.pendingFilenameResetPatches || {}).length > 0
    );
    const navigationControls = this.isBatchEdit() ? null : (
      <div className={'editor-next-prev-btns ' + this.props.detailRowBoundaryFlag}>
        <div className='btn editor-prev-btn' onClick={()=>this.goToPrevious()}>
          <div style={{display:"inline-block",transform:"scaleX(-1)"}}>{'\u25B8'}</div> Previous
        </div>
        <div className='separator'>|</div>
        <div className='btn editor-next-btn' onClick={()=>this.goToNext()}>
          Next <div style={{display:"inline-block"}}>{'\u25B8'}</div>
        </div>
      </div>
    );

    return (
      <div>
        <MynEditorSearch
          video={this.state.video}
          batch={this.props.batch}
          settings={this.props.settings}
          placeholderImage={this.state.placeholderImage}
          handleChange={this.handleChange}
          hasUnsavedChanges={hasUnsavedChanges}
        />

        {navigationControls}

        <MynEditorEdit
          show={this.props.show}
          video={this.state.video}
          batch={this.props.batch}
          settings={this.props.settings}
          handleChange={this.handleChange}
          revertChanges={this.revertChanges}
          resetFromFilename={this.requestResetFromFilename}
          resetPatches={this.state.pendingFilenameResetPatches}
          resetPending={this.state.resetFromFilenamePending}
          changedFields={this.state.changed}
          batchBaseline={this.state.batchObjectUnedited}
          saveChanges={this.saveChanges}
          placeholderImage={this.state.placeholderImage}
          reportValid={this.reportValid}
          saveHash={this.state.saveHash}
        />
      </div>
    );
  }

  render() {

    return super.render({
      jsx: this.createContentJSX(),
      confirmExit: () => {
        // console.log('EXITING EDITOR PANE!!! isEqual: ' + _.isEqual(this.props.video,this.state.video));
        // console.log('props: ' + JSON.stringify(this.props.video));
        // console.log('state: ' + JSON.stringify(this.state.video));
        // return !_.isEqual(this.props.video,this.state.video);
        // console.log('object when exiting:');
        // console.log(this.state.video);

        let newHash = this.state.video ? hashObject(this.state.video) : null;
        return this.state.saveHash !== newHash ||
          Object.keys(this.state.pendingFilenameResetPatches || {}).length > 0;
      }, // boolean for whether or not to show confirmation dialog upon exiting the pane
      confirmMsg: 'Are you sure you want to exit without saving? Your changes will be lost'
    });
  }

}

class MynEditorSearch extends React.Component {
  constructor(props) {
    super(props)

    this.state = {
      results: null,
      searching: false
    }

    this.handleSearch = this.handleSearch.bind(this);
    this.clearSearch = this.clearSearch.bind(this);
    this.render = this.render.bind(this);

    this.handleConfirmSelect = (event, response, video, checked) => {
      editorLog.debug('Search-result confirmation received', {
        response: response,
        videoID: video && video.imdbID,
        title: video && video.Title,
        overrideRequested: Boolean(checked)
      });
      // if the user checked the checkbox to override the confirmation dialog,
      // set that preference in the settings
      if (checked) {
        editorLog.debug('User disabled search-result confirmation dialogs');
        let prefs = _.cloneDeep(this.props.settings.preferences);
        if (!prefs.override_dialogs) {
          prefs.override_dialogs = {};
        }
        prefs.override_dialogs['MynEditorSearch-confirm-select'] = true;
        library.replace("settings.preferences",prefs);
      }

      if (response === 0) { // yes
        // choose search result and fill in the fields with it
        this.retrieveResult(video);
      } else {
        editorLog.debug('Search-result selection canceled by user', {
          videoID: video && video.imdbID,
          title: video && video.Title
        });
      }
    };
  }

  // search online movie database to auto-fill fields
  async handleSearch(event) {
    event.preventDefault();

    // The editor's synthetic batch summary is not a searchable video. Send
    // only the real selected IDs to the main process, which resolves fresh
    // library records, confirms the scope, and runs the normal Auto-Tag path.
    if (this.props.video && this.props.video.id === 'batch') {
      if (this.props.hasUnsavedChanges) {
        alert('Save or Revert the current batch edits before auto-tagging the selected videos.');
        return;
      }
      const selectedIDs = (this.props.batch || [])
        .map(video => video && video.id)
        .filter(Boolean);
      if (selectedIDs.length === 0) {
        alert('No videos are selected for Auto-Tag.');
        return;
      }
      ipcRenderer.send('autotag-selected', selectedIDs);
      return;
    }

    this.setState({searching:true});
    let resultsObject = await OmdbHelper.search(this.props.video);
    this.setState({searching:false});
    //console.log(results);
    let results;
    if (resultsObject.success) {
      results = resultsObject.data;
      if (!Array.isArray(results)) {
        results = [
          {
            Poster: results.artwork,
            Title: results.title,
            Type: results.kind === 'show' ? 'episode' : (results.type || results.kind),
            Year: results.year,
            imdbID: results.imdbID
          }
        ];
      }
    } else if (resultsObject.choiceType === 'series' && Array.isArray(resultsObject.choices) && resultsObject.choices.length > 0) {
      // OmdbHelper does not decide whether ambiguity is fatal. Automatic
      // tagging leaves these choices unresolved, while the editor lets the
      // user select the intended series and then retrieves that exact episode.
      results = resultsObject.choices;
    } else {
      alert('No results found! For shows, check the series, season, and episode. For other videos, try editing the title and year, or enter the IMDb ID for an exact match.');
      return;
    }

    // Ordinary title searches can contain series records that are not valid
    // choices for a movie or episode. Filter those records before rendering,
    // rather than returning undefined JSX entries: an array of undefined
    // entries is truthy and used to produce an empty results area with only
    // its X button visible.
    let displayableResults = results.filter(movie => {
      if (!movie) return false;
      let isSeriesChoice = movie.myndaChoiceType === 'series';
      return movie.Type !== 'series' || isSeriesChoice;
    });

    if (displayableResults.length === 0) {
      this.setState({results:null});
      alert('No compatible results found! For shows, check the series, season, and episode. For other videos, try editing the title and year, or enter the IMDb ID for an exact match.');
      return;
    }

    let movies = displayableResults.map((movie) => {

      if (!isValidURL(movie.Poster)) {
        movie.Poster = this.props.placeholderImage;
      }

      return (
        <tr key={movie.imdbID} onClick={() => (this.chooseResult(movie))}>
          <td className='artwork'><img src={movie.Poster} /></td>
          <td className='title'>{movie.Title}</td>
          <td className='year'>{movie.Year}</td>
          <td><a href={`https://www.imdb.com/title/${movie.imdbID}`} target='_blank' onClick={(e) => {e.stopPropagation()}}>IMDb</a></td>
        </tr>
      );
    });
    this.setState({results:movies});
  }

  clearSearch() {
    this.setState({results:null});
  }

  chooseResult(movie) {
    // if the user hasn't previously selected the preference to override this confirmation dialog
    if (!this.props.settings.preferences.override_dialogs || !this.props.settings.preferences.override_dialogs['MynEditorSearch-confirm-select']) {
      // we ask the user to confirm, because this will overwrite any metadata
      // the movie currently has (although the revert button will still work until
      // the user saves the changes)
      ipcRenderer.send(
        'generic-confirm',
        'MynEditorSearch-confirm-select',
        {
          message: `Are you sure you want to choose ${movie.Title} (${movie.Year})? This will overwrite most of the existing information for this video.`,
          checkboxLabel: `Don't show this dialog again`
        },
        movie
      );
    } else {
      // skip the dialog
      this.retrieveResult(movie);
    }
  }

  retrieveResult(movie) {
    // clear the search results
    this.clearSearch();

    // A series choice identifies which show owns the already-known season and
    // episode. Ordinary movie/episode result rows continue to be retrieved by
    // their own IMDb ID as before.
    let searchTarget = movie.myndaChoiceType === 'series' ? this.props.video : movie;
    let searchOptions = movie.myndaChoiceType === 'series' ? {seriesImdbID: movie.imdbID} : {};
    OmdbHelper.search(searchTarget, searchOptions).then(responseObject => {
      if (!responseObject.success) {
        alert(movie.myndaChoiceType === 'series' ?
          'OMDb could not find this episode in the selected series.' :
          'OMDb could not retrieve the selected result.');
        editorLog.warn('Could not retrieve the selected OMDb result', {
          choiceType: movie.myndaChoiceType || 'result',
          imdbID: movie.imdbID,
          error: responseObject.data
        });
        return;
      } else {
        this.props.handleChange(responseObject.data);
      }
    })
  }

  componentDidUpdate(previousProps) {
    const previousSelection = editorSelectionKey(previousProps.video, previousProps.batch);
    const currentSelection = editorSelectionKey(this.props.video, this.props.batch);
    if (previousSelection !== currentSelection && (this.state.results || this.state.searching)) {
      // Search rows belong to one concrete video. Never carry them into a
      // different video—or into a batch where selecting one row would apply a
      // single title's metadata to every selected item.
      this.setState({results: null, searching: false});
    }
  }

  componentDidMount() {
    ipcRenderer.on('MynEditorSearch-confirm-select', this.handleConfirmSelect);
  }

  componentWillUnmount() {
    ipcRenderer.removeListener('MynEditorSearch-confirm-select', this.handleConfirmSelect);
  }

  render() {
    const isBatch = this.props.video && this.props.video.id === 'batch';
    let clearBtn = !isBatch && this.state.results ? (<div id='edit-search-clear-button' className='clickable' onClick={this.clearSearch} title='Clear search results'>{"\u2715"}</div>) : null;
    let searchBtn;
    let batchMessage = null;
    if (isBatch) {
      const title = this.props.hasUnsavedChanges ?
        'Save or Revert the current batch edits before auto-tagging.' :
        'Auto-tag only the selected videos. Mynda will ask for confirmation before making changes.';
      searchBtn = (
        <span title={title}>
          <button
            type='button'
            id='edit-search-button'
            onClick={this.handleSearch}
            disabled={this.props.hasUnsavedChanges}
          >
            Auto-Tag Selected…
          </button>
        </span>
      );
      if (this.props.hasUnsavedChanges) {
        batchMessage = <span className='edit-search-batch-message'>Save or Revert this batch before Auto-Tag.</span>;
      }
    } else {
      searchBtn = this.state.searching ?
        (<img src='../images/loading-icon.gif' className='loading-icon' />) :
        (<button type='button' id='edit-search-button' onClick={this.handleSearch} title='Search OMDb for video information. Shows use series, season, and episode; other videos use IMDb ID, title, year, or filename. You can choose a result and edit it afterwards.'>Search</button>);
    }
    return (
        <div id='edit-search'>
          <div id='edit-search-controls'>
            {searchBtn}
            {batchMessage}
          </div>
          <table id='edit-search-results'>
            <thead>
              <tr>
                <th></th>
                <th></th>
                <th></th>
                <th>{clearBtn}</th>
              </tr>
            </thead>
            <tbody>
              {isBatch ? null : this.state.results}
            </tbody>
          </table>
        </div>
    );

    // <div className="input-container controls">
    //   <input id="editor-search-imdbID" className="filled" type="text" placeholder="IMDb ID (optional)" />
    //   <div className="input-clear-button hover" onClick={() => {document.getElementById('editor-search-imdbID').value = ''}}></div>
    // </div>

  }
}

// edit fields for video object in MynEditor
class MynEditorEdit extends React.Component {
  constructor(props) {
    super(props)

    this._isMounted = false;

    this.state = {
      // data: _.cloneDeep(props.video),
      validators: {
        people: {
          exp: /^[a-zA-Z0-9_\s\-\.',]+$/,
          tip: "Allowed: a-z A-Z 0-9 _ - . , ' [space]"
        },
        tags: {
          exp: /^[a-zA-Z0-9_\-\.&]+$/,
          tip: "Allowed: a-z A-Z 0-9 _ - . &"
        },
        generous: {
          exp: /^[^=;{}]+$/,
          tip: "Not allowed: = ; { }"
        },
        year: {
          exp: /^\d{4}$/,
          tip: "YYYY"
        },
        posint: {
          exp: { test: value => Number.isInteger(Number(value)) && Number(value)>0 },
          tip: "Positive integer"
        },
        episodeNumber: {
          exp: { test: value => parseEditableEpisodeNumber(value) !== null },
          tip: "0 or greater; up to one decimal place"
        },
        season: {
          exp: { test: value => String(value).toLowerCase() === 'extras' || (String(value).trim() !== '' && Number.isInteger(Number(value)) && Number(value)>=0) },
          tip: "Integer 0 or greater, or extras"
        },
        number: {
          exp: { test: value => !isNaN(Number(value)) },
          tip: "Number"
        },
        numrange: {
          exp: { test: (value,min,max) => !isNaN(Number(value)) && Number(value)>=min && Number(value)<=max },
          tip: (min,max) => `${min}-${max}`
        },
        money: {
          exp: { test: value => !isNaN(accounting.unformat(value)) && accounting.unformat(value) >= 0 },
          tip: "Non-negative monetary value"
        },
        imdb: {
          exp: /^tt\d+$/,
          tip: "Enter a valid IMDb ID"
        },
        everything: {
          exp: /.*/,
          tip: ""
        }
      }
    }

    this.render = this.render.bind(this);

    this.handleConfirmRevert = (event, response, data, checked) => {
      // if the user checked the checkbox to override the confirmation dialog,
      // set that preference in the settings
      if (checked) {
        editorLog.debug('User disabled editor-revert confirmation dialogs');
        let prefs = _.cloneDeep(this.props.settings.preferences);
        if (!prefs.override_dialogs) {
          prefs.override_dialogs = {};
        }
        prefs.override_dialogs['MynEditorEdit-confirm-revert'] = true;
        library.replace("settings.preferences",prefs);
      }

      if (response === 0) { // yes
        // choose search result and fill in the fields with it
        this.props.revertChanges();
      } else {
        editorLog.debug('Editor reversion canceled by user');
      }
    };
  }

  requestRevert(e) {
    e.preventDefault();

    // whether the video has been changed since load or the last save
    const newHash = hashObject(this.props.video);
    const saved = this.props.saveHash === newHash;
    // console.log('video has changed since load/last save? ' + !saved);
    // console.log('\n' + this.props.saveHash + '\n' + newHash);

    // if the video has been changed without saving
    // and if the user hasn't previously selected the preference to override this confirmation dialog
    if (!saved && (!this.props.settings.preferences.override_dialogs || !this.props.settings.preferences.override_dialogs['MynEditorEdit-confirm-revert'])) {
      // we ask the user to confirm, because this will erase any metadata
      // that hasn't been saved
      ipcRenderer.send(
        'generic-confirm',
        'MynEditorEdit-confirm-revert',
        {
          message: `Are you sure you want to revert to the saved values? You will lose any unsaved changes.`,
          checkboxLabel: `Don't show this dialog again`
        }
      );
    } else {
      // skip the dialog
      this.props.revertChanges();
    }
  }

  componentDidMount() {
    this._isMounted = true;
    ipcRenderer.on('MynEditorEdit-confirm-revert', this.handleConfirmRevert);

    // we're now doing the validating in MynEditor before it gets here, to avoid issues with the saveHash
    // validate the video in place (function fixes any broken values)
    // and also, if any changes were made (i.e. broken values fixed)
    // save the changes
    // if (validateVideo(this.props.video) !== true) {
    //   // this.props.saveChanges();
    // }
  }

  componentWillUnmount() {
    ipcRenderer.removeListener('MynEditorEdit-confirm-revert', this.handleConfirmRevert);
    this._isMounted = false;
  }

  render() {
    if (this.props.show === false) {
      return null;
    }

    if (!this.props.video) {
      editorLog.error('No video object was provided to the editor form');
      return null;
    }

    const video = this.props.video;
    const resetPatches = Object.values(this.props.resetPatches || {});

    // A batch reset can contain a different derived value for every video.
    // The common batch object must represent those differing values as blank,
    // which otherwise makes the editor look unchanged. Give every still-pending
    // reset field a normal form placeholder so the user can see what Save will
    // do. Once the user supplies an overriding value for a field, its ordinary
    // placeholder returns. (Ratings are handled per input below, because one
    // edited rating should not hide the reset marker from the other sources.)
    const isPendingResetField = (property, ignoreChanged = false) => {
      return video.id === 'batch' &&
        resetPatches.length > 0 &&
        (ignoreChanged || !this.props.changedFields || !this.props.changedFields.has(property)) &&
        resetPatches.every(patch => Object.prototype.hasOwnProperty.call(patch, property));
    };
    const resetPlaceholder = (property, ordinaryPlaceholder = '') => {
      return isPendingResetField(property) ? 'Reset' : ordinaryPlaceholder;
    };
    const isBatchFieldChanged = (property) => {
      return video.id === 'batch' && (
        (this.props.changedFields && this.props.changedFields.has(property)) ||
        isPendingResetField(property, true)
      );
    };
    const markBatchChangeWhen = (element, changed) => {
      if (!element || !changed) return element;
      return React.cloneElement(element, {
        className: `${element.props.className || ''} batch-changed`.trim()
      });
    };
    const markBatchChange = (element, property) => {
      return markBatchChangeWhen(element, isBatchFieldChanged(property));
    };
    const isBatchRatingChanged = (sources) => {
      const baseline = this.props.batchBaseline;
      if (video.id !== 'batch' || !baseline) return false;
      const currentRatings = video.ratings && typeof video.ratings === 'object' ? video.ratings : {};
      const baselineRatings = baseline.ratings && typeof baseline.ratings === 'object' ? baseline.ratings : {};
      return sources.some(source =>
        !editorRatingValuesEqual(currentRatings[source], baselineRatings[source])
      );
    };
    const batchChangedCatalogRatingSources = video.id === 'batch' ?
      ['imdb', 'rt', 'mc'].filter(source =>
        isBatchRatingChanged([source]) || isPendingResetField('ratings', true)
      ) : [];
    const batchBaselineItems = (property) => {
      const baseline = this.props.batchBaseline;
      return video.id === 'batch' && baseline && Array.isArray(baseline[property]) ?
        baseline[property] : null;
    };
    // validateVideo(video);

    // if (validateVideo(video) !== true) {
    //   console.log("Invalid video passed to editor: " + JSON.stringify(video));
    //   return (
    //     <div className="error-message">Error: Invalid video object</div>
    //   );
    // }

    /* FILENAME */
    // the user won't be able to edit the filename, but we need to display it
    let filename = (
      <div className='edit-field filename'>
        <div className="edit-field-editor">
          <MynOverflowTextMarquee text={this.props.video.filename} direction='left' ellipsis='fade' fadeSize='2em' />
        </div>
      </div>
    );

    /* TITLE */
    let title = (
      <div className='edit-field title'>
        <label className="edit-field-name" htmlFor="title">Title: </label>
        <div className="edit-field-editor">
          <MynEditText
            object={this.props.video}
            property="title"
            placeholder={resetPlaceholder('title', '[Title]')}
            className="edit-field-title"
            update={this.props.handleChange}
            options={null}
            validator={this.state.validators.everything.exp}
            validatorTip={this.state.validators.everything.tip}
            reportValid={this.props.reportValid}
          />
        </div>
      </div>
    );

    /* IMDb ID */
    let imdbID = (
      <div className='edit-field imdbID'>
        <label className="edit-field-name" htmlFor="imdbID">IMDb ID: </label>
        <div className="edit-field-editor">
          <MynEditText
            object={this.props.video}
            property="imdbID"
            placeholder={resetPlaceholder('imdbID')}
            className="edit-field-imdbID"
            update={this.props.handleChange}
            options={null}
            validator={this.state.validators.imdb.exp}
            validatorTip={this.state.validators.imdb.tip}
            reportValid={this.props.reportValid}
          />
        </div>
      </div>
    );

    /* YEAR */
    let year = (
      <div className='edit-field year'>
        <label className="edit-field-name" htmlFor="year">Year: </label>
        <div className="edit-field-editor">
          <MynEditText
            object={this.props.video}
            property="year"
            placeholder={resetPlaceholder('year')}
            className="edit-field-year"
            update={this.props.handleChange}
            options={null}
            validator={this.state.validators.year.exp}
            validatorTip={this.state.validators.year.tip}
            reportValid={this.props.reportValid}
          />
        </div>
      </div>
    );

    /* DIRECTOR */
    let director = (
      <div className='edit-field director'>
        <label className="edit-field-name" htmlFor="director">Director: </label>
        <div className="edit-field-editor">
          <MynEditText
            object={this.props.video}
            property="director"
            placeholder={resetPlaceholder('director')}
            className="edit-field-director"
            update={this.props.handleChange}
            options={null}
            validator={this.state.validators.people.exp}
            validatorTip={this.state.validators.people.tip}
            reportValid={this.props.reportValid}
          />
        </div>
      </div>
    );

    /* DIRECTORSORT */
    let directorsort = (
      <div className='edit-field directorsort'>
        <label className="edit-field-name" htmlFor="directorsort">Director Sort: </label>
        <div className="edit-field-editor">
          <MynEditText
            object={this.props.video}
            property="directorsort"
            placeholder={resetPlaceholder('directorsort')}
            className="edit-field-directorsort"
            update={this.props.handleChange}
            options={null}
            validator={this.state.validators.people.exp}
            validatorTip={this.state.validators.people.tip}
            reportValid={this.props.reportValid}
          />
        </div>
      </div>
    );

    /* DESCRIPTION */
    let description = (
      <div className='edit-field description'>
        <label className="edit-field-name" htmlFor="description">Description: </label>
        <div className="edit-field-editor">
          <textarea
            id="edit-field-description"
            name="description"
            value={this.props.video.description}
            placeholder={resetPlaceholder('description', '[Description]')}
            onChange={(e) => this.props.handleChange({'description':e.target.value})}
          />
        </div>
      </div>
    );

    /* TAGS */
    // <MynEditListWidget movie={this.state.video} property="tags" update={this.handleChange} />
    // <MynEditAddToList movie={this.state.video} property="tags" update={this.handleChange} validator={/^[a-zA-Z0-9_\-\.]+$/} options={["many","tags","happy","joy","existing","already-used"]} />
    let tags = (
      <div className='edit-field tags'>
        <label className="edit-field-name" htmlFor="tags">Tags: </label>
        <div className="edit-field-editor">
          <div className="select-container">
            <MynEditInlineAddListWidget
              object={this.props.video}
              property="tags"
              batchBaseline={batchBaselineItems('tags')}
              update={this.props.handleChange}
              options={this.props.settings.used.tags}
              storeTransform={value => value.toLowerCase()}
              validator={this.state.validators.tags.exp}
              validatorTip={this.state.validators.tags.tip}
              reportValid={this.props.reportValid}
            />
          </div>
        </div>
      </div>
    );

    /* ARTWORK */
    let artwork = (
      <div className='edit-field artwork'>
        <label className="edit-field-name" htmlFor="artwork">Artwork: </label>
        <div className="edit-field-editor">
          <MynEditArtwork
            movie={this.props.video}
            update={this.props.handleChange}
            placeholderImage={this.props.placeholderImage}
            placeholder={resetPlaceholder('artwork', 'Paste path/URL')}
          />
        </div>
      </div>
    );

    let subtitles = (
      <div className='edit-field subtitles'>
        <label className="edit-field-name" htmlFor="subtitles">Subtitles: </label>
        <div className="edit-field-editor">
          <MynEditSubtitles
            object={this.props.video}
            property={'subtitles'}
            batchBaseline={batchBaselineItems('subtitles')}
            update={this.props.handleChange}
            validator={this.state.validators.everything.exp}
            validatorTip={this.state.validators.everything.tip}
            reportValid={this.props.reportValid}
            marquee={true}
            overflowDirection={'left'}
          />
        </div>
      </div>
    );

    /* CAST */
    let cast = (
      <div className='edit-field cast'>
        <label className="edit-field-name" htmlFor="cast">Cast: </label>
        <div className="edit-field-editor">
          <MynEditInlineAddListWidget
            object={this.props.video}
            property="cast"
            batchBaseline={batchBaselineItems('cast')}
            placeholder={resetPlaceholder('cast', 'Add...')}
            update={this.props.handleChange}
            options={null}
            validator={this.state.validators.people.exp}
            validatorTip={this.state.validators.people.tip}
            reportValid={this.props.reportValid}
          />
        </div>
      </div>
    );

    /* GENRE */
    let genre = (
      <div className='edit-field genre'>
        <label className="edit-field-name" htmlFor="genre">Genre: </label>
        <div className="edit-field-editor select-container select-hovericon">
          <MynEditText
            object={this.props.video}
            property="genre"
            placeholder={resetPlaceholder('genre')}
            className="edit-field-genre"
            update={this.props.handleChange}
            options={this.props.settings.used.genres}
            storeTransform={value => value.replace(/\b\w/g,letter => letter.toUpperCase())}
            validator={this.state.validators.tags.exp}
            validatorTip={this.state.validators.tags.tip}
            reportValid={this.props.reportValid}
          />
        </div>
      </div>
    );

    /* SERIES */
    let series = (
      <div className='edit-field series'>
        <label className="edit-field-name" htmlFor="series">Series: </label>
        <div className="edit-field-editor">
          <MynEditText
            object={this.props.video}
            property="series"
            placeholder={resetPlaceholder('series')}
            className="edit-field-series"
            update={this.props.handleChange}
            options={null}
            validator={this.state.validators.everything.exp}
            validatorTip={this.state.validators.everything.tip}
            reportValid={this.props.reportValid}
          />
        </div>
      </div>
    );

    /* SEASON */
    let season = (
      <div className='edit-field season'>
        <label className="edit-field-name" htmlFor="season">Season: </label>
        <div className="edit-field-editor">
          <MynEditText
            object={this.props.video}
            property="season"
            placeholder={resetPlaceholder('season')}
            className="edit-field-season"
            update={this.props.handleChange}
            options={null}
            validator={this.state.validators.season.exp}
            validatorTip={this.state.validators.season.tip}
            reportValid={this.props.reportValid}
          />
        </div>
      </div>
    );

    /* EPISODE */
    let episode = (
      <div className='edit-field episode'>
        <label className="edit-field-name" htmlFor="episode">Episode: </label>
        <div className="edit-field-editor">
          <MynEditText
            object={this.props.video}
            property="episode"
            placeholder={resetPlaceholder('episode')}
            className="edit-field-episode"
            update={this.props.handleChange}
            options={null}
            validator={this.state.validators.episodeNumber.exp}
            validatorTip={this.state.validators.episodeNumber.tip}
            reportValid={this.props.reportValid}
          />
        </div>
      </div>
    );

    /* KIND */
    let options = this.props.settings.used.kinds.map(kind => (
      <option key={kind} value={kind}>{kind}</option>
    ));
    // if this video's kind is no longer among the list of allowed kinds (probably because the user deleted that kind from the preferences pane)
    // we want to display it as the kind of the video, but not allow the user to select it as an option
    if (this.props.video.kind && this.props.video.kind !== '' && !this.props.settings.used.kinds.includes(this.props.video.kind)) {
      options.unshift(<option key='invalid' disabled hidden value={this.props.video.kind}>{this.props.video.kind}</option>);
    }
    options.unshift(<option key='none' disabled hidden value=''>{resetPlaceholder('kind')}</option>);
    let kind = (
      <div className='edit-field kind'>
        <label className="edit-field-name" htmlFor="kind">Kind: </label>
        <div className="edit-field-editor select-container select-alwaysicon">
          <select id="edit-field-kind" name="kind" className={isPendingResetField('kind') && !this.props.video.kind ? 'pending-reset' : ''} value={this.props.video.kind || ''} onChange={(e) => this.props.handleChange({'kind':e.target.value})}>
            {options}
          </select>
        </div>
      </div>
    );

    /* DATEADDED */
    let dateadded = (
      <div className='edit-field dateadded'>
        <label className="edit-field-name" htmlFor="dateadded">Date Added: </label>
        <div className="edit-field-editor">
          <MynEditDateWidget
            movie={this.props.video}
            property="dateadded"
            update={this.props.handleChange}
            reportValid={this.props.reportValid}
          />
        </div>
      </div>
    );

    /* LASTSEEN */
    let lastseen = (
      <div className='edit-field lastseen'>
        <label className="edit-field-name" htmlFor="lastseen">Last Seen: </label>
        <div className="edit-field-editor">
          <MynEditDateWidget
            movie={this.props.video}
            property="lastseen"
            update={this.props.handleChange}
            reportValid={this.props.reportValid}
          />
        </div>
      </div>
    );

    /* SEEN */
    let seen = (
      <div className='edit-field seen'>
        <label className='edit-field-name' htmlFor="seen">Seen: </label>
        <div className="edit-field-editor">
          <MynEditSeenWidget movie={this.props.video} update={this.props.handleChange} />
        </div>
      </div>
    );

    /* WATCHLATER */
    let watchlater = (
      <div className='edit-field watchlater'>
        <label className='edit-field-name' htmlFor="watchlater">Watch Later: </label>
        <div className="edit-field-editor">
          <MynEditWatchlaterWidget movie={this.props.video} update={this.props.handleChange} />
        </div>
      </div>
    );

    /* POSITION */
    let position = (
      <div className='edit-field position'>
        <label className="edit-field-name" htmlFor="position">Position: </label>
        <div className="edit-field-editor">
          <MynEditPositionWidget movie={this.props.video} update={this.props.handleChange} />
        </div>
      </div>
    );

    /* RATING */
    let rating = (
      <div className='edit-field rating'>
        <label className="edit-field-name" htmlFor="rating">Rating: </label>
        <div className="edit-field-editor">
          <MynEditRatingWidget movie={this.props.video} update={this.props.handleChange} cancelBtn={true} />
        </div>
      </div>
    );

    /* RATINGS */
    // (not including the user rating, which is separate)
    let ratings = (
      <div className='edit-field ratings'>
        <label className="edit-field-name" htmlFor="ratings">Ratings: </label>
        <div className="edit-field-editor">
          <MynEditRatings
            property="ratings"
            video={this.props.video}
            update={this.props.handleChange}
            batchChangedSources={batchChangedCatalogRatingSources}
            placeholder={isPendingResetField('ratings', true) ? 'Reset' : '#'}
            validator={this.state.validators.numrange.exp}
            validatorTip={this.state.validators.numrange.tip}
            reportValid={this.props.reportValid}
          />
        </div>
      </div>
    );

    /* BOXOFFICE */
    let boxoffice = (
      <div className='edit-field boxoffice'>
        <label className="edit-field-name" htmlFor="boxoffice">Box Office: </label>
        <div className="edit-field-editor">
          <MynEditText
            object={this.props.video}
            property="boxoffice"
            placeholder={resetPlaceholder('boxoffice')}
            className="edit-field-boxoffice"
            update={this.props.handleChange}
            options={null}
            storeTransform={value => value !== '' ? Math.round(accounting.unformat(value)) : ''}
            displayTransform={value => value !== '' ? accounting.formatMoney(value,'$',0) : ''}
            validator={this.state.validators.money.exp}
            validatorTip={this.state.validators.money.tip}
            reportValid={this.props.reportValid}
          />
        </div>
      </div>
    );

    /* RATED */
    // create dropdown options for the different ratings systems
    // let options = {};
    // // populate movie and show with MPA and TV ratings, respectively;
    // // in the future we should expand to allow other content rating systems, perhaps by locale
    // // or else simply allow text entry instead of preset options
    // options.movie = ['Not Rated','G','PG','PG-13','R','NC-17','X'];
    // options.show = ['Not Rated','TV-G','TV-Y','TV-Y7','TV-PG','TV-14','TV-MA'];
    // // create JSX
    // try {
    //   options = options[this.props.video.kind].map(option => (<option key={option} value={option}>{option}</option>));
    // } catch(err) {
    //   options = (<option key='N/A' value='N/A'>N/A</option>);
    // }
    options = ['N/A','','G','PG','PG-13','R','NC-17','X','','TV-G','TV-Y','TV-Y7','TV-PG','TV-14','TV-MA','','Not Rated'];
    options = options.map((option,i) => {
      if (option !== '') {
        return (<option key={i} value={option}>{option}</option>);
      } else {
        // create separator
        return (<option key={i} disabled>{'\u2501'}{'\u2501'}{'\u2501'}{'\u2501'}</option>)
      }
    });
    options.unshift(<option key={options.length} disabled hidden value=''>{resetPlaceholder('rated')}</option>);
    let rated = (
      <div className='edit-field rated'>
        <label className="edit-field-name" htmlFor="rated">Rated: </label>
        <div className="edit-field-editor select-container select-alwaysicon">
          <select id="edit-field-kind" name="rated" className={isPendingResetField('rated') && !this.props.video.rated ? 'pending-reset' : ''} value={this.props.video.rated} onChange={(e) => this.props.handleChange({'rated':e.target.value})}>
            {options}
          </select>
        </div>
      </div>
    );

    /* LANGUAGES */
    let languages = (
      <div className='edit-field languages'>
        <label className="edit-field-name" htmlFor="languages">Languages: </label>
        <div className="edit-field-editor">
          <MynEditInlineAddListWidget
            object={this.props.video}
            property="languages"
            batchBaseline={batchBaselineItems('languages')}
            placeholder={resetPlaceholder('languages', 'Add...')}
            update={this.props.handleChange}
            options={null}
            validator={this.state.validators.generous.exp}
            validatorTip={this.state.validators.generous.tip}
            reportValid={this.props.reportValid}
          />
        </div>
      </div>
    );

    /* COUNTRY */
    let country = (
      <div className='edit-field country'>
        <label className="edit-field-name" htmlFor="country">Country: </label>
        <div className="edit-field-editor">
          <MynEditText
            object={this.props.video}
            property="country"
            placeholder={resetPlaceholder('country')}
            className="edit-field-country"
            update={this.props.handleChange}
            options={null}
            validator={this.state.validators.generous.exp}
            validatorTip={this.state.validators.generous.tip}
            reportValid={this.props.reportValid}
          />
        </div>
      </div>
    );

    const batchNewMixed = this.props.video.id === 'batch' && this.props.video.new === null;
    const newDescription = this.props.video.id === 'batch' ?
      "Keep selected videos in the 'New' playlist. A dash means the selection is mixed; leave it untouched to preserve each video's current status." :
      "Checked videos remain in the 'New' playlist after saving";
    let new_ = (
      <div className='edit-field new'>
        <label className="edit-field-name" htmlFor="new">New: </label>
        <div className="edit-field-editor">
          <input
            type='checkbox'
            ref={(input) => {
              if (input) input.indeterminate = batchNewMixed;
            }}
            checked={this.props.video.new === true}
            onChange={(e) => this.props.handleChange({'new': e.target.checked})}
          />
        </div>
        <div className='edit-field-description'>{newDescription}</div>
      </div>
    );

    let metadata = null;
    if (this.props.video.metadata) {
      metadata = (
        <div className='edit-field metadata'>
          <label className="edit-field-name" htmlFor="metadata">Metadata: </label>
          <div className="edit-field-editor">
            <table>
              <tbody>
                {Object.keys(this.props.video.metadata).map(key => {
                  // don't show the 'checked' boolean field
                  if (key === 'checked') return;
                  // format the field name
                  let formattedKey = key.replace(/_/g,' ').replace(/\b\w/g,l=>l.toUpperCase());
                  // set the value
                  let value = this.props.video.metadata[key];
                  let formattedValue = value;
                  // special case value formatting
                  if (key === 'duration') formattedValue = value >= 60 ? `${Math.round(value / 60)} min` : `${Math.round(value)} sec`;

                  return (
                    <tr key={key}>
                      <td className='field'>{formattedKey}</td>
                      <td className='value'>{formattedValue}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      );
    }

    // in the case that we're editing multiple videos, display a banner warning the user
    let batchNotification = null;
    let videoTable = null;
    if (this.props.video.id === 'batch') {
      const batchCount = Array.isArray(this.props.batch) ? this.props.batch.length : 0;
      // create a list of the videos we're editing
      if (this.props.batch) {
        videoTable = (
          <table id='batch-videos-table'>
            <thead>
              <tr>
                <th className='title'>Title</th>
                <th className='year'>Year</th>
                <th className='filename'>Filename</th>
              </tr>
            </thead>
            <tbody>
             {this.props.batch.map(v => {
               // Filename-derived batch resets remain pending until Save.
               // Preview each video's own patch here so the user can inspect
               // the newly detected titles rather than the stale saved ones.
               const previewVideo = {
                 ...v,
                 ...((this.props.resetPatches && this.props.resetPatches[v.id]) || {})
               };
               return (
                 <tr key={previewVideo.id}>
                  <td className='title'><MynOverflowTextMarquee text={previewVideo.title} ellipsis='fade' /></td>
                  <td className='year'>{previewVideo.year}</td>
                  <td className='filename'><MynOverflowTextMarquee text={previewVideo.filename} direction='left' ellipsis='fade' /></td>
                 </tr>
               );
             })}
            </tbody>
          </table>
       );
      }

      batchNotification = (
        <MynParagraphFolder
          id="edit-batch-notification"
          lede={`Editing ${batchCount} Video${batchCount === 1 ? '' : 's'}`}
          paragraph={videoTable}
          keepEllipsis={true}
        />
      );

    }

    return (
      <div id="edit-container">
        {batchNotification}
        <form onSubmit={this.props.saveChanges}>
          {filename}
          {markBatchChange(title, 'title')}
          {markBatchChange(series, 'series')}
          {markBatchChange(season, 'season')}
          {markBatchChange(episode, 'episode')}
          {markBatchChange(imdbID, 'imdbID')}
          {markBatchChange(description, 'description')}
          {markBatchChange(year, 'year')}
          {markBatchChange(director, 'director')}
          {markBatchChange(directorsort, 'directorsort')}
          {markBatchChange(cast, 'cast')}
          {markBatchChange(genre, 'genre')}
          {markBatchChange(tags, 'tags')}
          {markBatchChange(kind, 'kind')}
          {markBatchChangeWhen(rating, isBatchRatingChanged(['user']))}
          {markBatchChange(seen, 'seen')}
          {markBatchChange(watchlater, 'watchlater')}
          {markBatchChange(lastseen, 'lastseen')}
          {markBatchChange(position, 'position')}
          {markBatchChange(dateadded, 'dateadded')}
          {markBatchChange(artwork, 'artwork')}
          {markBatchChange(subtitles, 'subtitles')}
          {ratings}
          {markBatchChange(boxoffice, 'boxoffice')}
          {markBatchChange(rated, 'rated')}
          {markBatchChange(country, 'country')}
          {markBatchChange(languages, 'languages')}
          {markBatchChange(new_, 'new')}
          {metadata}
          <button
            type="button"
            className="edit-field filename-reset-btn"
            onClick={this.props.resetFromFilename}
            disabled={this.props.resetPending}
            title="Re-detect identification from each filename and its folders, then clear downloaded catalog information so tagging can be tried again"
          >
            {this.props.resetPending ? 'Preparing Reset…' : 'Reset from Filename'}
          </button>
          <button className="edit-field revert-btn" onClick={(e) => this.requestRevert(e)}>Revert to Saved</button>
          <input
            className="edit-field save-btn"
            type="submit"
            value="Save"
            disabled={this.props.resetPending}
            title={this.props.resetPending ? 'Wait for the filename reset to finish before saving' : ''}
          />
        </form>
      </div>
    );
  }
}

module.exports = {MynEditor, MynEditorSearch, MynEditorEdit};
