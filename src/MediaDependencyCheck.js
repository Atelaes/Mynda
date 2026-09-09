const fs = require('fs');
const os = require('os');
const path = require('path');
const MediaTools = require('./MediaTools.js');
const MediaMetadata = require('./MediaMetadata.js');
const MediaToolPolicy = require('./MediaToolPolicy.js');
const MpvProcess = require('./MpvProcess.js');

function errorDescription(error) {
  if (!error) return 'Unknown error';
  const parts = [error.message || String(error)];
  if (error.stderr && String(error.stderr).trim()) {
    parts.push(String(error.stderr).trim());
  }
  return parts.join('\n').slice(0, 12000);
}

// A tiny valid PCM wave file lets the smoke check exercise real decoding and
// probing without touching any movie, watchfolder, or library owned by a user.
function writeTestWave(filename) {
  const sampleRate = 8000;
  const channels = 1;
  const bitsPerSample = 16;
  const sampleCount = 800;
  const bytesPerSample = bitsPerSample / 8;
  const dataSize = sampleCount * channels * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  buffer.writeUInt16LE(channels * bytesPerSample, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  fs.writeFileSync(filename, buffer);
}

// One small YUV4MPEG frame is enough to make MPV initialize its real video
// output. Writing it directly keeps the graphical smoke check independent of
// external codecs and avoids touching user media.
function writeTestVideo(filename) {
  const width = 64;
  const height = 64;
  const lumaSize = width * height;
  const chromaSize = (width / 2) * (height / 2);
  const header = Buffer.from(
    `YUV4MPEG2 W${width} H${height} F1:1 Ip A1:1 C420jpeg\nFRAME\n`,
    'ascii'
  );
  const frame = Buffer.alloc(lumaSize + chromaSize * 2);
  frame.fill(96, 0, lumaSize);
  frame.fill(128, lumaSize);
  fs.writeFileSync(filename, Buffer.concat([header, frame]));
}

async function readMpvProperty(player, name) {
  try {
    return await MpvProcess.promiseWithTimeout(
      player.getProperty(name),
      1000,
      `MPV did not answer the ${name} property request`
    );
  } catch(error) {
    return undefined;
  }
}

async function waitForGraphicalMpvVideo(player, options = {}) {
  if (typeof options === 'number') options = {timeoutMs: options};
  const timeoutMs = options.timeoutMs || 10000;
  const platform = options.platform || process.platform;
  const requirements = MediaToolPolicy.mpvVideoRequirements(platform);
  const deadline = Date.now() + timeoutMs;
  let last = {};
  while (Date.now() < deadline) {
    const [videoOutput, gpuContext, width, height] = await Promise.all([
      readMpvProperty(player, 'current-vo'),
      readMpvProperty(player, 'current-gpu-context'),
      readMpvProperty(player, 'video-out-params/w'),
      readMpvProperty(player, 'video-out-params/h')
    ]);
    last = {
      videoOutput,
      gpuContext,
      width,
      height
    };
    if (last.videoOutput === 'gpu-next' &&
      requirements.runtimeContexts.includes(last.gpuContext) &&
      Number(last.width) > 0 &&
      Number(last.height) > 0) {
      return last;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  const error = new Error(
    `MPV decoded the test video but did not create its ${requirements.description} ` +
    `(current-vo=${last.videoOutput || 'unavailable'}, ` +
    `current-gpu-context=${last.gpuContext || 'unavailable'}, ` +
    `size=${last.width || 0}x${last.height || 0})`
  );
  error.code = 'MYNDA_MPV_VIDEO_OUTPUT_UNAVAILABLE';
  throw MpvProcess.withMpvDiagnostics(error, player);
}

function removeDirectory(directory) {
  if (!directory || !fs.existsSync(directory)) return;
  if (typeof fs.rmSync === 'function') {
    fs.rmSync(directory, {recursive: true, force: true});
    return;
  }
  fs.readdirSync(directory).forEach(entry => {
    const entryPath = path.join(directory, entry);
    const stats = fs.lstatSync(entryPath);
    if (stats.isDirectory()) removeDirectory(entryPath);
    else fs.unlinkSync(entryPath);
  });
  fs.rmdirSync(directory);
}

async function capture(operation) {
  try {
    return {ok: true, value: await operation()};
  } catch(error) {
    return {ok: false, error: errorDescription(error)};
  }
}

async function run(options = {}) {
  const requireMpv = options.requireMpv === true;
  const requireBundled = options.requireBundled === true;
  const requireLgpl = options.requireLgpl === true || requireBundled;
  const requireDvd = options.requireDvd === true || requireBundled;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mynda-media-check-'));
  const input = path.join(directory, 'input.wav');
  const videoInput = path.join(directory, 'input.y4m');
  const output = path.join(directory, 'ffmpeg-output.mkv');
  writeTestWave(input);
  writeTestVideo(videoInput);

  const result = {
    ok: false,
    requireMpv,
    requireBundled,
    requireLgpl,
    requireDvd,
    paths: MediaTools.status(),
    checks: {}
  };

  try {
    result.checks.nodeMpv = await capture(async () => {
      const NodeMpv = require('node-mpv');
      if (typeof NodeMpv !== 'function') {
        throw new Error('node-mpv did not export its player constructor');
      }
      if (!MediaTools.mpvPath) return {loaded: true, ipcChecked: false, skipped: true};

      // Loading the module alone did not catch the packaged-playback failure:
      // the old startup path could hang before connecting to MPV. Exercise the
      // same process/JSON-IPC handoff as the real Player pane, while keeping
      // this automated check headless.
      const graphicalVideoCheck = requireBundled;
      const mpvArguments = graphicalVideoCheck ?
        ['--no-config', '--keep-open=yes', '--ao=null'] :
        ['--no-config', '--vo=null', '--ao=null', '--force-window=no'];
      const player = new NodeMpv({
        time_update: 60,
        auto_restart: false,
        binary: MediaTools.mpvPath,
        socket: MpvProcess.uniqueMpvSocketPath(),
        ipc_command: '--input-ipc-server'
      }, mpvArguments);
      try {
        await MpvProcess.startMpvPlayer(player, {
          timeoutMs: 10000,
          showWindow: graphicalVideoCheck
        });
        const version = await MpvProcess.promiseWithTimeout(
          player.getProperty('mpv-version'),
          5000,
          'MPV did not answer a JSON IPC property request'
        );
        if (!graphicalVideoCheck) {
          return {
            loaded: true,
            ipcChecked: true,
            graphicalVideoChecked: false,
            version
          };
        }

        await MpvProcess.promiseWithTimeout(
          player.load(videoInput),
          10000,
          'MPV did not load the generated graphical test video'
        );
        const video = await waitForGraphicalMpvVideo(player, {
          platform: process.platform
        });
        return {
          loaded: true,
          ipcChecked: true,
          graphicalVideoChecked: true,
          version,
          videoOutput: video.videoOutput,
          gpuContext: video.gpuContext,
          width: Number(video.width),
          height: Number(video.height)
        };
      } finally {
        MpvProcess.stopMpvPlayer(player);
      }
    });

    result.checks.ffmpeg = await capture(async () => {
      if (!MediaTools.executableExists(MediaTools.ffmpegPath)) {
        throw new Error(`FFmpeg is missing or not executable: ${MediaTools.ffmpegPath}`);
      }
      if (requireBundled && !result.paths.ffmpeg.bundled) {
        throw new Error(`FFmpeg resolved outside Mynda's media-tools directory: ${MediaTools.ffmpegPath}`);
      }
      const version = await MediaTools.runExecutable(MediaTools.ffmpegPath, ['-version']);
      const versionOutput = `${version.stdout}\n${version.stderr}`;
      const license = MediaToolPolicy.inspectFfmpegLicense(versionOutput);
      if (requireLgpl) MediaToolPolicy.assertLgplOnlyFfmpeg(versionOutput, 'FFmpeg');
      await MediaTools.runExecutable(MediaTools.ffmpegPath, [
        '-v', 'error',
        '-nostdin',
        '-y',
        '-i', input,
        '-c:a', 'pcm_s16le',
        output
      ]);
      if (!fs.existsSync(output) || fs.statSync(output).size <= 44) {
        throw new Error('FFmpeg did not create the expected Matroska test file');
      }
      return {
        path: MediaTools.ffmpegPath,
        version: MediaToolPolicy.firstLine(version.stdout || version.stderr),
        license,
        outputBytes: fs.statSync(output).size
      };
    });

    result.checks.ffprobe = await capture(async () => {
      if (!MediaTools.executableExists(MediaTools.ffprobePath)) {
        throw new Error(`FFprobe is missing or not executable: ${MediaTools.ffprobePath}`);
      }
      if (requireBundled && !result.paths.ffprobe.bundled) {
        throw new Error(`FFprobe resolved outside Mynda's media-tools directory: ${MediaTools.ffprobePath}`);
      }
      const version = await MediaTools.runExecutable(MediaTools.ffprobePath, ['-version']);
      const versionOutput = `${version.stdout}\n${version.stderr}`;
      const license = MediaToolPolicy.inspectFfmpegLicense(versionOutput);
      if (requireLgpl) MediaToolPolicy.assertLgplOnlyFfmpeg(versionOutput, 'FFprobe');
      // Matroska normally records duration at the container level. Probing the
      // FFmpeg-created MKV catches the exact shape used by the sample-exclusion
      // regression that prompted fix53.
      const data = await MediaTools.probeFile(output);
      const audio = Array.isArray(data && data.streams) ?
        data.streams.find(stream => stream && stream.codec_type === 'audio') : null;
      if (!audio) throw new Error('FFprobe returned no audio stream for the test Matroska file');
      const duration = MediaMetadata.durationFromProbe(data);
      if (!duration) throw new Error('FFprobe returned no usable Matroska duration');
      return {
        path: MediaTools.ffprobePath,
        version: MediaToolPolicy.firstLine(version.stdout || version.stderr),
        license,
        codec: audio.codec_name,
        sampleRate: audio.sample_rate,
        duration
      };
    });

    result.checks.mpv = await capture(async () => {
      if (!MediaTools.mpvPath) {
        if (requireMpv) {
          throw new Error(
            'MPV is unavailable. Prepare Mynda\'s bundled media tools before packaging.'
          );
        }
        return {available: false, skipped: true};
      }
      if (requireBundled && !result.paths.mpv.bundled) {
        throw new Error(`MPV resolved outside Mynda's media-tools directory: ${MediaTools.mpvPath}`);
      }
      const version = await MediaTools.runExecutable(MediaTools.mpvPath, ['--version']);
      const protocols = await MediaTools.runExecutable(
        MediaTools.mpvPath,
        ['--no-config', '--list-protocols']
      );
      const protocolOutput = `${protocols.stdout}\n${protocols.stderr}`;
      if (requireDvd) MediaToolPolicy.assertMpvDvdSupport(protocolOutput);
      await MediaTools.runExecutable(MediaTools.mpvPath, [
        '--no-config',
        '--really-quiet',
        '--ao=null',
        '--vo=null',
        '--length=0.05',
        output
      ]);
      return {
        available: true,
        path: MediaTools.mpvPath,
        version: MediaToolPolicy.firstLine(version.stdout || version.stderr),
        dvd: MediaToolPolicy.mpvSupportsDvd(protocolOutput),
        playbackChecked: true
      };
    });

    result.ok = Object.keys(result.checks).every(name => result.checks[name].ok);
    return result;
  } finally {
    removeDirectory(directory);
  }
}

module.exports = {
  firstLine: MediaToolPolicy.firstLine,
  run,
  waitForGraphicalMpvVideo,
  writeTestVideo,
  writeTestWave
};
