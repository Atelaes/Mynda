// Reusable renderer UI shared by the major feature component groups.
const React = require('react');
const {ipcRenderer} = require('electron');
const _ = require('lodash');
const {v4: uuidv4} = require('uuid');
const {
  library,
  frontendLog,
  LOCAL_STATUS_UPDATE_EVENT
} = require('./RendererRuntime.js');

class MynNotify extends React.Component {
  constructor(props) {
    super(props)

    this.state = {
      on: false
    }

    ipcRenderer.on('status-update', (event, status) => this.statusUpdate(status));

    // Renderer-owned jobs, currently batch video saves, arrive here. The
    // listener exists for the lifetime of this notification component and is
    // removed if React ever unmounts it.
    this.handleLocalStatusUpdate = (event) => this.statusUpdate(event.detail);
    window.addEventListener(LOCAL_STATUS_UPDATE_EVENT, this.handleLocalStatusUpdate);

    this.render = this.render.bind(this);
    this.statusUpdate = this.statusUpdate.bind(this);
    this.animateEllipsis = this.animateEllipsis.bind(this);
  }

  on(status) {
    if (!status.action) {
      this.off();
      frontendLog.warn('Ignored renderer status without an action', {status: status});
      return;
    }

    // if it's not already on, turn on ellipsis animation and set the state to on
    if (!this.state.on) {
      // this.setState({on:true});
      this.state.on = true;
      this.startEllipsis();

      // give the 'notify-on' class to all the panes
      // to allow for any css manipulation
      Array.from(document.getElementsByClassName('pane')).map(el => {
        el.classList.add('notify-on');
      });
    }

    // if the status has changed, update the status in state
    // if (!_.isEqual(status,this.state.status)) {
    //   this.setState({status:status});
    // }
    this.setState({statusMessage:this.messageFor(status)})
  }

  off() {
    this.setState({on:false, status: {}});
    this.stopEllipsis();

    // remove the 'notify-on' class from all the panes
    Array.from(document.getElementsByClassName('pane')).map(el => {
      el.classList.remove('notify-on');
    })
  }

  statusUpdate(status) {
    // console.log(`Running statusUpdate with status: ${JSON.stringify(status)}`);
    // console.log('this.state.on: ' + this.state.on)
    if (status.action === '') {
      // console.log('STATUS.ACTION empty, turning off')
      // console.log(status)
      this.off();
    } else {
      this.on(status);
    }
  }

  messageFor(status) {
    if (status.action === 'autotag' && status.cancelRequested) {
      return 'Finishing the current video before canceling auto-tagging';
    }

    if (status.action === 'add') {
      const numberAdded = Number.isFinite(status.numTotal) ? status.numTotal : 0;
      const numberDuplicates = Number.isFinite(status.duplicateVideos) ?
        status.duplicateVideos : 0;
      const addedLabel = numberAdded === 1 ? 'video' : 'videos';
      const duplicateLabel = numberDuplicates === 1 ? 'duplicate' : 'duplicates';

      if (numberAdded === 0 && numberDuplicates > 0) {
        return `No new videos added — ${numberDuplicates} ${duplicateLabel} skipped`;
      }
      if (numberDuplicates > 0) {
        return `Adding ${numberAdded} ${addedLabel} — ${numberDuplicates} ${duplicateLabel} skipped`;
      }
      return `Adding ${numberAdded} ${addedLabel}`;
    }

    let _c = '';
    let _t = '';
    let _of = '';
    if (status.numCurrent) _c = ` ${status.numCurrent}`;
    if (status.numCurrent && status.numTotal) _of = ' of';
    if (status.numTotal) _t = ` ${status.numTotal}`;

    let textFor = {
      'export'        : `Exporting${_c}${_of}${_t} videos`,
      'metadata'      : `Checking metadata${status.numCurrent || status.numTotal ? ' for ' + _c + _of + _t + ' videos' : ''}`,
      'metadata_save' : `Saving metadata${status.numCurrent || status.numTotal ? ' for ' + _c + _of + _t + ' videos' : ''}`,
      'batch_save'    : `Saving${_c}${_of}${_t} ${status.numTotal === 1 ? 'video' : 'videos'}`,
      'autotag'       : `Auto-tagging${_c}${_of}${_t} videos`,
      'check'         : status.numTotal ?
        `Checking${_c}${_of}${_t} new ${status.numTotal === 1 ? 'video' : 'videos'}` :
        'Scanning watchfolders'
    }

    return textFor[status.action];
  }

  startEllipsis() {
    if (this.ellipsisAnimation) {
      // console.log("trying to start ellipsis, but thinks it's already started: ");
      // console.log(this.ellipsisAnimation);
      return;
    }

    // console.log('starting ellipsis........................')

    this.setState({ellipsis:""}, () => {
      this.animateEllipsis();
    });

    // this.ellipsisAnimation = setInterval(() => {
    //   this.state.ellipsis = ".".repeat((this.state.ellipsis.length+1)%4)
    //   this.setState({ellipsis:this.state.ellipsis});
    // },400);

  }

  stopEllipsis() {
    // console.log('stopping ellipsis........................')

    clearTimeout(this.ellipsisAnimation);
    this.ellipsisAnimation = null; // we have to do this to make sure the check in this.startEllipsis works
    this.state.ellipsis = "";
    this.setState({ellipsis:this.state.ellipsis});
  }

  animateEllipsis() {
    this.setState({ellipsis:".".repeat((this.state.ellipsis.length+1)%4)}, () => {
      // console.log('setting timeout for ellipsisAnimation')
      this.ellipsisAnimation = setTimeout(this.animateEllipsis,400);
    });
  }

  componentDidMount() {
    // this.statusUpdate({action:['export','add','metadata','autotag','check'][Math.round(Math.random()*4)], numCurrent:1, numTotal:85});
  }

  componentWillUnmount() {
    window.removeEventListener(LOCAL_STATUS_UPDATE_EVENT, this.handleLocalStatusUpdate);
  }

  render() {
    if (this.state.on) {
      // <div className="ellipsis animation" style={{display:'inline-block', width:'1em'}}>
      // </div>

      return (
        <div id="notify-banner">
          {this.state.statusMessage}
          <div className="ellipsis animation" style={{display:'inline-block', width:'1em', textAlign:'left'}}>{this.state.ellipsis}</div>
        </div>
      );
    } else {
      return null;
    }
  }
}

// <MynOverflowTextMarquee class="detail-title-text" text={video.title} endPadding='.2em' time={6} timeR={3} delay={.5} delayR={0} timingFuncR='ease-in-out' />
class MynOverflowTextMarquee extends React.Component {
  constructor(props) {
    super(props)

    this.ellipsisBaseStyle = {
      // position: 'absolute',
      // right: '0',
      // top: '0',
      // height: '100%',
      // width: '1em'
    }

    this.state = {
      ellipsisStyle: {...this.ellipsisBaseStyle},
      direction: props.direction ? props.direction : 'right',
      oppositeDir: props.direction === 'left' ? 'right' : 'left',
      fadeSize: props.fadeSize ? props.fadeSize : '1em'
    }

    // this.state = {
    //   reverse: false,
    //   style : {
    //
    //   },
    //   time: `${!isNaN(this.props.time) ? this.props.time : '5'}s`,
    //   timingFunc: this.props.timingFunc ? this.props.timingFunc : 'cubic-bezier(.5, 0, .8, 1)',
    //   timingFuncR: this.props.timingFuncR ? this.props.timingFuncR : 'cubic-bezier(.2, 0, .5, 1)',
    //   delay: `${!isNaN(this.props.delay) ? this.props.delay : '0'}s`
    // }
    //
    // this.baseStyle = {
    //   whiteSpace:'no-wrap',
    //   overflow:'visible'
    // };
    // this.overflowHoverStyle = {
    //   // animation: `details-scroll-left ${this.props.time ? this.props.time : '5'}s cubic-bezier(.5, 0, .8, 1) infinite`,
    //   // animationDelay: this.props.delay ? `${this.props.delay}s` : '0s',
    //   // animationDirection: 'alternate',
    //   // animationFillMode: 'both',
    //
    //
    //   transform: `translateX(calc(-100%${this.props.endPadding ? (' - ' + this.props.endPadding) : ''}))`,
    //   transitionProperty: 'transform',
    //   transitionDuration: this.state.time,
    //   transitionTimingFunction: this.state.timingFunc,
    //   transitionDelay: this.state.delay
    //
    // };
    //
    // this.overflowHoverStyleReverse = {
    //   transform: 'translateX(0%)',
    //   transitionProperty: 'transform',
    //   transitionDuration: !isNaN(this.props.timeR) ? `${this.props.timeR}s` : this.state.time,
    //   transitionTimingFunction: this.state.timingFuncR,
    //   transitionDelay: !isNaN(this.props.delayR) ? `${this.props.delayR}s` : this.state.delay
    //
    // };
    //
    //
    // this.switchDir = this.switchDir.bind(this);
    this.theDiv = React.createRef();
    this.render = this.render.bind(this);
    this.timeDelayInit = this.timeDelayInit.bind(this);
    this.componentDidMount = this.componentDidMount.bind(this);
    this.componentWillUnmount = this.componentWillUnmount.bind(this);
  }

  // initialize() {
  //   this.setState({style:{...this.baseStyle}});
  //
  //   // check for overflow
  //   try {
  //     this.overflowHoverStyle.border = '1px solid red';
  //     this.overflowHoverStyle.width = window.getComputedStyle(this.theDiv.current.parentNode, null).getPropertyValue('width');
  //
  //     // let computed = window.getComputedStyle(this.theDiv.current, null);
  //     // console.log(this.theDiv.current.innerHTML);
  //     // console.log('width: ' + this.theDiv.current.style.width);
  //     // console.log('actual width: ' + computed.getPropertyValue('width'));
  //     // console.log('offsetWidth: ' + this.theDiv.current.offsetWidth);
  //     // console.log('scrollWidth: ' + this.theDiv.current.scrollWidth);
  //     // console.log('getBoundingClientRect().width: ' + this.theDiv.current.getBoundingClientRect().width);
  //     // console.log('padding: ' + computed.getPropertyValue('padding-left') + computed.getPropertyValue('padding-left'));
  //     // console.log('font-size: ' + computed.getPropertyValue('font-size'));
  //     // console.log('margin-right: ' + computed.getPropertyValue('margin-right'));
  //
  //     // if the text is overflowing the container
  //     if (this.theDiv.current.offsetWidth < this.theDiv.current.scrollWidth) { // text is overflowing
  //       this.overflowHoverStyle.width = this.theDiv.current.scrollWidth - this.theDiv.current.offsetWidth + 'px';
  //       this.overflowHoverStyle.marginRight = titleDiv.parentNode.offsetWidth + 'px'; // necessary in some cases to force the parent element to stay wide; for instance, in table rows, if this is the only overflowing row, the <td> will shrink if we don't add this margin
  //       this.theDiv.current.classList.add('overflow');
  //     } else {
  //       // the text is not overflowing, so we don't need to do anything special
  //       this.theDiv.current.classList.remove('overflow');
  //     }
  //
  //     // console.log('new width: ' + this.theDiv.style.width);
  //   } catch(err) {
  //     console.error(`Could not apply overflow styles: ${err}`);
  //   }
  // }

  initialize() {
    let ellipsisStyle = {};
    // console.log('INITIALIZE');
    // check for overflow
    try {
      // I'm not sure why, but the following line seems to fix an issue where the
      // scrollWidth (I think) gives inconsistent numbers, resulting in a mess
      this.theDiv.current.style.width = window.getComputedStyle(this.theDiv.current.parentNode.parentNode, null).getPropertyValue('width');

      // let computed = window.getComputedStyle(this.theDiv.current, null);
      // console.log(this.theDiv.current.innerHTML);
      // console.log('width: ' + this.theDiv.current.style.width);
      // console.log('actual width: ' + computed.getPropertyValue('width'));
      // console.log('offsetWidth: ' + this.theDiv.current.offsetWidth);
      // console.log('scrollWidth: ' + this.theDiv.current.scrollWidth);
      // console.log('getBoundingClientRect().width: ' + this.theDiv.current.getBoundingClientRect().width);
      // console.log('padding: ' + computed.getPropertyValue('padding-left') + computed.getPropertyValue('padding-left'));
      // console.log('font-size: ' + computed.getPropertyValue('font-size'));
      // console.log('margin-right: ' + computed.getPropertyValue('margin-right'));

      // if the text is overflowing the container
      // set the width and stuff so that the CSS animation scrolls the appropriate amount;
      // then we just add the 'overflow' class and let the CSS do the actual animation
      if (this.theDiv.current.offsetWidth < this.theDiv.current.scrollWidth) { // text is overflowing
        // console.log('OVERFLOWING')

        this.theDiv.current.style.position = 'absolute';
        this.theDiv.current.style.width = this.theDiv.current.scrollWidth - this.theDiv.current.offsetWidth + 'px';
        if (this.state.direction === 'right') this.theDiv.current.style.marginRight = this.theDiv.current.parentNode.offsetWidth + 'px'; // necessary in some cases to force the parent element to stay wide; for instance, in table rows, if this is the only overflowing row, the <td> will shrink if we don't add this margin
        if (this.state.direction === 'left') this.theDiv.current.style.marginLeft = this.theDiv.current.parentNode.offsetWidth + 'px'; // necessary in some cases to force the parent element to stay wide; for instance, in table rows, if this is the only overflowing row, the <td> will shrink if we don't add this margin
        this.theDiv.current.classList.add('overflow');
        this.theDiv.current.classList.add(this.state.direction);

        this.setEllipsis();

      } else {
        // console.log('NOT OVERFLOWING');
        this.theDiv.current.style.position = 'relative';
        this.theDiv.current.style.width = null;
        this.theDiv.current.style.marginRight = null;
        this.theDiv.current.style.marginLeft = null;

        // the text is not overflowing, so we don't need to do anything special
        this.theDiv.current.classList.remove('overflow');
        this.theDiv.current.classList.remove(this.state.direction);

        this.unsetEllipsis();
      }



      // console.log('new width: ' + this.theDiv.current.style.width);
    } catch(err) {
      frontendLog.warn('Could not apply text overflow styles', {error: err});
    }
  }

  setEllipsis() {
    let ellipsis = {};
    if (this.props.ellipsis === 'fade' || !this.props.ellipsis) {
      // console.log('fade');
      ellipsis = {
        WebkitMaskImage: `linear-gradient(to ${this.state.oppositeDir}, transparent 0, rgba(0, 0, 0, 1.0) ${this.state.fadeSize})`,
        WebkitMaskPosition: '0 0',
        WebkitMaskRepeat: 'repeat-y'
      }
    }

    let ellipsisStyle = {...this.ellipsisBaseStyle,...ellipsis};

    // when we're overflowing left, this.theDiv is set to absolute,
    // which means the container will have a height of 0, so we have to compensate for that
    // if (this.state.direction === 'left') {
      ellipsisStyle.height = this.theDiv.current.offsetHeight + 'px';
    // }

    this.setState({ellipsisStyle:ellipsisStyle});
  }

  unsetEllipsis() {
    this.setState({ellipsisStyle: {...this.ellipsisBaseStyle}});
  }


  // switchDir() {
  //   // if this.state.reverse === true NOW, then we're currently reversing, so we want to switch to forward
  //   let hoverStyle = this.state.reverse ? this.overflowHoverStyle : this.overflowHoverStyleReverse
  //
  //   this.setState({
  //     reverse: !this.state.reverse,
  //     style: {...this.baseStyle,...hoverStyle}
  //   });
  // }
  //
  // hover(e) {
  //   // if the text is overflowing, set the overflow CSS animation
  //   if (this.theDiv.current.offsetWidth < this.theDiv.current.scrollWidth) {
  //     this.theDiv.current.addEventListener('transitionend', this.switchDir);
  //
  //     // start the animation (always start forward)
  //     this.setState({
  //       reverse: false,
  //       style: {...this.baseStyle,...this.overflowHoverStyle}
  //     });
  //   }
  // }
  //
  // unhover(e) {
  //   this.setState({style:{...this.baseStyle}});
  //   this.theDiv.current.removeEventListener('transitionend', this.switchDir);
  // }

  timeDelayInit() {
    clearTimeout(this.initTimer);
    this.initTimer = setTimeout(() => {
      this.initialize();
    },500);
  }

  componentDidMount() {
    this.initialize();

    // this.timeDelayInit();

    // this.theDiv.current.addEventListener('resize', this.timeDelayInit);
  }

  componentWillUnmount() {
    // this.theDiv.current.removeEventListener('resize', this.timeDelayInit);
  }


  componentDidUpdate(oldProps) {
    if (oldProps.text !== this.props.text) {
      this.initialize();
    }
  }

  render() {
    // return (
    //   <div ref={this.theDiv} className={this.props.class} style={this.state.style} onMouseEnter={(e) => this.hover(e)} onMouseLeave={(e) => this.unhover(e)}>
    //     {this.props.text}
    //   </div>
    // );

    let style = {
      whiteSpace: 'nowrap',
      // overflow: 'hidden'
    };
    if (this.state.direction === 'left') {
      style.textAlign = 'right';
      style.direction = 'rtl';
      style.position = 'absolute';
      style.right = '0';
      // style.float = 'right'
    }

    return (
      <div className='marquee-container' style={this.state.ellipsisStyle} onMouseEnter={this.timeDelayInit}>
        <div ref={this.theDiv} className={this.props.class} style={style}>
          {this.props.text}
        </div>
      </div>
    );

  }

}

class MynOpenablePane extends React.Component {
  constructor(props) {
    super(props)

    this.state = {
      paneID: ''
    }

    this.render = this.render.bind(this);
  }

  closePane(id,confirm,msg,cb) {
    try {
      // in case confirm is a function instead of just a boolean
      confirm = confirm();
    } catch(err) {}

    // if we're supposed to confirm before exiting:
    // i.e. the confirm boolean variable tells us whether the pane wants us to confirm exit,
    // but that can be overridden by the user preference to override the confirmation dialog,
    // hence the rest of the conditional here
    if (confirm && (!this.props.settings.preferences.override_dialogs || !this.props.settings.preferences.override_dialogs[`Myn${id.replace(/-pane$/,'').replace(/^\w/,(l)=>(l.toUpperCase()))}-confirm-exit`])) {
      ipcRenderer.once('MynOpenablePane-confirm-exit', (event, response, data, checked) => {
        let id = data.id;
        let cb = data.cb;
        // if the user checked the checkbox to override the confirmation dialog,
        // set that preference in the settings
        if (checked) {
          frontendLog.debug('User disabled a pane-exit confirmation dialog', {
            paneID: id
          });
          let prefs = _.cloneDeep(this.props.settings.preferences);
          if (!prefs.override_dialogs) {
            prefs.override_dialogs = {};
          }
          prefs.override_dialogs[`Myn${id.replace(/-pane$/,'').replace(/^\w/,(l)=>(l.toUpperCase()))}-confirm-exit`] = true;
          library.replace("settings.preferences",prefs);
        }

        if (response === 0) { // yes
          // close pane
          try {
            cb();
          } catch(err) {}
          this.props.hideFunction(id);
        } else {
          frontendLog.debug('Pane exit canceled by user', {paneID: id});
        }
      });

      ipcRenderer.send(
        'generic-confirm',
        'MynOpenablePane-confirm-exit',
        {
          message: msg || 'Are you sure you want to exit?',
          checkboxLabel: `Don't show this dialog again`
        },
        {id:id,cb:cb}
      );
    } else {
      try {
        cb();
      } catch(err) {
        // console.error(err);
      }
      this.props.hideFunction(id);
    }
  }

  // child class must supply 'content' variable when calling super.render()
  render(content) {
    if (this.props.show === false) {
      return null;
    }

    return (
      <div id={this.state.paneID} className="pane openable-pane">
        <div className="openable-close-btn" onClick={() => this.closePane(this.state.paneID,content.confirmExit,content.confirmMsg,content.exitCB)}>{"\u2715"}</div>
        {content.jsx}
      </div>
    );
  }
}

// accepts a 'lede' prop and a 'paragraph' prop;
// displays only the lede
// until the user clicks the icon to unfold the whole paragraph
// additional props:
// 'hideLede' : whether to hide the lede when the paragraph is expanded
// 'className' and 'id' pass the class and id to the main div of the component
// 'keepEllipsis' : whether to keep the ellipsis when the paragraph is expanded
class MynParagraphFolder extends React.Component {
  constructor(props) {
    super(props)

    this.state = {
      expanded : false
    }

    // this.input = React.createRef();
    this.render = this.render.bind(this);
    this.toggle = this.toggle.bind(this);
  }

  toggle(e) {
    this.setState({ expanded : !this.state.expanded });
  }

  render() {
    return (
      <div onClick={this.toggle} id={this.props.id} className={'paragraph-fold ' + this.props.className} style={{display:'flex'/*, alignItems: (this.state.expanded ? 'flex-start' : 'center')*/}}>

        <div className='twirl-icon' style={{ cursor : 'pointer', fontStyle : 'normal', opacity: '.6'/*, lineHeight: '0px'/*, transform : (this.state.expanded ? 'rotate(90deg)' : 'rotate(0deg)') */}}>
          { this.state.expanded ? '\u25BC ' : '\u25B6 ' }
        </div>

        <div className='text-container'>

          <div className='lede' style={{cursor: 'pointer', display: this.props.hideLede ? (!this.state.expanded ? '' : 'none') : ''}}>
            {' ' + (this.state.expanded ? this.props.lede : this.props.lede.replace(/[.,;]\s*$/,''))}
            {this.props.keepEllipsis ? '\u2026' : (this.state.expanded ? ' ' : '\u2026')}
          </div>

          <div className='paragraph' style={{display: this.state.expanded ? '' : 'none'}}>
            {this.props.paragraph}
          </div>

        </div>

      </div>
    );
  }
}

class MynTooltip extends React.Component {
  constructor(props) {
    super(props)

    this.state = {
      id : uuidv4(),
      timeout : null,
      shown : false
    }

    this.tipDiv = null;
    this.iconDiv = React.createRef();
    this.render = this.render.bind(this);
    this.showTip = this.showTip.bind(this);
    this.hideTip = this.hideTip.bind(this);
  }

  showTip(x,y) {
    this.state.shown = true;
    // show the div
    this.tipDiv.style.display = 'block';

    // if (typeof x === 'undefined' || typeof y === 'undefined') {
    //   // set the div position based on the mouse position
    //   let x = e.clientX;
    //   let y = e.clientY;
    // }

    // set the div position based on the icon div's position
    // let x = this.iconDiv.current.getBoundingClientRect().left;
    // let y = this.iconDiv.current.getBoundingClientRect().top;

    let fontSize = window.getComputedStyle(this.tipDiv, null).getPropertyValue('font-size');
    let maxWidth = Math.min(parseFloat(fontSize) * 25,window.innerWidth);
    let minWidthIfWrapping = Math.min(parseFloat(fontSize) * 20,window.innerWidth); // we'll set this as the minimum width, but only if the text is long enough to fill it
    let width = this.tipDiv.offsetWidth;

    // we have to set the white space to nowrap just long enough to get the scrollWidth
    // in order to see if the text is wrapping
    // this.tipDiv.style.whiteSpace = 'nowrap';
    let scrollWidth = this.tipDiv.scrollWidth;
    this.tipDiv.style.whiteSpace = 'normal';


    if (scrollWidth > minWidthIfWrapping) {
      // console.log('wrapping...');
      // if the text is long enough to fill the minimum width we've set, set the width to at least that;
      width = Math.max(width,minWidthIfWrapping);
      this.tipDiv.style.width = width + 'px';
    }
    // now test if the div will overflow off the right side of the window
    // and if so, move it over to the left
    let rightOverflow = x + width - window.innerWidth;
    if (rightOverflow > 0) x -= rightOverflow;

    this.tipDiv.style.left = x + 'px';
    this.tipDiv.style.top = (y + parseFloat(fontSize)) + 'px';
    this.tipDiv.style.maxWidth = maxWidth + 'px';


    // console.log('font size: ' + fontSize);
    // console.log('element width: ' + this.tipDiv.offsetWidth);
    // console.log('min width if wrapping: ' + minWidthIfWrapping);
    // console.log('scroll width: ' + scrollWidth);
    // console.log('window width: ' + window.innerWidth);
    // console.log('right overflow: ' + rightOverflow);
    // console.log(`x: ${x}, y: ${y}`);
  }

  hideTip() {
    this.state.shown = false;
    this.tipDiv.style.display = 'none';
    clearTimeout(this.state.timeout);
  }

  toggleTip(e) {
    e.stopPropagation();

    if (this.state.shown) {
      this.hideTip();
    } else {
      this.showTip(e.pageX,e.pageY);
    }
  }

  componentDidMount() {
    // const tipDiv = (
    //   <div ref={this.tip} className='tip' id={this.state.id}>
    //     {this.props.tip}
    //   </div>
    // );

    this.tipDiv = document.createElement('div');
    this.tipDiv.classList.add('tooltip');
    this.tipDiv.id = this.state.id;
    this.tipDiv.innerHTML = this.props.tip;

    document.body.appendChild(this.tipDiv);
  }

  componentWillUnmount() {
    // const tipDiv = document.getElementById(this.state.id);
    document.body.removeChild(this.tipDiv);
  }

  render() {
    return (
      <div
        ref={this.iconDiv}
        className={`tooltip-icon ${this.props.shade ? this.props.shade : ''}`}
        onMouseEnter={(e) => {let x = e.pageX; let y = e.pageY; this.state.timeout = setTimeout(() => this.showTip(x,y),200)}}
        onMouseLeave={this.hideTip}
        onClick={(e) => this.toggleTip(e)}
      />
    );
  }
}

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error) {    // Update state so the next render will show the fallback UI.
    return { hasError: true };
  }

  componentDidCatch(error, errorInfo) {    // You can also log the error to an error reporting service
    frontendLog.error('React error boundary caught a renderer error', {
      error: error,
      componentStack: errorInfo && errorInfo.componentStack
    });
  }

  render() {
    if (this.state.hasError) {      // You can render any custom fallback UI
      return <h2>Something went wrong.</h2>;
    }
    return this.props.children;
  }
}

module.exports = {
  MynNotify,
  MynOverflowTextMarquee,
  MynOpenablePane,
  MynParagraphFolder,
  MynTooltip,
  ErrorBoundary
};
