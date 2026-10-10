// Test-only lifecycle. Failure teardown must bypass production close handlers:
// the disposable renderer may never have initialized its library client.
function createSmokeTerminator({app,writeResult,clearDeadline}) {
  let finished=false;
  return function finish(ok,details) {
    if (finished) return;
    finished=true;
    clearDeadline();
    let exitCode=ok ? 0 : 1;
    try {writeResult({ok,...details});}
    catch (_) {exitCode=1;}
    // app.exit deliberately skips before-quit/close handlers. Do not destroy
    // windows first: window-all-closed could otherwise initiate graceful quit
    // and display a save confirmation for an already-broken test renderer.
    app.exit(exitCode);
  };
}

function rejectUnexpectedDialogs(dialog,finish) {
  const fail=args=>{
    const options=args[args.length-1] || {};
    finish(false,{stage:'unexpected-dialog',dialog:{title:options.title,message:options.message,detail:options.detail}});
  };
  dialog.showMessageBox=(...args)=>{fail(args);return Promise.resolve({response:1,checkboxChecked:false});};
  dialog.showMessageBoxSync=(...args)=>{fail(args);return 1;};
  dialog.showErrorBox=(title,message)=>{fail([{title,message}]);};
}

function closeAndVerify(window,verify,finish) {
  window.once('closed',()=>{
    try {finish(true,verify());}
    catch(error) {finish(false,{stage:'graceful-close-save',error:error.stack || String(error)});}
  });
  // Exercise the real close interception and renderer flush handshake. The
  // success result is unavailable until that handshake has closed the window.
  window.close();
}

module.exports={createSmokeTerminator,rejectUnexpectedDialogs,closeAndVerify};
