// Self-contained: the review page inlines this function before the heavy SDK.
export function createKitLoadingUI({onRetry = () => {}, onTimeout = () => {}, timeoutMs = 15000} = {}) {
  const previous = document.querySelector('[data-rr-kit-loading]');
  const host = document.createElement('div');
  if(previous)host.style.display='none';
  host.dataset.rrKitLoading = ''; host.dataset.bugReportUi = ''; host.dataset.html2canvasIgnore = 'true';
  const root = host.attachShadow({mode:'open'});
  root.innerHTML = `<style>:host{position:fixed;z-index:2147483646;display:block;width:40px;height:40px;transform-origin:0 0;pointer-events:none}button{box-sizing:border-box;width:40px;height:40px;padding:9px;border:1px solid #71809838;border-radius:12px;background:#f5f7fafa;color:#68758a;box-shadow:0 2px 8px #17203310;position:relative;cursor:wait;pointer-events:auto}button:focus-visible{outline:2px solid #2047d9;outline-offset:3px}svg{width:20px;height:20px;display:block;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}.spinner{position:absolute;inset:2px;border:2px solid transparent;border-top-color:#2047d9;border-radius:50%;animation:turn 1s linear infinite}.message{position:absolute;right:0;top:48px;width:240px;box-sizing:border-box;padding:10px 12px;font:14px/1.4 system-ui;background:white;border:1px solid #d8e0ec;border-radius:10px;color:#172033;box-shadow:0 3px 12px #17203320;pointer-events:auto}.message[hidden]{display:none}:host([data-error]) button{cursor:pointer;color:#b72424}:host([data-error]) .spinner{display:none}@keyframes turn{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.spinner{animation-duration:3s}}</style><button type="button" aria-label="Ловитель загружается" aria-disabled="true"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 3 1 2m5-2-1 2M8 9a4 4 0 0 1 8 0v6a4 4 0 0 1-8 0V9Zm0 2h8m-4 0v8M5 8l3 2m8 0 3-2M4 14h4m8 0h4M5 20l3-3m8 0 3 3"/></svg><span class="spinner" aria-hidden="true"></span></button><span class="message" role="status" hidden>Ловитель загружается…</span>`;
  const button = root.querySelector('button'), message = root.querySelector('.message');
  let disposed = false, failed = false, frame = 0, observer = null, handedOff = null, expectedCss = '';
  const restore = () => {for(const [el,item] of tracked)el.style.visibility=item.visibility;};
  const tracked = new Map(), baseline = new Set(document.querySelectorAll('[data-bug-report-kit]'));
  const viewport = window.visualViewport;
  function place() {
    if (disposed) return;
    const v = window.visualViewport, scale = v?.scale || 1, size = 40 / scale, gap = 10 / scale;
    const left = v?.offsetLeft || 0, top = v?.offsetTop || 0, width = v?.width || innerWidth, height = v?.height || innerHeight;
    const targets = [...document.querySelectorAll('button,a[href],input:not([type="hidden"]),textarea,select,[role="button"],[role="tab"],[aria-modal="true"]')]
      .filter(el => !el.closest('[data-bug-report-kit],[data-bug-report-ui]')).map(el=>el.getBoundingClientRect());
    let x = Math.max(left,left+width-size-20/scale), y = top+16/scale, found = false;
    for (let row=0;row<5&&!found;row++) for(let column=0;column<5&&!found;column++) {
      const xx=left+width-size-20/scale-column*(size+gap), yy=top+16/scale+row*(size+gap);
      if(xx<left+gap||yy+size>top+height-gap)continue;
      if(targets.every(r=>!r.width||!r.height||xx+size+gap<=r.left||xx>=r.right+gap||yy+size+gap<=r.top||yy>=r.bottom+gap)){x=xx;y=yy;found=true;}
    }
    Object.assign(host.style,{left:`${x}px`,top:`${y}px`,transform:`scale(${1/scale})`});
    message.style.right = x-left < 120/scale ? 'auto' : '0'; message.style.left = x-left < 120/scale ? '0' : 'auto';
  }
  const schedule = () => {cancelAnimationFrame(frame);frame=requestAnimationFrame(place);};
  window.addEventListener('resize',schedule);window.addEventListener('scroll',schedule,true);
  viewport?.addEventListener('resize',schedule);viewport?.addEventListener('scroll',schedule);
  function fail(text='Ловитель недоступен. Нажмите жука, чтобы повторить.') {
    if(disposed)return;failed=true;clearTimeout(deadline);observer?.disconnect();for(const item of tracked.values())item.cancel();restore();host.dataset.error='';host.setAttribute('aria-busy','false');
    button.setAttribute('aria-label','Повторить загрузку ловителя');button.removeAttribute('aria-disabled');message.textContent=text;message.hidden=false;
  }
  button.onclick=()=>{if(failed)onRetry();else {message.textContent='Ловитель загружается…';message.hidden=false;}};
  host.setAttribute('aria-busy','true');document.body.append(host);place();
  const deadline=setTimeout(()=>{fail('Ловитель загружается слишком долго. Нажмите жука, чтобы повторить.');onTimeout();},timeoutMs);
  function track(element,force=false) {
    if((!force&&baseline.has(element))||tracked.has(element))return;
    const link=element.shadowRoot?.querySelector('link[rel="stylesheet"]');
    if(!force && (!link || link.href!==expectedCss))return;
    const visibility=element.style.visibility;element.style.visibility='hidden';
    let cleanup=()=>{},cancel=()=>{};
    const promise=new Promise((resolve,reject)=>{
      if(!link){reject(new Error('Kit stylesheet missing'));return;}
      if(link.sheet){resolve();return;}
      cancel=()=>{cleanup();reject(new Error('Kit stylesheet cancelled'));};
      const timer=setTimeout(()=>{cleanup();reject(new Error('Kit stylesheet timeout'));},timeoutMs);
      const loaded=()=>{cleanup();resolve();},error=()=>{cleanup();reject(new Error('Kit stylesheet unavailable'));};
      cleanup=()=>{clearTimeout(timer);link.removeEventListener('load',loaded);link.removeEventListener('error',error);};
      link.addEventListener('load',loaded);link.addEventListener('error',error);
    });
    promise.catch(()=>{});tracked.set(element,{visibility,promise,cleanup,cancel});
  }
  return {
    host,fail,
    watchSdk(serverUrl) {
      expectedCss=new URL(serverUrl+'/widget.css',location.href).href;
      observer?.disconnect();
      observer=new MutationObserver(()=>{for(const el of document.querySelectorAll('[data-bug-report-kit]'))track(el);});
      observer.observe(document.body,{childList:true});
    },
    async ready(element) {
      if(handedOff===element && element)return;
      if(disposed)throw new Error('Kit loader disposed');
      if(!element)throw new Error('Kit launcher missing');track(element,true);
      const state=tracked.get(element);
      if(state)await state.promise;
      // The SDK chooses its own collision-free position. Reveal it in one frame.
      if(!disposed){const rect=element.shadowRoot?.querySelector('.launcher')?.getBoundingClientRect();if(rect)Object.assign(host.style,{left:`${rect.left}px`,top:`${rect.top}px`});}
      if(state)element.style.visibility=state.visibility;
      handedOff=element;this.dispose();
    },
    dispose() {
      if(disposed)return;disposed=true;clearTimeout(deadline);cancelAnimationFrame(frame);observer?.disconnect();restore();host.remove();
      const next=document.querySelector('[data-rr-kit-loading]');if(next)next.style.display='';
      window.removeEventListener('resize',schedule);window.removeEventListener('scroll',schedule,true);
      viewport?.removeEventListener('resize',schedule);viewport?.removeEventListener('scroll',schedule);
      for(const item of tracked.values())item.cancel();
    },
  };
}
