// Copied beside the disposable renderer only by the native test runner.
// An ordinary allowed script tests eval under page CSP. Testing eval directly
// from executeJavaScript can inherit the inspector's policy bypass instead.
(() => {
  let evalBlocked = false;
  try { window.eval('1 + 1'); } catch (error) { evalBlocked = error instanceof EvalError; }
  window.__myndaScriptPolicyResult = {evalBlocked};
})();
