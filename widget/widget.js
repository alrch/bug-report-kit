import {layoutViewport} from './viewport.js';
import {selectionControls} from './selection.js';
import {voiceInput} from './voice.js';
import {captureViewport, safePageUrl} from './capture.js';
import {openScreenshotPreview} from './preview.js';

const button = (label, className = '') => {
  const node = document.createElement('button');
  node.textContent = label;
  node.className = className;
  node.type = 'button';
  return node;
};

function anonymousReporterId(projectKey) {
  const storageKey = `bug-report-kit:reporter:${projectKey}`;
  try {
    const stored = localStorage.getItem(storageKey);
    if (/^anon:[0-9a-f-]{36}$/i.test(stored || '')) return stored;
  } catch { /* Storage can be disabled by the browser. */ }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const id = `anon:${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  try { localStorage.setItem(storageKey, id); } catch { /* Current page can still use this ID. */ }
  return id;
}

async function compress(canvas) {
  let current = document.createElement('canvas');
  current.width = canvas.width; current.height = canvas.height;
  const opaque = current.getContext('2d');
  opaque.fillStyle = '#fff'; opaque.fillRect(0, 0, current.width, current.height);
  opaque.drawImage(canvas, 0, 0);
  for (let pass = 0; pass < 5; pass++) {
    const url = current.toDataURL('image/jpeg', Math.max(.5, .84 - pass * .08));
    if (url.length - url.indexOf(',') - 1 <= 4 * Math.ceil(2 * 1024 * 1024 / 3)) return url;
    const next = document.createElement('canvas');
    next.width = Math.max(200, Math.round(current.width * .75));
    next.height = Math.max(120, Math.round(current.height * .75));
    next.getContext('2d').drawImage(current, 0, 0, next.width, next.height);
    current = next;
  }
  throw new Error('Снимок слишком большой. Выделите меньшую область.');
}

function init({serverUrl, projectKey, label = 'Сообщить о баге', launcherStyle = '', appVersion = '', captureFetchErrors = false, reporterAuth = false,
  reporterName = '', reporterContact = '', getReporter = null} = {}) {
  if (!serverUrl || !projectKey) throw new Error('Нужны serverUrl и projectKey');
  const base = serverUrl.replace(/\/$/, '');
  let destroyed = false;
  let cancelActiveSelection = null;
  let disposeVoice = () => {};
  const host = document.createElement('div');
  host.dataset.bugReportKit = '';
  document.body.append(host);
  const root = host.attachShadow({mode: 'open'});
  // Form typing and Escape belong to the reporter, not the underlying editor.
  root.addEventListener('keydown', event => event.stopPropagation());
  const syncInteraction = () => host.toggleAttribute('data-bug-report-kit-active',
    Boolean(root.querySelector('.overlay, .backdrop, dialog[open]')));
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = `${base}/widget.css`;
  root.append(css);
  const compactLauncher = launcherStyle === 'compact';
  const launcher = button(compactLauncher ? '' : label, compactLauncher ? 'launcher launcher-compact' : 'launcher');
  if (compactLauncher) {
    launcher.setAttribute('aria-label', label);
    launcher.title = label;
    launcher.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 3 1 2m5-2-1 2M8 9a4 4 0 0 1 8 0v6a4 4 0 0 1-8 0V9Zm0 2h8m-4 0v8M5 8l3 2m8 0 3-2M4 14h4m8 0h4M5 20l3-3m8 0 3 3"/></svg>';
  }
  root.append(launcher);
  let toast = null;
  let toastTimer = null;
  const clearToast = () => {
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = null;
    toast?.remove();
    toast = null;
  };
  const showSuccessToast = () => {
    clearToast();
    toast = document.createElement('div');
    toast.className = 'report-toast';
    toast.setAttribute('role', 'status');
    toast.textContent = 'Баг отправлен';
    root.append(toast);
    toastTimer = setTimeout(clearToast, 5000);
  };
  const recentDiagnostics = [];
  let guestReporterId = '';
  let activeReporter = null;
  let inMemoryReporterToken = '';
  const reporterStorageKey = `bug-report-kit:auth:${projectKey}`;
  const reporterToken = () => { try { return localStorage.getItem(reporterStorageKey) || inMemoryReporterToken; } catch { return inMemoryReporterToken; } };
  const saveReporterToken = (token) => { inMemoryReporterToken = token; try { if (token) localStorage.setItem(reporterStorageKey, token); else localStorage.removeItem(reporterStorageKey); } catch { /* Session still works until this page closes. */ } };
  const addDiagnostic = (item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return;
    recentDiagnostics.push({occurredAt: new Date().toISOString(), ...item});
    if (recentDiagnostics.length > 20) recentDiagnostics.shift();
  };
  const onError = (event) => {
    let source = '';
    try { const url = new URL(event.filename); source = `${url.origin}${url.pathname}`; } catch { /* no source */ }
    addDiagnostic({type: 'error', eventType: 'CLIENT_ERROR', level: 'ERROR',
      message: String(event.message || '').slice(0, 500), source,
      errorName: event.error?.name || '', stack: event.error?.stack || ''});
  };
  const onRejection = (event) => addDiagnostic({type: 'unhandledrejection',
    eventType: 'CLIENT_ERROR', level: 'ERROR',
    message: String(event.reason?.message || event.reason || '').slice(0, 500),
    errorName: event.reason?.name || '', stack: event.reason?.stack || ''});
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  const originalFetch = window.fetch;
  let observedFetch;
  if (captureFetchErrors) {
    const serverOrigin = new URL(base).origin;
    observedFetch = async function(input, options) {
      const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
      let target;
      try { target = new URL(rawUrl, location.href); } catch { /* unknown request target */ }
      const shouldRecord = target && !(target.origin === serverOrigin && target.pathname === '/api/reports');
      const method = String(options?.method || input?.method || 'GET').toUpperCase();
      const started = performance.now();
      try {
        const response = await originalFetch.call(window, input, options);
        if (shouldRecord && response.status >= 400) addDiagnostic({
          eventType: 'CLIENT_REQUEST_ERROR', level: response.status >= 500 ? 'ERROR' : 'WARN',
          message: `${method} ${target.pathname}: HTTP ${response.status}`,
          method, path: target.pathname, statusCode: response.status,
          durationMs: Math.round(performance.now() - started),
          requestId: response.headers.get('x-request-id') || '',
          errorId: response.headers.get('x-error-id') || '',
        });
        return response;
      } catch (error) {
        if (shouldRecord && error?.name !== 'AbortError') addDiagnostic({
          eventType: 'CLIENT_REQUEST_ERROR', level: 'ERROR',
          message: `${method} ${target.pathname}: network error`,
          method, path: target.pathname, errorName: error?.name || '',
          durationMs: Math.round(performance.now() - started),
        });
        throw error;
      }
    };
    window.fetch = observedFetch;
  }

  const collisionGap = 10;
  const targetsSelector = 'button,a[href],input:not([type="hidden"]),textarea,select,[role="button"],[role="tab"],[role="combobox"],[role="link"],[aria-modal="true"]';
  const cornerKey = `bug-report-kit:corner:${base}:${projectKey}`;
  let manualCorner = null;
  try {
    const saved = localStorage.getItem(cornerKey);
    if (['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(saved)) manualCorner = saved;
  } catch { /* Storage may be unavailable. */ }
  let dragState = null;
  let suppressLauncherClick = false;
  let placementFrame = 0;
  function placeLauncher() {
    const viewport = window.visualViewport;
    const zoom = viewport?.scale || 1;
    // Keep dialogs within the visible screen, including a zoomed/panned page and keyboard.
    for (const panel of root.querySelectorAll('.backdrop')) {
      Object.assign(panel.style, {inset:'auto',left:`${viewport?.offsetLeft || 0}px`,top:`${viewport?.offsetTop || 0}px`,
        width:`${(viewport?.width || innerWidth)*zoom}px`,height:`${(viewport?.height || innerHeight)*zoom}px`,
        transform:`scale(${1/zoom})`,transformOrigin:'0 0'});
    }
    if (launcher.hidden || dragState?.moved) return;
    Object.assign(launcher.style,{transform:`scale(${1/zoom})`,transformOrigin:'0 0'});
    const left = viewport?.offsetLeft || 0;
    const top = viewport?.offsetTop || 0;
    const right = left + (viewport?.width || innerWidth);
    const bottom = top + (viewport?.height || innerHeight);
    const width = launcher.offsetWidth / zoom;
    const height = launcher.offsetHeight / zoom;
    const gap = collisionGap / zoom;
    const corner = manualCorner || (compactLauncher ? 'top-right' : 'bottom-right');
    const fromRight = corner.endsWith('right');
    const fromBottom = corner.startsWith('bottom');
    const insetY = (compactLauncher || manualCorner ? 16 : 20) / zoom;
    const preferredX = fromRight ? right - width - 20 / zoom : left + 20 / zoom;
    const preferredY = fromBottom ? bottom - height - insetY : top + insetY;
    const targets = [...document.querySelectorAll(targetsSelector)]
      .filter((element) => !element.closest('[data-bug-report-kit]'))
      .map((element) => element.getBoundingClientRect())
      .filter((rect) => rect.width && rect.height && rect.bottom > top && rect.top < bottom);
    const overlaps = (box, rect) => box.left < rect.right + gap
      && box.right > rect.left - gap
      && box.top < rect.bottom + gap
      && box.bottom > rect.top - gap;
    const stepX = width + gap;
    const stepY = height + gap;
    let position;
    for (let row = 0; row < 8 && !position; row += 1) {
      for (let column = 0; column * stepX < right - left && !position; column += 1) {
        const x = preferredX + (fromRight ? -1 : 1) * column * stepX;
        const y = preferredY + (fromBottom ? -1 : 1) * row * stepY;
        const box = {left: x, right: x + width, top: y, bottom: y + height};
        if (x >= left + gap && y >= top + gap && y + height <= bottom - gap
          && targets.every((rect) => !overlaps(box, rect))) position = box;
      }
    }
    // The nearest visible position still keeps the launcher usable on dense pages.
    const x = position?.left ?? Math.max(left, Math.min(preferredX, right - width));
    const y = position?.top ?? Math.max(top, Math.min(preferredY, bottom - height));
    Object.assign(launcher.style, {left: `${x}px`, top: `${y}px`, right: 'auto', bottom: 'auto'});
  }
  const schedulePlacement = () => {
    cancelAnimationFrame(placementFrame);
    placementFrame = requestAnimationFrame(placeLauncher);
  };
  const observer = new MutationObserver((records) => {
    if (records.some((record) => !(record.target instanceof Element)
      || !record.target.closest('[data-bug-report-kit]'))) schedulePlacement();
  });
  observer.observe(document.body, {attributes: true, attributeFilter: ['class', 'style', 'aria-hidden'], childList: true, subtree: true});
  window.addEventListener('resize', schedulePlacement);
  window.addEventListener('scroll', schedulePlacement, true);
  window.visualViewport?.addEventListener('resize', schedulePlacement);
  window.visualViewport?.addEventListener('scroll', schedulePlacement);
  css.addEventListener('load', schedulePlacement);
  schedulePlacement();

  const field = (caption, control) => {
    const label = document.createElement('label');
    label.className = 'field';
    label.textContent = caption;
    label.append(control);
    return label;
  };

  function showAuth(onAuthenticated, initialMessage = '', onCancel = null) {
    launcher.hidden = true;
    const backdrop = document.createElement('div');
    backdrop.className = 'backdrop';
    const card = document.createElement('div');
    card.className = 'card auth-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    const heading = document.createElement('h2');
    heading.id = 'bug-kit-auth-heading';
    card.setAttribute('aria-labelledby', heading.id);
    heading.textContent = 'Кто сообщает о баге?';
    const hint = document.createElement('p');
    hint.className = 'meta';
    hint.textContent = 'Войдите со своим именем или создайте новое. PIN — 4 цифры.';
    const name = document.createElement('input');
    name.type = 'text'; name.maxLength = 80; name.autocomplete = 'username';
    name.placeholder = 'Имя или ник';
    let suggestedAction = 'login';
    const pin = document.createElement('input');
    pin.type = 'password'; pin.inputMode = 'numeric'; pin.pattern = '[0-9]{4}';
    pin.maxLength = 4; pin.autocomplete = 'current-password';
    pin.placeholder = '4 цифры';
    pin.setAttribute('aria-label', 'PIN из 4 цифр');
    const clearMessage = () => { if (message.className === 'error') message.textContent = ''; };
    name.addEventListener('input', () => {
      clearMessage();
      suggestedAction = 'login';
      login.classList.add('primary');
      register.classList.remove('primary');
    });
    pin.addEventListener('input', () => {
      pin.value = pin.value.replace(/\D/g, '').slice(0, 4);
      clearMessage();
    });
    const message = document.createElement('p');
    message.className = initialMessage ? 'error' : 'meta';
    message.textContent = initialMessage;
    message.setAttribute('role', 'status');
    const actions = document.createElement('div');
    actions.className = 'row auth-actions';
    const cancel = button('Отмена');
    const login = button('Войти', 'primary');
    const register = button('Создать имя');
    const close = () => {
      backdrop.remove(); syncInteraction();
      root.removeEventListener('keydown', onKey);
      if (onCancel) onCancel();
      else { pendingCapture = null; launcher.hidden = false; schedulePlacement(); }
    };
    const onKey = (event) => { if (event.key === 'Escape') close(); };
    root.addEventListener('keydown', onKey);
    cancel.onclick = close;
    let submitting = false;
    async function submit(action) {
      if (submitting) return;
      const enteredName = name.value.trim();
      if (enteredName.length < 2 || enteredName.length > 80) {
        message.className = 'error'; message.textContent = 'Имя должно содержать от 2 до 80 символов'; return;
      }
      if (!/^\d{4}$/.test(pin.value)) {
        message.className = 'error'; message.textContent = 'Введите PIN из 4 цифр'; return;
      }
      login.disabled = register.disabled = true;
      submitting = true;
      message.className = 'meta'; message.textContent = action === 'register' ? 'Создаём имя…' : 'Входим…';
      try {
        const response = await fetch(`${base}/api/reporter/${action}`, {
          method: 'POST', headers: {'Content-Type': 'application/json', 'X-Project-Key': projectKey},
          body: JSON.stringify({name: enteredName, pin: pin.value}),
        });
        const result = await response.json();
        if (!response.ok) {
          const failure = new Error(result.error || 'Не удалось войти');
          failure.code = result.code;
          throw failure;
        }
        if (!result.token || !result.reporter?.id || !result.reporter?.name) throw new Error('Сервер вернул неполные данные входа');
        saveReporterToken(result.token);
        activeReporter = result.reporter;
        pin.value = '';
        backdrop.remove(); syncInteraction();
        root.removeEventListener('keydown', onKey);
        onAuthenticated();
      } catch (cause) {
        message.className = 'error';
        message.textContent = cause instanceof TypeError ? 'Нет связи с сервером. Попробуйте ещё раз.' : cause.message;
        if (cause.code === 'name_not_found') {
          suggestedAction = 'register';
          login.classList.remove('primary');
          register.classList.add('primary');
          register.focus();
        } else if (cause.code === 'name_taken') {
          suggestedAction = 'login';
          login.classList.add('primary');
          register.classList.remove('primary');
          login.focus();
        } else if (cause.code === 'wrong_pin') {
          suggestedAction = 'login';
          pin.value = '';
          pin.focus({preventScroll:true});
        }
      } finally { submitting = false; login.disabled = register.disabled = false; }
    }
    login.onclick = () => submit('login');
    register.onclick = () => submit('register');
    pin.addEventListener('keydown', (event) => { if (event.key === 'Enter') submit(suggestedAction); });
    actions.append(cancel, register, login);
    card.append(heading, hint, field('Имя или ник', name), field('PIN · 4 цифры', pin), message, actions);
    backdrop.append(card);
    root.append(backdrop); syncInteraction(); placeLauncher();
    if (!matchMedia('(pointer: coarse)').matches) name.focus({preventScroll:true});
  }

  function showForm({screenshot, selection, error = ''}) {
    if (destroyed) return;
    launcher.hidden = true;
    let attachment = null;
    let readingAttachment = false;
    let attachmentReadId = 0;
    const backdrop = document.createElement('div');
    backdrop.className = 'backdrop';
    const card = document.createElement('div');
    card.className = 'card report-card';
    const heading = document.createElement('h2');
    heading.textContent = 'Сообщить о баге';
    const header = document.createElement('div');
    header.className = 'report-header';
    header.append(heading);
    const context = document.createElement('div');
    context.className = 'report-context';
    const meta = document.createElement('p');
    meta.className = 'meta';
    meta.textContent = safePageUrl();
    meta.title = meta.textContent;
    const preview = document.createElement('img');
    preview.className = 'preview';
    preview.alt = 'Выделенная область';
    const previewFrame = document.createElement('div');
    previewFrame.className = 'preview-frame';
    previewFrame.hidden = !screenshot;
    previewFrame.append(preview);
    if (screenshot) {
      const zoom = button('Увеличить снимок', 'preview-zoom');
      zoom.onclick = () => openScreenshotPreview(root, screenshot, zoom);
      previewFrame.append(zoom);
    }
    if (screenshot) preview.src = screenshot;
    else preview.hidden = true;
    const description = document.createElement('textarea');
    description.placeholder = 'Суть бага, шаги для воспроизведения и что ожидалось';
    description.setAttribute('aria-label', description.placeholder);
    description.setAttribute('aria-required', 'true');
    description.maxLength = 4000;
    const descriptionCount = document.createElement('span');
    descriptionCount.className = 'character-count';
    descriptionCount.id = 'bug-kit-description-count';
    descriptionCount.textContent = '0 / 4000';
    description.setAttribute('aria-describedby', descriptionCount.id);
    description.addEventListener('input', () => syncForm());
    const reporter = document.createElement('input');
    reporter.type = 'text';
    reporter.maxLength = 120;
    reporter.autocomplete = 'name';
    let currentReporter = {};
    try { currentReporter = !reporterAuth && typeof getReporter === 'function' ? getReporter() || {} : {}; }
    catch { /* Identity is optional; the reporter can enter it manually. */ }
    const accountReporterId = typeof currentReporter.id === 'string' ? currentReporter.id.trim().slice(0, 120) : '';
    if (!reporterAuth && !accountReporterId && !guestReporterId) guestReporterId = anonymousReporterId(projectKey);
    const reporterId = accountReporterId || guestReporterId;
    reporter.value = typeof currentReporter.name === 'string' ? currentReporter.name.slice(0, 120) : reporterName;
    reporter.placeholder = 'Анонимный пользователь';
    const guestIdLabel = document.createElement('p');
    guestIdLabel.className = 'meta';
    guestIdLabel.textContent = `ID этого браузера: ${guestReporterId.slice(5, 13)}`;
    const contact = document.createElement('input');
    contact.type = 'text';
    contact.maxLength = 240;
    contact.autocomplete = 'email';
    contact.value = typeof currentReporter.contact === 'string' ? currentReporter.contact.slice(0, 240) : reporterContact;
    contact.placeholder = 'Необязательно';
    const uploadLabel = document.createElement('label');
    uploadLabel.className = 'upload-action';
    uploadLabel.title = 'Прикрепить изображение';
    const uploadPlus = document.createElement('span');
    uploadPlus.className = 'upload-plus';
    uploadPlus.textContent = '+';
    uploadPlus.setAttribute('aria-hidden', 'true');
    const clipIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    clipIcon.setAttribute('viewBox', '0 0 24 24');
    clipIcon.setAttribute('aria-hidden', 'true');
    const clipPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    clipPath.setAttribute('d', 'M8.5 12.5 14.9 6.1a3 3 0 0 1 4.2 4.2l-8.8 8.8a5 5 0 0 1-7.1-7.1l9.2-9.2');
    clipIcon.append(clipPath);
    const upload = document.createElement('input');
    upload.type = 'file';
    upload.className = 'upload-input';
    upload.setAttribute('aria-label', 'Прикрепить файл');
    uploadLabel.append(uploadPlus, clipIcon, upload);
    const uploadName = document.createElement('span');
    uploadName.className = 'upload-name';
    uploadName.hidden = true;
    upload.onchange = () => {
      const readId = ++attachmentReadId;
      const file = upload.files?.[0];
      if (!file) { readingAttachment = false; return; }
      if (file.size > 5 * 1024 * 1024) {
        readingAttachment = false;
        status.textContent = 'Файл должен быть не больше 5 МБ';
        upload.value = '';
        attachment = null;
        uploadName.hidden = true;
        return;
      }
      attachment = null;
      uploadName.hidden = true;
      readingAttachment = true;
      const reader = new FileReader();
      reader.onload = () => {
        if (readId !== attachmentReadId) return;
        attachment = {name: file.name, data: String(reader.result)};
        uploadName.textContent = file.name;
        uploadName.title = file.name;
        uploadName.hidden = false;
        status.textContent = '';
        readingAttachment = false;
      };
      reader.onerror = () => {
        if (readId !== attachmentReadId) return;
        readingAttachment = false;
        status.textContent = 'Не удалось прочитать файл';
      };
      reader.readAsDataURL(file);
    };
    const status = document.createElement('p');
    status.className = 'error';
    status.id = 'bug-kit-report-status';
    status.textContent = error;
    const speechStatus = document.createElement('p');
    speechStatus.className = 'speech-status';
    speechStatus.id = 'bug-kit-transcription-status';
    speechStatus.setAttribute('role', 'status');
    speechStatus.setAttribute('aria-live', 'polite');
    speechStatus.setAttribute('aria-atomic', 'true');
    speechStatus.hidden = true;
    const speechIcon = document.createElement('span');
    speechIcon.className = 'speech-icon';
    speechIcon.setAttribute('aria-hidden', 'true');
    const speechText = document.createElement('span');
    speechStatus.append(speechIcon, speechText);
    const showSpeechStatus = (state = '', text = '') => {
      speechStatus.hidden = !state;
      speechStatus.dataset.state = state;
      speechIcon.textContent = state === 'ready' ? '✓' : '';
      speechText.textContent = text;
    };
    const actions = document.createElement('div');
    actions.className = 'row';
    let submitting = false, transcribing = false, finishing = false, disposedForm = false;
    let draft = null, recognitionGeneration = 0, pollAbort = null, pollTimer = null, releaseWait = null;
    const cancel = button('Отмена');
    const send = button('Отправить', 'primary');
    const retrySpeech = button('Повторить распознавание', 'text-action');
    retrySpeech.hidden = true;
    const headersFor = token => ({'Content-Type':'application/json','X-Project-Key':projectKey,
      ...(token ? {'X-Reporter-Token':token} : {})});
    const cancelDraft = old => {
      if (old) fetch(`${base}/api/transcription-drafts/${old.id}/cancel`, {
        method:'POST',headers:{...headersFor(old.reporterToken),'X-Draft-Token':old.draftToken},keepalive:true,
      }).catch(()=>{});
    };
    const clearRecognition = () => {
      recognitionGeneration++; pollAbort?.abort(); clearTimeout(pollTimer); releaseWait?.(); releaseWait=null;
      cancelDraft(draft); draft=null; transcribing=false; retrySpeech.hidden=true; showSpeechStatus();
    };
    const syncForm = () => {
      if (disposedForm) return;
      const recording = voice.busy();
      send.textContent = recording ? 'Готово' : 'Отправить';
      const tooLong = description.value.trim().length > 4000;
      descriptionCount.textContent = `${description.value.length} / 4000${tooLong ? ' — сократите текст перед отправкой' : ''}`;
      description.setAttribute('aria-invalid',String(tooLong));
      send.disabled = submitting || transcribing || finishing || (!recording && (!description.value.trim() || tooLong)) || (reporterAuth && !activeReporter);
      voice.setDisabled(submitting || transcribing || finishing);
      retrySpeech.disabled = submitting || transcribing || recording || finishing;
    };
    const recognize = async (audio, retry = false) => {
      if (disposedForm || destroyed || !audio) return;
      let previous = retry ? draft : null;
      if (previous) draft=null;
      clearRecognition();
      const generation = recognitionGeneration;
      const current = () => !disposedForm && !destroyed && generation===recognitionGeneration && backdrop.isConnected;
      transcribing=true; retrySpeech.hidden=true; status.className='meta'; status.textContent=''; showSpeechStatus('pending', 'Идёт расшифровка…'); syncForm();
      const authToken = reporterAuth ? reporterToken() : '';
      let active = previous;
      if (previous) draft=previous;
      try {
        // Do not abort creation: a late response must still be cancelled explicitly.
        // If the connection is lost, the server TTL removes the orphaned draft.
        let response = await fetch(previous ? `${base}/api/transcription-drafts/${previous.id}/${['pending','processing'].includes(previous.state) ? 'status' : 'retry'}` : `${base}/api/transcription-drafts`,{
          method:'POST',headers:{...headersFor(authToken),...(previous ? {'X-Draft-Token':previous.draftToken} : {})},
          body:JSON.stringify(previous ? {} : {audio,pageUrl:safePageUrl()}),
        });
        if (previous && response.status===404) {
          // The TTL can expire while the user edits; retry starts a fresh draft.
          previous=null;draft=null;
          response=await fetch(`${base}/api/transcription-drafts`,{method:'POST',headers:headersFor(authToken),body:JSON.stringify({audio,pageUrl:safePageUrl()})});
        }
        let result=await response.json();
        if (!response.ok) throw new Error(result.error || 'Не удалось начать распознавание');
        active=previous || {id:result.id,draftToken:result.draftToken,reporterToken:authToken};
        if (!current()) {cancelDraft(active); return;}
        active.state=result.state;
        draft=active;
        pollAbort=new AbortController();
        while (['pending','processing'].includes(result.state)) {
          await new Promise(resolve=>{releaseWait=resolve;pollTimer=setTimeout(resolve,500);}); releaseWait=null;
          if (!current()) return;
          const poll=await fetch(`${base}/api/transcription-drafts/${active.id}/status`,{
            method:'POST',headers:{...headersFor(authToken),'X-Draft-Token':active.draftToken},signal:pollAbort.signal,
          });
          result=await poll.json();
          active.state=result.state;
          if (!poll.ok) throw new Error(result.error || 'Не удалось получить расшифровку');
          if (!current()) return;
        }
        if (result.state!=='ready' || !result.text?.trim()) throw new Error(result.error || 'Не удалось распознать запись. Можно ввести текст вручную.');
        // Read the live field after ASR, so typing while waiting is preserved.
        description.value=[description.value,result.text.trim()].filter(Boolean).join('\n\n');
        showSpeechStatus('ready', 'Расшифровка добавлена. Проверьте текст перед отправкой.');
      } catch (cause) {
        if (current()) {showSpeechStatus();status.className='error';status.textContent=cause.message || 'Не удалось распознать запись. Можно ввести текст вручную.';retrySpeech.hidden=false;}
      } finally {
        if (current()) {transcribing=false;syncForm();}
      }
    };
    const voice = voiceInput({onChange:()=>{if (voice.busy() && speechStatus.dataset.state==='ready') showSpeechStatus();syncForm();},onReady:audio=>void recognize(audio),
      onError:error=>{status.className='error';status.textContent=error.message;syncForm();},onClear:()=>{clearRecognition();status.textContent='';syncForm();}});
    retrySpeech.onclick=()=>void recognize(voice.value(),true);
    const disposeForm = () => {if (disposedForm) return; disposedForm=true;window.removeEventListener('pagehide',disposeForm);clearRecognition();voice.dispose();};
    window.addEventListener('pagehide',disposeForm);
    disposeVoice = disposeForm;
    cancel.onclick = () => {if(submitting)return;disposeForm();backdrop.remove();syncInteraction();launcher.hidden=false;schedulePlacement();};
    const identity = document.createElement('p');
    identity.className = 'meta reporter-identity';
    const identityName = document.createElement('span');
    const signOut = button('Выйти', 'text-action');
    const promptToSignIn = (message, successText = 'Вход выполнен. Можно отправить баг.') => {
      card.inert = true;
      showAuth(() => {
        card.inert = false;
        identityName.textContent = `Автор: ${activeReporter.name}`;
        signOut.textContent = 'Выйти';
        syncForm();
        signOut.disabled = false;
        if (send.isConnected) status.textContent = successText;
      }, message, () => { card.inert = false; signOut.disabled = false; });
    };
    if (reporterAuth) {
      identityName.textContent = `Автор: ${activeReporter?.name || 'не определён'}`;
      signOut.onclick = () => {
        if (signOut.disabled) return;
        if (!activeReporter) {
          signOut.disabled = true;
          promptToSignIn('Войдите, чтобы отправить баг.');
          return;
        }
        const token = reporterToken();
        clearRecognition();
        saveReporterToken('');
        activeReporter = null;
        identityName.textContent = 'Автор: не вошли';
        send.disabled = true;
        signOut.textContent = 'Войти';
        signOut.disabled = true;
        if (token) fetch(`${base}/api/reporter/logout`, {
          method: 'POST', headers: {'X-Project-Key': projectKey, 'X-Reporter-Token': token},
        }).catch(() => {});
        promptToSignIn('Вы вышли. Войдите снова, чтобы отправить баг.');
      };
      identity.append(identityName, signOut);
    }
    context.append(meta, ...(reporterAuth ? [identity] : []));
    send.onclick = async () => {
      if (submitting || destroyed || disposedForm || transcribing || finishing) return;
      if (voice.busy()) {
        finishing=true;syncForm();status.className='meta';status.textContent='Завершаем запись…';
        try {await voice.finish();} catch(cause) {if(!disposedForm)status.textContent=cause.message || 'Не удалось прочитать запись';}
        finally {finishing=false;syncForm();}
        return;
      }
      if (!description.value.trim() || description.value.trim().length>4000) {syncForm();return;}
      if (readingAttachment) { status.textContent = 'Подождите, файл ещё загружается'; return; }
      if (reporterAuth && (!activeReporter || !reporterToken())) { status.textContent = 'Сначала войдите или создайте имя'; return; }
      submitting = true;
      send.disabled = true;
      cancel.disabled = true;
      voice.setDisabled(true);
      if (reporterAuth) signOut.disabled = true;
      status.className='meta';
      status.textContent = voice.busy() ? 'Завершаем запись…' : 'Отправляем…';
      try {
        await voice.finish();
        if (destroyed || !backdrop.isConnected) return;
        if (!description.value.trim() && !voice.value()) throw new Error('Опишите суть бага или запишите голос');
        status.textContent = 'Отправляем…';
        const response = await fetch(`${base}/api/reports`, {
          method: 'POST',
          headers: {'Content-Type': 'application/json', 'X-Project-Key': projectKey, ...(reporterAuth ? {'X-Reporter-Token': reporterToken()} : {})},
          body: JSON.stringify({
            title: description.value.trim().split('\n')[0].slice(0, 160),
            description: description.value.trim(),
            expected: '',
            actual: description.value.trim(),
            ...(draft ? {transcriptionDraft:{id:draft.id,token:draft.draftToken}} : {}),
            ...(reporterAuth ? {} : {reporterName: reporter.value.trim(), reporterContact: contact.value.trim(), reporterId}),
            pageUrl: safePageUrl(),
            viewport: {width: innerWidth, height: innerHeight, pixelRatio: devicePixelRatio},
            selection,
            screenshot,
            attachment,
            audio:voice.value(),
            appVersion,
            userAgent: navigator.userAgent,
            diagnostics: recentDiagnostics,
          }),
        });
        const result = await response.json();
        if (reporterAuth && response.status === 401) {
          saveReporterToken('');
          activeReporter = null;
          send.disabled = false;
          cancel.disabled = false;
          voice.setDisabled(false);
          signOut.disabled = true;
          signOut.textContent = 'Войти';
          status.textContent = 'Войдите снова, чтобы отправить баг.';
          promptToSignIn('Сессия закончилась. Войдите снова, затем отправьте баг.',
            'Вход восстановлен. Теперь отправьте баг ещё раз.');
          return;
        }
        if (response.status===404 && draft) {
          // The server already discarded the temporary result. Keep original bytes
          // and the reviewed text; the next send uses the compatible raw-audio API.
          draft=null;
          throw new Error('Черновик распознавания истёк. Текст и запись сохранены — нажмите «Отправить» ещё раз.');
        }
        if (!response.ok) throw new Error(result.error || 'Не удалось отправить');
        disposeForm(); backdrop.remove(); syncInteraction();
        launcher.hidden = false;
        schedulePlacement();
        showSuccessToast();
      } catch (cause) {
        status.className = 'error';
        status.textContent = cause instanceof TypeError
          ? 'Не удалось связаться с сервером. Данные остались в форме — попробуйте отправить ещё раз.'
          : cause.message || 'Не удалось отправить';
        send.disabled = false;
        cancel.disabled = false;
        voice.setDisabled(false);
        if (reporterAuth) signOut.disabled = false;
      } finally {submitting = false;syncForm();}
    };
    actions.append(cancel, send);
    const descriptionField = document.createElement('div');
    descriptionField.className = 'report-field';
    descriptionField.append(description);
    descriptionField.append(descriptionCount);
    const reportFields = document.createElement('div');
    reportFields.className = 'report-fields';
    reportFields.append(descriptionField);
    const attachmentControl = document.createElement('div');
    attachmentControl.className = 'report-attachment';
    attachmentControl.append(uploadLabel, uploadName);
    const footer = document.createElement('div');
    footer.className = 'report-footer';
    footer.append(attachmentControl, actions);
    const body = document.createElement('div');
    body.className = 'report-body';
    voice.element.append(retrySpeech);
    body.append(previewFrame, voice.element, reportFields,
      ...(reporterAuth ? [] : [field('Кто сообщает', reporter), ...(accountReporterId ? [] : [guestIdLabel]), field('Контакт для уточнений (необязательно)', contact)]));
    card.append(header, context, body, speechStatus, status, footer);
    backdrop.append(card);
    root.append(backdrop); syncInteraction(); placeLauncher(); syncForm();
    if (!matchMedia('(pointer: coarse)').matches) description.focus({preventScroll:true});
  }

  let pendingCapture = null;
  const captureBeforeDismiss = (event) => {
    if (event.button !== 0 || launcher.disabled || !event.composedPath().includes(launcher)) return;
    if (compactLauncher) {
      suppressLauncherClick = false;
      dragState = {id: event.pointerId, x: event.clientX, y: event.clientY,
        rect: launcher.getBoundingClientRect(), moved: false};
    }
    // WebKit suppresses the touch compatibility click if pointerdown is cancelled.
    // The synchronous clone still precedes focus/outside handlers; stop their propagation.
    if (event.pointerType !== 'touch') event.preventDefault();
    event.stopPropagation();
    // Clone before outside-click/focus handlers dismiss the inspected popup.
    pendingCapture = captureViewport().then(page => ({page}), error => ({error}));
  };
  const moveLauncher = (event) => {
    if (!dragState || event.pointerId !== dragState.id) return;
    const dx = event.clientX - dragState.x;
    const dy = event.clientY - dragState.y;
    if (!dragState.moved && Math.hypot(dx, dy) * (window.visualViewport?.scale || 1) < 8) return;
    dragState.moved = true;
    suppressLauncherClick = true;
    pendingCapture = null;
    event.preventDefault();
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0;
    const right = left + (viewport?.width || innerWidth), bottom = top + (viewport?.height || innerHeight);
    Object.assign(launcher.style, {left: `${Math.max(left, Math.min(dragState.rect.left + dx, right - launcher.getBoundingClientRect().width))}px`,
      top: `${Math.max(top, Math.min(dragState.rect.top + dy, bottom - launcher.getBoundingClientRect().height))}px`, right: 'auto', bottom: 'auto'});
  };
  const finishLauncherDrag = (event) => {
    if (!dragState || event.pointerId !== dragState.id) return;
    if (dragState.moved && event.type !== 'pointercancel') {
      const rect = launcher.getBoundingClientRect();
      const viewport = window.visualViewport;
      const centerX = (viewport?.offsetLeft || 0) + (viewport?.width || innerWidth) / 2;
      const centerY = (viewport?.offsetTop || 0) + (viewport?.height || innerHeight) / 2;
      manualCorner = `${rect.top + rect.height / 2 < centerY ? 'top' : 'bottom'}-${rect.left + rect.width / 2 < centerX ? 'left' : 'right'}`;
      try { localStorage.setItem(cornerKey, manualCorner); } catch { /* Keep the choice for this page. */ }
    }
    dragState = null;
    schedulePlacement();
  };
  window.addEventListener('pointerdown', captureBeforeDismiss, true);
  window.addEventListener('pointermove', moveLauncher, {capture: true, passive: false});
  window.addEventListener('pointerup', finishLauncherDrag, true);
  window.addEventListener('pointercancel', finishLauncherDrag, true);
  function prepareCapture() {
    const viewportBefore = layoutViewport();
    const onResize = () => {if (layoutViewport().width !== viewportBefore.width) cancel();};
    const layer = document.createElement('div');
    layer.className = 'overlay is-preparing';
    const hint = document.createElement('div');
    hint.className = 'hint'; hint.textContent = 'Подготавливаем снимок… · Esc — отмена';
    const close = button('Отмена', 'selection-cancel');
    layer.append(hint, close); root.append(layer); syncInteraction();
    launcher.hidden = true;
    const abort = new AbortController();
    let cancelled = false, finished = false;
    const finish = () => {
      if (finished) return;
      finished = true; layer.remove(); syncInteraction();
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onResize);
      if (cancelActiveSelection === cancel) cancelActiveSelection = null;
    };
    const cancel = () => {
      cancelled = true; pendingCapture = null; abort.abort(); finish();
      launcher.hidden = false; schedulePlacement();
    };
    const onKey = event => {
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.key === 'Escape') cancel();
    };
    layer.addEventListener('wheel', event => event.preventDefault(), {passive:false});
    close.onclick = cancel;
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onResize);
    cancelActiveSelection = cancel;
    return {finish, signal:abort.signal, get cancelled() { return cancelled; }};
  }

  async function beginSelection() {
    if (destroyed) return;
    const preparation = prepareCapture();
    const captured = pendingCapture;
    pendingCapture = null;
    let capture = await (captured || captureViewport().then(page => ({page}), error => ({error})));
    if (destroyed || preparation.cancelled) { preparation.finish(); return; }
    if (capture.page && (Number(capture.page.dataset.captureCssWidth) !== layoutViewport().width
      || Number(capture.page.dataset.captureCssHeight) !== layoutViewport().height
      || Number(capture.page.dataset.captureScrollX) !== scrollX || Number(capture.page.dataset.captureScrollY) !== scrollY)) {
      capture = await captureViewport().then(page => ({page}), error => ({error}));
    }
    preparation.finish();
    if (destroyed || preparation.cancelled) return;
    const bounds = capture.page ? {width:Number(capture.page.dataset.captureCssWidth),height:Number(capture.page.dataset.captureCssHeight)} : layoutViewport();
    const onResize = () => {if (layoutViewport().width !== bounds.width) cancelSelection();};
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    // The displayed frame is frozen; scrolling its hidden page would cause a
    // jump on cancel and make a later capture refer to a different position.
    overlay.addEventListener('wheel', event => event.preventDefault(), {passive:false});
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'Выделите область мышью · Esc — отмена';
    const box = document.createElement('div');
    box.className = 'box';
    // In iOS Safari a fixed layer's client rect can move with the visual viewport.
    // Anchor the captured image at client0, then keep that image origin for crop input.
    let imageOrigin = {x:0,y:0};
    if (capture.page) {
      // The renderer already owns an immutable bitmap; avoid a second full-size buffer.
      const frozen = capture.page;
      Object.assign(frozen.style, {position:'absolute',left:'0',top:'0',width:`${bounds.width}px`,height:`${bounds.height}px`,pointerEvents:'none'});
      overlay.append(frozen);
    }
    overlay.append(hint, box);
    root.append(overlay); syncInteraction();
    const layerRect = overlay.getBoundingClientRect();
    imageOrigin = {x:-layerRect.left,y:-layerRect.top};
    const frozenImage = overlay.querySelector('canvas');
    if (frozenImage) Object.assign(frozenImage.style,{left:`${imageOrigin.x}px`,top:`${imageOrigin.y}px`});
    const finishSelection = () => {
      controls?.dispose();
      overlay.remove(); syncInteraction();
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onResize);
      cancelActiveSelection = null;
    };
    const cancelSelection = () => {
      finishSelection(); launcher.hidden = false; schedulePlacement();
    };
    cancelActiveSelection = cancelSelection;
    const onKey = (event) => {
      // Block shortcuts while the frame is frozen. Earlier application capture
      // listeners must honor the public active marker on the widget host.
      const ownControl = overlay.contains(event.composedPath()[0]);
      if (ownControl && ['Tab','ArrowLeft','ArrowRight','ArrowUp','ArrowDown',' '].includes(event.key)) return;
      if (event.key === 'Enter' && event.composedPath()[0]?.tagName === 'BUTTON') return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.key === 'Escape') cancelSelection();
      if (event.key === 'Enter') controls.confirm();
    };
    window.addEventListener('keydown', onKey, true);
    // Width changes reflow the page. Browser toolbar height changes keep the exact frozen bitmap.
    window.addEventListener('resize', onResize);
    const controls = selectionControls(overlay, box, hint, async (selection) => {
      finishSelection();
      try {
        if (capture.error) throw capture.error;
        const page = capture.page;
        const scale = page.width / Number(page.dataset.captureCssWidth);
        const cropped = document.createElement('canvas');
        cropped.width = Math.round(selection.width * scale);
        cropped.height = Math.round(selection.height * scale);
        cropped.getContext('2d').drawImage(page,
          selection.x * scale,
          selection.y * scale,
          cropped.width, cropped.height,
          0, 0, cropped.width, cropped.height);
        showForm({screenshot: await compress(cropped), selection});
      } catch (cause) {
        showForm({screenshot: null, selection, error: `Снимок не получился: ${cause.message}. Файл можно приложить отдельно.`});
      }
    }, cancelSelection, () => {finishSelection(); showForm({screenshot:null, selection:null});}, bounds, imageOrigin);
  }
  launcher.onclick = async (event) => {
    event.stopPropagation();
    if (suppressLauncherClick) { suppressLauncherClick = false; pendingCapture = null; return; }
    clearToast();
    if (!reporterAuth) { beginSelection(); return; }
    const token = reporterToken();
    if (!token) { showAuth(beginSelection); return; }
    launcher.disabled = true;
    const preparation = prepareCapture();
    try {
      const response = await fetch(`${base}/api/reporter/me`, {
        signal: preparation.signal,
        // Same-origin GET omits Origin; POST retains the strict server origin check.
        method: 'POST',
        headers: {'X-Project-Key': projectKey, 'X-Reporter-Token': token},
      });
      const result = await response.json();
      preparation.finish();
      if (destroyed || preparation.cancelled) return;
      if (!response.ok || !result.reporter?.id || !result.reporter?.name) {
        if (response.status === 401) saveReporterToken('');
        activeReporter = null;
        showAuth(beginSelection, response.status === 401 ? 'Сессия закончилась. Войдите снова.' : result.error || 'Не удалось проверить вход');
        return;
      }
      activeReporter = result.reporter;
      beginSelection();
    } catch {
      preparation.finish();
      if (!destroyed && !preparation.cancelled) showAuth(beginSelection, 'Нет связи с сервером. Попробуйте войти ещё раз.');
    } finally { preparation.finish(); launcher.disabled = false; }
  };
  const instance = {recordDiagnostic: addDiagnostic, destroy: () => {
    if (destroyed) return;
    destroyed = true;
    cancelActiveSelection?.();
    disposeVoice();
    clearToast();
    window.removeEventListener('pointerdown', captureBeforeDismiss, true);
    window.removeEventListener('pointermove', moveLauncher, true);
    window.removeEventListener('pointerup', finishLauncherDrag, true);
    window.removeEventListener('pointercancel', finishLauncherDrag, true);
    pendingCapture = null;
    cancelAnimationFrame(placementFrame);
    observer.disconnect();
    window.removeEventListener('resize', schedulePlacement);
    window.removeEventListener('scroll', schedulePlacement, true);
    window.visualViewport?.removeEventListener('resize', schedulePlacement);
    window.visualViewport?.removeEventListener('scroll', schedulePlacement);
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
    if (observedFetch && window.fetch === observedFetch) window.fetch = originalFetch;
    host.remove();
    if (window.BugReportKit?.instance === instance) delete window.BugReportKit.instance;
  }};
  return instance;
}

// Repeated SPA embeds keep the live instance and its unfinished report.
window.BugReportKit = {...window.BugReportKit, init};
const script = document.currentScript;
if (script?.dataset.projectKey && !window.BugReportKit.instance) {
  window.BugReportKit.instance = init({
    serverUrl: script.dataset.serverUrl || new URL(script.src).origin,
    projectKey: script.dataset.projectKey,
    label: script.dataset.label,
    launcherStyle: script.dataset.launcherStyle,
    appVersion: script.dataset.appVersion || document.querySelector('meta[name="app-version"]')?.content || '',
    captureFetchErrors: script.dataset.captureFetchErrors === 'true',
    reporterName: script.dataset.reporterName || '',
    reporterContact: script.dataset.reporterContact || '',
    reporterAuth: script.dataset.reporterAuth === 'true',
    getReporter: () => window.__BUG_REPORT_KIT_REPORTER_PROVIDER__?.() || {},
  });
}
