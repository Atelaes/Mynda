// Reusable field and widget components used by the editor, settings, and library views.
const React = require('react');
const {ipcRenderer} = require('electron');
const _ = require('lodash');
const fs = require('fs');
const {v4: uuidv4} = require('uuid');
const {
  editorLog,
  artworkLog,
  confirmationDialogIsDisabled,
  disableConfirmationDialog
} = require('./RendererRuntime.js');
const {isValidURL, findNearestOfClass} = require('./RendererUtils.js');
const {MynOverflowTextMarquee} = require('./SharedComponents.js');

let nextEditorArtworkDownloadNumber = 0;

class MynEdit extends React.Component {
  constructor(props) {
    super(props)
  }

  handleValidity(valid, property, element, tip) {
    if (!element) return;

    if (valid) {
      if (this.props.reportValid) {
        this.props.reportValid(property,true);
      }
      element.classList.remove("invalid");
    } else {
      if (this.props.reportValid) {
        this.props.reportValid(property,false);
      }
      element.classList.add("invalid");
    }

    // if the element doesn't already have an id, we need to create a unique one,
    // so that we can reference it below to add/remove the tip div
    if (!element.id) {
      element.id = uuidv4();
    }

    // show validator tip on the element, if we were given one
    let tipper = document.getElementById(property + '-tip-' + element.id);
    if (tipper) {
      tipper.parentNode.removeChild(tipper);
    }
    if (tip) {
      // console.log(tip);
      tipper = document.createElement('div')
      tipper.id = property + '-tip-' + element.id;
      tipper.className = "tip";
      tipper.innerHTML = tip;
      element.parentNode.appendChild(tipper);
    }
  }

  render() {
    return null;
  }
}

class MynEditWidget extends MynEdit {
  constructor(props) {
    super(props)
  }

  render() {
    return null;
  }
}


class MynEditRatings extends MynEdit {
  constructor(props) {
    super(props)

    this.state = {
      source : {
        "imdb" : {
          min: 0,
          max: 10,
          display: "IMDb",
          units: "/\u202F10"
        },
        "rt" : {
          min: 0,
          max: 100,
          display: "Rotten Tomatoes",
          units: "%"
        },
        "mc" : {
          min: 0,
          max: 100,
          display: "Metacritic",
          units: "/\u202F100"
        }
      }
    }

    this.table = React.createRef();
    // this.render = this.render.bind(this);
    // this.handleInput = this.handleInput.bind(this);
  }

  validateInput(target, value, source) {
    let min = this.state.source[source].min;
    let max = this.state.source[source].max;

    if (value === "") {
      super.handleValidity(true,this.props.property,target);
    } else if (this.props.validator.test(value,min,max)) {
      super.handleValidity(true,this.props.property,target);
    } else {
      super.handleValidity(false,this.props.property,target,this.props.validatorTip(min,max));
      // console.log('validation error!');
      // event.target.parentElement.getElementsByClassName('error-message')[0].classList.add('show');
    }
  }

  handleInput(target, value, source) {
    this.validateInput(target, value, source);

    let update = _.cloneDeep(this.props.video[this.props.property]);
    // update[source] = !isNaN(Number(value)) && value !== '' ? value / this.state.source[source].max : value;
    update[source] = value;
    // console.log('HMMM... ' + update[source]);
    this.props.update(this.props.property,update);
  }

  componentDidUpdate(oldProps) {
    // Controlled React inputs already receive their new displayed values from
    // props when Revert or Reset changes the ratings object. Revalidate those
    // programmatic values, but do not route them through handleInput(): doing
    // so falsely marked ratings as a user edit and made the later batch-save
    // override logic run even when the user never touched a rating field.
    if (!_.isEqual(oldProps.video[this.props.property],this.props.video[this.props.property])) {
      let inputs = Array.from(this.table.current.getElementsByClassName('ratings-input-input'));
      inputs.map(input => {
        // Identify the rating source from the input's imdb/rt/mc class.
        let source = Array.from(input.classList).find(theClass => Object.keys(this.state.source).includes(theClass));
        let value = this.props.video[this.props.property][source];
        if (value === undefined) {
          value = '';
        }
        this.validateInput(input, value, source);
      });
    }
  }

  render() {
    // value={!isNaN(Number(this.props.video[this.props.property][source])) && this.props.video[this.props.property][source] !== '' ? Math.round(Number(this.props.video[this.props.property][source]) * this.state.source[source].max * 10) / 10 : this.props.video[this.props.property][source]}
    return (
      <table ref={this.table}><tbody>
        {Object.keys(this.state.source).map((source) => {
          const batchChanged = Array.isArray(this.props.batchChangedSources) &&
            this.props.batchChangedSources.includes(source);
          return (
            <tr key={source}>
              <td className="ratings-icon">
                <img src={`../images/logos/${source}-logo` + (source=='rt' && this.props.video[this.props.property][source]<60 && this.props.video[this.props.property][source] !== '' ? '-splat' : '') + '.png'} />
              </td>
              <td className="ratings-input">
                <input
                 className={"ratings-input-input " + source + (batchChanged ? " batch-changed" : "")}
                 id={`edit-field-${this.props.property}-${source}`}
                 type="text"
                 name={source}
                 value={this.props.video[this.props.property][source] === undefined ||
                   this.props.video[this.props.property][source] === null ? '' :
                   this.props.video[this.props.property][source]}
                 placeholder={this.props.placeholder || '#'}
                 onChange={(e) => this.handleInput(e.target, e.target.value, source)}
                />
              </td>
              <td className="ratings-unit">
                {this.state.source[source].units}
              </td>
           </tr>
          );
        })}
      </tbody></table>
    );
  }
}

class MynClickToEditText extends React.Component {
  constructor(props) {
    super(props)

    this.state = {
      editing : false
    }
  }

  edit(e) {
    // e.stopPropagation();
    this.setState({editing:true});
  }

  endEdit(e) {
    e.preventDefault();
    e.stopPropagation();

    if (e.keyCode === 13) {
      // if the key hit was 'enter'
      // save the value and exit the editor
      this.setState({editing:false});
      this.props.save();
    } else if (e.keyCode === 27) {
      // if the key hit was 'esc'
      // exit the editor without saving
      // (also revert to the initial value)
      this.setState({editing:false});
      if (this.props.update) {
        this.props.update(this.props.property, this.state.initialValue);
      }
   }
  }

  componentDidMount() {
    // store the initial value in case the user wants to stop editing without saving
    this.state.initialValue = this.props.object[this.props.property];
  }

  render() {
    // if the user has clicked, display the editor;
    // also always display the editor if the value is empty/only white space
    if (this.state.editing || /^\s*$/.test(this.props.object[this.props.property])) {
      this.state.editing = true;
      return (
        <div onClick={(e) => {e.stopPropagation()}} onKeyUp={(e) => {this.endEdit(e)}}>
          <MynEditText {...this.props} />
        </div>
      );
    } else {
      if (this.props.doubleClick) {
        return (
          <div
            onDoubleClick={(e) => this.edit(e)}
            onClick={(e) => {
              // we must essentially pause the propagation of the (single) click event
              // to check if it was a double click (by checking the 'editing' state var),
              // and if it wasn't, register a click on the parent element to continue
              // the propagation upwards to be caught by any event handlers there may be
              e.stopPropagation();
              let parent = e.target.parentNode;
              setTimeout(() => {
                if (!this.state.editing) {
                    // console.log("SINGLE CLICK");
                    parent.click();
                }
              },150)
            }}
            style={{cursor:'text'}}
          >
            {this.props.object[this.props.property]}
          </div>
        );
      } else {
        return (
          <div onClick={(e) => {e.stopPropagation(); this.edit(e)}} style={{cursor:'text'}}>
            {this.props.object[this.props.property]}
          </div>
        );
      }
    }
  }
}

class MynEditText extends MynEdit {
  constructor(props) {
    super(props)

    this.state = {
      value: ''
    }

    this.input = React.createRef();
    this.clearInput = this.clearInput.bind(this);
  }

  handleInput(value) {
    if (this.props.uneditable) return;

    let target = this.input.current;
    if (value === undefined) {
      value = target.value;
    }

    // console.log("value: " + value);

    // keep the input field updated with what the user is typing
    this.setStateValue(value);

    // handle validation
    if (this.props.validator) {
      if (value === "" && this.props.allowedEmpty !== false) {
        super.handleValidity(true,this.props.property,target);
      } else if (this.props.validator.test(value)) {
        super.handleValidity(true,this.props.property,target);
      } else {
        super.handleValidity(false,this.props.property,target,this.props.validatorTip);
      }
    }

    // if we're given a transform function (i.e. we want the saved value to be different
    // in some way than the value of the input form), transform the value here before updating it
    if (this.props.storeTransform) {
      value = this.props.storeTransform(value);
    }
    this.props.update(this.props.property,value);
  }

  clearInput() {
    this.handleInput('');
  }

  setStateValuesFromProps() {
    this.setStateValue(this.props.object[this.props.property]);
  }

  // set state form value with optional transform
  setStateValue(value) {
    try {
      value = this.props.displayTransform(value);
    } catch(err) {

    }
    this.setState({value:value});

    // if there is anything in the input field, add a class to display the clear button
    let pseudoEmpty = this.props.displayTransform ? this.props.displayTransform('') : '';
    // console.log('display transform of empty string: ' + pseudoEmpty);
    if (value !== pseudoEmpty) {
      this.input.current.classList.add('filled');
    } else {
      this.input.current.classList.remove('filled');
    }
  }

  componentDidUpdate(oldProps) {
    if (oldProps.object[this.props.property] !== this.props.object[this.props.property]) {
      this.setStateValuesFromProps();
      // this.handleInput();
    }
  }

  componentDidMount() {
    this.setStateValuesFromProps();

    if (this.props.setFocus) {
      this.input.current.focus();
    }
  }

  render() {
    let options = null;
    let listName = null;
    let clearBtn = null;
    if (this.props.options) {
      listName = "used-" + this.props.property;
      options = (
        <datalist id={listName}>
          {this.props.options.map((option) => (<option key={option} value={option} />))}
        </datalist>
      );
    } else if (!this.props.noClear && !this.props.uneditable) {
      // only create a clear button if there's no dropdown and if the field is not uneditable
      clearBtn = (<div className="input-clear-button hover" onClick={this.clearInput}></div>);
    }

    return (
      <div>
        <input
          ref={this.input}
          className={(this.props.className || '') + (this.props.noClear ? ' no-clear' : '') + (this.props.uneditable ? ' uneditable' : '')}
          title={this.props.tooltip || null}
          list={listName}
          type="text"
          name="text"
          value={this.state.value}
          placeholder={this.props.placeholder || ''}
          onChange={() => this.handleInput()}
          readOnly={this.props.uneditable ? "readOnly" : ""}
        />
        {options}
        {clearBtn}
      </div>
    );
  }
}

class MynEditArtwork extends MynEdit {
  constructor(props) {
    super(props)

    this._isMounted = false;

    this.state = {
      value: "",
      message: "",
      revertLink: null,
      original: props.movie.artwork
      // cancelDownload: () => { console.log('default cancel function') }
    }

    this.revert = React.createRef();
    this.input = React.createRef();
    this.dlMsg = React.createRef();
    this.container = React.createRef();
    this.downloadResponseChannel = null;
    this.downloadResponseHandler = null;
    this.downloadStatusTimer = null;

    this.handleArtworkSelected = (event, image) => {
      if (image) {
        this.update(image);
      } else {
        artworkLog.debug('Artwork file selection canceled or returned no file');
      }
    };
    ipcRenderer.on('editor-artwork-selected', this.handleArtworkSelected);

    // ipcRenderer.on('cancel-download', (event, cancelFunc, string) => {
    //   this.setState({cancelDownload: cancelFunc});
    //   console.log(string);
    // });
  }

  handleInput(event) {
    // update value as it's entered
    let value = event.target.value;
    this._isMounted && this.setState({value:value});

    let extReg = /\.(jpg|jpeg|png|gif)$/i;
    if (isValidURL(value) && extReg.test(value)) {
      artworkLog.debug('Artwork input recognized as a remote image URL', {
        value: value
      });
      // then this is a valid url with an image extension at the end
      // try to download it
      this.download(value);

    } else if (extReg.test(value)) {
      artworkLog.debug('Artwork input recognized as a possible local path', {
        value: value
      });
      // then this MIGHT be a valid local path,
      // we'll see if we can find it
      this.handleLocalFile(value);
    } else {
      // do nothing?
      artworkLog.debug('Artwork input was not recognized as a supported URL or local path', {
        value: value
      });
    }

  }

  removeDownloadListener() {
    if (this.downloadResponseChannel && this.downloadResponseHandler) {
      ipcRenderer.removeListener(this.downloadResponseChannel, this.downloadResponseHandler);
    }
    this.downloadResponseChannel = null;
    this.downloadResponseHandler = null;
  }

  clearDownloadStatusTimer() {
    if (this.downloadStatusTimer) {
      clearTimeout(this.downloadStatusTimer);
      this.downloadStatusTimer = null;
    }
  }

  showDownloadStatus(message, downloading, clearAfter = 0) {
    this.clearDownloadStatusTimer();
    if (!this._isMounted) {
      return;
    }
    if (this.input.current) {
      this.input.current.style.visibility = downloading ? 'hidden' : 'visible';
    }
    if (this.dlMsg.current) {
      this.dlMsg.current.style.display = message ? 'block' : 'none';
    }
    this.setState({message: message});
    if (clearAfter) {
      this.downloadStatusTimer = setTimeout(() => {
        this.downloadStatusTimer = null;
        this.showDownloadStatus('', false);
      }, clearAfter);
    }
  }

  download(url, fallbackArtwork) {
    this.removeDownloadListener();
    if (!this._isMounted) {
      return;
    }

    // hide the input element and display message while downloading
    this.showDownloadStatus('Downloading', true);

    let responseChannel = `downloaded-editor-artwork-${process.pid}-${++nextEditorArtworkDownloadNumber}`;
    let restorePreviousArtwork = typeof fallbackArtwork !== 'undefined';
    let handleFailure = response => {
      let status = response && response.status;
      artworkLog.error('Could not download editor artwork', {
        status: status,
        error: response && response.message ? response.message : response
      });
      this.showDownloadStatus(
        status ? `Download failed (${status})` : 'Download failed',
        false,
        4000
      );

      if (restorePreviousArtwork) {
        // Never restore another remote URL: that would immediately trigger the
        // same download again. Keep the previous local file, or clear artwork.
        let safeFallback = fallbackArtwork && !isValidURL(fallbackArtwork) ? fallbackArtwork : '';
        if (this.props.movie.artwork !== safeFallback) {
          this.update(safeFallback);
        }
      }
    };
    let handleDownload = (event, response) => {
      if (this.downloadResponseChannel !== responseChannel) {
        return;
      }
      this.downloadResponseChannel = null;
      this.downloadResponseHandler = null;
      if (response && response.success) {
        this.showDownloadStatus('', false);
        this.update(response.message);
        artworkLog.info('Editor artwork downloaded', {
          destination: response.message
        });
      } else {
        handleFailure(response);
      }
    };
    this.downloadResponseChannel = responseChannel;
    this.downloadResponseHandler = handleDownload;
    ipcRenderer.once(responseChannel, handleDownload);

    try {
      ipcRenderer.send('download', url, undefined, responseChannel);
    } catch(err) {
      this.removeDownloadListener();
      handleFailure({message: err && err.message ? err.message : err});
    }
  }

  handleLocalFile(path) {
    this._isMounted && fs.readFile(path, (err, data) => {
      if (err) {
        this.update(this.state.placeholderImage);
        artworkLog.error('Could not read local editor artwork', {
          path: path,
          error: err
        });
        return;
      }
      this.update(path);
      artworkLog.debug('Local editor artwork accepted', {path: path});
    });
  }

  update(path) {
    this._isMounted && this.setState({value:''});

    this.props.update({'artwork':path});
  }

  handleBrowse(event) {
    ipcRenderer.send('editor-artwork-select');
    event.preventDefault();
  }

  handleRevert() {
    artworkLog.debug('Reverting editor artwork', {
      originalArtwork: this.state.original
    });
    this.removeDownloadListener();
    this.showDownloadStatus('', false);
    this.update(this.state.original);
  }

  imageOver(event) {
    // this.revert.current.style.visibility = "visible";
  }

  imageOut(event) {
    // // //this is the original element the event handler was assigned to
    // // var e = event.toElement || event.relatedTarget;
    // // if (e.parentNode == this || e == this) {
    // //    return;
    // // }
    //
    // this.revert.current.style.visibility = "hidden";
  }

  componentDidUpdate(oldProps) {
    // console.log("artwork component updated");

    // if we're given a url ( for instance by the user clicking on a search result during auto-tagging)
    // then we want to download it, and point the movie metadata to the downloaded local file instead
    if (oldProps.movie.artwork !== this.props.movie.artwork && isValidURL(this.props.movie.artwork)) {
      artworkLog.debug('Editor artwork changed to a remote URL from an external update', {
        videoID: this.props.movie && this.props.movie.id
      });
      this.download(this.props.movie.artwork, oldProps.movie.artwork || '');
    }
  }

  componentDidMount(props) {
    this._isMounted = true;
    // const container = this.container.current;

    // set listener for drag and drop functionality
    document.addEventListener('drop', (event) => {
        event.preventDefault();
        // event.stopPropagation();

        const droppedFiles = Array.from((event.dataTransfer && event.dataTransfer.files) || []);
        artworkLog.debug('Files dropped onto the artwork editor', {
          fileCount: droppedFiles.length,
          files: droppedFiles.map(file => ({
            name: file.name,
            path: file.path,
            type: file.type
          }))
        });

        try {
          const files = event.dataTransfer.files;
          if (files.length === 1) {
            if (/image/.test(files[0].type)) {
              this.handleLocalFile(files[0].path);
            } else {
              artworkLog.debug('Rejected dropped artwork with a non-image file type', {
                path: files[0].path,
                type: files[0].type
              });
            }
          } else if (files.length === 0) {
            artworkLog.debug('Artwork drop did not contain any files');
          } else {
            artworkLog.debug('Rejected artwork drop containing multiple files', {
              fileCount: files.length
            });
          }
        } catch(err) {
          artworkLog.error('Could not process dropped artwork', {error: err});
        }
    });

    document.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });

    document.addEventListener('dragenter', (event) => {
      // console.log('File is in the Drop Space');
    });

    document.addEventListener('dragleave', (event) => {
      // console.log('File has left the Drop Space');
    });
  }

  componentWillUnmount() {
    this.removeDownloadListener();
    this.clearDownloadStatusTimer();
    ipcRenderer.removeListener('editor-artwork-selected', this.handleArtworkSelected);
    this._isMounted = false;
  }

  render() {
    return (
      <div ref={this.container}>
        <img
          id="edit-artwork-image"
          src={this.props.movie.artwork || this.props.placeholderImage}
          width="100"
          onMouseOver={(e) => this.imageOver(e)}
          onMouseLeave={(e) => this.imageOut(e)}
        />
        <div>
          <input ref={this.input} type="text" id="edit-field-artwork" value={this.state.value || ""} placeholder={this.props.placeholder || "Paste path/URL"} onChange={(e) => this.handleInput(e)} />
          <div ref={this.dlMsg} id="edit-field-artwork-dl-msg" style={{display:"none"}}>{this.state.message}</div>
        </div>
        <div id="edit-field-artwork-buttons">
          <div ref={this.revert} onClick={() => this.handleRevert()} className="edit-field-revert"></div>
          <button onClick={(e) => this.handleBrowse(e)}>Browse</button>
        </div>
      </div>
    );
  }
}

// ######  ###### //
class MynEditGraphicalWidget extends MynEditWidget {
  constructor(props) {
    super(props)

    this.state = {
      displayGraphic : [],
      property : "property",
      className : "class"
    }

    this.render = this.render.bind(this);
  }

  updateValue(value, event) {
    editorLog.debug('Inline graphical editor value changed', {
      videoID: this.props.movie && this.props.movie.id,
      title: this.props.movie && this.props.movie.title,
      property: this.state.property,
      value: value
    });
    event.stopPropagation(); // clicking on the widget should not trigger a click on the whole row
    // this.props.movie[this.state.property] = value;

    // update the value
    if (this.props.update) {
      this.props.update(this.state.property,value);
    }

    // event.target.parentNode.classList.remove('over');
    findNearestOfClass(event.target,"edit-widget").classList.remove('over');
  }

  mouseOver(value,event) {
    this.updateGraphic(value);
    // event.target.parentNode.classList.add('over');
    findNearestOfClass(event.target,"edit-widget").classList.add('over');
  }

  mouseOut(target,event) {
    this.updateGraphic(this.props.movie[this.state.property]);
    target.classList.remove('over');
    // console.log("mouse out: " + target.classList)
    // try{
    //   event.stopPropagation();
    // } catch(error) {
    //   // console.log("called from <ul>");
    // }
  }

  componentDidMount(props) {
    this.setState({className : this.state.className + " edit-widget"})
    this.updateGraphic(this.props.movie[this.state.property]);
  }

  componentDidUpdate(oldProps) {
    // console.log('MynEditGraphicalWidget is updating ' + this.state.property + ' for ' + this.props.movie.title);
    if (!_.isEqual(oldProps.movie[this.state.property],this.props.movie[this.state.property])) {//(oldProps.movie[this.state.property] !== this.props.movie[this.state.property]) {
      this.updateGraphic(this.props.movie[this.state.property]);
    }
  }

  // updateGraphic(graphic) {
  //   this.setState({displayGraphic : graphic});
  // }

  render() {
    // return (<ul className={this.state.className} onMouseOut={(e) => this.mouseOut(e.target)}>{this.state.displayGraphic}</ul>);
    return (<ul className={this.state.className}>{this.state.displayGraphic}</ul>);
  }
}

// ######  ###### //
class MynEditWidgetCheckmark extends MynEditGraphicalWidget {
  constructor(props) {
    super(props)

    this.state = {
      className : "checkmarkContainer"
    }

    this.render = this.render.bind(this);
  }

  updateGraphic(value) {
    let graphic = <li className={"checkmark " + (value ? "on" : "off")} onMouseOver={(e) => this.mouseOver(!this.props.movie[this.state.property],e)} onMouseOut={(e) => this.mouseOut(e.target.parentNode,e)} onClick={(e) => this.updateValue(!this.props.movie[this.state.property],e)}>{value ? this.state.onChar : this.state.offChar}</li>;
    this.setState({displayGraphic : graphic});
  }

  // render() {
  //   return (<ul className="stars" onMouseOut={(e) => this.mouseOut(e.target)}>{this.state.displayStars}</ul>);
  // }
}

// ###### Graphical editor for the 'seen' checkmark ###### //
class MynEditSeenWidget extends MynEditWidgetCheckmark {
  constructor(props) {
    super(props)

    this.state = {
      property: "seen",
      className: "seen",
      onChar: "\u2714",
      offChar: "\u2718"
    }

    this.render = this.render.bind(this);
  }
}

// ###### Graphical editor for the 'watchlater' widget ###### //
class MynEditWatchlaterWidget extends MynEditWidgetCheckmark {
  constructor(props) {
    super(props)

    this.state = {
      property: "watchlater",
      className: "watchlater",
      onChar: "\u2665",
      offChar: "\u2661"
    }

    this.render = this.render.bind(this);
  }
}

// ###### Graphical editor for the 5-star user rating ###### //
class MynEditRatingWidget extends MynEditGraphicalWidget {
  constructor(props) {
    super(props)

    this.state = {
      property : "ratings",
      className : "stars"
    }

    this.render = this.render.bind(this);
    this.updateGraphic = this.updateGraphic.bind(this);
  }

  updateGraphic(rating) {
    // sometimes the actual rating value will be passed to us here,
    // but other times, the whole ratings object will be passed,
    // in which case we want the value of the 'user' property
    if (rating.hasOwnProperty("user")) {
      rating = rating.user
    }

    let stars = [];
    let char = "";
    for (let i=1; i<=5; i++) {
      let starClass = "star ";

      // if (i === 0 && this.props.cancelBtn) {
      //   // char = "\u2298";
      //   // char="\u2205";
      //   // char="\u2715";
      //   // for some reason all these characters produce a weird bug where the stars get smaller????
      //
      //   starClass += "cancel";
      // } else if (i === 0 && !this.props.cancelBtn) {
      //   continue;
      /* } else*/ if (i <= rating) {
        char="\u2605";
        starClass += "filled";
      } else {
        char="\u2606";
        starClass += "empty";
      }
      let update = _.cloneDeep(this.props.movie[this.state.property]);
      update["user"] = i;
      stars.push(<li className={starClass} key={i} onMouseOver={(e) => this.mouseOver(i,e)} onMouseOut={(e) => this.mouseOut(e.target.parentNode,e)} onClick={(e) => this.updateValue(update,e)}>{char}</li>);
    }
    this.setState({displayGraphic : stars});
  }

  // render() {
  //   return (<ul className="stars" onMouseOut={(e) => this.mouseOut(e.target)}>{this.state.displayStars}</ul>);
  // }
}

// ###### Graphical editor for the 'position' attribute ###### //
class MynEditPositionWidget extends MynEditGraphicalWidget {
  constructor(props) {
    super(props)

    this.state = {
      property : "position",
      className : "position",
    }

    this.render = this.render.bind(this);
  }

  getPositionFromMouse(event) {
    let position = 0;
    const duration = this.props.movie.metadata ? this.props.movie.metadata.duration : null;

    try {
      let target = findNearestOfClass(event.target,'position-container');
      let widgetX = window.scrollX + target.getBoundingClientRect().left;
      let widgetWidth = target.clientWidth;
      let mouseX = event.clientX;

      position = (mouseX - widgetX) / widgetWidth * duration;
    } catch(err) {
      editorLog.error('Could not calculate a playback position from the editor widget', {
        videoID: this.props.movie && this.props.movie.id,
        error: err
      });
    }

    // console.log(
    //   'mouseX: ' + mouseX + '\n' +
    //   'widgetX: ' + widgetX + '\n' +
    //   // 'offsetLeft: ' + event.target.offsetLeft + '\n' +
    //   'widgetWidth: ' + widgetWidth + '\n' +
    //   '(mouseX - widgetX) / widgetWidth == ' + position / this.props.movie.metadata.duration
    // );

    return position;
  }

  updatePosition(event) {
    this.mouseOver(this.getPositionFromMouse(event),event);
  }

  updateGraphic(position) {
    const duration = this.props.movie.metadata ? Number(this.props.movie.metadata.duration) : null;
    if (!duration) return;

    position = Number(Math.min(Math.max(position,0),duration));
    let graphic = (
      <div className="position-widget">
        {/*<div className="position-outer"
          onMouseMove={(e) => this.updatePosition(e)}
          onMouseLeave={(e) => this.mouseOut(findNearestOfClass(event.target,'position-outer').parentElement,e)}
          onClick={(e) => this.updateValue(Math.round(position * 10)/10,e)}>
            {<div className="position-inner" style={{width:(position / duration * 100) + "%"}} />}
        </div>*/}

        <div className="position-container"
          onMouseMove={(e) => this.updatePosition(e)}
          onMouseLeave={(e) => this.mouseOut(findNearestOfClass(event.target,'position-widget'),e)}
          onClick={(e) => this.updateValue(Math.round(position * 10)/10,e)}
        >
          <div className="position-bar filled" style={{width:(position / duration * 100) + "%"}}/>
          <div className="position-bar empty" />
        </div>

        <div className="position-text">
          {position / duration > .01 ? `${Math.floor(position / 60)}:${(position % 60) < 10 ? '0' : ''}${Math.floor(position % 60)} \u2022 ` : null}
          {duration ? (duration >= 60 ? `${Math.round(duration / 60)} min` : `${Math.round(duration)} sec`) : null}
        </div>
      </div>
    );

    this.setState({displayGraphic : graphic});
  }

  // componentDidMount(props) {
  //   // ReactDOM.findDOMNode(this.refs.outer)
  //   return super.componentDidMount(props);
  // }

  // we have to override the super componentDidUpdate method
  // because in the case of the position widget, we need to check for
  // both a difference in position, but also a difference in duration
  componentDidUpdate(oldProps) {
    let duration;
    let oldDuration;
    if (this.props.movie.metadata) duration = this.props.movie.metadata.duration;
    if (oldProps.movie.metadata) oldDuration = oldProps.movie.metadata.duration;

    if (oldProps.movie.position !== this.props.movie.position || (!isNaN(duration) && oldDuration !== duration)) {
      // console.log('MynEditPositionWidget is updating for ' + this.props.movie.title);
      // console.log(`${oldProps.movie.position} !== ${this.props.movie.position} || ${oldDuration} !== ${duration}`);
      this.updateGraphic(this.props.movie.position);
    }
  }

  render() {
    // if the duration is 0, '', or does not exist, return nothing
    if (!this.props.movie.metadata || !this.props.movie.metadata.duration) {
      return null;
    } else {
      return super.render();
    }
  }
}

class MynShowPositionWidget extends React.Component {
  constructor(props) {
    super(props)

  }

  render() {
    const duration = this.props.video.metadata ? Number(this.props.video.metadata.duration) : null;
    if (!duration) return null;
    let position = Number(Math.min(Math.max(this.props.video.position,0),duration));

    return (
      <div className="position-widget">
        <div className="position-container">
          <div className="position-bar filled" style={{width:(position / duration * 100) + "%"}}/>
          <div className="position-bar empty" />
        </div>
        <div className="position-text" style={{display:(this.props.showText ? 'block' : 'none')}}>
          {position / duration > .01 ? `${Math.floor(position / 60)}:${(position % 60) < 10 ? '0' : ''}${Math.floor(position % 60)} \u2022 ` : null}
          {duration ? (duration >= 60 ? `${Math.round(duration / 60)} min` : `${Math.round(duration)} sec`) : null}
        </div>
      </div>
    );
  }
}

// ######  ###### //
class MynEditListWidget extends MynEditWidget {
  constructor(props) {
    super(props)

    this.state = {
      list: []
    }

    this.render = this.render.bind(this);
    this.updateList = this.updateList.bind(this);
  }

  updateList(list) {
    // console.log('ORIGINAL UPDATELIST')
    this.setState({ list : list });
    this.props.update(this.props.property,list);
  }

  deleteItem(index, skipDialog) {
    const confirmationPreference = this.props.deleteConfirmationPreference;
    const confirmationChannel = confirmationPreference || 'MynEditListWidget-confirm-delete-item';
    const dialogDisabled = typeof this.props.deleteConfirmationDisabled === 'boolean' ?
      this.props.deleteConfirmationDisabled :
      confirmationPreference && confirmationDialogIsDisabled(confirmationPreference);

    if (this.props.deleteDialog && !skipDialog && !dialogDisabled) {
      ipcRenderer.once(confirmationChannel, (event, response, index, checked) => {
        if (response === 0) { // yes
          if (checked && confirmationPreference) {
            disableConfirmationDialog(confirmationPreference, editorLog);
            if (typeof this.props.onDeleteConfirmationDisabled === 'function') {
              this.props.onDeleteConfirmationDisabled();
            }
          }
          // delete item (pass 'true' so as not to prompt another dialog)
          this.deleteItem(index, true);
        } else {
          editorLog.debug('Editor list-item deletion canceled by user', {
            property: this.props.property,
            index: index
          });
        }
      });

      const options = {
        message: `Are you sure you want to remove '${this.state.list[index]}'? ${this.props.deleteDialog}`
      };
      if (confirmationPreference) {
        options.checkboxLabel = `Don't show this message again`;
      }
      ipcRenderer.send('generic-confirm', confirmationChannel, options, index);
      return;
    }

    var temp = this.state.list;
    temp.splice(index, 1);
    this.updateList(temp);
  }

  displayList() {
    return this.state.list.map((item, index) => {
      let displayItem
      const addedInBatch = Array.isArray(this.props.batchBaseline) &&
        !this.props.batchBaseline.includes(item);
      try {
        displayItem = this.props.displayTransform(item);
      } catch(err) {
        displayItem = item
      }

      if (this.props.marquee) {
        displayItem = (<MynOverflowTextMarquee text={displayItem} direction={this.props.overflowDirection} ellipsis='fade' fadeSize='2em' />);
      }

      return (
        <li key={index} className={`list-widget-item${addedInBatch ? ' batch-added' : ''}`} title={item}>
          <pre>{displayItem}</pre>
          <div className="list-widget-delete-item inline-delete-button" onClick={() => this.deleteItem(index)}>
            {"\u2715"}
          </div>
        </li>
      );

    });
  }

  componentDidMount(props) {
    this.setState({list:this.props.object[this.props.property]});
  }

  componentDidUpdate(oldProps) {
    if (oldProps.object[this.props.property] !== this.props.object[this.props.property]) {
      this.setState({list:this.props.object[this.props.property]});
    }
  }

  render() {
    // return (<ul className={this.state.className} onMouseOut={(e) => this.mouseOut(e.target)}>{this.state.displayGraphic}</ul>);
    return (<ul className={"list-widget-list " + this.props.property}>{this.displayList()}</ul>);
  }
}

// ######  ###### //

//<MynEditAddToList
//movie={this.state.video}
//property="cast"
//validator={/.*/g}
//options={null} />
class MynEditAddToList extends MynEditListWidget {
  constructor(props) {
    super(props)

    this.state = {
      id : "list-widget-add-" + props.property,
      value : ''
    }

    this.render = this.render.bind(this);
  }

  /* test for valid input */
  handleInput(event) {
    const input = document.getElementById(this.state.id + "-input");

    // update form field to reflect user actions, applying a transform if it was given
    try {
      this.setState({value:this.props.displayTransform(input.value)});
    } catch(err) {
      this.setState({value:input.value});
    }

    const item = input.value;
    if (item === "") {
      super.handleValidity(true,this.props.property,input);
    } else if (this.props.validator.test(item)) {
      super.handleValidity(true,this.props.property,input);
    } else {
      super.handleValidity(false,this.props.property,input,this.props.validatorTip);
      // console.log('validation error!');
      // event.target.parentElement.getElementsByClassName('error-message')[0].classList.add('show');
    }
  }

  addItem(event) {
    const input = document.getElementById(this.state.id + "-input");
    let item = input.value;
    if (item === "") {
      // do nothing
    } else if (this.props.validator.test(item)) {
      // if we're given a transform function (i.e. we want the saved value to be different
      // in some way than the value of the input form), transform the value here before updating it
      if (this.props.storeTransform) {
        item = this.props.storeTransform(item);
        // console.log('transformed to ' + item);
      }

      let temp = this.state.list;
      try {
        if (!this.state.list.includes(item)) {
          temp.push(item);
        }
      } catch(e) {
        temp = [item];
      }
      this.updateList(temp);
      // input.value = '';
      this.setState({value:''});
    } else {
      // do nothing
      // console.log('validation error!');
      // event.target.parentElement.getElementsByClassName('error-message')[0].classList.add('show');
    }
    event.preventDefault();
    // event.stopPropagation();
  }

  // if Enter is pressed, add item
  keyDown(event) {
    if (event.key === "Enter") {
      this.addItem(event);
    }
  }

  render() {
    let options = null;
    let listName = null;
    if (this.props.options) {
      listName = "used-" + this.props.property;
      options = (
        <datalist id={listName}>
          {this.props.options.map((option) => (<option key={option} value={option} />))}
        </datalist>
      );
    }

    return (
      <div id={this.state.id} className={"list-widget-add select-container " + (this.props.inline || "") + (this.props.options ? " select-hovericon" : "") + (options ? " datalist" : "")}>
        <input type="text" list={listName} id={this.state.id + "-input"} className="list-widget-add-input" placeholder={this.props.placeholder || "Add..."} value={this.state.value} minLength="1" onChange={(e) => this.handleInput(e)} onKeyDown={(e) => this.keyDown(e)} />
        <button className="editor-inline-button" onClick={(e) => this.addItem(e)}>{"\uFE62"}</button>
        {options}
      </div>
    );
  }
}

// Can either call MynEditListWidget followed by MynEditAddToList
// or, alternatively, call this class, which places the add-to-list
// field within the list itself, at the end
class MynEditInlineAddListWidget extends MynEditListWidget {
  constructor(props) {
    super(props)
  }
  render() {
    return (
      <ul className={"list-widget-list " + this.props.property}>
        {this.displayList()}
        <MynEditAddToList object={this.props.object} property={this.props.property} update={this.props.update} options={this.props.options} storeTransform={this.props.storeTransform} displayTransform={this.props.displayTransform} inline="inline" validator={this.props.validator} validatorTip={this.props.validatorTip} placeholder={this.props.placeholder} />
      </ul>
    );
  }
}

class MynEditSubtitles extends MynEditListWidget {
  constructor(props) {
    super(props)


    this.validator = {
      test: (val) => (val && val !== '' && fs.existsSync(val))
    }

    this.validatorTip = 'File does not exist';

    // this.input = React.createRef();

    this.handleSubtitleSelected = (event, subs) => {
      if (subs) {
        let update = [...this.props.object[this.props.property], ...subs];
        this.updateList(update);
      } else {
        editorLog.debug('Subtitle file selection canceled or returned no files');
      }
    };

    this.render = this.render.bind(this);
    this.addToListUpdate = this.addToListUpdate.bind(this);
  }

  // update(property,list) {
  //   if (input.value !== '' && fs.existsSync(input.value)) {
  //     let update = [...this.props.video.subtitles, input.value]
  //     this.props.update('subtitles',update);
  //   }
  // }

  // override updateList from MynEditListWidget to check if the file exists;
  // we're also using the validator function passed to MynEditAddToList
  // to do an existence check as the user types a file name,
  // because that gives visual feedback before the user tries to add the file;
  // (note: MynEditAddToList has its own updateList function, which is also called
  // when the user adds an item, which may be confusing: MynEditAddToList's own
  // updateList function , but we're passing THIS updateList
  // function to MynEditAddToList as its props.update function (well, through
  // this.addToListUpdate which just fixes the parameters), which it runs when the
  // user clicks to add; we do that so we can reuse this logic, mainly to prevent
  // the user from adding a duplicate, though it also checks for existence again)
  //
  // so to summarize: this function runs when the user clicks 'open' from the
  // browse dialog window, and when the user clicks the add (+) button next to the
  // text input field (if there is valid input in it)
  updateList(list) {
    // console.log('NEW UPDATELIST')
    let added = list.filter(el => !this.state.list.includes(el));
    let rejected = [];
    added.map(sub => {
      if (typeof sub !== 'string' || !fs.existsSync(sub)) {
        rejected.push(sub);
      }
    })

    // filter nonexistent files and get rid of duplicates
    list = Array.from(new Set(list.filter(el => !rejected.includes(el))));

    if (rejected.length > 0) {
      alert(`The following subtitle files could not be found:\n${rejected.map(el=>'\n'+el)}`);
    }

    this.setState({ list : list });
    this.props.update(this.props.property,list);
  }

  // passed to MynEditAddToList as its props.update function,
  // all we do is take the list parameter and call updateList
  // with it, since that function doesn't take the property parameter
  addToListUpdate(property,list) {
    this.updateList(list);
  }

  emptyList() {
    this.updateList([]);
  }

  componentDidMount() {
    super.componentDidMount();
    ipcRenderer.on('editor-subtitle-selected', this.handleSubtitleSelected);
  }

  componentWillUnmount() {
    ipcRenderer.removeListener('editor-subtitle-selected', this.handleSubtitleSelected);
  }


  render() {
    return (
      <ul className={"list-widget-list browse subtitles"}>
        {this.displayList()}
        <li className='list-widget-add-with-browse'>
          <MynEditAddToList object={this.props.object} property={this.props.property} update={this.addToListUpdate} options={this.props.options} storeTransform={this.props.storeTransform} displayTransform={this.props.displayTransform} inline="inline" validator={this.validator} validatorTip={this.validatorTip} />
          <button type="button" className='list-widget-browse editor-inline-button' onClick={() => ipcRenderer.send('editor-subtitle-select')}><div className='icon-container'></div></button>
        </li>
        <li>
          <button type="button" className='' onClick={() => this.emptyList()}>Clear All Subtitles</button>
        </li>
      </ul>
    );
  }
}

// <MynEditDateWidget movie={this.state.video} property="cast" update={this.handleChange} />
class MynEditDateWidget extends MynEditWidget {
  constructor(props) {
    super(props)

    this.state = {
      inputValue : "",
      inputValueTimestamp : null,
      userFeedback : null,
      valid : true
    }

    this.input = React.createRef();
  }

  isValidDate(d) {
    return d instanceof Date && !isNaN(d);
  }

  // we may want to use a library for this for more robustitudinality and such
  // cleanDateInput(input) {
  //   try {
  //     // get rid of ordinal suffixes
  //     input = input.replace(/(\d+)(?:st|nd|rd|th)/gi, (match,$1) => $1);
  //
  //     // rough-and-tumble convert to military time, deleting "am" and "pm"
  //     input = input.replace(/((\d{1,2})(:\d\d)?(:\d\d)?)(am?|pm?)/gi, (...groups) => {
  //       groups = groups.filter(el => el !== undefined); // clean array of undefined matches
  //       console.log(groups);
  //       let ampm = groups.findIndex(el => el.match(/^am?$|^pm?$/i));
  //       console.log("ampm index: " + ampm);
  //       if (!isNaN(groups[2]) && groups[2] < 12 && groups[ampm].match(/p/i)) {
  //         groups[2] = parseInt(groups[2]) + 12;
  //       }
  //       return groups.slice(2,ampm).join('');
  //     });
  //
  //     // console.log("cleaned input: " + input);
  //   } catch(error) {
  //     console.log(error);
  //   }
  //   return input;
  // }

  handleValidity(valid, tip) {
    let element = this.input.current;
    super.handleValidity(valid,this.props.property,element,tip);
  }

  handleInput(event) {
    // update the state variable so that the form input reflects what is typed
    this.setState({inputValue: event.target.value});

    // now figure out if it's a valid date
    // and if so, update the parent object
    let value = event.target.value;//this.cleanDateInput(event.target.value);
    try {
      let date = Date.parse(value);

      // if field is empty, reset to valid, pass null to parent
      if (value === "") {
        this.handleValidity(true);
        this.props.update(this.props.property,null);

      // if field is a valid date, reset to valid, pass timestamp of date to parent
      } else if (this.isValidDate(date)) {
        let timestamp = Math.round(date.getTime() / 1000);
        this.handleValidity(true, date.toString("M/d/yyyy, hh:mm:ss tt"));//date.toString().replace(/\sGMT.*$/,''));
        this.props.update(this.props.property,timestamp);

      // if we're here, whatever's in the field is invalid; reset to invalid,
      // pass null to parent;
      } else {
        this.handleValidity(false, "Invalid Date");
        this.props.update(this.props.property,null);
      }
    } catch(error) {
      editorLog.warn('Could not parse an editor date value', {
        property: this.props.property,
        value: value,
        error: error
      });
    }
  }

  setStateValuesFromProps() {
    let timestamp = this.props.movie[this.props.property];
    if (timestamp) {
      let value = timestamp;
      let date = new Date(timestamp * 1000);
      if (this.isValidDate(date)) {
        value = date.toDateString().replace(/(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s/,"");
      }
      this.setState({
        inputValue : value,
        inputValueTimestamp: timestamp
      });
    }
  }

  componentDidMount(props) {
    // set initial value
    this.setStateValuesFromProps();
  }

  componentDidUpdate(oldProps) {
    // console.log("PROPSCHANGE\nold: " + oldProps.movie[this.props.property] + "\nnew: " + this.props.movie[this.props.property] + '\nste: ' + this.state.inputValueTimestamp);
    if (oldProps.movie[this.props.property] != this.props.movie[this.props.property]) {// && this.props.movie[this.props.property] != this.state.inputValueTimestamp) {
      this.setStateValuesFromProps();
      super.handleValidity(true);
    }
  }

  render() {
    return (
      <div className={"date-widget " + this.props.property}>
        <input ref={this.input} type="text" value={this.state.inputValue} placeholder={this.props.property} onChange={(e) => this.handleInput(e)} />
      </div>
    );
  }
}

module.exports = {
  MynEdit,
  MynEditWidget,
  MynEditRatings,
  MynClickToEditText,
  MynEditText,
  MynEditArtwork,
  MynEditGraphicalWidget,
  MynEditWidgetCheckmark,
  MynEditSeenWidget,
  MynEditWatchlaterWidget,
  MynEditRatingWidget,
  MynEditPositionWidget,
  MynShowPositionWidget,
  MynEditListWidget,
  MynEditAddToList,
  MynEditInlineAddListWidget,
  MynEditSubtitles,
  MynEditDateWidget
};
