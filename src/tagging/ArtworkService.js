const Response = require('./CatalogResponse');
const {requestFailure} = Response;
const {summarizeError, summarizeOMDbResponse} = require('./TaggingDiagnostics');

function createArtworkService({log, pollOMDB, createURLParts, electron, ipcRenderer, dl, fs, path}) {
  const seriesArtworkCache = new Map();
  const failedArtworkURLs = new Set();
  let nextArtworkDownloadNumber = 0;
  function usablePosterURL(poster) {
    if (typeof poster !== 'string') {
      return null;
    }
    let url = poster.trim();
    return url && url.toUpperCase() !== 'N/A' ? url : null;
  }

  async function getSeriesArtwork(seriesID, context) {
    if (seriesArtworkCache.has(seriesID)) {
      let cachedArtwork = seriesArtworkCache.get(seriesID);
      log.debug('Using cached series artwork fallback', {
        searchID: context.searchID,
        seriesID: seriesID,
        artworkAvailable: Boolean(cachedArtwork)
      });
      return cachedArtwork;
    }

    try {
      let response = await pollOMDB(createURLParts({id: seriesID}), {...context,
        searchID: context.searchID,
        stage: 'series artwork fallback'
      });
      let failure = requestFailure(response);
      if (failure) {
        if (failure.failure === 'No results') {
          seriesArtworkCache.set(seriesID, '');
        }
        log.warn('Could not retrieve series artwork fallback', {
          searchID: context.searchID,
          seriesID: seriesID,
          failure: failure.failure,
          error: summarizeError(failure.data)
        });
        return '';
      }

      let seriesData = response.data;
      if (seriesData.Type !== 'series' || seriesData.imdbID !== seriesID) {
        log.warn('Series artwork fallback response did not match the requested series', {
          searchID: context.searchID,
          seriesID: seriesID,
          received: summarizeOMDbResponse(response)
        });
        return '';
      }

      let artwork = usablePosterURL(seriesData.Poster) || '';
      seriesArtworkCache.set(seriesID, artwork);
      if (artwork) {
        log.debug('Found series artwork fallback', {
          searchID: context.searchID,
          seriesID: seriesID,
          seriesTitle: seriesData.Title
        });
      } else {
        log.debug('Series has no usable artwork fallback', {
          searchID: context.searchID,
          seriesID: seriesID,
          seriesTitle: seriesData.Title
        });
      }
      return artwork;
    } catch(err) {
      log.warn('Series artwork fallback request failed; keeping the episode without artwork', {
        searchID: context.searchID,
        seriesID: seriesID,
        error: summarizeError(err)
      });
      return '';
    }
  }

  function summarizeArtworkDownloadFailure(failure) {
    let source = failure && failure.response ? failure.response : failure;
    if (!source || typeof source !== 'object') {
      return {message: String(source || 'Download failed')};
    }
    return {
      message: source.message || 'Download failed',
      status: source.status || (source.response && source.response.status),
      statusText: source.statusText || (source.response && source.response.statusText)
    };
  }

  function artworkHostname(url) {
    try {
      return new URL(url).hostname;
    } catch(err) {
      return '';
    }
  }

  async function tryDownloadArtwork(url, source, seriesID, context) {
    if (!url) {
      return '';
    }
    if (failedArtworkURLs.has(url)) {
      log.debug('Skipping OMDb artwork URL that previously returned 404', {
        searchID: context.searchID,
        artworkSource: source,
        artworkHost: artworkHostname(url)
      });
      return '';
    }

    try {
      return await downloadArt(url, Object.assign({}, context, {artworkSource: source}));
    } catch(err) {
      let failure = summarizeArtworkDownloadFailure(err);
      if (failure.status === 404) {
        failedArtworkURLs.add(url);
        if (source === 'series' && seriesID) {
          // The cached URL itself is bad, not merely this particular request.
          seriesArtworkCache.set(seriesID, '');
        }
      }
      log.warn('Could not download OMDb artwork', {
        searchID: context.searchID,
        artworkSource: source,
        artworkHost: artworkHostname(url),
        httpStatus: failure.status,
        httpStatusText: failure.statusText,
        error: failure.message
      });
      return '';
    }
  }

  async function downloadArtworkWithSeriesFallback(data, seriesID, context) {
    let isEpisode = data && data.Type === 'episode';
    let primaryArtwork = usablePosterURL(data && data.Poster);
    if (primaryArtwork) {
      let downloadedArtwork = await tryDownloadArtwork(
        primaryArtwork,
        isEpisode ? 'episode' : 'title',
        seriesID,
        context
      );
      if (downloadedArtwork) {
        return downloadedArtwork;
      }
    }

    if (!isEpisode || !seriesID) {
      return '';
    }

    let seriesArtwork = await getSeriesArtwork(seriesID, context);
    if (!seriesArtwork) {
      return '';
    }
    if (primaryArtwork) {
      log.debug('Trying series artwork after the episode artwork download failed', {
        searchID: context.searchID,
        seriesID: seriesID
      });
    }
    let downloadedSeriesArtwork = await tryDownloadArtwork(
      seriesArtwork,
      'series',
      seriesID,
      context
    );
    if (downloadedSeriesArtwork) {
      log.debug('Using series artwork fallback', {
        searchID: context.searchID,
        seriesID: seriesID
      });
    }
    return downloadedSeriesArtwork;
  }

  function downloadArt(url, context = {}) {
    return new Promise(function(resolve, reject) {
      let fileExt = path.extname(url)
      let fileName = path.basename(url, fileExt);
      log.debug('Preparing OMDb artwork download', {searchID: context.searchID, sourceFilename: fileName});
      fileName = fileName.replace(/[\*\."/\\\[\]:;\|,]/g, '') + fileExt;
      log.debug('Prepared local OMDb artwork filename', {searchID: context.searchID, localFilename: fileName});
      let filePath = path.join((electron.app || electron.remote.app).getPath('userData'),'Library','Artwork', fileName);
      if (fs.existsSync(filePath)) {
        log.debug('Reusing existing OMDb artwork file', {
          searchID: context.searchID,
          destination: filePath
        });
        return resolve(filePath);
      }

      if (electron.app) {
        dl.download(url,filePath, (args) => {
          try {
            // if successful, we'll receive an object with the path at "path"
            if (args && Object.prototype.hasOwnProperty.call(args, 'path')) {
              log.debug('OMDb artwork download finished', {
                searchID: context.searchID,
                artworkSource: context.artworkSource,
                destination: args.path
              });
              resolve(args.path);
            } else {
              reject({
                message: args && args.message ? args.message : String(args || 'Download returned no path'),
                status: args && args.status,
                statusText: args && args.statusText
              });
            }
          } catch(error) {
            reject({
              message: error && error.message ? error.message : String(error),
              status: error && error.response && error.response.status,
              statusText: error && error.response && error.response.statusText
            });
          }
        });
      } else {
        // Every renderer download gets a private, one-use reply channel. The old
        // shared "downloaded" listener remained active forever and allowed one
        // download completion to resolve every outstanding artwork request.
        let responseChannel = `downloaded-omdb-${process.pid}-${++nextArtworkDownloadNumber}`;
        let handleDownload = (event, response) => {
          if (response && response.success) {
            let destination = response.message || filePath;
            log.debug('OMDb artwork download finished', {
              searchID: context.searchID,
              artworkSource: context.artworkSource,
              destination: destination
            });
            resolve(destination);
          } else {
            reject({
              message: response && response.message ? response.message : 'Download failed',
              status: response && response.status,
              statusText: response && response.statusText
            });
          }
        };
        ipcRenderer.once(responseChannel, handleDownload);
        try {
          ipcRenderer.send('download', url, filePath, responseChannel);
        } catch(err) {
          ipcRenderer.removeListener(responseChannel, handleDownload);
          reject(err);
        }
      }
    });
  }
  return {downloadArtworkWithSeriesFallback};
}

module.exports = {createArtworkService};
