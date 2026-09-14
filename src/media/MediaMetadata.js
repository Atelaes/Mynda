const fs = require('fs');
const path = require('path');
const {positiveDimension, positiveRatio, isUnverifiedMjpeg} = require('./VideoResolution.js');

function dispositionEnabled(value) {
  return value === true || value === 1 || value === '1';
}

function isArtworkStream(stream) {
  const disposition = stream && stream.disposition || {};
  return ['attached_pic', 'timed_thumbnails', 'still_image'].some(flag =>
    dispositionEnabled(disposition[flag])
  );
}

function selectVideoStream(data) {
  const streams = Array.isArray(data && data.streams) ? data.streams : [];
  const candidates = streams.filter(stream =>
    stream && stream.codec_type === 'video' && !isArtworkStream(stream)
  );
  const usable = candidates.filter(stream =>
    positiveDimension(stream.width) && positiveDimension(stream.height)
  );
  const choices = usable.length ? usable : candidates;
  return choices.find(stream => dispositionEnabled((stream.disposition || {}).default)) ||
    choices[0] || null;
}

function needsMetadataScan(metadata) {
  return !metadata || !metadata.checked ||
    (isUnverifiedMjpeg(metadata) && metadata.video_stream_checked !== true);
}

function hasTechnicalMetadata(metadata) {
  return Boolean(metadata && (usableDuration(metadata.duration) ||
    (positiveDimension(metadata.width) && positiveDimension(metadata.height)) ||
    metadata.audio_codec));
}

function usableDuration(value) {
  const duration = Number(value);
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

// Matroska files commonly store their duration on the container rather than
// on an individual audio/video stream. Prefer the video stream when present,
// then any stream, then the container-level duration returned by FFprobe.
function durationFromProbe(data) {
  const streams = Array.isArray(data && data.streams) ? data.streams : [];
  const video = selectVideoStream(data);
  const videoDuration = usableDuration(video && video.duration);
  if (videoDuration) return videoDuration;

  for (const stream of streams) {
    if (!stream || isArtworkStream(stream)) continue;
    const streamDuration = usableDuration(stream && stream.duration);
    if (streamDuration) return streamDuration;
  }

  return usableDuration(data && data.format && data.format.duration);
}

function metadataFromProbe(data) {
  const video = selectVideoStream(data);
  const metadata = {video_stream_selected: Boolean(video)};
  if (video) {
    metadata.codec = typeof video.codec_name === 'string' ? video.codec_name : '';
    metadata.width = positiveDimension(video.width);
    metadata.height = positiveDimension(video.height);
    if (Number.isInteger(video.index)) metadata.video_stream_index = video.index;
    if (positiveRatio(video.sample_aspect_ratio)) metadata.sample_aspect_ratio = video.sample_aspect_ratio;
    if (positiveRatio(video.display_aspect_ratio)) metadata.aspect_ratio = video.display_aspect_ratio;
    const rate = positiveRatio(video.avg_frame_rate) || positiveRatio(video.r_frame_rate);
    if (rate) metadata.framerate = Math.round(rate * 100) / 100;
  }
  const duration = durationFromProbe(data);
  if (duration) metadata.duration = duration;
  // Preserve the existing audio-track choice; this change concerns video
  // selection and must not change the stored audio layout unexpectedly.
  for (const stream of (Array.isArray(data && data.streams) ? data.streams : [])) {
    if (!stream || stream.codec_type !== 'audio') continue;
    if (stream.codec_name) metadata.audio_codec = stream.codec_name;
    if (stream.channel_layout) metadata.audio_layout = stream.channel_layout;
    if (stream.channels) metadata.audio_channels = stream.channels;
  }
  return metadata;
}

// fluent-ffmpeg's codecData keeps only the LAST input video line, which can be
// cover art. Capture the complete first input's video list before codecData
// fires, then apply the same selection policy as the structured FFprobe path.
function createFfmpegVideoCollector() {
  const streams = [];
  let inInput = false;
  return {
    streams,
    consume(line) {
      if (/^Input #/.test(line)) inInput = /^Input #0,/.test(line);
      if (/^Output #|^Stream mapping:/.test(line)) inInput = false;
      if (!inInput) return;
      const match = line.match(/^\s*Stream #0:(\d+)(?:\[[^\]]*\])?(?:\([^)]*\))?: Video:\s*([^,\s]+)(.*)$/);
      if (!match) return;
      const detail = match[3];
      const dimensions = detail.match(/\b(\d{1,6})x(\d{1,6})\b/);
      const sar = detail.match(/\bSAR\s+(\d+:\d+)/);
      const dar = detail.match(/\bDAR\s+(\d+:\d+)/);
      const rate = detail.match(/\b(\d+(?:\.\d+)?)\s+fps\b/);
      streams.push({
        index: Number(match[1]), codec_type: 'video', codec_name: match[2],
        width: dimensions ? Number(dimensions[1]) : 0,
        height: dimensions ? Number(dimensions[2]) : 0,
        sample_aspect_ratio: sar ? sar[1] : '',
        display_aspect_ratio: dar ? dar[1] : '',
        avg_frame_rate: rate ? rate[1] : '',
        disposition: {
          default: /\(default\)/i.test(detail),
          attached_pic: /\(attached pic\)/i.test(detail),
          timed_thumbnails: /\(timed thumbnails\)/i.test(detail),
          still_image: /\(still image\)/i.test(detail)
        }
      });
    }
  };
}

function metadataFromFfmpeg(data, videoStreams) {
  const metadata = metadataFromProbe({streams: videoStreams});
  const durationParts = String(data.duration || '').split(':');
  const duration = durationParts.length === 3 ?
    Number(durationParts[0]) * 3600 + Number(durationParts[1]) * 60 + Number(durationParts[2]) :
    Number(data.duration);
  if (usableDuration(duration)) metadata.duration = duration;
  if (data.audio) metadata.audio_codec = data.audio;
  const channelLayouts = {mono: 1, stereo: 2, '2.0': 2, '2.1': 3, '5.1': 6, '6.1': 7, '7.1': 8};
  for (const detail of (Array.isArray(data.audio_details) ? data.audio_details : [])) {
    if (Object.prototype.hasOwnProperty.call(channelLayouts, detail)) {
      metadata.audio_layout = detail;
      metadata.audio_channels = channelLayouts[detail];
    }
  }
  return metadata;
}

async function retrieveMetadata(options) {
  const log = options.log || {debug() {}, warn() {}};
  const context = options.context || {};
  let primary = {video_stream_selected: false};
  try {
    primary = metadataFromProbe(await options.probe());
  } catch(error) {
    log.debug('ffprobe metadata retrieval failed; trying FFmpeg fallback', {...context, error});
  }
  const hasVideo = metadata => metadata.video_stream_selected === true &&
    positiveDimension(metadata.width) && positiveDimension(metadata.height);
  if ((!usableDuration(primary.duration) || !hasVideo(primary)) && options.fallback) {
    try {
      const fallback = await options.fallback();
      log.debug('FFmpeg metadata retrieved', {...context, metadata: fallback});
      if (!hasVideo(primary) && hasVideo(fallback)) {
        // Treat dimensions, codec, aspect ratios, and frame rate as one set;
        // never combine technical properties from different video streams.
        for (const field of ['codec', 'width', 'height', 'aspect_ratio', 'sample_aspect_ratio',
          'framerate', 'video_stream_index']) {
          delete primary[field];
          if (fallback[field] !== undefined) primary[field] = fallback[field];
        }
        primary.video_stream_selected = true;
      }
      if (!usableDuration(primary.duration) && usableDuration(fallback.duration)) {
        primary.duration = fallback.duration;
      }
      for (const field of ['audio_codec', 'audio_layout', 'audio_channels']) {
        if (!primary[field] && fallback[field]) primary[field] = fallback[field];
      }
    } catch(error) {
      log.warn('Could not retrieve video metadata with FFmpeg', {...context, error});
    }
  }
  // Keep useful old non-video data if a targeted legacy recheck fails. The
  // selected flag still prevents suspect artwork dimensions from being used.
  if (options.previous && !hasVideo(primary)) {
    for (const field of ['duration', 'audio_codec', 'audio_layout', 'audio_channels']) {
      if (!primary[field] && options.previous[field]) primary[field] = options.previous[field];
    }
  }
  return {
    codec: '', width: 0, height: 0, duration: 0, aspect_ratio: '', framerate: 0,
    audio_codec: '', audio_layout: '', audio_channels: 0,
    ...primary, checked: true, video_stream_checked: true
  };
}

// FFmpeg's legacy metadata fallback needs an output target before it emits
// codecData. A relative filename works in development but resolves inside a
// packaged application's read-only Resources directory. Always put it under
// Electron's writable userData directory instead.
function createFallbackOutputPath(app, options = {}) {
  if (!app || typeof app.getPath !== 'function') {
    throw new Error('Electron app is required to create a metadata scratch path');
  }

  const filesystem = options.fs || fs;
  const identifier = String(options.identifier || `${process.pid}-${Date.now()}`)
    .replace(/[^a-z0-9_-]/gi, '-');
  const directory = path.join(app.getPath('userData'), 'temp');
  filesystem.mkdirSync(directory, {recursive: true});
  return path.join(directory, `metadata-${identifier}.mkv`);
}

// Keep the real subprocess path testable without starting Electron. Resolve
// only after FFmpeg closes and its scratch file has been removed.
function readFfmpegMetadata(filepath, options) {
  const log = options.log || {debug() {}};
  const context = options.context || {filename: filepath};
  return new Promise((resolve, reject) => {
    let tempFile;
    let metadata;
    let timer;
    let timeoutError;
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const complete = () => metadata ? resolve(metadata) : reject(timeoutError || error ||
        new Error('FFmpeg finished without reporting input metadata'));
      if (!tempFile) return complete();
      fs.unlink(tempFile, cleanupError => {
        if (cleanupError && cleanupError.code !== 'ENOENT') {
          log.debug('Could not remove FFmpeg metadata scratch file', {
            ...context, tempFile, error: cleanupError
          });
        }
        complete();
      });
    };
    try {
      log.debug('Starting FFmpeg metadata fallback', context);
      tempFile = createFallbackOutputPath(options.app, {identifier: options.identifier});
      const collector = createFfmpegVideoCollector();
      const command = options.ffmpeg(filepath)
        .on('start', () => {
          // Own this timer: the installed fluent-ffmpeg release does not
          // clear its built-in timeout when a process exits early.
          timer = setTimeout(() => {
            timeoutError = new Error('FFmpeg metadata retrieval timed out after 30 seconds');
            command.kill();
          }, 30000);
        })
        .on('stderr', line => collector.consume(line))
        .on('codecData', data => {
          metadata = metadataFromFfmpeg(data, collector.streams);
          log.debug('FFmpeg codec data received', {...context, codecData: data});
          command.kill();
        })
        .on('end', () => finish())
        .on('error', error => {
          if (!metadata) log.debug('FFmpeg metadata fallback process failed', {...context, error});
          finish(error);
        });
      // Uppercase V excludes attached pictures from the output. Stream-copy
      // needs no encoder and avoids GPL-only defaults in the LGPL bundle.
      command.outputOptions('-map', '0:V:0?', '-map', '0:a:0?')
        .videoCodec('copy').audioCodec('copy').save(tempFile);
    } catch(error) {
      log.debug('Could not start FFmpeg metadata fallback', {...context, error});
      finish(error);
    }
  });
}

module.exports = {
  selectVideoStream,
  isArtworkStream,
  needsMetadataScan,
  hasTechnicalMetadata,
  metadataFromProbe,
  createFfmpegVideoCollector,
  metadataFromFfmpeg,
  retrieveMetadata,
  createFallbackOutputPath,
  readFfmpegMetadata,
  durationFromProbe,
  usableDuration
};
