const MAX_BYTES = 5 * 1024 * 1024;
const MAX_SECONDS = 120;
export function voiceInput({enabled = false, onChange = () => {}, onReady = () => {}, onError = () => {}, onClear = () => {}} = {}) {
  const element = document.createElement('section'); element.className = 'voice-input';
  if (enabled !== true) return {element, value:()=>null, busy:()=>false,
    finish:async()=>null, setDisabled() {}, dispose() {}};
  element.setAttribute('role','group'); element.setAttribute('aria-label','Голосовое описание');
  const record = document.createElement('button'); record.type = 'button'; record.className = 'voice-record';
  const micIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/></svg>';
  const stopIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>';
  const recordLabel = label => {
    const recording = label === 'Остановить запись';
    record.setAttribute('aria-label',label); record.title = label;
    record.setAttribute('aria-pressed',String(recording));
    record.classList.toggle('is-recording',recording);
    record.innerHTML = recording ? stopIcon : micIcon;
  };
  recordLabel('Записать голос');
  const remove = document.createElement('button'); remove.type = 'button'; remove.hidden = true;
  remove.setAttribute('aria-label','Удалить запись'); remove.title = 'Удалить запись';
  remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
  const preview = document.createElement('audio'); preview.controls = true; preview.hidden = true; preview.setAttribute('aria-label', 'Прослушать запись');
  const idleStatus = 'Голосом · до 2 мин';
  const status = document.createElement('p'); status.className = 'meta voice-status'; status.setAttribute('role', 'status'); status.id = 'bug-kit-voice-status'; status.textContent = idleStatus;
  record.setAttribute('aria-describedby',status.id);
  const controls = document.createElement('div'); controls.className = 'voice-controls';
  controls.append(record, status, remove); element.append(controls, preview);
  let recorder, stream, timer, watchdog, chunks = [], bytes = 0, data = null, url = '', disposed = false, pending = false, reading = false, disabled = false;
  let completion = null, completionError = null, complete = () => {}, finishRequested = false;
  const supports = window.isSecureContext && navigator.mediaDevices?.getUserMedia && window.MediaRecorder;
  if (!supports) {record.disabled = true; status.textContent = 'Запись недоступна в этом браузере. Введите текст или используйте диктовку клавиатуры.';}
  const stopTracks = () => {stream?.getTracks().forEach(track => track.stop()); stream = null;};
  const clearTimers = () => {clearInterval(timer); clearTimeout(watchdog);};
  const reset = () => {
    data = null; if (url) URL.revokeObjectURL(url); url = ''; preview.removeAttribute('src'); preview.hidden = true; remove.hidden = true;
  };
  const stop = () => {if (recorder?.state === 'recording') {reading = true; recorder.stop();} clearTimers(); stopTracks(); onChange();};
  const onPageHide = () => stop();
  window.addEventListener('pagehide', onPageHide);
  remove.onclick = () => {if (!disabled) {reset(); recordLabel('Записать голос'); status.textContent = idleStatus; onClear(); onChange();}};
  record.onclick = async () => {
    if (disabled || pending || reading) return;
    if (recorder?.state === 'recording') {stop(); return;}
    pending = true; onChange(); record.disabled = true; status.textContent = 'Разрешите доступ к микрофону';
    completionError = null; finishRequested = false;
    // Resolve rather than reject here: only finish() consumes errors; ordinary
    // stop/re-record must never create an unhandled rejected promise.
    completion = new Promise(resolve => {
      let settled = false;
      complete = error => {if (settled) return; settled = true; completionError = error || null; resolve();};
    });
    try {
      const next = await navigator.mediaDevices.getUserMedia({audio:true});
      if (disposed) {next.getTracks().forEach(t=>t.stop()); complete(new Error('Запись отменена')); return;}
      stream = next;
      const mime = ['audio/webm;codecs=opus','audio/mp4','audio/ogg;codecs=opus','audio/webm'].find(type => MediaRecorder.isTypeSupported(type));
      if (!mime) throw new Error('Формат записи не поддерживается. Используйте текст или диктовку клавиатуры.');
      recorder = new MediaRecorder(stream, {mimeType:mime, audioBitsPerSecond:48000});
      chunks = []; bytes = 0;
      let failure = null;
      recorder.ondataavailable = event => {
        if (!event.data.size || failure) return;
        bytes += event.data.size;
        if (bytes > MAX_BYTES) {failure = new Error('Запись больше 5 МБ. Запишите короче.'); status.textContent = failure.message; stop(); return;}
        chunks.push(event.data);
      };
      recorder.onerror = () => {failure = new Error('Запись прервалась. Попробуйте ещё раз.'); status.textContent = failure.message; stop();};
      recorder.onstop = async () => {
        clearTimers(); stopTracks(); reading = true;
        recordLabel('Записать голос'); record.disabled = true;
        try {
          if (disposed) throw new Error('Запись отменена');
          if (failure) throw failure;
          // onstop follows the final dataavailable, including a short recording
          // stopped before its first timeslice. Finish only after FileReader.
          const blob = new Blob(chunks, {type:mime.split(';')[0]});
          if (!blob.size) throw new Error('Микрофон не вернул звук. Попробуйте ещё раз.');
          const result = await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result));r.onerror=()=>reject(new Error('Не удалось прочитать запись'));r.readAsDataURL(blob);});
          if (disposed) throw new Error('Запись отменена');
          reset(); data = result; url = URL.createObjectURL(blob); preview.src = url; preview.hidden = false; remove.hidden = false;
          recordLabel('Перезаписать голос'); status.textContent = 'Запись готова. Можно прослушать.';
        } catch (error) {failure = error; status.textContent = error.message || 'Не удалось прочитать запись';}
        finally {
          reading = false;
          if (!disposed && data) {preview.hidden = false; remove.hidden = false; recordLabel('Перезаписать голос');}
          record.disabled = disabled || disposed;
          complete(failure);
          if (!disposed) {if (failure) onError(failure); else onReady(data); onChange();}
        }
      };
      recorder.onstart = () => {if (finishRequested) stop();};
      recorder.start(1000); remove.hidden = true; preview.hidden = true;
      recordLabel('Остановить запись'); record.disabled = disabled; onChange();
      const started = Date.now();
      const tick = () => {const seconds = Math.floor((Date.now()-started)/1000); status.textContent = `Идёт запись: ${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')} / 2:00`;};
      tick(); timer = setInterval(tick, 1000); watchdog = setTimeout(stop, MAX_SECONDS * 1000);
    } catch (error) {
      stopTracks(); status.textContent = error.name === 'NotAllowedError' ? 'Доступ к микрофону не разрешён. Можно ввести текст или включить доступ в настройках браузера.' : error.message || 'Не удалось включить микрофон';
      if (data) {preview.hidden = false; remove.hidden = false;}
      complete(new Error(status.textContent)); onError(new Error(status.textContent));
    } finally {pending = false; record.disabled = disabled || !supports || disposed || reading; onChange();}
  };
  return {
    element, value:()=>data, busy:()=>pending || reading || recorder?.state === 'recording',
    async finish() {
      if (disposed) throw new Error('Запись отменена');
      if (!pending && !reading && recorder?.state !== 'recording') return data;
      finishRequested = true;
      stop();
      await completion;
      if (disposed) throw new Error('Запись отменена');
      if (completionError) throw completionError;
      return data;
    },
    setDisabled(value) {disabled = value; record.disabled = value || !supports || pending || reading || disposed; remove.disabled = value;},
    dispose() {window.removeEventListener('pagehide', onPageHide); disposed = true; clearTimers(); stop(); reset(); complete(new Error('Запись отменена'));},
  };
}
