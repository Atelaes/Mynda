'use strict';

// This is the complete renderer capability surface. Channel names, Electron
// events, file handles and unrestricted invoke/send never leave the preload.
function createBridge({invoke, subscribe, platform, getPathForFile}) {
  const call = name => (...args) => invoke(name, ...args);
  const on = channel => callback => subscribe(channel, callback);
  return Object.freeze({
    app:Object.freeze({platform}),
    library:Object.freeze({snapshot:call('library.snapshot'), commit:call('library.commit'),
      closeReady:call('library.closeReady'), export:call('library.export'),
      onCommitted:on('library:committed'), onPrepareClose:on('library:prepare-close'),
      onCloseCanceled:on('library:close-canceled')}),
    playback:Object.freeze({play:call('playback.play'), stop:call('playback.stop'),
      getState:call('playback.getState'), onState:on('playback:state')}),
    editor:Object.freeze({...Object.fromEntries(['search','select','cancelSearch','resetFromFilename','prepareArtwork',
      'inspectArtwork','downloadArtwork','chooseArtwork','chooseSubtitles','validateSubtitles','confirm']
      .map(name => [name,call('editor.'+name)])),
      onLookupStatus:on('editor:lookup-status'),
      async inspectDroppedArtwork(file) {
        // DOM Files cannot cross IPC. Resolve the native path inside preload,
        // then use the same main-process approval and validation as typed paths.
        const path = getPathForFile(file);
        if (typeof path !== 'string' || !path) throw new Error('This image is not a file on disk. Use Browse to choose an image.');
        return invoke('editor.inspectArtwork', path);
      }
    }),
    scan:Object.freeze({start:call('scan.start')}),
    tagging:Object.freeze({start:call('tagging.start'), startSelected:call('tagging.startSelected'), cancel:call('tagging.cancel')}),
    watchfolders:Object.freeze({choose:call('watchfolders.choose'), add:call('watchfolders.add'), remove:call('watchfolders.remove'),
      onAdded:on('settings-watchfolder-added'), onRemoved:on('settings-watchfolder-remove')}),
    dialogs:Object.freeze({confirmPaneExit:call('dialogs.confirmPaneExit'), confirmPlaylistDelete:call('dialogs.confirmPlaylistDelete'),
      confirmVideoEdit:call('dialogs.confirmVideoEdit')}),
    files:Object.freeze({revealVideo:call('files.revealVideo'), revealExport:call('files.revealExport')}),
    external:Object.freeze({open:call('external.open')}),
    events:Object.freeze({onStatus:on('status-update'), onVideosAdded:on('videos_added')}),
    logs:Object.freeze({write:call('logs.write')}),
    share:Object.freeze({...Object.fromEntries(['getState','chooseDirectory','inspect','createRequest','planFulfillment',
      'fulfillRequest','planImport','import','cancel'].map(name=>[name,call('share.'+name)])), onProgress:on('share-progress')})
  });
}

module.exports = {createBridge};
