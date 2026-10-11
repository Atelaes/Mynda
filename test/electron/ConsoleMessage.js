'use strict';

// Electron 35 moved console fields onto the event and made level a string.
// Keep diagnostics readable on both sides of the runtime upgrade.
function consoleMessage(event, level, message, line, sourceId) {
  if (event && typeof event.message === 'string') {
    ({level, message, lineNumber: line, sourceId} = event);
  }
  return {
    level: typeof level === 'number' ? ['debug', 'info', 'warning', 'error'][level] : level,
    message: String(message || '').slice(0, 2000),
    line,
    source: String(sourceId || '').slice(0, 1000)
  };
}

module.exports = {consoleMessage};
