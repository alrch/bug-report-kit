import {createKitLoadingUI} from './loading-ui.js';

// The heavy script has no embed attributes: a removed/late request cannot auto-init.
export function init(options = {}, nonce = '', {exclusive = false} = {}) {
  const previous = window.BugReportKitLoader?.instance;
  if (previous && !previous.destroyed) {
    if (exclusive) throw new Error('Kit loader is already owned by another integration');
    return previous;
  }
  if (exclusive && window.BugReportKit?.instance) throw new Error('Kit SDK is already owned by another integration');
  const base = (options.serverUrl || location.origin).replace(/\/$/, '');
  let generation = 0, script = null, ui = null, owned = null, rejectReady = null, onBodyReady = null;
  const instance = {destroyed:false, ready:null, retry() {if (!onBodyReady && document.body) start();}, destroy() {
    if (instance.destroyed) return;
    instance.destroyed = true; ++generation;
    rejectReady?.(new Error('Kit loader disposed')); rejectReady = null;
    script?.remove(); script = null; ui?.dispose(); ui = null;
    owned?.destroy(); owned = null;
    window.removeEventListener('pagehide', onPageHide);
    if (onBodyReady) document.removeEventListener('DOMContentLoaded', onBodyReady);
    if (window.BugReportKitLoader?.instance === instance) delete window.BugReportKitLoader.instance;
  }};
  const onPageHide = event => {if (!event.persisted) instance.destroy();};
  window.addEventListener('pagehide', onPageHide);
  window.BugReportKitLoader ??= {init};
  window.BugReportKitLoader.instance = instance;
  function start() {
    if (instance.destroyed) return;
    const run = ++generation;
    rejectReady?.(new Error('Kit loader retry')); rejectReady = null;
    script?.remove(); script = null; ui?.dispose(); ui = null;
    owned?.destroy(); owned = null;
    if (window.BugReportKit?.instance) {
      instance.ready = exclusive
        ? Promise.reject(new Error('Kit SDK is already owned by another integration'))
        : Promise.resolve(window.BugReportKit.instance);
      instance.ready.catch(() => {});
      return;
    }
    instance.ready = new Promise((resolve, reject) => {
      rejectReady = reject;
      const fail = error => {
        if (run !== generation || instance.destroyed) return;
        ++generation; script?.remove(); script = null;
        owned?.destroy(); owned = null;
        ui?.fail(); rejectReady = null; reject(error);
      };
      ui = createKitLoadingUI({onRetry:start, onTimeout:() => fail(new Error('Kit loader timeout'))});
      ui.watchSdk(base);
      const mount = async () => {
        if (run !== generation || instance.destroyed) return;
        try {
          // An independently embedded SDK may have become ready in the meantime.
          if (window.BugReportKit?.instance) {
            if (exclusive) throw new Error('Kit SDK is already owned by another integration');
            ui.dispose(); ui = null; resolve(window.BugReportKit.instance); return;
          }
          if (!window.BugReportKit?.init) throw new Error('Kit SDK missing');
          const before = new Set(document.querySelectorAll('[data-bug-report-kit]'));
          owned = window.BugReportKit.init({...options, serverUrl:base});
          window.BugReportKit.instance = owned;
          const host = [...document.querySelectorAll('[data-bug-report-kit]')].find(el => !before.has(el));
          await ui.ready(host);
          if (run !== generation || instance.destroyed) return;
          ui = null; rejectReady = null; resolve(owned);
        } catch (error) { fail(error); }
      };
      if (window.BugReportKit?.init) { void mount(); return; }
      script = document.createElement('script');
      script.src = base + '/widget.js'; script.async = true;
      if (nonce) script.nonce = nonce;
      script.onload = () => { void mount(); };
      script.onerror = () => fail(new Error('Kit SDK unavailable'));
      document.head.append(script);
    });
    // Embeds do not need to attach a rejection handler; API consumers still can.
    instance.ready.catch(() => {});
  }
  if (document.body) start();
  else {
    instance.ready = new Promise((resolve,reject) => {
      rejectReady = reject;
      onBodyReady = () => {
        if (instance.destroyed) return;
        onBodyReady = null;
        rejectReady = null; start(); instance.ready.then(resolve,reject);
      };
      document.addEventListener('DOMContentLoaded', onBodyReady, {once:true});
    });
    instance.ready.catch(() => {});
  }
  return instance;
}
