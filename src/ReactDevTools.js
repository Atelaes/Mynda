const path = require('path');

const DEFAULT_EXTENSION_PATH = path.resolve(
  __dirname,
  '..',
  'devtools',
  'react-developer-tools'
);

async function loadReactDeveloperTools({
  app,
  session,
  log,
  extensionPath = DEFAULT_EXTENSION_PATH
}) {
  if (!app || app.isPackaged) return null;

  try {
    const extension = await session.defaultSession.loadExtension(
      extensionPath,
      {allowFileAccess: true}
    );
    log.debug('React developer tools loaded', {
      name: extension && extension.name,
      version: extension && extension.version,
      path: extensionPath
    });
    return extension;
  } catch(err) {
    log.warn('Could not load React developer tools', {
      path: extensionPath,
      error: err
    });
    return null;
  }
}

module.exports = loadReactDeveloperTools;
module.exports.DEFAULT_EXTENSION_PATH = DEFAULT_EXTENSION_PATH;
