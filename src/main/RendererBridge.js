'use strict';

function invalid(message) { return Object.assign(new Error(message), {code:'INVALID_APP_REQUEST'}); }
// Bound work before recursively processing an IPC value. IPC already clones
// payloads, but that is not schema validation or authorization.
function validatePayload(value, {maxNodes=200000, maxText=16*1024*1024, maxDepth=40}={}) {
  let nodes=0, text=0;
  const seen=new Set();
  function visit(item, depth) {
    if (++nodes>maxNodes || depth>maxDepth) throw invalid('The request is too large or deeply nested.');
    if (item === null || item === undefined || typeof item === 'boolean') return;
    if (typeof item === 'string') { text+=item.length; if (text>maxText) throw invalid('The request contains too much text.'); return; }
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || seen.has(item)) throw invalid('The request must contain ordinary, acyclic data.');
    if (!Array.isArray(item) && Object.getPrototypeOf(item)!==Object.prototype && Object.getPrototypeOf(item)!==null) throw invalid('Unsupported request value.');
    seen.add(item);
    for (const [key, child] of Object.entries(item)) {
      if (['__proto__','prototype','constructor'].includes(key)) throw invalid('Unsafe request property.');
      visit(key,depth+1); visit(child,depth+1);
    }
    seen.delete(item);
  }
  visit(value,0);
}

function installRendererBridge({ipcMain, isTrustedSender, methods, log}) {
  ipcMain.handle('mynda:invoke', async (event, method, args) => {
    try {
      if (!isTrustedSender(event)) throw Object.assign(new Error('This request is not from the Mynda application window.'), {code:'APP_UNAUTHORIZED'});
      if (typeof method!=='string' || !Object.prototype.hasOwnProperty.call(methods,method) || !Array.isArray(args) || args.length>4) throw invalid('Unknown application operation.');
      validatePayload(args);
      return {ok:true, value:await methods[method](event,...args)};
    } catch (error) {
      if (log) log.warn('Application request failed', {method:typeof method==='string'?method.slice(0,100):null,error});
      return {ok:false,error:{code:error.code || 'APP_REQUEST_FAILED',message:error.message || 'Mynda could not complete this request.'}};
    }
  });
}
module.exports={installRendererBridge,validatePayload,invalid};
