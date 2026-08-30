const fs = require('fs');
const path = require('path');

const IPC_CHANNEL = 'mynda-backend-log';
const LEVELS = {debug: 10, info: 20, warn: 30, error: 40};
const DEFAULT_MAX_FILE_SIZE = 5 * 1024 * 1024;
const DEFAULT_MAX_BACKUPS = 4;
const MAX_LOG_TEXT_LENGTH = 50000;
const ANSI_RESET = '\u001b[0m';
const ANSI_TIMESTAMP_COLOR = '\u001b[90m';
const ANSI_LEVEL_COLORS = {
  debug: '\u001b[1;32m',
  info: '\u001b[1;34m',
  warn: '\u001b[1;33m',
  error: '\u001b[1;31m'
};
const DEVTOOLS_TIMESTAMP_STYLE = 'color: #8b949e;';
const DEVTOOLS_LEVEL_STYLES = {
  debug: 'color: #7bc96f; font-weight: 700;',
  info: 'color: #58a6ff; font-weight: 700;',
  warn: 'color: #d9a441; font-weight: 700;',
  error: 'color: #e06c75; font-weight: 700;'
};

// DEBUG stays in the console. INFO/WARN/ERROR go to mynda-info.log, and ERROR
// is duplicated into mynda-error.log. Renderer calls are forwarded over IPC so
// the main process remains the only process that writes and rotates the files.

let electron;
try {
  electron = require('electron');
} catch(err) {
  // Logger tests and other plain-Node tools do not necessarily have Electron.
  electron = null;
}

let initialized = false;
let logDirectory = null;
let infoSink = null;
let errorSink = null;
let ipcMainReference = null;
let ipcListener = null;
let fileErrorReported = false;

function isRendererProcess() {
  return typeof process !== 'undefined' && process.type === 'renderer';
}

function isLogLevel(level) {
  return Object.prototype.hasOwnProperty.call(LEVELS, level);
}

function redactSecrets(value) {
  return String(value)
    .replace(/((?:api[_-]?key|apikey|authorization|password|token|secret)\s*[=:]\s*)(?:Bearer\s+)?[^&\s,;}\]"']+/gi, '$1[REDACTED]')
    .replace(/([?&](?:api[_-]?key|apikey|token|password|secret)=)[^&\s"']+/gi, '$1[REDACTED]');
}

function serialize(value) {
  const seen = new WeakSet();
  try {
    let serialized = JSON.stringify(value, (key, currentValue) => {
      if (/^(?:api[_-]?key|apikey|authorization|password|token|secret)$/i.test(key)) {
        return '[REDACTED]';
      }
      if (currentValue instanceof Error) {
        return {
          name: currentValue.name,
          message: currentValue.message,
          code: currentValue.code,
          stack: currentValue.stack
        };
      }
      if (typeof currentValue === 'bigint') {
        return currentValue.toString();
      }
      if (currentValue && typeof currentValue === 'object') {
        if (seen.has(currentValue)) {
          return '[Circular]';
        }
        seen.add(currentValue);
      }
      return currentValue;
    });
    return redactSecrets(typeof serialized === 'undefined' ? String(value) : serialized);
  } catch(err) {
    return redactSecrets(`[Could not serialize log data: ${err.message}]`);
  }
}

function makeEntry(level, scope, message, data) {
  return {
    timestamp: new Date().toISOString(),
    level: isLogLevel(level) ? level : 'info',
    scope: redactSecrets(scope || 'Mynda').slice(0, 200),
    processType: isRendererProcess() ? 'renderer' : 'main',
    pid: typeof process !== 'undefined' ? process.pid : null,
    message: redactSecrets(message instanceof Error ? message.message : message).slice(0, MAX_LOG_TEXT_LENGTH),
    details: typeof data === 'undefined' ? '' : serialize(data).slice(0, MAX_LOG_TEXT_LENGTH)
  };
}

function formatEntry(entry) {
  let processLabel = entry.processType;
  if (entry.pid !== null && typeof entry.pid !== 'undefined') {
    processLabel += `:${entry.pid}`;
  }
  let line = `${entry.timestamp} ${entry.level.toUpperCase()} [${entry.scope}] [${processLabel}] ${entry.message}`;
  if (entry.details) {
    // Persistent logs deliberately keep one complete event on each line.
    line += ` ${entry.details}`;
  }
  return `${line}\n`;
}

function formatConsoleDetails(details) {
  let formatted = String(details);
  try {
    formatted = JSON.stringify(JSON.parse(formatted), null, 2);
  } catch(err) {
    // Truncated or non-JSON details still belong on their own indented line.
  }
  return formatted.split('\n').map(line => `  ${line}`).join('\n');
}

function consoleEntryParts(entry) {
  let processLabel = entry.processType;
  if (entry.pid !== null && typeof entry.pid !== 'undefined') {
    processLabel += `:${entry.pid}`;
  }
  let remainder = `[${entry.scope}] [${processLabel}] ${entry.message}`;
  if (entry.details) {
    remainder += `\n${formatConsoleDetails(entry.details)}`;
  }
  return {
    timestamp: entry.timestamp,
    level: entry.level.toUpperCase(),
    remainder: remainder
  };
}

function consoleSupportsAnsi(entry) {
  if (typeof process === 'undefined' || !process.env) return false;
  if (Object.prototype.hasOwnProperty.call(process.env, 'NO_COLOR')) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true;
  let stream = entry.level === 'warn' || entry.level === 'error' ?
    process.stderr : process.stdout;
  return Boolean(stream && stream.isTTY);
}

function backupPath(filePath, index) {
  let extension = path.extname(filePath);
  let stem = filePath.slice(0, filePath.length-extension.length);
  return `${stem}.${index}${extension}`;
}

// Serializing each sink through one promise queue prevents overlapping appends
// or rotations without blocking Electron's main process on synchronous I/O.
class RotatingFileSink {
  constructor(filePath, maxFileSize, maxBackups) {
    this.filePath = filePath;
    this.maxFileSize = maxFileSize;
    this.maxBackups = maxBackups;
    this.currentSize = null;
    this.queue = Promise.resolve();
  }

  prepare() {
    this.enqueue(async () => {
      await this.ensureReady();
    });
  }

  write(line) {
    this.enqueue(async () => {
      await this.ensureReady();
      let lineSize = Buffer.byteLength(line);
      if (this.currentSize > 0 && this.currentSize + lineSize > this.maxFileSize) {
        await this.rotate();
      }
      await fs.promises.appendFile(this.filePath, line, 'utf8');
      this.currentSize += lineSize;
    });
  }

  enqueue(operation) {
    this.queue = this.queue.then(operation).catch(reportFileError);
  }

  async ensureReady() {
    if (this.currentSize !== null) {
      return;
    }
    await fs.promises.mkdir(path.dirname(this.filePath), {recursive: true});
    try {
      this.currentSize = (await fs.promises.stat(this.filePath)).size;
    } catch(err) {
      if (err.code !== 'ENOENT') {
        throw err;
      }
      await fs.promises.appendFile(this.filePath, '', 'utf8');
      this.currentSize = 0;
    }
  }

  async rotate() {
    if (this.maxBackups === 0) {
      await fs.promises.writeFile(this.filePath, '', 'utf8');
      this.currentSize = 0;
      return;
    }

    for (let index=this.maxBackups; index>=1; index--) {
      let destination = backupPath(this.filePath, index);
      let source = index === 1 ? this.filePath : backupPath(this.filePath, index-1);
      try {
        await fs.promises.unlink(destination);
      } catch(err) {
        if (err.code !== 'ENOENT') {
          throw err;
        }
      }
      try {
        await fs.promises.rename(source, destination);
      } catch(err) {
        if (err.code !== 'ENOENT') {
          throw err;
        }
      }
    }

    await fs.promises.appendFile(this.filePath, '', 'utf8');
    this.currentSize = 0;
  }

  flush() {
    return this.queue;
  }
}

function reportFileError(err) {
  if (!fileErrorReported) {
    fileErrorReported = true;
    console.error(`[Logger] Could not write a log file: ${err && err.stack ? err.stack : err}`);
  }
}

function normalizeForwardedEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  let level = isLogLevel(entry.level) ? entry.level : 'info';
  let timestamp = /^\d{4}-\d{2}-\d{2}T/.test(entry.timestamp || '') ? String(entry.timestamp).slice(0, 40) : new Date().toISOString();
  return {
    timestamp: timestamp,
    level: level,
    scope: redactSecrets(String(entry.scope || 'Renderer')).slice(0, 200),
    processType: 'renderer',
    pid: Number.isInteger(entry.pid) ? entry.pid : null,
    message: redactSecrets(String(entry.message || '')).slice(0, MAX_LOG_TEXT_LENGTH),
    details: redactSecrets(String(entry.details || '')).slice(0, MAX_LOG_TEXT_LENGTH)
  };
}

function persistEntry(entry) {
  if (!initialized) {
    return;
  }
  let line = formatEntry(entry);
  if (LEVELS[entry.level] >= LEVELS.info) {
    infoSink.write(line);
  }
  if (LEVELS[entry.level] >= LEVELS.error) {
    errorSink.write(line);
  }
}

function writeToConsole(entry) {
  let outputMethod;
  if (entry.level === 'error') {
    outputMethod = console.error;
  } else if (entry.level === 'warn') {
    outputMethod = console.warn;
  } else if (entry.level === 'debug' && console.debug) {
    outputMethod = console.debug;
  } else {
    outputMethod = console.log;
  }

  const parts = consoleEntryParts(entry);
  if (isRendererProcess()) {
    // Chromium DevTools supports CSS substitutions. Reset the style after both
    // highlighted fields so wrapped message text retains the console's normal
    // foreground color.
    outputMethod.call(
      console,
      '%c%s%c %c%s%c %s',
      DEVTOOLS_TIMESTAMP_STYLE,
      parts.timestamp,
      '',
      DEVTOOLS_LEVEL_STYLES[entry.level],
      parts.level,
      '',
      parts.remainder
    );
  } else if (consoleSupportsAnsi(entry)) {
    // The main Electron process normally writes to a terminal. ANSI resets are
    // placed immediately after the timestamp and level so only those two
    // fields are colored, even when the remainder wraps onto another line.
    outputMethod.call(
      console,
      `${ANSI_TIMESTAMP_COLOR}${parts.timestamp}${ANSI_RESET} ` +
      `${ANSI_LEVEL_COLORS[entry.level]}${parts.level}${ANSI_RESET} ${parts.remainder}`
    );
  } else {
    outputMethod.call(console, `${parts.timestamp} ${parts.level} ${parts.remainder}`);
  }
}

function forwardFromRenderer(entry) {
  try {
    if (electron && electron.ipcRenderer) {
      electron.ipcRenderer.send(IPC_CHANNEL, entry);
    }
  } catch(err) {
    console.error(`[Logger] Could not forward a renderer log entry: ${err.message}`);
  }
}

function write(level, scope, message, data) {
  let entry = makeEntry(level, scope, message, data);
  writeToConsole(entry);
  if (isRendererProcess()) {
    forwardFromRenderer(entry);
  } else {
    persistEntry(entry);
  }
}

function initialize(options = {}) {
  if (isRendererProcess()) {
    return null;
  }
  if (initialized) {
    return logDirectory;
  }

  let app = options.app || (electron && electron.app);
  logDirectory = options.logDirectory || (app && path.join(app.getPath('userData'), 'logs'));
  if (!logDirectory) {
    throw new Error('Logger.initialize needs an Electron app or a logDirectory');
  }

  let maxFileSize = Number.isFinite(options.maxFileSize) && options.maxFileSize > 0 ?
    options.maxFileSize : DEFAULT_MAX_FILE_SIZE;
  let maxBackups = Number.isInteger(options.maxBackups) && options.maxBackups >= 0 ?
    options.maxBackups : DEFAULT_MAX_BACKUPS;

  infoSink = new RotatingFileSink(path.join(logDirectory, 'mynda-info.log'), maxFileSize, maxBackups);
  errorSink = new RotatingFileSink(path.join(logDirectory, 'mynda-error.log'), maxFileSize, maxBackups);
  infoSink.prepare();
  errorSink.prepare();
  initialized = true;

  ipcMainReference = options.ipcMain || (electron && electron.ipcMain);
  if (ipcMainReference) {
    ipcListener = (event, entry) => {
      let normalizedEntry = normalizeForwardedEntry(entry);
      if (normalizedEntry) {
        persistEntry(normalizedEntry);
      }
    };
    ipcMainReference.on(IPC_CHANNEL, ipcListener);
  }

  write('info', 'Logger', 'Backend file logging initialized', {
    logDirectory: logDirectory,
    infoFile: 'mynda-info.log',
    errorFile: 'mynda-error.log',
    maxFileSize: maxFileSize,
    maxBackups: maxBackups
  });
  return logDirectory;
}

function child(scope) {
  return {
    debug: (message, data) => write('debug', scope, message, data),
    info: (message, data) => write('info', scope, message, data),
    warn: (message, data) => write('warn', scope, message, data),
    error: (message, data) => write('error', scope, message, data)
  };
}

async function flush() {
  let sinks = [infoSink, errorSink].filter(Boolean);
  await Promise.all(sinks.map(sink => sink.flush()));
}

async function shutdown() {
  if (ipcMainReference && ipcListener) {
    ipcMainReference.removeListener(IPC_CHANNEL, ipcListener);
  }
  await flush();
}

module.exports = {
  initialize,
  child,
  debug: (message, data) => write('debug', 'Mynda', message, data),
  info: (message, data) => write('info', 'Mynda', message, data),
  warn: (message, data) => write('warn', 'Mynda', message, data),
  error: (message, data) => write('error', 'Mynda', message, data),
  flush,
  shutdown,
  getLogDirectory: () => logDirectory
};
