'use strict';
const {performance} = require('perf_hooks');

// Observers only: no window policy, save scheduling, or tagging decisions change.
function createUiDiagnostics({enabled,log,getState,now=()=>performance.now(),wall=()=>Date.now(),
  timers={setInterval,clearInterval}}) {
  let window, timer, previous=now(), sampled=now(), phase='idle', phaseCounts={}, work={}, lastStatus={}, stopped=false;
  const session=`ui-${wall()}-${process.pid}`;
  let commits=0, maxCommitMs=0, slowCommits=0, lastCommit=null, lastSlowLog=-Infinity;
  const removers=[];
  function emit(level,message,data={}) { try { log[level](message,{session,...data}); } catch (_) {} }
  function windowState() {
    const result={};
    for(const [key,method] of [['focused','isFocused'],['visible','isVisible'],['minimized','isMinimized']]) {
      try { result[key]=typeof window?.[method]==='function'?window[method]():null; } catch (_) { result[key]=null; }
    }
    return result;
  }
  function sample(event,extra={}) {
    let state={};try { state=getState(); } catch (_) {}
    emit('info','UI diagnostics backend sample',{event,phase,phaseCounts,work,lastStatus,...windowState(),...state,
      commits,slowCommits,maxCommitMs:Math.round(maxCommitMs),lastCommit,...extra});
    commits=0;slowCommits=0;maxCommitMs=0;sampled=now();
  }
  function stop() {
    if(stopped)return;stopped=true;
    if(timer)timers.clearInterval(timer);
    removers.splice(0).forEach(remove=>remove());
  }
  return {
    config:()=>({enabled:Boolean(enabled),session:enabled?session:null}),
    activity(value) { if(enabled)work=value; },
    phase(name,counts={}) { if(!enabled)return;phase=name;phaseCounts=counts;sample('tagging-phase'); },
    status(value) { if(enabled)lastStatus={action:value.action,current:value.numCurrent,total:value.numTotal,
      waiting:Boolean(value.capacityWait),cancelRequested:Boolean(value.cancelRequested)}; },
    beginCommit() { return enabled?now():null; },
    endCommit(start,{revision,committed,changedAddresses,queueLength,failed=false}) {
      if(!enabled||start===null)return undefined;
      const durationMs=Math.round(now()-start),savedAt=wall();
      commits++;maxCommitMs=Math.max(maxCommitMs,durationMs);if(durationMs>=250)slowCommits++;
      lastCommit={revision,committed,changedAddresses,queueLength,durationMs,failed};
      if(durationMs>=1000 && now()-lastSlowLog>=10000) {
        emit('warn','UI diagnostics slow library commit',lastCommit);lastSlowLog=now();
      }
      return {session,savedAt,commitMs:durationMs};
    },
    attach(win,powerMonitor) {
      if(!enabled||timer)return;
      window=win;
      for(const name of ['focus','blur','show','hide','minimize','restore','unresponsive','responsive']) {
        const handler=()=>sample('window-'+name);win.on(name,handler);removers.push(()=>win.removeListener(name,handler));
      }
      if(powerMonitor)for(const name of ['suspend','resume','lock-screen','unlock-screen']) {
        const handler=()=>sample('system-'+name);powerMonitor.on(name,handler);
        removers.push(()=>powerMonitor.removeListener(name,handler));
      }
      const closed=()=>stop();win.once('closed',closed);removers.push(()=>win.removeListener('closed',closed));
      emit('info','UI diagnostics enabled',{electron:process.versions.electron,chromium:process.versions.chrome,
        backgroundThrottling:win.webContents.getLastWebPreferences?.().backgroundThrottling ?? true});
      previous=now();sampled=previous;
      timer=timers.setInterval(()=>{
        const current=now(),gapMs=current-previous;previous=current;
        if(gapMs>2500)emit('warn','UI diagnostics backend timer delayed',{gapMs:Math.round(gapMs),phase,...windowState()});
        if(current-sampled>=10000)sample('periodic');
      },1000);
      timer.unref?.();sample('window-attached');
    },stop
  };
}
module.exports={createUiDiagnostics};
