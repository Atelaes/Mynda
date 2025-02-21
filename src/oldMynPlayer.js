// ###### Player Pane: plays the video ###### //
class MynPlayer extends MynOpenablePane {
    constructor(props) {
        super(props)

        this.state = {
            video: props.video,
            subtitleTracks: null,
            paneID: 'player-pane',
            // startedMuxing: false,
            errorMessage: null,
            showLoadingIndicator: false,
            tries: 0
        }

        this.loadingIndicator = null;


        // callbacks to hand off to Stream.js, for different events ffmpeg sends back
        this.callbacks = {
            codecData: (outputPath) => {
                // // called periodically throughout the process;
                // // we only want to know that progress has started, so we use a flag
                // if (this.state.startedMuxing == false) {
                //   this.state.startedMuxing = true;
                // once the process has started, we'll check for the ffmpeg output
                // and when it exists, add it to the video element
                this.checkForStreamPlaylist(outputPath);
                // }
            },
            error: (err) => {
                // turn off loading icon
                this.setState({ showLoadingIndicator: false });

                // unset video player height
                try {
                    this.player.current.setAttribute('height', '');
                } catch (e) {
                    console.log('unable to unset video height after ffmpeg error: ' + e);
                }

                // display error message to user
                this.setState({
                    errorMessage: (
                        <div className='error-message'>
                            <div className='header'>Error Loading Video</div>
                            {err.message}
                        </div>
                    )
                });
            }
        }

        this.render = this.render.bind(this);
        this.onblur = this.onblur.bind(this);
        this.onplay = this.onplay.bind(this);
        this.onpause = this.onpause.bind(this);
        this.onseeked = this.onseeked.bind(this);
        this.ontimeupdate = this.ontimeupdate.bind(this);
        this.onended = this.onended.bind(this);
        this.player = React.createRef();
    }

    // ========================================== //
    // ========== VIDEO EVENT HANDLERS ========== //
    // ========================================== //

    onplay(e) {
        console.log("PLAYING!!!!!")

        // log that we played the video, but only after 10 seconds
        this.logPlayTimeout = setTimeout(() => { console.log('Logging that we played ' + this.state.video.title); this.props.logPlayed(this.state.video.id) }, 10000);
    }

    onpause(e) {
        console.log("PAUSING!!!!!");
        this.updatePosition(e.target.currentTime);
        clearTimeout(this.logPlayTimeout);
    }

    onseeked(e) {
        console.log(`SOUGHT to ${e.target.currentTime} !!!!!`);
        this.updatePosition(e.target.currentTime);

    }

    ontimeupdate(e) {
        if (!this.timeupdateTimeout) {
            let target = e.target;
            this.timeupdateTimeout = setTimeout(() => {
                this.updatePosition(target.currentTime);
            }, 5000);
        }
    }

    onended(e) {
        // in case the video was shorter than the 10 seconds or whatever,
        // or was started less than 10 seconds from the end,
        // we want to log that we played the video here.
        clearTimeout(this.logPlayTimeout);
        this.props.logPlayed(this.state.video.id);
    }

    updatePosition(time) {
        clearTimeout(this.timeupdateTimeout);
        this.timeupdateTimeout = null;
        this.state.video.position = Math.round(time * 10) / 10;
        console.log('UPDATING POSITION TO ' + this.state.video.position);
        library.replace(`media.id=${this.state.video.id}`, this.state.video);
    }

    // called when exiting MynPlayer
    onExit() {
        console.log('EXIT CALLBACK');

        clearTimeout(this.logPlayTimeout);

        let position;
        try {
            position = this.player.current.currentTime;
        } catch (err) {
            position = this.state.video.position;
        }
        let duration = this.state.video.metadata.duration; // we don't try to get this from the video element, in case of an ffmpeg stream that isn't finished, the duration won't be correct
        console.log(`position: ${position}, duration: ${duration}`);
        // if (!duration) return;

        // if the position is close to the beginning or close enough to the end
        // that we estimate the user is done watching it, we reset to 0
        if (position < Math.min(duration * .005, 30)) {
            // if < 30 seconds or 0.5%, whichever is smaller, reset to 0
            // (0.5% of 45 minutes is 13.5 seconds; 0.5% of 2 hours is 36 seconds)
            position = 0;
            console.log('POSITION close to beginning, resetting to 0');
        } else if (position > Math.max(duration * .97, duration - 300)) {
            // if 5 minutes or less from the end, or 3% or less from the end, which ever is later, reset to 0 ()
            // (3% of 45 min is 1:21; 3% of 2 hours is 3:36)
            position = 0;
            console.log('POSITION close to END, resetting to 0');
        }

        // save the position
        this.updatePosition(position);
    }

    // key commands for the video player;
    // spacebar already works natively,
    // as does escape to exit fullscreen;
    keyCommand(e) {
        let isFullscreen = document.fullscreenElement !== null;

        // ESC
        if (e.keyCode === 27 && !isFullscreen) {
            // while not in fullscreen, use escape to close the video;
            // don't do anything while in fullscreen, because escape already exits fullscreen natively
            this.props.hideFunction();
        }
    }

    seekVideoTo(time) {
        let vid = this.player.current;
        if (vid) {
            time = Math.max(Math.min(time, vid.duration), 0);
            vid.currentTime = time;
        } else {
            console.error('Tried to seek, but could not find video');
        }
    }

    // keep focus on the video element
    onblur(e) {
        e.target.focus();
    }


    // ========================================== //
    // =========== CREATING THE VIDEO =========== //
    // ========================================== //

    showLoadingIndicator() {
        console.log('Setting timeout for loading indicator...');
        this.loadingIndicatorTimeout = setTimeout(() => {
            console.log('Actually showing loading indicator!');
            this.state.loadingIndicator = (
                <img className='loading' src='../images/loading-icon.gif' />
            );
        }, 500);
    }

    hideLoadingIndicator() {
        console.log('Canceling timeout for/hiding loading indicator');
        clearTimeout(this.loadingIndicatorTimeout);
        this.state.loadingIndicator = null;
    }

    checkForStreamPlaylist(playlist) {
        this.state.tries += 1;
        console.log('Checking for .m3u8 file: ' + playlist);
        fs.stat(playlist, (err, stat) => {
            if (err == null) {
                console.log('File exists');
                this.createFFmpegVideo(playlist);
            } else if (err.code === 'ENOENT') {
                // file does not exist, wait a second and check again
                if (this.state.tries < 15) {
                    this.createVidTimeout = setTimeout(() => {
                        this.checkForStreamPlaylist(playlist);
                    }, 1000);
                } else {
                    // display error message to user
                    this.setState({
                        errorMessage: (
                            <div className='error-message'>
                                <div className='header'>Error Loading Video</div>
                                Could not locate stream output
                            </div>
                        )
                    });
                    this.setState({ showLoadingIndicator: false });
                }
            } else {
                console.log('Some other error: ', err.code);
                this.setState({
                    errorMessage: (
                        <div className='error-message'>
                            <div className='header'>Error Loading Video</div>
                            Could not locate stream output: unknown problem
                        </div>
                    )
                });
                this.setState({ showLoadingIndicator: false });
            }
        });

    }

    createFFmpegVideo(streamPath) {
        this.setState({ showLoadingIndicator: false });

        console.log('Connecting video element to ffmpeg stream');
        let video;
        try {
            video = this.player.current;
        } catch (err) {
            console.error(err);
        }
        if (!video) {
            console.log('MynPlayer did not create video; video element does not exist');
            return;
        }

        // const source = '../video_stream/output.m3u8'
        const source = `../${streamPath}`;

        if (Hls.isSupported()) {
            this.hls = new Hls();
            this.hls.attachMedia(video);
            this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
                video.currentTime = 0;
                video.play();

                // this is a little hacky, but we had to set the height manually
                // in the render function, so that the player would be the right
                // height for the video before the video loads;
                // but once the video loads, we don't want the height set, we want
                // it to adjust naturally based on the width (in case the window resizes, for instance);
                // so we unset it here, now that the video is loaded
                setTimeout(() => {
                    video.setAttribute('height', '');
                }, 500);

            });
            this.hls.loadSource(source);
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
            console.log('the other option...');
            // video.addEventListener('canplay',function() {
            //   video.play();
            // });
            // video.src = source;
        } else {

        }
    }

    createFFmpegStream() {
        this.state.errorMessage = null;
        // console.log('MynPlayer video: ' + JSON.stringify(this.state.video));
        this.stream = new Stream();
        this.stream.createStream(this.state.video.filename, this.state.video.id, this.callbacks);
    }

    setUpVideo() {
        this.createSubtitleTracks();

        let promise;
        if (this.player.current) {
            this.player.current.src = this.state.video.filename;
            this.player.current.focus(); // so that the key commands will work
            promise = this.player.current.play();
        } else {
            console.error('Could not play video at all; could not find video element');
        }

        if (typeof promise !== "undefined") {
            promise.then(() => {
                console.log('Browser can play video natively!');
                this.seekVideoTo(this.state.video.position);
                this.setState({ showLoadingIndicator: false });
            }).catch((err) => {
                // for now, don't try to make an ffmpeg stream, it's too buggy. We'll figure it out later
                console.error(`Browser could not play video natively`);
                this.setState({
                    errorMessage: (
                        <div className='error-message'>
                            <div className='header'>Error Loading Video</div>
                            This video format cannot be played natively
                        </div>
                    ), showLoadingIndicator: false
                });

                // console.error(`Browser could not play video natively, using HLS fallback: ${err}`);
                // this.createFFmpegStream();
            });
        } else {
            console.error('Video player promise was undefined');
        }

    }

    // ========== HANDLING SUBTITLES =========== //

    async createSubtitleTracks() {
        if (!this.state.video) return null;

        const tempFolder = path.join((electron.app || electron.remote.app).getPath('userData'), 'temp');
        const createFilename = (origName) => `${this.state.video.id}-${crypto.createHash('sha1').update(origName).digest('hex')}.vtt`;
        let subtitles = [];

        // ======= Convert external subs ======= //
        this.state.video.subtitles.map((sub, index) => {
            // create a unique filename for each converted subtitle file based on the video id and a hash of the original filename
            let vttFilename = createFilename(sub);
            let vttFilePath = path.join(tempFolder, vttFilename)

            let subName = '';
            try {
                subName = path.basename(sub, path.extname(sub)).toLowerCase().replace(path.basename(this.state.video.filename, path.extname(this.props.video.filename)).toLowerCase(), '').replace(/\b\w/g, (l) => l.toUpperCase());
            } catch (err) { console.error(err) }
            if (subName === '') subName = `Track ${index + 1}`;

            fs.createReadStream(sub)
                .pipe(subtitle.parse())
                // .pipe(subtitle.resync(-100))
                .pipe(subtitle.stringify({ format: 'WebVTT' }))
                .pipe(fs.createWriteStream(vttFilePath));

            // let trackLabel = `Track ${index+1}`;
            let subObj = {
                path: vttFilePath,
                name: subName,
                lang: 'English'
            }
            console.log(subObj);

            subtitles.push(subObj);

            // return (
            //   <track key={vttFilename} label={trackLabel} kind="subtitles" srcLang="en" src={vttFilePath} />
            // );
        });

        // ======= Extract and convert internal subs ======= //
        let vidInfo;
        try {
            vidInfo = await ffprobe(this.state.video.filename, { path: ffprobeStatic.path });
            console.log(vidInfo);
        } catch (err) {
            console.error(err);
        }
        try {
            vidInfo.streams.map(stream => {
                // loop over the various data streams that ffprobe found in the video;
                // if any of these are subtitle streams, extract them as external files;

                if (stream.codec_type === 'subtitle') {
                    let filepath = path.join(tempFolder, `internal${stream.index}.vtt`);

                    let subObj = {
                        path: filepath,
                        name: stream.tags && stream.tags.title ? stream.tags.title : `Track ${subtitles.length + 1}`,
                        lang: stream.tags ? stream.tags.language : ''
                    }
                    subtitles.push(subObj);

                    let cmd = ffmpeg(this.state.video.filename, {
                        timeout: 60
                    }).outputOptions([
                        `-map 0:${stream.index}`
                    ]).on('codecData', (data) => {
                        console.log('==== FFMPEG codecData ====');
                        console.log(data);
                        console.log(JSON.stringify(data));

                        // setTimeout(()=>cmd.kill(),15000);


                    }).on('end', (stdout, stderr) => {
                        console.log('==== FFMPEG end ====');
                        console.log(stdout);

                    }).on('error', (err) => {
                        console.log('==== FFMPEG error ====');
                        console.log(err.message);
                        // fs.unlink(tempFile, () => {
                        //   console.log('deleted temp file used by ffmpeg');
                        // });
                    }).save(filepath);
                }

            });
        } catch (err) {
            // if we don't have ffprobe we'll probably end up here
        }

        // create track tags and set them in state to be rendered
        let tracks = subtitles.map((sub, index) =>
            (<track key={sub.path} label={sub.name} kind="subtitles" srcLang="en" src={sub.path} />)
        );
        this.setState({ subtitleTracks: tracks });
    }

    // ============== UPDATE AND RENDER =============== //

    componentDidUpdate(oldProps) {
        // the component should update if props.video changes, BUT
        // ONLY IF the pane was also just opened.
        // (we will be continually updating the position of the video
        // as it's playing, and we don't want the component to re-render
        // every time we do that)
        if (!oldProps.show && this.props.show) {
            console.log('NOW SHOWING');
            this.state.video = this.props.video;
            this.setState({ showLoadingIndicator: true });
            this.setUpVideo();
        }

        if (!this.props.show) {
            this.state.errorMessage = null;
            this.state.showLoadingIndicator = false;
            this.state.tries = 0;
        }

    }

    render() {
        let jsx = null;

        if (this.props.show) {
            // we decide whether to show the loading indicator
            // using functions instead of just doing it directly in the JSX
            // because we want to use a brief timeout before actually displaying it
            if (this.state.showLoadingIndicator) {
                this.showLoadingIndicator();
            } else {
                this.hideLoadingIndicator();
            }

            // default size for the video player if no video size is found in the metadata
            let width = 800;
            let height = '';
            // let height = 600;

            // get dimensions from the metadata
            if (this.state.video && this.state.video.metadata) {
                let probedWidth = this.state.video.metadata.width;
                let probedHeight = this.state.video.metadata.height;
                console.log(`width: ${probedWidth}, height: ${probedHeight}`);
                if (!isNaN(probedWidth) && probedWidth > 0) {
                    width = probedWidth;
                    // style.width = Math.min(probedWidth,window.innerWidth) + 'px';
                    if (!isNaN(probedHeight) && probedHeight > 0) {
                        // style.height = Math.min(probedHeight,window.innerHeight) + 'px';
                        try {
                            height = parseFloat(this.player.current.offsetWidth) * probedHeight / probedWidth;
                        } catch (err) { }
                    } else {
                        // if we got a valid width but not a height, let the height be automatic
                        height = '';
                    }
                }
            }

            jsx = (
                <div id="video-container" style={{ width: width + 'px' }} onKeyUp={(e) => this.keyCommand(e)}>
                    <video
                        controls
                        id="video-player"
                        ref={this.player}
                        width={width}
                        height={height}
                        onBlur={this.onblur}
                        onPlay={this.onplay}
                        onPause={this.onpause}
                        onSeeked={this.onseeked}
                        onTimeUpdate={this.ontimeupdate}
                        onEnded={this.onended}
                    >
                        {this.state.subtitleTracks}
                    </video>
                    {this.state.loadingIndicator}
                    {this.state.errorMessage}
                </div>
            );
        }

        return super.render({ jsx: jsx, exitCB: () => this.onExit() });
    }
}