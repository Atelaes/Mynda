const path = require('path');
const MovieSearch = require('./MovieSearch.js');

// Release samples and trailers in the real library are all under four minutes.
// Five minutes leaves substantial headroom while protecting a feature-length
// movie whose actual title or containing folder happens to include "Sample" or
// "Trailer".
const DEFAULT_MAX_DURATION_SECONDS = 300;
const DEFAULT_PROBE_TIMEOUT_MS = 30000;
const TRAILER_BASENAME_SUFFIX = /(?:^|[^a-z0-9])trailers?[^a-z0-9]*$/i;
const SAMPLE_PATH_COMPONENT = /(?:^|[^a-z0-9])samples?(?:$|[^a-z0-9])/i;
const MOVIE_PATH_COMPONENT = /(?:^|[^a-z0-9])movies?(?:$|[^a-z0-9])/i;

function basenameLooksLikeTrailer(filepath) {
  let filepathString = String(filepath || '');
  let basename = path.basename(filepathString, path.extname(filepathString));
  return TRAILER_BASENAME_SUFFIX.test(basename);
}

function candidateKind(filepath) {
  // An explicit trailer basename is stronger evidence than its containing
  // folder. This keeps the two preferences independent when, for example, a
  // trailer happens to be stored inside a directory named Sample.
  if (basenameLooksLikeTrailer(filepath)) return 'trailer';
  if (MovieSearch.basenameLooksLikeSampleOrGarbage(filepath) ||
      MovieSearch.pathContainsSampleArea(filepath)) {
    return 'sample/garbage';
  }
  return '';
}

// A containing folder such as "Movie and Sample" provides deliberately weak
// evidence: it contains both the feature and its sample, so an ordinary movie
// basename must not trigger an expensive secondary scan. A dedicated Sample
// or Sample,Screens folder remains strong evidence, as do explicit sample,
// garbage, and trailer basenames.
function pathContainsDedicatedSampleArea(filepath) {
  let components = String(filepath || '').split(/[\\/]+/).slice(0, -1);
  return components.some(component =>
    SAMPLE_PATH_COMPONENT.test(component) && !MOVIE_PATH_COMPONENT.test(component)
  );
}

function hasStrongCandidateEvidence(filepath, kind = candidateKind(filepath)) {
  if (kind === 'trailer') return true;
  return MovieSearch.basenameLooksLikeSampleOrGarbage(filepath) ||
    pathContainsDedicatedSampleArea(filepath);
}

function usableDuration(value) {
  let duration = Number(value);
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

function runtimeIsBelowLimit(value, maxDurationSeconds = DEFAULT_MAX_DURATION_SECONDS) {
  let duration = usableDuration(value);
  return duration > 0 && duration < maxDurationSeconds;
}

function normalizeLog(log) {
  const noop = () => {};
  if (typeof log === 'function') {
    return {
      debug: (message, data) => log(message, data, 'debug'),
      info: (message, data) => log(message, data, 'info'),
      warn: (message, data) => log(message, data, 'warn'),
      error: (message, data) => log(message, data, 'error')
    };
  }
  if (!log || typeof log !== 'object') {
    return {debug: noop, info: noop, warn: noop, error: noop};
  }
  return {
    debug: typeof log.debug === 'function' ? log.debug.bind(log) : noop,
    info: typeof log.info === 'function' ? log.info.bind(log) : noop,
    warn: typeof log.warn === 'function' ? log.warn.bind(log) : noop,
    error: typeof log.error === 'function' ? log.error.bind(log) : noop
  };
}

class VideoExclusion {
  constructor(options = {}) {
    this.library = options.library || {media: [], inactive_media: []};
    this.probeMetadata = options.probeMetadata;
    this.verifyMinimumRuntime = options.verifyMinimumRuntime;
    this.isExclusionEnabled = typeof options.isExclusionEnabled === 'function' ?
      options.isExclusionEnabled : () => true;
    this.log = normalizeLog(options.log);
    this.maxDurationSeconds = usableDuration(options.maxDurationSeconds) ||
      DEFAULT_MAX_DURATION_SECONDS;
    this.probeTimeoutMs = usableDuration(options.probeTimeoutMs) || DEFAULT_PROBE_TIMEOUT_MS;
    this.reset();
  }

  reset() {
    // Candidate probes and secondary packet scans are deliberately serialized.
    // A first scan may encounter many release-sample folders at once, and
    // spawning several FFmpeg processes simultaneously would create unnecessary
    // competing disk reads and CPU load.
    this.probeQueue = Promise.resolve();
    this.verificationQueue = Promise.resolve();
  }

  storedMetadata(filepath) {
    for (let collectionName of ['media', 'inactive_media']) {
      let collection = Array.isArray(this.library[collectionName]) ?
        this.library[collectionName] : [];
      let video = collection.find(item => item && item.filename === filepath);
      let metadata = video && video.metadata;
      if (usableDuration(metadata && metadata.duration)) return metadata;
    }
    return null;
  }

  storedDuration(filepath) {
    let metadata = this.storedMetadata(filepath);
    return usableDuration(metadata && metadata.duration);
  }

  async probedMetadata(filepath) {
    if (typeof this.probeMetadata !== 'function') return null;

    let runProbe = async () => {
      let timeout;
      try {
        let metadata = await Promise.race([
          this.probeMetadata({
            id: '',
            filename: filepath
          }),
          new Promise((_, reject) => {
            timeout = setTimeout(() => {
              reject(new Error(`metadata probe timed out after ${this.probeTimeoutMs}ms`));
            }, this.probeTimeoutMs);
          })
        ]);
        return metadata || null;
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    };

    let result = this.probeQueue.then(runProbe, runProbe);
    // A failed probe must not poison the queue for later candidates.
    this.probeQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  async verifiedMinimumRuntime(options) {
    if (typeof this.verifyMinimumRuntime !== 'function') return null;

    let runVerification = () => this.verifyMinimumRuntime(options);
    let result = this.verificationQueue.then(runVerification, runVerification);
    // A failed verification must not poison the queue for later candidates.
    this.verificationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  async shouldExclude(filepath) {
    let kind = candidateKind(filepath);
    if (!kind) return false;

    // Preference checks happen before stored metadata lookup or any external
    // probe, so opting into samples or trailers has no hidden scan cost.
    try {
      if (this.isExclusionEnabled(kind) === false) return false;
    } catch (err) {
      this.log.warn('Could not read video-exclusion preference; retaining candidate', {
        kind: kind,
        filename: filepath,
        error: err
      });
      return false;
    }

    let metadata = this.storedMetadata(filepath);
    let duration = usableDuration(metadata && metadata.duration);
    let durationSource = metadata ? 'stored metadata' : 'file probe';

    if (!duration) {
      try {
        metadata = await this.probedMetadata(filepath);
        duration = usableDuration(metadata && metadata.duration);
        durationSource = 'file probe';
      } catch (err) {
        this.log.warn('Could not determine candidate runtime; retaining video', {
          kind: kind,
          filename: filepath,
          error: err
        });
        return false;
      }
    }

    if (!duration) {
      this.log.warn('Candidate probe returned no usable runtime; retaining video', {
        kind: kind,
        filename: filepath
      });
      return false;
    }

    if (runtimeIsBelowLimit(duration, this.maxDurationSeconds)) {
      this.log.info('Excluded short sample/trailer candidate from the library', {
        kind: kind,
        filename: filepath,
        durationSeconds: duration,
        durationSource: durationSource,
        maximumDurationSeconds: this.maxDurationSeconds
      });
      return true;
    }

    // A successful duration probe can still be wrong when a container carries
    // the feature's original duration even though it contains only a short
    // sample. For strong candidates only, count compressed packets with a
    // bounded FFmpeg stream-copy scan. This avoids decoding and does not trust
    // the suspect duration/timestamps. Weak "Movie and Sample" path evidence
    // deliberately retains an ordinary feature without the extra disk read.
    if (hasStrongCandidateEvidence(filepath, kind) &&
        typeof this.verifyMinimumRuntime === 'function') {
      let verification;
      try {
        verification = await this.verifiedMinimumRuntime({
          filename: filepath,
          framerate: metadata && metadata.framerate,
          minimumSeconds: this.maxDurationSeconds
        });
      } catch (err) {
        this.log.warn('Could not verify a candidate with a suspect reported runtime; retaining video', {
          kind: kind,
          filename: filepath,
          reportedDurationSeconds: duration,
          durationSource: durationSource,
          error: err
        });
        return false;
      }

      if (!verification || typeof verification.hasMinimumRuntime !== 'boolean') {
        this.log.warn('Runtime verification returned no usable result; retaining candidate', {
          kind: kind,
          filename: filepath,
          reportedDurationSeconds: duration,
          durationSource: durationSource
        });
        return false;
      }

      if (!verification.hasMinimumRuntime) {
        this.log.info('Excluded sample/trailer candidate after bounded runtime verification', {
          kind: kind,
          filename: filepath,
          reportedDurationSeconds: duration,
          durationSource: durationSource,
          packetsRead: verification.packetsRead,
          targetPackets: verification.targetPackets,
          maximumDurationSeconds: this.maxDurationSeconds
        });
        return true;
      }

      this.log.debug('Retained candidate after bounded runtime verification confirmed sufficient content', {
        kind: kind,
        filename: filepath,
        reportedDurationSeconds: duration,
        durationSource: durationSource,
        packetsRead: verification.packetsRead,
        targetPackets: verification.targetPackets
      });
      return false;
    }

    this.log.debug('Retained candidate whose reported runtime exceeds the exclusion limit', {
      kind: kind,
      filename: filepath,
      reportedDurationSeconds: duration,
      durationSource: durationSource,
      maximumDurationSeconds: this.maxDurationSeconds,
      strongCandidateEvidence: hasStrongCandidateEvidence(filepath, kind)
    });
    return false;
  }
}

VideoExclusion.DEFAULT_MAX_DURATION_SECONDS = DEFAULT_MAX_DURATION_SECONDS;
VideoExclusion.DEFAULT_PROBE_TIMEOUT_MS = DEFAULT_PROBE_TIMEOUT_MS;
VideoExclusion.basenameLooksLikeTrailer = basenameLooksLikeTrailer;
VideoExclusion.candidateKind = candidateKind;
VideoExclusion.pathContainsDedicatedSampleArea = pathContainsDedicatedSampleArea;
VideoExclusion.hasStrongCandidateEvidence = hasStrongCandidateEvidence;
VideoExclusion.runtimeIsBelowLimit = runtimeIsBelowLimit;

module.exports = VideoExclusion;
