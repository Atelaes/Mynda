// Browser entry point. scripts/build-renderer.js compiles JSX and resolves
// CommonJS imports before launch; this page has no Node or Electron access.
const React = require('react');
const ReactDOM = require('react-dom');
// Editor date fields intentionally support DateJS's natural-language parsing
// and formatting. Keep the extension loaded before importing the components.
require('datejs');
const {library, frontendLog, uiDiagnostics} = require('./RendererRuntime.js');
const {Mynda} = require('./Mynda.js');
void uiDiagnostics.start();

library.ready.then(() => {
  ReactDOM.render(<Mynda library={library}/>, document.getElementById('root'));
}).catch(error => {
  frontendLog.error('Could not initialize the library view', {error});
  document.getElementById('root').textContent = 'Mynda could not load its library. Please restart the app. ' + error.message;
});
