// Settings pane and its major settings views.
const React = require('react');
const {ipcRenderer} = require('electron');
const _ = require('lodash');
const path = require('path');
const {v4: uuidv4} = require('uuid');
const {DragDropContext, Droppable, Draggable} = require('react-beautiful-dnd');
const {library, settingsLog} = require('./RendererRuntime.js');
const {
  MynOpenablePane,
  MynOverflowTextMarquee,
  MynTooltip
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
      sync : (<MynSettingsSync                save={this.save} settings={this.props.settings} />)

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

    ipcRenderer.on('MynSettingsPlaylists-confirm-delete-playlist', (event, response, id) => {
      if (response === 0) { // yes
        // delete playlist
        let playlists = _.cloneDeep(this.state.playlists).filter(playlist => playlist.id !== id);
        this.setState({playlists:playlists}, () => {
          this.updateValue(); // force a save to the library
        });
      } else {
        settingsLog.debug('Playlist deletion canceled by user', {playlistID: id});
      }
    });

    this.updateValue = this.updateValue.bind(this);
    this.reportValid = this.reportValid.bind(this);
    this.showEditPlaylist = this.showEditPlaylist.bind(this);
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

  deletePlaylist(playlist) {
    let playlistName = playlist.name != '' ? `the '${playlist.name}' playlist` : 'this playlist'
    ipcRenderer.send('generic-confirm', 'MynSettingsPlaylists-confirm-delete-playlist', `Are you sure you want to delete ${playlistName}?`, playlist.id);
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
      )
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

    let filterEditor = (
      <div className="cell filter" id={'edit-filter-field-' + playlist.id} style={{display: 'none'}}>
        <textarea
          className='edit-filter-field'
          name="playlist filter"
          value={playlist.filter_function}
          placeholder={'Enter a boolean expression to be executed on each video object: e.g. video.genre === \'Action\''}
          onChange={(e) => this.props.updateValue(this.props.index,'filter_function',e.target.value)}
        />
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

class MynSettingsSync extends React.Component {
  constructor(props) {
    super(props);
    this.state = {driveList : [],
      driveInfo : [],
      selectedDrive : ''}

    this.render = this.render.bind(this);
    //this.findDrives = this.findDrives.bind(this);
    this.selectDrive = this.selectDrive.bind(this);
    this.plantManifest = this.plantManifest.bind(this);
    this.exportFiles = this.exportFiles.bind(this);
  }

  /*findDrives() {
    lsDevices()
    .then((drives) => {
      let currentDriveList = [<option key={-1} disabled selected value> -- select an option -- </option>];
      for (let i=0; i<drives.length; i++) {
        let drive = drives[i];
        currentDriveList.push( <option key={i} value={drive.caption}>{drive.caption} {drive.so.VolumeName}</option>);
      }
      this.setState({driveList : currentDriveList, driveInfo : drives});
      console.log(currentDriveList);
    })
    .catch((err) => {
        console.log(err);
    });
  }*/

  folderSelect() {
    ipcRenderer.once('settings-folder-selected', (event, args) => {
      this.changeTargetFolder(args);
    });
    ipcRenderer.send('settings-folder-select');
  }

  changeTargetFolder(folder) {
    this.setState({selectedDrive: folder});
  }


  exportFiles(e) {
    if (!this.state.selectedDrive) {
      alert('You have to select a drive, you silly goose!');
      return;
    }
    ipcRenderer.send('exportFiles', this.state.selectedDrive);
  }

  plantManifest(e) {
    if (!this.state.selectedDrive) {
      alert('You have to select a drive, you silly goose!');
      return;
    }
    let location = path.join(this.state.selectedDrive, "Mynda Manifest.json");
    library.save(location);
  }

  importFiles(e) {
  }

  selectDrive(e) {
    this.setState({selectedDrive : e.target.value});
  }

  render() {
    return (<div>
      <div className="input-container">
        <input type="text" id="settings-sync-choose-path" className="empty" value={this.state.selectedDrive || ''} placeholder="Select a directory..." onChange={(e) => this.changeTargetFolder(e.target.value)} />
        <div className="input-clear-button hover" onClick={() => this.changeTargetFolder('')}></div>
      </div>
      <div><button onClick={() => this.folderSelect()}>Browse</button></div>
      <div>
        <span style={{width: '33%'}}><button onClick={this.plantManifest}>Request</button></span>
        <span style={{width: '33%'}}><button onClick={this.exportFiles}>Export</button></span>
        <span style={{width: '33%'}}><button onClick={this.importFiles}>Import</button></span>
      </div>
    </div>)
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
  MynSettingsSync,
  MynSettingsThemes
};
