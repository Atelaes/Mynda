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
  if (MovieSearch.basenameLooksLikeSampleOrGarbage(filepath) ||
      MovieSearch.pathContainsSampleArea(filepath)) {
    return 'sample/garbage';
  }
  if (basenameLooksLikeTrailer(filepath)) return 'trailer';
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

class VideoExclusion {
  constructor(options = {}) {
    this.library = options.library || {media: [], inactive_media: []};
    this.probeMetadata = options.probeMetadata;
    this.verifyMinimumRuntime = options.verifyMinimumRuntime;
    this.log = typeof options.log === 'function' ? options.log : () => {};
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

    let metadata = this.storedMetadata(filepath);
    let duration = usableDuration(metadata && metadata.duration);
    let durationSource = metadata ? 'stored metadata' : 'file probe';

    if (!duration) {
      try {
        metadata = await this.probedMetadata(filepath);
        duration = usableDuration(metadata && metadata.duration);
      } catch (err) {
        this.log(
          `Could not determine runtime for possible ${kind} video; retaining ${filepath}: ${err}`
        );
        return false;
      }
    }

    if (!duration) {
      this.log(`Could not determine runtime for possible ${kind} video; retaining ${filepath}`);
      return false;
    }

    if (runtimeIsBelowLimit(duration, this.maxDurationSeconds)) {
      this.log(
        `Ignoring ${kind} video (${duration.toFixed(2)} seconds from ${durationSource}): ${filepath}`
      );
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
        this.log(
          `Could not verify reported runtime for possible ${kind} video; ` +
          `retaining ${filepath}: ${err}`
        );
        return false;
      }

      if (!verification || typeof verification.hasMinimumRuntime !== 'boolean') {
        this.log(
          `Could not verify reported runtime for possible ${kind} video; retaining ${filepath}`
        );
        return false;
      }

      if (!verification.hasMinimumRuntime) {
        this.log(
          `Ignoring ${kind} video (reported ${duration.toFixed(2)} seconds from ` +
          `${durationSource}, but bounded FFmpeg scan reached EOF after ` +
          `${verification.packetsRead}/${verification.targetPackets} video packets): ` +
          filepath
        );
        return true;
      }
    }

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
