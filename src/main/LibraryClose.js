const {v4:uuidv4} = require('uuid');

// Closing waits for already-requested edits, never an entire scan or tagging
// lookup. The renderer flushes deferred saves; main drains the commit queue.
function installLibraryClose({app,ipcMain,dialog,library,getWindow,log,
  timeoutMs=15000,setTimer=setTimeout,clearTimer=clearTimeout}) {
  let closing=false,permitted=false,quitRequested=false,pending=null,activeToken=null;

  function cancelClosing() {
    closing=false;quitRequested=false;pending=null;
    library.resumeWrites();
    const window=getWindow();
    try {
      if (window && !window.isDestroyed() && window.webContents && !window.webContents.isDestroyed()) {
        window.webContents.send('library:close-canceled',{token:activeToken});
      }
    } catch(error) {if(log) log.warn('Could not notify interface that closing was canceled',{error});}
    activeToken=null;
  }

  ipcMain.handle('library:close-ready', (event,reply) => {
    const waiting=pending;
    if (!waiting || !reply || reply.token!==waiting.token || event.sender!==waiting.sender) return {accepted:false};
    pending=null;
    if (reply.error) waiting.reject(new Error(typeof reply.error==='string' ? reply.error : reply.error.message || 'A pending edit could not be saved.'));
    else waiting.resolve();
    return {accepted:true};
  });

  async function prepareRenderer(window) {
    if (!window || window.isDestroyed() || !window.webContents || window.webContents.isDestroyed()) {
      throw new Error('The interface is unavailable, so pending interface saves could not be confirmed.');
    }
    const token=uuidv4();
    activeToken=token;
    await new Promise((resolve,reject) => {
      const timer=setTimer(() => {
        if (pending && pending.token===token) pending=null;
        reject(new Error('The interface has not confirmed that its pending edits were saved.'));
      },timeoutMs);
      const settle=fn=>value=>{clearTimer(timer);fn(value);};
      pending={token,sender:window.webContents,resolve:settle(resolve),reject:settle(reject)};
      try {window.webContents.send('library:prepare-close',{token});}
      catch(error) {pending=null;clearTimer(timer);reject(error);}
    });
  }

  async function requestClose(quit) {
    quitRequested=quitRequested || quit;
    if (closing || permitted) return;
    closing=true;
    library.stopBackgroundWrites();
    while (closing) {
      try {
        await prepareRenderer(getWindow());
        await library.whenIdle();
        permitted=true;
        closing=false;
        if (quitRequested) app.quit();
        else {
          const window=getWindow();
          if (window && !window.isDestroyed()) window.close();
          else app.quit();
        }
      } catch(error) {
        if (log) log.warn('Waiting for library saves before closing', {error});
        let choice;
        try {
          choice=await dialog.showMessageBox({type:'warning',title:'Pending Library Saves',
            message:'Mynda has not confirmed that all pending changes were saved.',
            detail:`${error.message}\n\nWait to try again, cancel closing, or quit and discard any changes that have not been saved.`,
            buttons:['Wait','Cancel Closing','Quit Without Saving'],defaultId:0,cancelId:1,noLink:true});
        } catch(dialogError) {
          if (log) log.error('Could not display pending-save confirmation; closing canceled', {error:dialogError});
          choice={response:1};
        }
        if (choice.response===0) continue;
        pending=null;
        closing=false;
        if (choice.response===2) {permitted=true;app.quit();}
        else cancelClosing();
      }
    }
  }

  const intercept=(event,quit)=>{
    if (permitted) return;
    event.preventDefault();
    requestClose(quit).catch(error=>{
      cancelClosing();
      if (log) log.error('Could not finish library shutdown; closing canceled',{error});
    });
  };
  app.on('before-quit',event=>intercept(event,true));
  return {attachWindow:window=>window.on('close',event=>intercept(event,false)),
    isClosing:()=>closing};
}

module.exports={installLibraryClose};
