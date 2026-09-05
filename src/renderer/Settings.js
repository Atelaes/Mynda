// Settings pane and its major settings views.
const React = require('react');
const {ipcRenderer} = require('electron');
const _ = require('lodash');
const {v4: uuidv4} = require('uuid');
const {DragDropContext, Droppable, Draggable} = require('react-beautiful-dnd');
const {
  library,
  settingsLog,
  confirmationDialogIsDisabled,
  disableConfirmationDialog
} = require('./RendererRuntime.js');
const {
  MynOpenablePane,
  MynOverflowTextMarquee,
  MynTooltip,
  MynParagraphFolder
} = require('./SharedComponents.js');
const {
  MynEditText,
  MynEditInlineAddListWidget
} = require('./EditorFields.js');
const {getObjectDiff, isEqualIgnoreFuncs} = require('./RendererUtils.js');

// ###### Settings Pane: allows user to edit settings. Only appears when user clicks to open it ###### //
class MynSettings extends MynOpenablePane {
  constructor(props) {
    super(props)

    this.save = this.save.bind(this);

    this.state = {
      paneID: 'settings-pane',
      settingView: null,
      settingViewName: props.view,
      delaySave: false,
      timer: null
    }

    ipcRenderer.on('settings-watchfolder-added', (event, folderObj) => {
      settingsLog.info('Watchfolder added', {
        path: folderObj && folderObj.path,
        kind: folderObj && folderObj.kind
      });
      // update everything
      this.setStateViewsFromProps(() => this.setView(this.state.settingViewName));
    });

    ipcRenderer.on('settings-watchfolder-remove', (event, path, removed) => {
      if (removed) {
        settingsLog.info('Watchfolder removed', {path: path});
        // update everything
        this.setStateViewsFromProps(() => this.setView(this.state.settingViewName));
      } else {
        settingsLog.warn('Watchfolder removal was not completed', {path: path});
      }
    });
  }

  setStateViewsFromProps(callback) {
    let views = {
      folders :     (<MynSettingsFolders      save={this.save} folders={this.props.settings.watchfolders} kinds={this.props.settings.used.kinds} />),
      playlists :   (<MynSettingsPlaylists    save={this.save} playlists={this.props.playlists} defaultcolumns={this.props.settings.preferences.defaultcolumns} displayColumnName={this.props.displayColumnName} />),
      // themes :      (<MynSettingsThemes       save={this.save} themes={this.props.settings.themes} />),
      preferences : (<MynSettingsPrefs        save={this.save} settings={this.props.settings} displayColumnName={this.props.displayColumnName} />),
      share : (<MynSettingsShare              settings={this.props.settings} videos={this.props.videos} />)

    }
    this.setState({views:views},callback);
  }

  save(saveObj) {
    // if the timer is already running
    if (this.state.timer !== null) {
      // cancel the old timer before we set a new one
      clearTimeout(this.state.timer);
    }

    // set new delay timer
    // console.log('Setting new timer...');
    this.state.timer = setTimeout(() => {
      // console.log('Timer ended; saving');

      // SAVE
      // saveObj should be an object with the keys being the 'replace' parameter in the library.replace function
      // (i.e. a string address in dot notation pointing to the object being updated in the library)
      // and the values should be the object being updated;
      // then we just loop over all the keys, and save everything to the library
      Object.keys(saveObj).forEach((address) => {
        library.replace(address, saveObj[address]);
      });

      this.setState({timer:null});
    },500);
  }

  setView(view,event,index) {
    // if the index isn't passed to us, find it from the view name;
    // even though object keys aren't in a reliable order, these should be
    // in the same order as they were when we generated the tabs
    if (index === undefined) {
      Object.keys(this.state.views).forEach((v,i) => {
        if (v == view) {
          index = i;
        }
      });
    }

    // console.log('index: ' + index);
    // update all views first, and then switch to the selected view
    this.setStateViewsFromProps(() => this.setState({settingView : this.state.views[view], settingViewName : view}));

    // remove "selected" class from all the tabs
    try {
      Array.from(document.getElementById("settings-tabs").getElementsByClassName("tab")).map((tab,i) => {
        // console.log('i: ' + i);
        tab.classList.remove("selected");

        // make classes for the selected-adjacent tabs
        if (i == index-1) { tab.classList.add("before-selected"); } else { tab.classList.remove("before-selected"); }
        if (i == index+1) { tab.classList.add("after-selected"); } else { tab.classList.remove("after-selected"); }
      });
    } catch(e) {
      // this will happen when the settings pane is not visible
      // console.log('There was an error updating classes for the settings tabs: ' + e.toString());
    }

    // add "selected" class to the clicked tab
    let element;
    try {
      element = event.target;
    } catch(e) {
      // if no event was passed, try to get the element from the view name
      try {
        element = document.getElementById('settings-tab-' + view);
      } catch(e) {
        //console.log('Unable to add "selected" class to tab in settings component: ' + e.toString());
      }
    }
    try {
      element.classList.add("selected");
    } catch(e) {
    }
  }

  createContentJSX() {
    const tabs = [];
    try {
      Object.keys(this.state.views).forEach((tab,i) => {
        tabs.push(<li key={tab} id={"settings-tab-" + tab} className="tab" onClick={(e) => this.setView(tab,e,i)}>{tab.replace(/\b\w/g,(letter) => letter.toUpperCase())}</li>)
      });
    } catch(err) {
      // this.state.views has not been created yet
    }

    return (
        <div>
          <ul id="settings-tabs">
            {tabs}
          </ul>
          <div id="settings-content">{this.state.settingView}</div>
        </div>
    );
  }

  componentDidMount(props) {
    // create the views
    // and set the initial view to the 'folders' tab
    // --------
    // NOTE: this no longer works, because the rendering process relies on
    // finding existing DOM nodes (e.g. document.getElementById("settings-tabs") for styling),
    // and when props.show is false, those don't exist;
    // this is always the case when the component mounts, because props.show isn't
    // set to true until the user clicks to open the pane;
    // it doesn't matter though, because we're calling the same function
    // in componentDidUpdate anyway
    // --------
    // this.setStateViewsFromProps(() => this.setView('folders'));
  }

  componentDidUpdate(oldProps) {
    // console.log('MynSettings: component has updated');
    // console.log(this.props.settings.watchfolders)

    // Mynda creates new callback functions whenever it renders. Ignore those
    // function-only changes before doing the expensive deep prop comparison.
    const nonFunctionPropsChanged = Object.keys(this.props).some(key => {
      return !_.isFunction(this.props[key]) && oldProps[key] !== this.props[key];
    });
    if (!nonFunctionPropsChanged) return;

    if (!isEqualIgnoreFuncs(oldProps,this.props)) {
      settingsLog.debug('Settings pane properties changed', {
        changedProperties: getObjectDiff(oldProps,this.props)
      });

      // if the view was changed from outside, call up that view;
      // OR, whenever the pane is closed, also set to props.view
      // so that it will open to that view the next time the user opens the pane;
      // (if we want the open tab to be persistent through close, just get rid of the 'or' statement)
      // otherwise stay with the view we're on, so that if an update happens
      // while the pane is open, it doesn't throw the user to a different tab
      let viewName = this.state.settingViewName;
      if (this.props.view !== oldProps.view || this.props.show === false) {
        viewName = this.props.view;
      }

      // update everything
      this.setStateViewsFromProps(() => this.setView(viewName));
    }
  }

  render() {
    return super.render({jsx:this.createContentJSX()});
  }
}

class MynSettingsFolders extends React.Component {
  constructor(props) {
    super(props);

    this.state = {
      existingFolders : [],
      folderToAdd: null

    }
    this.folderSelect = this.folderSelect.bind(this);

  }

  // create JSX for an options dropdown of the possible media kinds
  formFieldKindOptions() {
    let options;
    try {
      options = this.props.kinds.map((kind) => {
        if (!kind) return null;
        return (<option key={kind} value={kind}>{kind.replace(/\b\w/g,(letter) => letter.toUpperCase())}</option>)
      });
      options.unshift(<option key="none" value="none">(none)</option>);
    } catch(e) {
      settingsLog.error('Could not build the media-kind options from the library', {
        error: e
      });
      // should display error message to user
    }
    return options;
  }

  editRemove(path, index) {
    settingsLog.debug('Watchfolder removal requested', {
      path: path,
      index: index
    });

    ipcRenderer.send('settings-watchfolder-remove', path);
  }

  // edit the default kind of an existing watchfolder
  editKind(event, index) {
    settingsLog.debug('Watchfolder default kind change requested', {
      index: index,
      kind: event.target.value
    });

    try {
      let temp = _.cloneDeep(this.state.existingFolders[index]);
      temp.kind = event.target.value;

      library.replace(`settings.watchfolders.${index}`,temp);

    } catch(err) {
      settingsLog.error('Could not edit a watchfolder default kind', {
        index: index,
        kind: event.target.value,
        error: err
      });
    }
  }

  changeTargetFolder(folder) {
    this.setState({folderToAdd: folder});
    settingsLog.debug('Watchfolder path input changed', {path: folder});

    const inputField = document.getElementById('settings-folders-choose-path');
    if (folder == "") {
      inputField.classList.remove('filled');
      inputField.classList.add('empty');
    } else {
      inputField.classList.remove('empty');
      inputField.classList.add('filled');
    }
  }

  submitFolderToServer() {
    let folderAddress = document.getElementById("settings-folders-choose-path").value;
    let defaultKind = document.getElementById("settings-folders-choose-kind").value;
    let submitObject = {address: folderAddress, kind: defaultKind};
    // console.log(submitObject);
    ipcRenderer.send('settings-watchfolder-add', submitObject);
  }

  displayFolders() {
    let folders;
    try {
      folders = this.state.existingFolders.map((folder, index) => {
        if (!folder) return null;
        return (
          <tr key={index}>
            <td className='path' title={folder.path}><MynOverflowTextMarquee text={folder.path} ellipsis='fade' fadeSize='3em' direction='left' /></td>
            <td className='default-kind'>
              <span className='select-container select-alwaysicon'>
                <select value={folder.kind} onChange={(e) => this.editKind(e,index)}>{this.formFieldKindOptions()}</select>
              </span>
            </td>
            <td className='remove'><button onClick={() => this.editRemove(folder.path, index)}>Remove</button></td>
          </tr>
        )
      });
    } catch(e) {
      settingsLog.error('Could not display watchfolders from the library', {
        error: e
      });
    }
    return folders;
  }

  folderSelect() {
    ipcRenderer.once('settings-folder-selected', (event, args) => {
      this.changeTargetFolder(args);
    });
    ipcRenderer.send('settings-folder-select');
  }

  componentDidMount() {
    this.setState({existingFolders: this.props.folders})
  }

  componentDidUpdate(oldProps) {
    if (!_.isEqual(this.props.kinds,oldProps.kinds)) {
      settingsLog.debug('Available media kinds changed', {
        kindCount: Array.isArray(this.props.kinds) ? this.props.kinds.length : 0
      });
    }
    if (!_.isEqual(this.props.folders,oldProps.folders)) {
      settingsLog.debug('Watchfolder settings changed', {
        watchfolderCount: Array.isArray(this.props.folders) ? this.props.folders.length : 0
      });
      this.setState({existingFolders: this.props.folders})
    }
  }

  render() {
    // console.log(JSON.stringify(this.props.folders));
    return (
      <div id="settings-folders">

        <div id="settings-folders-choose" className='subsection'>
          <h2>Add new watchfolder</h2>
          <div className="choose-section kind">
            <label htmlFor="settings-folders-choose-kind">Default kind: </label>
            <span className='select-container select-alwaysicon'>
              <select id="settings-folders-choose-kind">
                {this.formFieldKindOptions()}
              </select>
            </span>
          </div>
          <div className="choose-section path">
            <label htmlFor="settings-folders-choose-path">Path: </label>
            <div className="input-container">
              <input type="text" id="settings-folders-choose-path" className="empty" value={this.state.folderToAdd || ''} placeholder="Select a directory..." onChange={(e) => this.changeTargetFolder(e.target.value)} />
              <div className="input-clear-button hover" onClick={() => this.changeTargetFolder('')}></div>
            </div>
          </div>
          <div className="choose-section buttons">
            <button onClick={() => this.folderSelect()}>Browse</button>
            <button onClick={this.submitFolderToServer}>Add</button>
          </div>
        </div>

        <div id="settings-folders-folders" className='subsection'>
          <h2>Watchfolders</h2>
          <table className='watchfolders-table' style={{visibility: this.state.existingFolders.length > 0 ? "visible" : "hidden"}}>
            <thead>
              <tr>
                <th className='path'>Path</th>
                <th className='default-kind'>Default Kind</th>
                <th className='remove'>Remove</th>
              </tr>
            </thead>
            <tbody>
              {this.displayFolders()}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

}

class MynSettingsPlaylists extends React.Component {
  constructor(props) {
    super(props);

    this.state = {
      playlists : _.cloneDeep(props.playlists),
      valid : {}
    }

    ipcRenderer.on('MynSettingsPlaylists-confirm-delete-playlist', (event, response, id, checked) => {
      if (response === 0) { // yes
        if (checked) {
          disableConfirmationDialog(
            'MynSettingsPlaylists-confirm-delete-playlist',
            settingsLog
          );
        }
        this.removePlaylist(id);
      } else {
        settingsLog.debug('Playlist deletion canceled by user', {playlistID: id});
      }
    });

    this.updateValue = this.updateValue.bind(this);
    this.reportValid = this.reportValid.bind(this);
    this.showEditPlaylist = this.showEditPlaylist.bind(this);
    this.removePlaylist = this.removePlaylist.bind(this);
    this.deletePlaylist = this.deletePlaylist.bind(this);
    this.addPlaylist = this.addPlaylist.bind(this);
    this.onDragEnd = this.onDragEnd.bind(this);
  }

  updateValue(index,prop,value) {
    // console.log(`Updating ${index}: ${prop} = ${value}`);
    let playlists = _.cloneDeep(this.state.playlists);

    // if an index is given, update that playlist
    if (!isNaN(index) && index >= 0) {
      playlists[index][prop] = value;

      if (prop === 'tab') {
        playlists = this.sortByTab(playlists);
      }

      // update the playlists object in state (this is what is displayed in the editor)
      this.setState({playlists: playlists});
    }

    // if there are no invalid fields, save the updated playlists to the library
    let invalidFields = Object.keys(this.state.valid).filter(key => this.state.valid[key] === false);
    if (invalidFields.length == 0) {
      this.props.save({'playlists':playlists});
    } else {
      settingsLog.debug('Playlist settings not saved because fields are invalid', {
        invalidFields: invalidFields
      });
    }
  }

  reportValid(property,valid) {
    settingsLog.debug('Playlist setting validation changed', {
      property: property,
      valid: valid
    });
    if (typeof valid === 'boolean') {
      this.state.valid[property] = valid;
    }
  }

  showEditPlaylist(playlist) {
    let hiddenEls = [];
    hiddenEls.push(document.getElementById('edit-filter-header-' + playlist.id));
    hiddenEls.push(document.getElementById('edit-filter-field-' + playlist.id));
    hiddenEls.push(document.getElementById('edit-columns-header-' + playlist.id));
    hiddenEls.push(document.getElementById('edit-columns-field-' + playlist.id));

    hiddenEls.map(el => {
      if (!el || !el.style) return;
      if (el.style.display === 'none') {
        el.style.display = 'block';
      } else {
        el.style.display = 'none';
      }
    });
  }

  removePlaylist(id) {
    let playlists = _.cloneDeep(this.state.playlists).filter(playlist => playlist.id !== id);
    this.setState({playlists:playlists}, () => {
      this.updateValue(); // force a save to the library
    });
  }

  deletePlaylist(playlist) {
    const confirmationPreference = 'MynSettingsPlaylists-confirm-delete-playlist';
    if (confirmationDialogIsDisabled(confirmationPreference)) {
      this.removePlaylist(playlist.id);
      return;
    }

    let playlistName = playlist.name != '' ? `the '${playlist.name}' playlist` : 'this playlist'
    ipcRenderer.send(
      'generic-confirm',
      confirmationPreference,
      {
        message: `Are you sure you want to delete ${playlistName}?`,
        checkboxLabel: `Don't show this message again`
      },
      playlist.id
    );
  }

  addPlaylist() {
    let newPlaylist = {
      id : uuidv4(),
      name : "",
      filter_function : "false",
      view : "flat",
      tab : true,
      columns : _.cloneDeep(this.props.defaultcolumns.used)
    }
    let playlists = _.cloneDeep(this.state.playlists);
    playlists.unshift(newPlaylist);
    this.setState({playlists : playlists});
    // we do NOT want to call this.updateValue here to force a save,
    // because we don't want the new playlists to start being saved until a name
    // is entered by the user. The playlist will be saved automatically when that
    // or any other change is made to the playlist by the user
  }

  // order playlist array according to the user's drag and drop action
  onDragEnd(result) {
    const { destination, source, draggableId } = result;
    // if the user actually moved an item
    if (destination && (destination.droppableId !== source.droppableId || destination.index !== source.index)) {
      // re-order the array
      const playlists = _.cloneDeep(this.state.playlists);
      const movedItems = playlists.splice(source.index, 1);
      playlists.splice(destination.index, 0, movedItems[0]);

      // now change the 'tab' value of the playlist if it was moved amongst or away from the 'tab'-ed playlists
      if (playlists[destination.index + 1] && playlists[destination.index + 1].tab) {
        playlists[destination.index].tab = true;
      }
      if (playlists[destination.index - 1] && !playlists[destination.index - 1].tab) {
        playlists[destination.index].tab = false;
      }

      this.setState({playlists:playlists}, () => {
        this.updateValue(); // passing no parameters means nothing will be updated, but the whole (newly ordered) array will still be saved
      });
    }
  }

  sortByTab(playlists) {
    playlists.sort((a,b) => {
      return a.tab > b.tab ? -1 : 1;
    });
    return playlists;
  }

  render() {
    // console.log(JSON.stringify(this.state.playlists));

    let playlists = this.state.playlists.map((playlist,i) => {
      if (!playlist) return null;
      return (
        <Draggable key={playlist.id} draggableId={'' + playlist.id} index={i}>
          {(provided) => (
            <MynSettingsPlaylistsTableRow
              playlist={playlist}
              index={i}
              allColumns={this.props.defaultcolumns.used.concat(this.props.defaultcolumns.unused)}
              defaultcolumns={this.props.defaultcolumns}
              updateValue={this.updateValue}
              showEditPlaylist={this.showEditPlaylist}
              deletePlaylist={this.deletePlaylist}
              reportValid={this.reportValid}
              displayColumnName={this.props.displayColumnName}
              innerRef={provided.innerRef}
              provided={provided}
            />
          )}
        </Draggable>
      )
    });

    // add a divider at the end of the tab==true playlists
    // for (let i=0; i<this.state.playlists.length; i++) {
    //   if (this.state.playlists[i-1] && !this.state.playlists[i].tab && this.state.playlists[i-1].tab) {
    //     playlists.splice(i,0,(<tr id='settings-playlists-rowdivider' key='-1'><td/><td/><td/><td/><td/><td/></tr>));
    //   }
    // }

    return (
      <div id='settings-playlists'>
        <DragDropContext onDragEnd={this.onDragEnd}>
          <div className="table" id='settings-playlists-table'>
            <div className="header row">
              <div className="header cell tab" title="Checked playlists will display as tabs. Unchecked playlists will only appear in the dropdown">Tab</div>
              <div className="header cell name">Name</div>
              <div className="header cell view" title="Flat view displays items as a simple list. Series view displays only items that are part of a series.">View</div>
              <div className="header cell add-btn"><button onClick={() => this.addPlaylist()}>Add...</button></div>
            </div>
            <Droppable droppableId='settings-playlist-table'>
              {(provided) => (
                <div ref={provided.innerRef} {...provided.droppableProps}>
                  {playlists}
                  {provided.placeholder}
                </div>
              )}
            </Droppable>
          </div>
        </DragDropContext>
      </div>
    );
  }
}

class MynSettingsPrefs extends React.Component {
  constructor(props) {
    super(props);

    this.state = {
      defaultcolumns : {
        used : _.cloneDeep(props.settings.preferences.defaultcolumns.used),
        unused : _.cloneDeep(props.settings.preferences.defaultcolumns.unused)
      },
      hide_description : props.settings.preferences.hide_description,
      include_new_vids_in_playlists : props.settings.preferences.include_new_vids_in_playlists,
      remove_edited_from_new:
        props.settings.preferences.remove_edited_from_new === true,
      remove_autotagged_from_new: props.settings.preferences.remove_autotagged_from_new,
      exclude_samples_from_library :
        props.settings.preferences.exclude_samples_from_library !== false,
      exclude_trailers_from_library :
        props.settings.preferences.exclude_trailers_from_library !== false,
      include_user_rating_in_avg : props.settings.preferences.include_user_rating_in_avg,
      kinds : props.settings.used.kinds.filter(kind => !!kind),
      override_dialogs : props.settings.preferences.override_dialogs
    }

    this.update = this.update.bind(this);
  }

  update(property, value, subProp) {
    let address = '';
    switch(property) {
      case "columns" :
        address = "settings.preferences.defaultcolumns";
        this.setState({defaultcolumns:value});
        break;
      case "hide-description" :
        address = "settings.preferences.hide_description";
        this.setState({hide_description:value});
        break;
      case "user-rating-avg" :
        address = "settings.preferences.include_user_rating_in_avg";
        this.setState({include_user_rating_in_avg:value});
        break;
      case "include-new" :
        address = "settings.preferences.include_new_vids_in_playlists";
        this.setState({include_new_vids_in_playlists:value});
        break;
      case "remove-edited-new":
        address = "settings.preferences.remove_edited_from_new";
        this.setState({remove_edited_from_new: value});
        break;
      case "remove-autotagged-new":
        address = "settings.preferences.remove_autotagged_from_new";
        this.setState({ remove_autotagged_from_new: value });
        break;
      case "exclude-samples":
        address = "settings.preferences.exclude_samples_from_library";
        this.setState({exclude_samples_from_library:value});
        break;
      case "exclude-trailers":
        address = "settings.preferences.exclude_trailers_from_library";
        this.setState({exclude_trailers_from_library:value});
        break;
      case "kinds" :
        address = "settings.used.kinds";
        this.setState({kinds:value});
        break;
      case "override-dialogs" :
        address = "settings.preferences.override_dialogs";
        let new_od = _.cloneDeep(this.state.override_dialogs);
        new_od[subProp] = value;
        value = new_od;
        this.setState({override_dialogs:value});
        break;
    }

    if (address !== '') {
      let saveObj = {};
      saveObj[address] = value;
      this.props.save(saveObj);
    } else {
      settingsLog.error('Could not save a preference because no library address was resolved', {
        property: property
      });
    }
  }

  render() {
    const dialogDescriptions = {
      'MynEditorSearch-confirm-select' : 'Confirm selection of search result in video editor',
      'MynEditor-confirm-exit' : 'Confirm on exiting video editor without saving',
      'MynEditorEdit-confirm-revert' : 'Confirm on reverting to saved values in video editor',
      'MynLibTable-confirm-inlineEdit' : (
        <span>
          {'Confirm when editing a video directly from a widget'}
          <br/>
          {'in a table row (e.g. the rating stars)'}
        </span>
      ),
      'MynAutoTag-confirm-cancel' : 'Confirm before canceling Auto-Tag',
      'MynEditor-confirm-reset-from-filename' : 'Confirm before resetting video information from filenames',
      'MynSettingsFolders-confirm-remove' : 'Confirm before removing a watchfolder',
      'MynSettingsPlaylists-confirm-delete-playlist' : 'Confirm before deleting a playlist',
      'MynSettingsPrefs-confirm-remove-kind' : 'Confirm before removing a media kind'
    }

    return (
      <div id='settings-preferences'>
        <ul className='sections-container'>
          <li id='settings-prefs-cols' className='subsection'>
            <h2>Default Columns for new playlists:</h2>
            <MynSettingsColumns
              used={this.state.defaultcolumns.used}
              unused={this.state.defaultcolumns.unused}
              defaultcolumns={this.props.settings.preferences.defaultdefaultcolumns}
              update={this.update}
              displayTransform={this.props.displayColumnName}
              storeTransform={(val) => this.props.displayColumnName(val,true)}
            />
          </li>
          <li id='settings-prefs-kinds' className='subsection'>
            <h2>Media Kinds:</h2>
            <MynEditInlineAddListWidget
              object={this.state}
              property="kinds"
              update={this.update}
              options={null}
              deleteDialog={'Videos of this kind will not be affected until edited.'}
              deleteConfirmationPreference='MynSettingsPrefs-confirm-remove-kind'
              deleteConfirmationDisabled={Boolean(this.state.override_dialogs && this.state.override_dialogs['MynSettingsPrefs-confirm-remove-kind'])}
              onDeleteConfirmationDisabled={() => {
                let overrideDialogs = _.cloneDeep(this.state.override_dialogs || {});
                overrideDialogs['MynSettingsPrefs-confirm-remove-kind'] = true;
                this.setState({override_dialogs: overrideDialogs});
              }}
              storeTransform={value => value.toLowerCase()}
              displayTransform={value => value.replace(/\b\w/g,(letter) => letter.toUpperCase())}
              validator={/^[^=;{}]+$/}
              validatorTip={"Not allowed: = ; { }"}
              reportValid={() => {}}
            />
          </li>
          <li id='settings-prefs-libraryexclusions' className='subsection'>
            <h2>Library Exclusions:</h2>
            <div>
              <input
                type='checkbox'
                checked={this.state.exclude_samples_from_library}
                onChange={(e) => this.update('exclude-samples',e.target.checked)}
              />
              Exclude sample videos from library
              <MynTooltip tip="If checked, short release samples and known release-group garbage clips will be excluded on the next watchfolder scan" />
            </div>
            <div>
              <input
                type='checkbox'
                checked={this.state.exclude_trailers_from_library}
                onChange={(e) => this.update('exclude-trailers',e.target.checked)}
              />
              Exclude trailers from library
              <MynTooltip tip="If checked, short videos whose filenames identify them as trailers will be excluded on the next watchfolder scan" />
            </div>
          </li>
          <li id='settings-prefs-includenew' className='subsection'>
            <h2>Include New:</h2>
            <input
              type='checkbox'
              checked={this.state.include_new_vids_in_playlists ? true : false}
              onChange={(e) => this.update('include-new',e.target.checked)}
            />
            Include new videos in playlists
            <MynTooltip tip="If unchecked, videos marked as New will appear only in the 'New' playlist" />
          </li>
          <li id='settings-prefs-removeautotaggednew' className='subsection'>
            <h2>Remove from New:</h2>
            <div>
              <input
                type='checkbox'
                checked={this.state.remove_edited_from_new}
                onChange={(e) => this.update('remove-edited-new', e.target.checked)}
              />
              Remove individually edited videos from 'New' when saved
              <MynTooltip tip="If unchecked, saving an individual edit preserves the video's current New status. Batch edits always preserve each video's status unless the batch New checkbox is changed." />
            </div>
            <div>
              <input
                type='checkbox'
                checked={this.state.remove_autotagged_from_new}
                onChange={(e) => this.update('remove-autotagged-new', e.target.checked)}
              />
              Remove successfully auto-tagged videos from 'New'
              <MynTooltip tip="If unchecked, auto-tagging preserves each video's current New status" />
            </div>
          </li>
          <li id='settings-prefs-hidedescrip' className='subsection'>
            <h2>Hide Descriptions:</h2>
            <input
              type='checkbox'
              checked={this.state.hide_description === "hide" ? true : false}
              onChange={(e) => this.update('hide-description',e.target.checked ? "hide" : "show")}
            />
            Hide plot summaries
            <MynTooltip tip="Hide plot summaries in the Details pane until clicked on" />
          </li>
          <li id='settings-prefs-userratingavg' className='subsection'>
            <h2>Average Rating:</h2>
            <input
              type='checkbox'
              checked={this.state.include_user_rating_in_avg ? true : false}
              onChange={(e) => this.update('user-rating-avg',e.target.checked)}
            />
            Include user rating in avg rating
            <MynTooltip tip="If checked, the user rating (i.e. the rating stars) will be included along with the external ratings (Rotten Tomatoes, Metacritic, and IMDb) when calculating the average (though only if you've actually rated it). If unchecked, the average will only be calculated from the external ratings." />
          </li>
          <li id='settings-prefs-showdialogs' className='subsection' style={{display: this.props.settings.preferences.override_dialogs && Object.keys(this.props.settings.preferences.override_dialogs).length > 0 ? 'block' : 'none'}}>
            <h2>Show Confirmation Dialogs:</h2>
            {this.state.override_dialogs ? Object.keys(this.state.override_dialogs).map(dialogName => (
              <div className='dialog' key={dialogName} style={{display:'flex'}}>
                <input
                  type='checkbox'
                  checked={!this.state.override_dialogs[dialogName]}
                  onChange={(e) => this.update('override-dialogs',!e.target.checked,dialogName)}
                />
                <div className='showdialog-descrip'>{dialogDescriptions[dialogName] || dialogName}</div>
              </div>
            )) : null}
          </li>
        </ul>
      </div>
    );
  }
}

class MynSettingsColumns extends React.Component {
  constructor(props) {
    super(props);

    // this.state = {
    //   used : _.cloneDeep(props.used),
    //   unused : _.cloneDeep(props.unused)
    // }

    this.onDragEnd = this.onDragEnd.bind(this);
  }

  onDragEnd(result) {
    let temp = {};
    temp.used = _.cloneDeep(this.props.used);
    temp.unused = _.cloneDeep(this.props.unused);

    const { destination, source, draggableId } = result;
    // if the user actually moved an item
    if (destination && (destination.droppableId !== source.droppableId || destination.index !== source.index)) {
      // move the item
      const movedItems = temp[source.droppableId].splice(source.index,1);

      // transform the item if given a transform function
      let movedItem;
      try {
        movedItem = this.props.storeTransform(movedItems[0]);
      } catch(err) {
        movedItem = movedItems[0];
      }

      // store the item in the new location
      temp[destination.droppableId].splice(destination.index, 0, movedItems[0]);
    }

    this.props.update('columns',temp);//{ used : this.props.used, unused : this.props.unused });
  }

  render() {
    return (
      <DragDropContext onDragEnd={this.onDragEnd}>
        <div className='settings-columns'>
          <Droppable droppableId='used' direction='horizontal'>
            {(provided) => (
              <div>
                <label>Used:</label>
                <ul className="columns-list used" ref={provided.innerRef} {...provided.droppableProps}>
                  {this.props.used.map((col,i) => (
                    <Draggable key={col} draggableId={col} index={i}>
                      {(provided) => (
                        <li className='col' ref={provided.innerRef} {...provided.draggableProps} {...provided.dragHandleProps}>{this.props.displayTransform ? this.props.displayTransform(col) : col}</li>
                      )}
                    </Draggable>
                  ))}
                  {provided.placeholder}
                </ul>
              </div>
            )}
          </Droppable>
          <Droppable droppableId='unused' direction='horizontal'>
          {(provided) => (
            <div>
              <label>Available:</label>
              <ul className="columns-list unused" ref={provided.innerRef} {...provided.droppableProps}>
                {this.props.unused.map((col,i) => (
                  <Draggable key={col} draggableId={col} index={i}>
                    {(provided) => (
                      <li className='col' ref={provided.innerRef} {...provided.draggableProps} {...provided.dragHandleProps}>{this.props.displayTransform ? this.props.displayTransform(col) : col}</li>
                    )}
                  </Draggable>
                ))}
                {provided.placeholder}
              </ul>
            </div>
          )}
          </Droppable>
          <button className='settings-prefs-restore-btn' onClick={() => this.props.update('columns',this.props.defaultcolumns)}>Restore Default Columns</button>
        </div>
      </DragDropContext>
    );
  }
}

class MynSettingsPlaylistsTableRow extends React.Component {
  constructor(props) {
    super(props);
  }

  render() {
    let playlist = this.props.playlist;

    let dragButton = (
      <div className='cell drag-button' {...this.props.provided.dragHandleProps}>
        {'\u2630'}
      </div>
    );

    let tabCheckbox = (
      <div className='cell tab'>
        <input
          type='checkbox'
          checked={playlist.tab}
          onChange={(e) => this.props.updateValue(this.props.index,'tab',e.target.checked)}
        />
      </div>
    );

    let uneditable = playlist.id === 'new';
    let newToolTip = "The 'New' playlist is a special built-in playlist that only appears when there are new videos. A video is marked New when it is first added to the library, and remains there until its New checkbox is cleared. By default, saving edits preserves that status; this can be changed in Preferences. The 'New' playlist cannot be deleted, but you can hide it by unchecking the 'tab' property."
    let name = (
      <div className='cell name name-and-edit'>
        <MynEditText
          object={playlist}
          property='name'
          update={(...args) => this.props.updateValue(this.props.index,...args)}
          options={null}
          validator={/[^\s]/}
          validatorTip={'At least 1 non-whitespace character'}
          allowedEmpty={false}
          reportValid={this.props.reportValid}
          uneditable={uneditable}
          tooltip={playlist.id === 'new' ? newToolTip : null}
        />
      </div>
    );

    let filterHeader = (
      <div className='header filter' id={'edit-filter-header-' + playlist.id} style={{display: 'none'}}>
        Filter
      </div>
    );

    let filterHelp = (
      <MynParagraphFolder
        className='filter-help'
        lede={"Filter Help"}
        paragraph={
          <div className='filter-help-paragraph'>
            <div className='filter-help-text'>
              The filter is a boolean expression that will be executed on each video object in the library. If the expression evaluates to true, the video will be included in the playlist. If it evaluates to false, the video will not be included. The expression can use any property of the video object, and can use standard JavaScript operators and functions. For example, to include only videos with a genre of 'Action', you could use: <pre>video.genre === 'Action'</pre>. To include videos with a user rating greater than 3, you could use: <pre>Number(video.ratings.user) &gt; 3</pre>.
              <br /><br />
              Note: unset values are generally represented by an empty string, and some numeric values may be stored as numeric strings. Use <pre>Number()</pre> when making numeric comparisons.
            </div>
            <div className='filter-help-list'>
              <h3>Video Properties</h3>
              <ul>
                <li><strong>title:</strong> <i>[string]</i> The title of the video</li>
                <li><strong>year:</strong> <i>[integer]</i> The year the video was released</li>
                <li><strong>series:</strong> <i>[string]</i> The series the video belongs to</li>
                <li><strong>season:</strong> <i>[integer]/"Extras"</i> The season the video belongs to ("Extras" is a special allowed season name)</li>
                <li><strong>episode:</strong> <i>[number] (one decimal place)</i> The episode number of the video</li>
                <li><strong>director:</strong> <i>[string]</i> The director of the video</li>
                <li><strong>directorsort:</strong> <i>[string]</i> The sort name of the director (e.g. "Smithee, Alan")</li>
                <li><strong>cast:</strong> <i>[array[string]]</i> The cast of the video</li>
                <li><strong>description:</strong> <i>[string]</i> The plot summary of the video</li>
                <li><strong>genre:</strong> <i>[string]</i> The genre of the video</li>
                <li><strong>tags:</strong> <i>[array[string]]</i> The video's tags</li>
                <li><strong>seen:</strong> <i>[boolean]</i> Whether the video has been seen</li>
                <li><strong>position:</strong> <i>[number]</i> The watch position of the video in seconds</li>
                <li><strong>ratings:</strong> <i>[object]</i> The ratings of the video
                  <ul>
                    <li><strong>user:</strong> <i>[integer] (1-5)</i> The user rating of the video</li>
                    <li><strong>imdb:</strong> <i>[number] (0-10)</i> The IMDb rating of the video</li>
                    <li><strong>rt:</strong> <i>[integer] (0-100)</i> The Rotten Tomatoes rating of the video</li>
                    <li><strong>mc:</strong> <i>[integer] (0-100)</i> The Metacritic rating of the video</li>
                  </ul>
                </li>
                <li><strong>dateadded:</strong> <i>[integer]</i> The date the video was added (file birthtime), seconds since Unix epoch</li>
                <li><strong>lastseen:</strong> <i>[integer]</i> The date the video was last seen, seconds since Unix epoch</li>
                <li><strong>kind:</strong> <i>[string]</i> The kind of the video (e.g. "movie", "show")</li>
                <li><strong>filename:</strong> <i>[string]</i> The absolute file path of the video</li>
                <li><strong>artwork:</strong> <i>[string]</i> The absolute file path of the video's artwork</li>
                <li><strong>subtitles:</strong> <i>[array[string]]</i> The absolute file paths of the video's subtitles</li>
                <li><strong>boxoffice:</strong> <i>[number]</i> The box office earnings of the video, American dollars</li>
                <li><strong>rated:</strong> <i>[string]</i> The MPAA/TVPG rating of the video</li>
                <li><strong>languages:</strong> <i>[array[string]]</i> The languages of the video</li>
                <li><strong>country:</strong> <i>[string]</i> The country of the video</li>
                <li><strong>metadata:</strong> <i>[object]</i> The metadata of the video
                  <ul>
                    <li><strong>codec:</strong> <i>[string]</i> The codec of the video</li>
                    <li><strong>duration:</strong> <i>[number]</i> The duration of the video in seconds</li>
                    <li><strong>width:</strong> <i>[integer]</i> The width of the video, pixels</li>
                    <li><strong>height:</strong> <i>[integer]</i> The height of the video, pixels</li>
                    <li><strong>aspect_ratio:</strong> <i>[string]</i> The aspect ratio of the video</li>
                    <li><strong>framerate:</strong> <i>[number]</i> The framerate of the video</li>
                    <li><strong>audio_codec:</strong> <i>[string]</i> The audio codec of the video</li>
                    <li><strong>audio_layout:</strong> <i>[string]</i> The audio layout of the video</li>
                    <li><strong>audio_channels:</strong> <i>[integer]</i> The number of audio channels of the video</li>
                  </ul>
                </li>
                <li><strong>imdbID:</strong> <i>[string]</i> The IMDb ID of the video</li>
                <li><strong>seriesImdbID:</strong> <i>[string]</i> The IMDb ID of the series the video belongs to</li>
                <li><strong>autotag_tried:</strong> <i>[boolean]</i> Whether auto-tagging has been tried on this video</li>
                <li><strong>new:</strong> <i>[boolean]</i> Whether the video is new</li>
                <li><strong>dvd:</strong> <i>[boolean]</i> Whether the video is a DVD folder</li>
                <li><strong>watchlater:</strong> <i>[boolean]</i> Whether the video is marked to watch later (♥)</li>
              </ul>
            </div>
          </div>
        }
      />
    );

    let filterEditor = (
      <div className="cell filter" id={'edit-filter-field-' + playlist.id} style={{ display: 'none' }}>
        <textarea
          className='edit-filter-field'
          name="playlist filter"
          value={playlist.filter_function}
          placeholder={'Enter a boolean expression to be executed on each video object: e.g. video.genre === \'Action\''}
          onChange={(e) => this.props.updateValue(this.props.index, 'filter_function', e.target.value)}
        />
        {filterHelp}
      </div>
    );


    let columnsHeader = (
      <div className='header columns' id={'edit-columns-header-' + playlist.id} style={{display: 'none'}}>
        Columns
      </div>
    );

    let columnsEditor = (
      <div className="cell columns" id={'edit-columns-field-' + playlist.id} style={{display: 'none'}}>
        <MynSettingsColumns
          used={playlist.columns}
          defaultcolumns={this.props.defaultcolumns}
          unused={this.props.allColumns.filter(col => !playlist.columns.includes(col))}
          update={(prop, columns) => this.props.updateValue(this.props.index,prop,columns.used)}
          displayTransform={this.props.displayColumnName}
          storeTransform={(val) => this.props.displayColumnName(val,true)}
        />
      </div>
    );

    let view = (
      <div className='cell view'>
        <div className='select-container select-alwaysicon'>
          <select value={playlist.view} onChange={(e) => this.props.updateValue(this.props.index,'view',e.target.value)}>
            <option value='flat'>Flat</option>
            <option value='series'>Series</option>
          </select>
        </div>
      </div>
    );

    let editButton = (
      <div className='cell edit-btn'>
        <button onClick={() => this.props.showEditPlaylist(playlist)}>Edit</button>
      </div>
    );

    let deleteButton = (
      <div className='cell delete-btn'>
        <button onClick={() => this.props.deletePlaylist(playlist)}>Delete</button>
      </div>
    );

    // several things are not to be displayed for the 'new' playlist, because it's a special playlist
    return (
      <div className="row" id={'settings-playlists-row-' + playlist.id} ref={this.props.innerRef} {...this.props.provided.draggableProps}>
        {dragButton}
        {tabCheckbox}
        {name}
        {playlist.id === 'new' ? null : filterHeader}
        {playlist.id === 'new' ? null : filterEditor}
        {columnsHeader}
        {columnsEditor}
        {view}
        {editButton}
        {playlist.id === 'new' ? null : deleteButton}
      </div>
    );

  }
}

function shareKindValues(settings, videos) {
  const values = new Set();
  const configured = settings && settings.used && Array.isArray(settings.used.kinds) ?
    settings.used.kinds : [];
  configured.forEach(kind => {
    if (typeof kind === 'string' && kind.trim()) values.add(kind.trim().toLowerCase());
  });
  (Array.isArray(videos) ? videos : []).forEach(video => {
    if (video && typeof video.kind === 'string' && video.kind.trim()) {
      values.add(video.kind.trim().toLowerCase());
    }
  });
  return Array.from(values).sort((a, b) => a.localeCompare(b, undefined, {sensitivity: 'base'}));
}

function shareKindLabel(kind) {
  return String(kind || '').replace(/\b\w/g, letter => letter.toUpperCase());
}

function formatShareBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown size';
  if (bytes === 0) return '0 bytes';
  const units = ['bytes', 'KiB', 'MiB', 'GiB', 'TiB'];
  const unit = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, unit);
  const decimals = unit === 0 || value >= 10 ? 0 : 1;
  return `${value.toFixed(decimals)} ${units[unit]}`;
}

const shareReasonLabels = {
  'requested-kind-unmapped': 'requested kinds deliberately not mapped',
  'dvd-excluded': 'DVDs excluded',
  'identity-conflict': 'same ID but different content',
  'source-unavailable': 'source unavailable',
  'subtitle-unavailable': 'subtitle files unavailable',
  'SOURCE_OUTSIDE_WATCHFOLDER': 'outside a watchfolder',
  'destination-path-conflict': 'destination path collisions',
  'SHARE_SOURCE_MISSING': 'source missing',
  'SHARE_SYMLINK_UNSUPPORTED': 'symbolic links unsupported',
  'INVALID_DVD_SOURCE': 'invalid DVD folders',
  'INVALID_VIDEO_SOURCE': 'invalid video files',
  'EMPTY_DVD_SOURCE': 'empty DVD folders',
  'SHARE_PACKAGE_INCOMPLETE': 'incomplete package files',
  'SHARE_DESTINATION_CONFLICT': 'destination conflicts',
  'PARTIAL_DVD_DESTINATION': 'partial DVD destinations',
  'import-conflict': 'import conflicts'
};

class MynSettingsShare extends React.Component {
  constructor(props) {
    super(props);
    const kinds = shareKindValues(props.settings, props.videos);
    this.state = {
      shareDirectory: '',
      selectedRequestKinds: kinds,
      includeDvds: true,
      replaceRequestReady: false,
      inspection: null,
      fulfillmentMappings: {},
      fulfillmentIncludeDvds: true,
      fulfillmentPlan: null,
      importMappings: {},
      importPlan: null,
      busy: false,
      busyPhase: null,
      cancelRequested: false,
      progress: null,
      message: null,
      messageType: 'info'
    };

    this.handleShareProgress = this.handleShareProgress.bind(this);
    this.changeShareDirectory = this.changeShareDirectory.bind(this);
    this.folderSelect = this.folderSelect.bind(this);
    this.loadShare = this.loadShare.bind(this);
    this.createShareRequest = this.createShareRequest.bind(this);
    this.prepareFulfillment = this.prepareFulfillment.bind(this);
    this.fulfillRequest = this.fulfillRequest.bind(this);
    this.prepareImport = this.prepareImport.bind(this);
    this.importShare = this.importShare.bind(this);
    this.cancelShare = this.cancelShare.bind(this);
  }

  componentDidMount() {
    ipcRenderer.on('share-progress', this.handleShareProgress);
    ipcRenderer.invoke('share:get-state').then(response => {
      if (response && response.ok && response.value) {
        this.handleShareProgress(null, response.value);
      }
    }).catch(err => {
      settingsLog.warn('Could not retrieve current Share state', {error: err});
    });
  }

  componentWillUnmount() {
    ipcRenderer.removeListener('share-progress', this.handleShareProgress);
  }

  handleShareProgress(event, progress) {
    progress = progress || {};
    this.setState({
      busy: Boolean(progress.busy),
      busyPhase: progress.phase || null,
      cancelRequested: Boolean(progress.cancelRequested),
      progress: progress.busy ? progress : null
    });
  }

  async invokeShare(channel, options) {
    try {
      const response = await ipcRenderer.invoke(channel, options || {});
      if (!response || response.ok !== true) {
        const error = response && response.error || {};
        const thrown = new Error(error.message || 'Mynda could not complete the Share operation.');
        thrown.code = error.code || 'SHARE_FAILED';
        thrown.details = error.details;
        throw thrown;
      }
      return response.value;
    } catch(err) {
      const correctableShareError = typeof err.code === 'string' &&
        /^(?:SHARE_|NO_SHARE_|INVALID_IMPORT_|IMPORT_|MISSING_IMPORT_|SOURCE_KIND_|UNKNOWN_SOURCE_|FULFILLMENT_|PARTIAL_DVD_)/.test(err.code);
      const logData = {channel: channel, error: err};
      if (correctableShareError) {
        settingsLog.warn('Share action was not completed in the renderer', logData);
      } else {
        settingsLog.error('Share action failed in the renderer', logData);
      }
      throw err;
    }
  }

  clearLoadedShare(directory) {
    this.setState({
      shareDirectory: directory,
      replaceRequestReady: false,
      inspection: null,
      fulfillmentMappings: {},
      fulfillmentPlan: null,
      importMappings: {},
      importPlan: null,
      message: null
    });
  }

  changeShareDirectory(directory) {
    this.clearLoadedShare(directory || '');
  }

  clearShareMessage(changes = {}) {
    this.setState(Object.assign({
      message: null,
      messageType: 'info'
    }, changes));
  }

  async folderSelect() {
    this.clearShareMessage();
    try {
      const result = await this.invokeShare('share:choose-directory');
      if (result && result.directory) {
        this.clearLoadedShare(result.directory);
      }
    } catch(err) {
      this.setState({message: err.message, messageType: 'error'});
    }
  }

  mappingsFromInspection(inspection) {
    const fulfillmentMappings = {};
    (inspection.defaultFulfillmentMappings || []).forEach(mapping => {
      fulfillmentMappings[mapping.requestedKindId] = (mapping.sourceKinds || []).slice();
    });
    const importMappings = {};
    (inspection.defaultImportMappings || []).forEach(mapping => {
      importMappings[mapping.requestedKindId] = {
        localKind: mapping.localKind || '',
        watchfolder: mapping.watchfolder || ''
      };
    });
    return {fulfillmentMappings: fulfillmentMappings, importMappings: importMappings};
  }

  async loadShare(options = {}) {
    this.clearShareMessage();
    if (!this.state.shareDirectory) {
      this.setState({message: 'Choose a Share directory first.', messageType: 'error'});
      return null;
    }
    try {
      const inspection = await this.invokeShare('share:inspect', {
        directory: this.state.shareDirectory
      });
      const mappings = this.mappingsFromInspection(inspection);
      this.setState({
        inspection: inspection,
        fulfillmentMappings: mappings.fulfillmentMappings,
        fulfillmentIncludeDvds: inspection.request.includeDvds &&
          (!inspection.fulfillment || inspection.fulfillment.includeDvds !== false),
        fulfillmentPlan: null,
        importMappings: mappings.importMappings,
        importPlan: null,
        replaceRequestReady: false,
        message: options.message || `Loaded Share request created ${new Date(inspection.request.createdAt).toLocaleString()}.`,
        messageType: options.messageType || 'success'
      });
      return inspection;
    } catch(err) {
      this.setState({message: err.message, messageType: 'error', inspection: null});
      return null;
    }
  }

  toggleRequestKind(kind) {
    const selected = new Set(this.state.selectedRequestKinds);
    if (selected.has(kind)) selected.delete(kind); else selected.add(kind);
    this.setState({selectedRequestKinds: Array.from(selected)});
  }

  selectAllRequestKinds(select) {
    this.setState({
      selectedRequestKinds: select ? shareKindValues(this.props.settings, this.props.videos) : []
    });
  }

  async createShareRequest() {
    this.clearShareMessage();
    if (!this.state.shareDirectory) {
      this.setState({message: 'Choose a Share directory first.', messageType: 'error'});
      return;
    }
    if (this.state.selectedRequestKinds.length === 0) {
      this.setState({message: 'Select at least one media kind to request.', messageType: 'error'});
      return;
    }
    try {
      const result = await this.invokeShare('share:create-request', {
        directory: this.state.shareDirectory,
        requestedKinds: this.state.selectedRequestKinds,
        includeDvds: this.state.includeDvds,
        overwrite: this.state.replaceRequestReady
      });
      const action = result.replacedExistingRequest ? 'Replaced' : 'Created';
      await this.loadShare({
        message: `${action} Share request with ${result.inventoriedVideos} present video${result.inventoriedVideos === 1 ? '' : 's'}.` +
          (result.unavailableVideos ? ` ${result.unavailableVideos} unavailable video${result.unavailableVideos === 1 ? ' was' : 's were'} left out of the inventory.` : ''),
        messageType: result.unavailableVideos ? 'warning' : 'success'
      });
    } catch(err) {
      if (err.code === 'SHARE_REQUEST_EXISTS') {
        this.setState({
          replaceRequestReady: true,
          message: 'This directory already contains a Share request. Click “Replace Existing Request” to replace it. Any media files copied for the previous request will remain in the directory, but the replacement request will not list or use them.',
          messageType: 'warning'
        });
      } else {
        this.setState({message: err.message, messageType: 'error'});
      }
    }
  }

  toggleFulfillmentKind(requestedKindId, sourceKind) {
    const mappings = _.cloneDeep(this.state.fulfillmentMappings);
    Object.keys(mappings).forEach(kindId => {
      mappings[kindId] = (mappings[kindId] || []).filter(kind => kind !== sourceKind);
    });
    const wasSelected = (this.state.fulfillmentMappings[requestedKindId] || []).includes(sourceKind);
    if (!wasSelected) {
      mappings[requestedKindId] = (mappings[requestedKindId] || []).concat(sourceKind);
    }
    this.setState({
      fulfillmentMappings: mappings,
      fulfillmentPlan: null,
      message: null,
      messageType: 'info'
    });
  }

  fulfillmentMappingArray() {
    const requestedKinds = this.state.inspection && this.state.inspection.request.requestedKinds || [];
    return requestedKinds.map(kind => ({
      requestedKindId: kind.id,
      sourceKinds: (this.state.fulfillmentMappings[kind.id] || []).slice()
    }));
  }

  async prepareFulfillment() {
    this.clearShareMessage({fulfillmentPlan: null});
    try {
      const plan = await this.invokeShare('share:plan-fulfillment', {
        directory: this.state.shareDirectory,
        kindMappings: this.fulfillmentMappingArray(),
        includeDvds: this.state.fulfillmentIncludeDvds
      });
      this.setState({
        fulfillmentPlan: plan,
        message: plan.enoughSpace ? 'Fulfillment plan is ready for review.' :
          'The Share directory does not have enough free space for this plan and its safety reserve.',
        messageType: plan.enoughSpace ? 'info' : 'error'
      });
    } catch(err) {
      this.setState({message: err.message, messageType: 'error', fulfillmentPlan: null});
    }
  }

  async fulfillRequest() {
    const plan = this.state.fulfillmentPlan;
    if (!plan) return;
    this.clearShareMessage();
    try {
      const result = await this.invokeShare('share:fulfill-request', {token: plan.token});
      await this.loadShare({
        message: result.canceled ?
          `Share fulfillment canceled after packaging ${result.packagedVideos} video${result.packagedVideos === 1 ? '' : 's'}. It can be resumed later.` :
          `Share fulfillment ${result.status === 'complete' ? 'finished' : 'finished with problems'}: ${result.packagedVideos} video${result.packagedVideos === 1 ? '' : 's'} packaged` +
            (result.failedVideos ? `; ${result.failedVideos} failed` : '') + '.',
        messageType: result.status === 'complete' ? 'success' : 'warning'
      });
    } catch(err) {
      this.setState({message: err.message, messageType: 'error', fulfillmentPlan: null});
    }
  }

  changeImportKind(requestedKindId, localKind) {
    const mappings = _.cloneDeep(this.state.importMappings);
    const folders = this.state.inspection.watchfolders.filter(folder => folder.kind === localKind);
    mappings[requestedKindId] = {
      localKind: localKind,
      watchfolder: folders.length > 0 ? folders[0].path : ''
    };
    this.setState({
      importMappings: mappings,
      importPlan: null,
      message: null,
      messageType: 'info'
    });
  }

  changeImportWatchfolder(requestedKindId, watchfolder) {
    const mappings = _.cloneDeep(this.state.importMappings);
    mappings[requestedKindId] = Object.assign({}, mappings[requestedKindId], {watchfolder: watchfolder});
    this.setState({
      importMappings: mappings,
      importPlan: null,
      message: null,
      messageType: 'info'
    });
  }

  importMappingArray() {
    const importKinds = this.state.inspection && this.state.inspection.importKinds || [];
    return importKinds.map(kind => ({
      requestedKindId: kind.id,
      localKind: this.state.importMappings[kind.id] && this.state.importMappings[kind.id].localKind || '',
      watchfolder: this.state.importMappings[kind.id] && this.state.importMappings[kind.id].watchfolder || ''
    }));
  }

  importMappingsComplete() {
    const mappings = this.importMappingArray();
    return mappings.length > 0 && mappings.every(mapping => mapping.localKind && mapping.watchfolder);
  }

  async prepareImport() {
    this.clearShareMessage({importPlan: null});
    try {
      const plan = await this.invokeShare('share:plan-import', {
        directory: this.state.shareDirectory,
        kindMappings: this.importMappingArray()
      });
      this.setState({
        importPlan: plan,
        message: plan.enoughSpace ? 'Import plan is ready for review.' :
          'One or more destination drives do not have enough free space for this import and its safety reserve.',
        messageType: plan.enoughSpace ? 'info' : 'error'
      });
    } catch(err) {
      this.setState({message: err.message, messageType: 'error', importPlan: null});
    }
  }

  async importShare() {
    const plan = this.state.importPlan;
    if (!plan) return;
    this.clearShareMessage();
    try {
      const result = await this.invokeShare('share:import', {token: plan.token});
      this.setState({
        importPlan: null,
        message: result.canceled ?
          `Share import canceled after preparing ${result.readyForScan} video${result.readyForScan === 1 ? '' : 's'}.` :
          `Share import ${result.status === 'complete' ? 'finished' : 'finished with problems'}: ${result.readyForScan} video${result.readyForScan === 1 ? '' : 's'} ready` +
            (result.failedVideos ? `; ${result.failedVideos} failed` : '') +
            (result.shouldScan ? '. Mynda is scanning the destination watchfolders now.' : '.'),
        messageType: result.status === 'complete' ? 'success' : 'warning'
      });
    } catch(err) {
      this.setState({message: err.message, messageType: 'error', importPlan: null});
    }
  }

  async cancelShare() {
    this.clearShareMessage();
    try {
      const result = await this.invokeShare('share:cancel');
      if (result.cancelRequested) {
        this.setState({cancelRequested: true, message: 'Canceling after the current filesystem operation stops safely…', messageType: 'warning'});
      }
    } catch(err) {
      this.setState({message: err.message, messageType: 'error'});
    }
  }

  renderReasonCounts(counts) {
    const entries = Object.keys(counts || {});
    if (entries.length === 0) return null;
    return (
      <ul className='share-reason-counts'>
        {entries.sort().map(reason => (
          <li key={reason}><span className='share-summary-value'>{counts[reason]}</span> {shareReasonLabels[reason] || reason}</li>
        ))}
      </ul>
    );
  }

  renderProgress() {
    if (!this.state.busy || !this.state.progress) return null;
    const progress = this.state.progress;
    const labels = {
      request: 'Creating request',
      'fulfillment-plan': 'Preparing fulfillment plan',
      fulfill: 'Fulfilling request',
      'import-plan': 'Preparing import plan',
      import: 'Importing media'
    };
    let detail = '';
    if (progress.numTotal) detail += ` ${progress.numCurrent || 0} of ${progress.numTotal}`;
    if (progress.bytesTotal) {
      detail += ` — ${formatShareBytes(progress.bytesCurrent || 0)} of ${formatShareBytes(progress.bytesTotal)}`;
    }
    return (
      <div className='share-progress'>
        <span>{labels[this.state.busyPhase] || 'Working'}{detail}</span>
        <button onClick={this.cancelShare} disabled={this.state.cancelRequested}>
          {this.state.cancelRequested ? 'Canceling…' : 'Cancel'}
        </button>
      </div>
    );
  }

  renderRequestSection() {
    const kinds = shareKindValues(this.props.settings, this.props.videos);
    return (
      <div className='subsection share-request-section'>
        <h2>Create a Request</h2>
        <p>Create a small inventory describing what this library already has and which kinds it wants another Mynda library to share.</p>
        <div className='share-kind-heading'>Requested kinds:</div>
        <div className='share-kind-actions'>
          <button onClick={() => this.selectAllRequestKinds(true)} disabled={this.state.busy}>All</button>
          <button onClick={() => this.selectAllRequestKinds(false)} disabled={this.state.busy}>None</button>
        </div>
        <div className='share-kind-list'>
          {kinds.map(kind => (
            <label key={kind}>
              <input type='checkbox' checked={this.state.selectedRequestKinds.includes(kind)}
                onChange={() => this.toggleRequestKind(kind)} disabled={this.state.busy} />
              {shareKindLabel(kind)}
            </label>
          ))}
        </div>
        <label className='share-dvd-option'>
          <input type='checkbox' checked={this.state.includeDvds}
            onChange={event => this.setState({includeDvds: event.target.checked})}
            disabled={this.state.busy} />
          Include DVD folders
        </label>
        <div className='share-actions'>
          <button onClick={this.createShareRequest}
            disabled={this.state.busy || !this.state.shareDirectory || this.state.selectedRequestKinds.length === 0}>
            {this.state.replaceRequestReady ? 'Replace Existing Request' : 'Create Request'}
          </button>
        </div>
      </div>
    );
  }

  renderFulfillmentSection() {
    const inspection = this.state.inspection;
    if (!inspection) return null;
    const sourceKinds = inspection.localKinds || [];
    const plan = this.state.fulfillmentPlan;
    return (
      <div className='subsection share-fulfillment-section'>
        <h2>Fulfill This Request</h2>
        <p>Choose which kinds in this library correspond to each kind requested by the receiving library. One requested kind may use several local kinds.</p>
        <div className='share-mapping-table'>
          <div className='share-mapping-header'>Requested kind</div>
          <div className='share-mapping-header'>Use these local kinds</div>
          {inspection.request.requestedKinds.map(requestedKind => (
            <React.Fragment key={requestedKind.id}>
              <div className='share-mapping-label'>{shareKindLabel(requestedKind.label)}</div>
              <div className='share-mapping-options'>
                {sourceKinds.length === 0 ? <span className='share-muted'>No local kinds available</span> :
                  sourceKinds.map(sourceKind => (
                    <label key={sourceKind.value} title={sourceKind.packagedOnly ?
                      'This kind is no longer present locally, but already-packaged videos use its saved mapping.' :
                      (sourceKind.configured ? '' : 'This kind is used by active videos but is no longer configured in Preferences.')}>
                      <input type='checkbox'
                        checked={(this.state.fulfillmentMappings[requestedKind.id] || []).includes(sourceKind.value)}
                        onChange={() => this.toggleFulfillmentKind(requestedKind.id, sourceKind.value)}
                        disabled={this.state.busy} />
                      {shareKindLabel(sourceKind.label)} ({sourceKind.packagedOnly ? 'packaged only' : sourceKind.activeVideos})
                    </label>
                  ))}
                {(this.state.fulfillmentMappings[requestedKind.id] || []).length === 0 ?
                  <span className='share-unfulfilled'>Do not fulfill</span> : null}
              </div>
            </React.Fragment>
          ))}
        </div>
        <label className='share-dvd-option'>
          <input type='checkbox'
            checked={this.state.fulfillmentIncludeDvds}
            onChange={event => this.setState({
              fulfillmentIncludeDvds: event.target.checked,
              fulfillmentPlan: null,
              message: null,
              messageType: 'info'
            })}
            disabled={this.state.busy || !inspection.request.includeDvds} />
          Include requested DVD folders
        </label>
        {!inspection.request.includeDvds ?
          <div className='share-muted'>The receiving library did not request DVDs.</div> : null}
        {inspection.fulfillment ?
          <div className='share-existing-summary'>
            <div>Existing fulfillment: {inspection.fulfillment.status}, {inspection.fulfillment.itemCount} video{inspection.fulfillment.itemCount === 1 ? '' : 's'} ({inspection.fulfillment.dvdCount} DVD{inspection.fulfillment.dvdCount === 1 ? '' : 's'}), {formatShareBytes(inspection.fulfillment.totalBytes)}.</div>
            {this.renderReasonCounts(inspection.fulfillment.omissionCounts)}
          </div> : null}
        <div className='share-actions'>
          <button onClick={this.prepareFulfillment} disabled={this.state.busy}
            title='Inventory matching media and calculate the transfer plan without copying any files.'>
            Prepare Fulfillment Plan
          </button>
        </div>
        {plan ? (
          <div className={`share-plan ${plan.enoughSpace ? '' : 'insufficient'}`}>
            <h3>Fulfillment plan</h3>
            <div><span className='share-summary-value'>{plan.videos}</span> video{plan.videos === 1 ? '' : 's'} (<span className='share-summary-value'>{plan.dvds}</span> DVD{plan.dvds === 1 ? '' : 's'}), <span className='share-summary-value'>{plan.subtitles}</span> subtitle{plan.subtitles === 1 ? '' : 's'}</div>
            <div><span className='share-summary-value'>{formatShareBytes(plan.totalBytes)}</span> to copy; <span className='share-summary-value'>{formatShareBytes(plan.availableBytes)}</span> free; <span className='share-summary-value'>{formatShareBytes(plan.reserveBytes)}</span> safety reserve</div>
            <div><span className='share-summary-value'>{plan.alreadyPresent}</span> already in the receiving inventory; <span className='share-summary-value'>{plan.alreadyPackaged}</span> already packaged; <span className='share-summary-value'>{plan.omissions}</span> omitted</div>
            {this.renderReasonCounts(plan.omissionCounts)}
            <div className='share-actions'>
              <button onClick={this.fulfillRequest} disabled={this.state.busy || !plan.enoughSpace}
                title='Copy the planned video and subtitle files into this Share directory.'>
                Fulfill Request
              </button>
              <span className='share-action-description'>Copy the actual video and subtitle files into this Share directory.</span>
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  renderImportSection() {
    const inspection = this.state.inspection;
    if (!inspection || !inspection.fulfillment) return null;
    const importKinds = inspection.importKinds || [];
    const plan = this.state.importPlan;
    return (
      <div className='subsection share-import-section'>
        <h2>Import Shared Media</h2>
        <p>Choose a local kind and matching destination watchfolder for each kind in the package. Mynda will scan those watchfolders after importing.</p>
        {inspection.request.belongsToThisLibrary ? null :
          <div className='share-message warning'>This request was created by a different Mynda library. You may still import it, but verify the destinations carefully.</div>}
        {importKinds.length === 0 ?
          <div className='share-muted'>No videos in this package need to be imported.</div> :
          <div className='share-import-table'>
            <div className='share-mapping-header'>Share kind</div>
            <div className='share-mapping-header'>Local kind</div>
            <div className='share-mapping-header'>Destination watchfolder</div>
            {importKinds.map(kind => {
              const mapping = this.state.importMappings[kind.id] || {localKind: '', watchfolder: ''};
              const matchingFolders = inspection.watchfolders.filter(folder => folder.kind === mapping.localKind);
              return (
                <React.Fragment key={kind.id}>
                  <div className='share-mapping-label'>{shareKindLabel(kind.label)}</div>
                  <div className='select-container select-alwaysicon'>
                    <select value={mapping.localKind}
                      onChange={event => this.changeImportKind(kind.id, event.target.value)}
                      disabled={this.state.busy}>
                      <option value=''>Choose kind…</option>
                      {inspection.localKinds.map(localKind => (
                        <option key={localKind.value} value={localKind.value}>{shareKindLabel(localKind.label)}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <span className='select-container select-alwaysicon'>
                      <select value={mapping.watchfolder}
                        onChange={event => this.changeImportWatchfolder(kind.id, event.target.value)}
                        disabled={this.state.busy || !mapping.localKind || matchingFolders.length === 0}>
                        <option value=''>{matchingFolders.length ? 'Choose watchfolder…' : 'No matching watchfolder'}</option>
                        {matchingFolders.map(folder => (
                          <option key={folder.path} value={folder.path}>{folder.path}</option>
                        ))}
                      </select>
                    </span>
                    {mapping.localKind && matchingFolders.length === 0 ?
                      <div className='share-unfulfilled'>Add a {shareKindLabel(mapping.localKind)} watchfolder in the Folders tab first, then return here and reload this Share.</div> : null}
                  </div>
                </React.Fragment>
              );
            })}
          </div>
        }
        <div className='share-actions'>
          <button onClick={this.prepareImport}
            disabled={this.state.busy || !this.importMappingsComplete()}
            title='Inspect the packaged media and destination folders, check available space, and calculate the import plan without copying any files.'>
            Prepare Import Plan
          </button>
        </div>
        {plan ? (
          <div className={`share-plan ${plan.enoughSpace ? '' : 'insufficient'}`}>
            <h3>Import plan</h3>
            <div>{plan.videos} video{plan.videos === 1 ? '' : 's'} ({plan.dvds} DVD{plan.dvds === 1 ? '' : 's'}), {plan.filesToCopy} file{plan.filesToCopy === 1 ? '' : 's'} to copy</div>
            <div>{formatShareBytes(plan.totalBytes)} required; {plan.alreadyInLibrary} already in this library; {plan.omissions} omitted</div>
            {(plan.volumes || []).map(volume => (
              <div key={volume.diskPath}>{volume.diskPath}: {formatShareBytes(volume.availableBytes)} free, {formatShareBytes(volume.reserveBytes)} safety reserve</div>
            ))}
            {this.renderReasonCounts(plan.omissionCounts)}
            <button onClick={this.importShare} disabled={this.state.busy || !plan.enoughSpace}>
              Import Shared Media
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  render() {
    const inputClass = this.state.shareDirectory ? 'filled' : 'empty';
    return (
      <div id='settings-share'>
        <div className='subsection share-directory-section'>
          <h2>Share Directory</h2>
          <p>Use a directory on a removable drive to carry a request and its media between Mynda libraries.</p>
          <div className='share-directory-controls'>
            <div className='input-container'>
              <input type='text' id='settings-share-choose-path' className={inputClass}
                value={this.state.shareDirectory}
                placeholder='Select a Share directory…'
                onChange={event => this.changeShareDirectory(event.target.value)}
                disabled={this.state.busy} />
              <div className='input-clear-button hover'
                onClick={() => { if (!this.state.busy) this.changeShareDirectory(''); }}></div>
            </div>
            <button onClick={this.folderSelect} disabled={this.state.busy}>Browse</button>
            <button onClick={() => this.loadShare()} disabled={this.state.busy || !this.state.shareDirectory}
              title='Read and validate an existing Share request in this directory. No files will be copied.'>
              Load Share Request
            </button>
          </div>
        </div>
        {this.renderProgress()}
        {this.state.message ?
          <div className={`share-message ${this.state.messageType}`}>{this.state.message}</div> : null}
        {this.renderRequestSection()}
        {this.renderFulfillmentSection()}
        {this.renderImportSection()}
      </div>
    );
  }
}


class MynSettingsThemes extends React.Component {
  constructor(props) {
    super(props);
  }

  render() {
    return (<h1>I'm a Themee!!!</h1>)
  }
}

module.exports = {
  MynSettings,
  MynSettingsFolders,
  MynSettingsPlaylists,
  MynSettingsPrefs,
  MynSettingsColumns,
  MynSettingsPlaylistsTableRow,
  MynSettingsShare,
  MynSettingsThemes
};
