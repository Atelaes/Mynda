'use strict';

function createUiDiagnostics({api,log,window,document,getState,now=()=>performance.now(),wall=()=>Date.now()}) {
  let enabled=false,disposed=false,session=null,timer=null,frame=null,previous=0,sampled=0;
  let lastFrame=null,lastEllipsis=null,lastStatus=null,lastReceived=null,lastApplied=null,lastRendered=null;
  let renderSequence=0,frameObservedRenderSequence=0,frames=0,renders=0,deliveries=0,maxDeliveryMs=0;
  let maxTransitMs=0,maxQueueMs=0,ellipsisTicks=0,latestTimerGapMs=0,maxTimerGapMs=0;
  let maxFrameGapMs=0,maxEllipsisGapMs=0;
  const removers=[];
  function visibility() { return {visibility:document.visibilityState,focused:document.hasFocus?.() ?? null}; }
  function emit(level,message,data) { try { log[level](message,{session,...visibility(),...data}); } catch (_) {} }
  function sample(event,extra={}) {
    if(!enabled)return;
    const time=now();let state={};try { state=getState(); } catch (_) {}
    emit('info','UI diagnostics renderer sample',{event,...state,frames,renders,deliveries,ellipsisTicks,
      lastStatus,lastReceived,lastApplied,lastRendered,renderSequence,frameObservedRenderSequence,
      frameAgeMs:lastFrame===null?null:Math.round(time-lastFrame),
      ellipsisAgeMs:lastEllipsis===null?null:Math.round(time-lastEllipsis),
      maxDeliveryMs:Math.round(maxDeliveryMs),maxTransitMs:Math.round(maxTransitMs),maxQueueMs:Math.round(maxQueueMs),
      latestTimerGapMs:Math.round(latestTimerGapMs),maxTimerGapMs:Math.round(maxTimerGapMs),
      maxFrameGapMs:Math.round(maxFrameGapMs),maxEllipsisGapMs:Math.round(maxEllipsisGapMs),...extra});
    sampled=time;frames=0;renders=0;deliveries=0;ellipsisTicks=0;
    maxDeliveryMs=0;maxTransitMs=0;maxQueueMs=0;maxTimerGapMs=0;maxFrameGapMs=0;maxEllipsisGapMs=0;
  }
  function onFrame() {
    if(!enabled)return;
    const time=now();if(lastFrame!==null)maxFrameGapMs=Math.max(maxFrameGapMs,time-lastFrame);
    lastFrame=time;frames++;frameObservedRenderSequence=renderSequence;
    frame=window.requestAnimationFrame(onFrame);
  }
  function stop() {
    disposed=true;enabled=false;
    if(timer!==null)window.clearInterval(timer);
    if(frame!==null)window.cancelAnimationFrame(frame);
    removers.splice(0).forEach(remove=>remove());
  }
  return {
    isEnabled:()=>enabled,
    async start() {
      if(!api?.getConfig || enabled || disposed)return;
      let config;try { config=await api.getConfig(); } catch (_) { return; }
      if(!config?.enabled||disposed)return;
      enabled=true;session=config.session;previous=now();sampled=previous;
      for(const [target,name] of [[document,'visibilitychange'],[window,'focus'],[window,'blur'],[window,'pagehide']]) {
        const handler=()=>{sample(name);if(name==='pagehide')stop();};
        target.addEventListener(name,handler);removers.push(()=>target.removeEventListener(name,handler));
      }
      timer=window.setInterval(()=>{
        const time=now();latestTimerGapMs=time-previous;previous=time;maxTimerGapMs=Math.max(maxTimerGapMs,latestTimerGapMs);
        if(latestTimerGapMs>2500)emit('warn','UI diagnostics renderer timer delayed',{
          gapMs:Math.round(latestTimerGapMs),lastReceived,lastApplied,renderSequence,frameObservedRenderSequence});
        if(time-sampled>=10000)sample('periodic');
      },1000);
      frame=window.requestAnimationFrame(onFrame);sample('started');
    },stop,
    status(value) { if(enabled)lastStatus={action:value.action,current:value.numCurrent,total:value.numTotal,
      waiting:Boolean(value.capacityWait),cancelRequested:Boolean(value.cancelRequested)}; },
    ellipsis() { if(enabled){const time=now();if(lastEllipsis!==null)maxEllipsisGapMs=Math.max(maxEllipsisGapMs,time-lastEllipsis);lastEllipsis=time;ellipsisTicks++;} },
    receive(message) {
      if(!enabled)return null;
      const received=now();lastReceived={revision:message?.revision,at:wall()};
      if(message?.diagnostics?.session===session && Number.isFinite(message.diagnostics.savedAt))
        maxTransitMs=Math.max(maxTransitMs,Math.max(0,wall()-message.diagnostics.savedAt));
      return received;
    },
    beginDelivery(received) { if(!enabled)return null;const time=now();if(received!==null)maxQueueMs=Math.max(maxQueueMs,time-received);return time; },
    applied(start,revision) { if(enabled&&start!==null){deliveries++;maxDeliveryMs=Math.max(maxDeliveryMs,now()-start);lastApplied={revision,at:wall()};} },
    rendered(value) { if(enabled){renders++;renderSequence++;lastRendered={...value,at:wall()};} }
  };
}
module.exports={createUiDiagnostics};
