import {captureViewport, safePageUrl} from './capture.js';

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
  const host = document.createElement('div');
  host.dataset.bugReportKit = '';
  document.body.append(host);
  const root = host.attachShadow({mode: 'open'});
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
  let placementFrame = 0;
  function placeLauncher() {
    if (launcher.hidden) return;
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft || 0;
    const top = viewport?.offsetTop || 0;
    const right = left + (viewport?.width || innerWidth);
    const bottom = top + (viewport?.height || innerHeight);
    const width = launcher.offsetWidth;
    const height = launcher.offsetHeight;
    const targets = [...document.querySelectorAll(targetsSelector)]
      .filter((element) => !element.closest('[data-bug-report-kit]'))
      .map((element) => element.getBoundingClientRect())
      .filter((rect) => rect.width && rect.height && rect.bottom > top && rect.top < bottom);
    const overlaps = (box, rect) => box.left < rect.right + collisionGap
      && box.right > rect.left - collisionGap
      && box.top < rect.bottom + collisionGap
      && box.bottom > rect.top - collisionGap;
    const stepX = width + collisionGap;
    const stepY = height + collisionGap;
    let position;
    for (let row = 0; row < 8 && !position; row += 1) {
      for (let column = 0; column * stepX < right - left && !position; column += 1) {
        const x = right - 20 - width - column * stepX;
        const y = compactLauncher ? top + 16 + row * stepY : bottom - 20 - height - row * stepY;
        const box = {left: x, right: x + width, top: y, bottom: y + height};
        if (x >= left + collisionGap && y >= top + collisionGap && y + height <= bottom - collisionGap
          && targets.every((rect) => !overlaps(box, rect))) position = box;
      }
    }
    // The nearest visible position still keeps the launcher usable on dense pages.
    const x = position?.left ?? Math.max(left + collisionGap, right - width - 20);
    const y = position?.top ?? (compactLauncher ? top + 16 : Math.max(top + collisionGap, bottom - height - 20));
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
      backdrop.remove();
      window.removeEventListener('keydown', onKey);
      if (onCancel) onCancel();
      else { pendingCapture = null; launcher.hidden = false; schedulePlacement(); }
    };
    const onKey = (event) => { if (event.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
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
        backdrop.remove();
        window.removeEventListener('keydown', onKey);
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
          pin.focus();
        }
      } finally { submitting = false; login.disabled = register.disabled = false; }
    }
    login.onclick = () => submit('login');
    register.onclick = () => submit('register');
    pin.addEventListener('keydown', (event) => { if (event.key === 'Enter') submit(suggestedAction); });
    actions.append(cancel, register, login);
    card.append(heading, hint, field('Имя или ник', name), field('PIN · 4 цифры', pin), message, actions);
    backdrop.append(card);
    root.append(backdrop);
    name.focus();
  }

  function showForm({screenshot, selection, error = ''}) {
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
    if (screenshot) preview.src = screenshot;
    else preview.hidden = true;
    const description = document.createElement('textarea');
    description.placeholder = 'Суть бага, шаги для воспроизведения';
    description.setAttribute('aria-label', description.placeholder);
    description.setAttribute('aria-required', 'true');
    description.maxLength = 2000;
    const descriptionCount = document.createElement('span');
    descriptionCount.className = 'character-count';
    descriptionCount.id = 'bug-kit-description-count';
    descriptionCount.textContent = '0 / 2000';
    description.setAttribute('aria-describedby', descriptionCount.id);
    description.addEventListener('input', () => {
      descriptionCount.textContent = `${description.value.length} / 2000`;
    });
    const expected = document.createElement('textarea');
    expected.placeholder = 'Что ожидалось';
    expected.setAttribute('aria-label', expected.placeholder);
    expected.maxLength = 2000;
    const expectedCount = document.createElement('span');
    expectedCount.className = 'character-count';
    expectedCount.id = 'bug-kit-expected-count';
    expectedCount.textContent = '0 / 2000';
    expected.setAttribute('aria-describedby', expectedCount.id);
    expected.addEventListener('input', () => {
      expectedCount.textContent = `${expected.value.length} / 2000`;
    });
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
    const actions = document.createElement('div');
    actions.className = 'row';
    const cancel = button('Отмена');
    cancel.onclick = () => { if (status.textContent === 'Отправляем…') return; backdrop.remove(); launcher.hidden = false; schedulePlacement(); };
    const send = button('Отправить', 'primary');
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
        send.disabled = false;
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
      if (!description.value.trim()) { status.textContent = 'Опишите суть бага'; return; }
      if (readingAttachment) { status.textContent = 'Подождите, файл ещё загружается'; return; }
      if (reporterAuth && (!activeReporter || !reporterToken())) { status.textContent = 'Сначала войдите или создайте имя'; return; }
      send.disabled = true;
      cancel.disabled = true;
      if (reporterAuth) signOut.disabled = true;
      status.textContent = 'Отправляем…';
      try {
        const response = await fetch(`${base}/api/reports`, {
          method: 'POST',
          headers: {'Content-Type': 'application/json', 'X-Project-Key': projectKey, ...(reporterAuth ? {'X-Reporter-Token': reporterToken()} : {})},
          body: JSON.stringify({
            title: description.value.trim().split('\n')[0].slice(0, 160),
            description: description.value.trim(),
            expected: expected.value.trim(),
            actual: description.value.trim(),
            ...(reporterAuth ? {} : {reporterName: reporter.value.trim(), reporterContact: contact.value.trim(), reporterId}),
            pageUrl: safePageUrl(),
            viewport: {width: innerWidth, height: innerHeight, pixelRatio: devicePixelRatio},
            selection,
            screenshot,
            attachment,
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
          signOut.disabled = true;
          signOut.textContent = 'Войти';
          status.textContent = 'Войдите снова, чтобы отправить баг.';
          promptToSignIn('Сессия закончилась. Войдите снова, затем отправьте баг.',
            'Вход восстановлен. Теперь отправьте баг ещё раз.');
          return;
        }
        if (!response.ok) throw new Error(result.error || 'Не удалось отправить');
        backdrop.remove();
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
        if (reporterAuth) signOut.disabled = false;
      }
    };
    actions.append(cancel, send);
    const descriptionField = document.createElement('div');
    descriptionField.className = 'report-field';
    descriptionField.append(description);
    descriptionField.append(descriptionCount);
    const expectedField = document.createElement('div');
    expectedField.className = 'report-field';
    expectedField.append(expected);
    expectedField.append(expectedCount);
    const reportFields = document.createElement('div');
    reportFields.className = 'report-fields';
    reportFields.append(descriptionField, expectedField);
    const attachmentControl = document.createElement('div');
    attachmentControl.className = 'report-attachment';
    attachmentControl.append(uploadLabel, uploadName);
    const footer = document.createElement('div');
    footer.className = 'report-footer';
    footer.append(attachmentControl, actions);
    card.append(header, context, previewFrame,
      reportFields, ...(reporterAuth ? [] : [field('Кто сообщает', reporter), ...(accountReporterId ? [] : [guestIdLabel]), field('Контакт для уточнений (необязательно)', contact)]),
      status, footer);
    backdrop.append(card);
    root.append(backdrop);
    description.focus();
  }

  let pendingCapture = null;
  const captureBeforeDismiss = (event) => {
    if (event.button !== 0 || launcher.disabled || !event.composedPath().includes(launcher)) return;
    event.preventDefault(); event.stopPropagation();
    // Clone before outside-click/focus handlers dismiss the inspected popup.
    pendingCapture = captureViewport().then(page => ({page}), error => ({error}));
  };
  window.addEventListener('pointerdown', captureBeforeDismiss, true);
  async function beginSelection() {
    launcher.hidden = true;
    const capture = await (pendingCapture || captureViewport().then(page => ({page}), error => ({error})));
    pendingCapture = null;
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'Выделите область мышью · Esc — отмена';
    const close = button('Отмена', 'selection-cancel');
    const box = document.createElement('div');
    box.className = 'box';
    if (capture.page) {
      const frozen = document.createElement('canvas');
      frozen.width = capture.page.width; frozen.height = capture.page.height;
      frozen.getContext('2d').drawImage(capture.page, 0, 0);
      Object.assign(frozen.style, {position:'absolute', inset:'0', width:'100%', height:'100%', pointerEvents:'none'});
      overlay.append(frozen);
    }
    overlay.append(hint, close, box);
    root.append(overlay);
    let start = null;
    const cancelSelection = () => {
      overlay.remove(); launcher.hidden = false; schedulePlacement();
      window.removeEventListener('keydown', onKey);
    };
    const onKey = (event) => { if (event.key === 'Escape') cancelSelection(); };
    close.onclick = cancelSelection;
    close.onpointerdown = (event) => event.stopPropagation();
    window.addEventListener('keydown', onKey);
    overlay.onpointerdown = (event) => {
      if (event.button !== 0) return;
      start = {x: event.clientX, y: event.clientY};
      overlay.setPointerCapture(event.pointerId);
    };
    overlay.onpointermove = (event) => {
      if (!start) return;
      const x = Math.min(start.x, event.clientX), y = Math.min(start.y, event.clientY);
      Object.assign(box.style, {
        left: `${x}px`, top: `${y}px`,
        width: `${Math.abs(event.clientX - start.x)}px`,
        height: `${Math.abs(event.clientY - start.y)}px`,
      });
    };
    overlay.onpointerup = async (event) => {
      if (!start) return;
      const selection = {
        x: Math.max(0, Math.min(start.x, event.clientX)),
        y: Math.max(0, Math.min(start.y, event.clientY)),
        width: Math.abs(event.clientX - start.x),
        height: Math.abs(event.clientY - start.y),
      };
      start = null;
      if (selection.width < 24 || selection.height < 24) return;
      overlay.remove();
      window.removeEventListener('keydown', onKey);
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
    };
  }
  launcher.onclick = async (event) => {
    event.stopPropagation();
    clearToast();
    if (!reporterAuth) { beginSelection(); return; }
    const token = reporterToken();
    if (!token) { showAuth(beginSelection); return; }
    launcher.disabled = true;
    try {
      const response = await fetch(`${base}/api/reporter/me`, {
        headers: {'X-Project-Key': projectKey, 'X-Reporter-Token': token},
      });
      const result = await response.json();
      if (!response.ok || !result.reporter?.id || !result.reporter?.name) {
        if (response.status === 401) saveReporterToken('');
        activeReporter = null;
        showAuth(beginSelection, response.status === 401 ? 'Сессия закончилась. Войдите снова.' : result.error || 'Не удалось проверить вход');
        return;
      }
      activeReporter = result.reporter;
      beginSelection();
    } catch {
      showAuth(beginSelection, 'Нет связи с сервером. Попробуйте войти ещё раз.');
    } finally { launcher.disabled = false; }
  };
  return {recordDiagnostic: addDiagnostic, destroy: () => {
    clearToast();
    window.removeEventListener('pointerdown', captureBeforeDismiss, true);
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
  }};
}

window.BugReportKit = {init};
const script = document.currentScript;
if (script?.dataset.projectKey) {
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
