// One terminal notification for both whole-library and selected Auto-Tag.
// A per-video catalog miss is handled by the runner and does not reach here.
function causes(error) {
  const result=[],seen=new Set();
  for(let item=error;item && result.length<8 && !seen.has(item);item=item.cause) {
    seen.add(item);result.push(item);
  }
  return result;
}

function describeFailure(error, libraryPath) {
  const chain=causes(error);
  const context=chain.find(item=>item.autoTagFailure)?.autoTagFailure;
  const saveFailed=context && context.stage==='save';
  const location=chain.find(item=>typeof item.libraryPath==='string')?.libraryPath || libraryPath;
  const known=new Set(['ENOSPC','EDQUOT','EACCES','EPERM','EROFS','ENOENT','ENODEV','ENXIO','EIO']);
  const code=chain.find(item=>known.has(item.code))?.code || chain.find(item=>item.code)?.code;
  let message='Auto-Tag stopped because an unexpected error occurred.';
  let action='Try Auto-Tag again. If it stops again, check the application logs for details.';
  if(saveFailed) {
    message=context.committed ? 'Auto-Tag stopped after saving, while finishing the library update.' :
      'Auto-Tag stopped because its results could not be saved.';
    action=context.committed ? 'The last batch was saved. Restart Mynda to reload the saved library before continuing.' :
      'Check that the library folder is available and writable, then run Auto-Tag again.';
  }
  if(context && context.committed) {
    // A later IPC/callback error must not relabel an already completed save
    // as an unsaved batch, even when that later error has a storage code.
  } else if(code==='ENOSPC') {
    message=saveFailed ? 'Auto-Tag stopped because the drive containing your Mynda library is out of space.' :
      'Auto-Tag stopped because a disk write ran out of space.';
    action=saveFailed ? 'Free space on the drive containing the library file below, then run Auto-Tag again.' :
      'Free space on the affected drive, then run Auto-Tag again.';
  } else if(code==='EDQUOT') {
    message='Auto-Tag stopped because the storage quota was reached.';
    action='Free space or increase the storage quota for the library folder, then run Auto-Tag again.';
  } else if(saveFailed && ['EACCES','EPERM'].includes(code)) {
    message='Auto-Tag stopped because Mynda does not have permission to save the library.';
  } else if(saveFailed && code==='EROFS') {
    message='Auto-Tag stopped because the drive containing the library is read-only.';
  } else if(saveFailed && ['ENOENT','ENODEV','ENXIO'].includes(code)) {
    message='Auto-Tag stopped because the library folder or its drive is unavailable.';
  }
  const details=[action];
  if(saveFailed && location) details.push(`Library file:\n${location}`);
  if(saveFailed && !context.committed) {
    const count=context.videoCount;
    details.push(Number.isInteger(count) && count>0 ?
      `The last ${count===1?'video was':count+' videos were'} not saved. Earlier saved results are unchanged. The affected videos retain their previous tags and Auto-Tag status.` :
      'The last batch was not saved. Earlier saved results are unchanged.');
  }
  if(code) details.push(`Error code: ${String(code).slice(0,80)}`);
  return {code,location,context,options:{type:'error',buttons:['OK'],defaultId:0,cancelId:0,
    title:'Auto-Tag stopped',message,detail:details.join('\n\n')}};
}

function createFailureReporter({dialog,log,getLibraryPath,getWindow}) {
  const record=(message,details)=>{try {log.error(message,details);}catch(error) { /* The log drive may also be full. */ }};
  return async function reportFailure(error,scope='library') {
    const failure=describeFailure(error,getLibraryPath());
    record('Automatic tagging stopped after an error',{scope,code:failure.code,libraryPath:failure.location,
      ...failure.context,causes:causes(error).map(item=>({code:item.code,
        message:String(item.message || item).slice(0,600),stack:item.stack && item.stack.slice(0,2000)}))});
    try {
      const parent=getWindow && getWindow();
      if(parent) await dialog.showMessageBox(parent,failure.options);
      else await dialog.showMessageBox(failure.options);
    } catch(dialogError) {
      record('Could not display the Auto-Tag failure dialog',{error:String(dialogError)});
      // The notification must not become another unhandled promise rejection.
      try {dialog.showErrorBox(failure.options.title,failure.options.message+'\n\n'+failure.options.detail);}
      catch(fallbackError) {record('Could not display the fallback Auto-Tag error',{error:String(fallbackError)});}
    }
  };
}

module.exports={describeFailure,createFailureReporter};
