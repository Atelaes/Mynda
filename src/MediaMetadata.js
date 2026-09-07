const fs = require('fs');
const path = require('path');

function usableDuration(value) {
  const duration = Number(value);
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

// Matroska files commonly store their duration on the container rather than
// on an individual audio/video stream. Prefer the video stream when present,
// then any stream, then the container-level duration returned by FFprobe.
function durationFromProbe(data) {
  const streams = Array.isArray(data && data.streams) ? data.streams : [];
  const video = streams.find(stream => stream && stream.codec_type === 'video');
  const videoDuration = usableDuration(video && video.duration);
  if (videoDuration) return videoDuration;

  for (const stream of streams) {
    const streamDuration = usableDuration(stream && stream.duration);
    if (streamDuration) return streamDuration;
  }

  return usableDuration(data && data.format && data.format.duration);
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

module.exports = {
  createFallbackOutputPath,
  durationFromProbe,
  usableDuration
};
