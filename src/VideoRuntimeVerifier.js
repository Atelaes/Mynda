const childProcess = require('child_process');

const DEFAULT_TIMEOUT_MS = 60000;
const MIN_USABLE_FRAMERATE = 1;
const MAX_USABLE_FRAMERATE = 240;

function usableFrameRate(value) {
  let frameRate = Number(value);
  if (!Number.isFinite(frameRate) ||
      frameRate < MIN_USABLE_FRAMERATE ||
      frameRate > MAX_USABLE_FRAMERATE) {
    return 0;
  }
  return frameRate;
}

function targetPacketCount(frameRate, minimumSeconds) {
  let usableRate = usableFrameRate(frameRate);
  let seconds = Number(minimumSeconds);
  if (!usableRate || !Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.ceil(usableRate * seconds);
}

class VideoRuntimeVerifier {
  constructor(options = {}) {
    this.ffmpegPath = options.ffmpegPath;
    this.spawn = options.spawn || childProcess.spawn;
    this.timeoutMs = Number(options.timeoutMs) > 0 ?
      Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
  }

  hasMinimumRuntime(options = {}) {
    let filename = String(options.filename || '');
    let targetPackets = targetPacketCount(
      options.framerate,
      options.minimumSeconds
    );

    if (!this.ffmpegPath) {
      return Promise.reject(new Error('FFmpeg executable is unavailable'));
    }
    if (!filename) {
      return Promise.reject(new Error('video filename is unavailable'));
    }
    if (!targetPackets) {
      return Promise.reject(new Error(
        `usable video framerate is unavailable (${options.framerate})`
      ));
    }

    // Stream-copying into framecrc makes FFmpeg emit one short text record for
    // each compressed video packet. It does not decode or re-encode the video.
    // -frames:v bounds a genuine long-form video to approximately the requested
    // runtime, while a short clip reaches EOF naturally. Packet counting also
    // avoids trusting the same container duration/timestamps that prompted this
    // secondary check.
    let args = [
      '-v', 'error',
      '-nostdin',
      '-i', filename,
      '-map', '0:V:0',
      '-c:v', 'copy',
      '-frames:v', String(targetPackets),
      '-f', 'framecrc',
      'pipe:1'
    ];

    return new Promise((resolve, reject) => {
      let child;
      try {
        child = this.spawn(this.ffmpegPath, args, {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe']
        });
      } catch (err) {
        reject(err);
        return;
      }

      let settled = false;
      let lineBuffer = '';
      let packetCount = 0;
      let stderr = '';
      let timeout;

      let finish = (err, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (err) reject(err);
        else resolve(result);
      };

      let countLine = line => {
        line = line.trim();
        if (line && !line.startsWith('#')) packetCount++;
      };

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        lineBuffer += chunk;
        let newlineIndex;
        while ((newlineIndex = lineBuffer.indexOf('\n')) !== -1) {
          countLine(lineBuffer.slice(0, newlineIndex));
          lineBuffer = lineBuffer.slice(newlineIndex + 1);
        }
      });

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => {
        // Retain enough diagnostic text to explain a failure without allowing
        // a misbehaving subprocess to grow memory without bound.
        stderr = (stderr + chunk).slice(-8192);
      });

      child.on('error', err => finish(err));
      child.on('close', code => {
        if (lineBuffer) countLine(lineBuffer);
        if (code !== 0) {
          let details = stderr.trim();
          finish(new Error(
            `bounded FFmpeg packet scan exited with code ${code}` +
            (details ? `: ${details}` : '')
          ));
          return;
        }
        if (packetCount === 0) {
          finish(new Error('bounded FFmpeg packet scan returned no video packets'));
          return;
        }

        finish(null, {
          hasMinimumRuntime: packetCount >= targetPackets,
          packetsRead: packetCount,
          targetPackets: targetPackets
        });
      });

      timeout = setTimeout(() => {
        try {
          child.kill();
        } catch (err) {
          // The rejection below remains the useful result even if the process
          // exited between the timeout firing and kill being called.
        }
        finish(new Error(
          `bounded FFmpeg packet scan timed out after ${this.timeoutMs}ms`
        ));
      }, this.timeoutMs);
    });
  }
}

VideoRuntimeVerifier.DEFAULT_TIMEOUT_MS = DEFAULT_TIMEOUT_MS;
VideoRuntimeVerifier.usableFrameRate = usableFrameRate;
VideoRuntimeVerifier.targetPacketCount = targetPacketCount;

module.exports = VideoRuntimeVerifier;
