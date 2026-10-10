const {redactSecrets, serialize} = require('../platform/LogSerialization');
const styles = {debug:'color: #7bc96f', info:'color: #58a6ff', warn:'color: #d9a441', error:'color: #f97583'};
function child(scope) {
  return Object.fromEntries(Object.keys(styles).map(level => [level, (message, data) => {
    const entry = {timestamp:new Date().toISOString(), level, scope, processType:'renderer',
      message:redactSecrets(message instanceof Error ? message.message : message).slice(0,50000),
      details:data === undefined ? '' : serialize(data).slice(0,50000)};
    const method = level === 'debug' ? 'log' : level;
    console[method]('%c%s %s [%s] %s', styles[level], entry.timestamp, level.toUpperCase(), scope,
      entry.message + (entry.details ? '\n' + entry.details : ''));
    if (level !== 'debug') window.mynda.logs.write(entry).catch(error => console.error('Could not forward log:', error.message));
  }]));
}
module.exports = {child};
