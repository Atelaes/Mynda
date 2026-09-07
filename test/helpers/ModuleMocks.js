const Module = require('module');
const path = require('path');

// Load one CommonJS module while substituting a deliberately small set of its
// dependencies. This keeps tests independent of Electron's real main/renderer
// processes without adding a mocking framework to Mynda's production install.
function loadFreshWithMocks(modulePath, mocks = {}) {
  const absoluteModulePath = require.resolve(path.resolve(modulePath));
  const originalLoad = Module._load;
  delete require.cache[absoluteModulePath];

  Module._load = function mockedLoad(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(mocks, request)) {
      return mocks[request];
    }

    let resolved;
    try {
      resolved = Module._resolveFilename(request, parent, isMain);
    } catch(err) {
      resolved = null;
    }
    if (resolved && Object.prototype.hasOwnProperty.call(mocks, resolved)) {
      return mocks[resolved];
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return require(absoluteModulePath);
  } finally {
    Module._load = originalLoad;
  }
}

module.exports = {loadFreshWithMocks};
