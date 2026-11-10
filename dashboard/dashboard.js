const $ = (selector) => document.querySelector(selector);
const {panelMount, panelLogout} = document.body.dataset;
const panelPath = (path) => panelMount ? panelMount + path.slice(1) : path;
const gatewaySession = panelMount ? new AbortController() : null;
const gatewayRequest = {mode: 'same-origin', credentials: 'same-origin', redirect: 'error', cache: 'no-store'};
const validReportId = (id) => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id);
let token = panelMount ? '' : sessionStorage.getItem('bug-kit-panel-token') || '';
let selected = null;
let imageUrl = '';
let audioUrl = '';
let showing = 0;
let offset = 0;
let actor = null;
let projectNames = new Map();
const statusLabels = {new:'Новый',triaged:'В очереди',in_progress:'Исправляется',
  ready_for_check:'Проверить исправление',closed:'Исправлен',cancelled:'Отменён'};

function showGatewayError(error) {
  if (gatewaySession.signal.aborted) return;
  gatewaySession.abort(error);
  ++showing;
  selected = null;
  actor = null;
  projectNames.clear();
  $('#actor').textContent = '';
  $('#project').replaceChildren();
  if (imageUrl) URL.revokeObjectURL(imageUrl);
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  imageUrl = audioUrl = '';
  $('#list').replaceChildren();
  $('#detail').replaceChildren();
  $('#workspace').hidden = true;
  $('#header-session').hidden = true;
  $('#gateway-message').textContent = error.message;
  $('#gateway-sign-in').hidden = false;
  $('#gateway-session').hidden = false;
}

async function api(path, {responseType = 'json', ...options} = {}) {
  gatewaySession?.signal.throwIfAborted();
  const headers = options.body ? {'Content-Type': 'application/json'} : {};
  if (!panelMount) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(panelPath(path), {
    ...options, headers,
    ...(gatewaySession ? {...gatewayRequest, signal: gatewaySession.signal} : {}),
  });
  if (panelMount && [401, 403].includes(response.status)) {
    const error = new Error('Для доступа к панели войдите через стартовую страницу.');
    showGatewayError(error);
    throw error;
  }
  if (response.status === 401) throw new Error('Сессия завершилась. Войдите снова.');
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result.error || 'Ошибка сервера');
  }
  const body = await response[responseType]();
  gatewaySession?.signal.throwIfAborted();
  return body;
}

function message(text, isError = false) {
  $('#message').textContent = text;
  $('#message').className = isError ? 'error' : 'success';
}

async function loadList() {
  const query = new URLSearchParams();
  if ($('#project').value) query.set('project', $('#project').value);
  if ($('#filter').value) query.set('status', $('#filter').value);
  query.set('offset', String(offset));
  const items = await api(`/api/reports?${query}`);
  const list = $('#list');
  list.replaceChildren();
  if (!items.length) list.textContent = 'Пока нет багов.';
  $('#previous').disabled = offset === 0;
  $('#next').disabled = items.length < 100;
  $('#page').textContent = items.length ? `${offset + 1}–${offset + items.length}` : '0';
  for (const report of items) {
    const button = document.createElement('button');
    button.className = `item ${selected?.id === report.id ? 'active' : ''}`;
    const title = document.createElement('strong');
    title.textContent = report.title;
    const status = document.createElement('span');
    status.className = `status status-${report.status}`;
    status.textContent = statusLabels[report.status] || report.status;
    const meta = document.createElement('span');
    meta.className = 'muted';
    meta.textContent = `${report.reporterName || 'Анонимный пользователь'} · ${new Date(report.createdAt).toLocaleString()}`;
    button.append(title, status, meta);
    button.onclick = () => {
      if (panelMount && !validReportId(report.id)) return message('Неверный номер карточки.', true);
      history.replaceState(null, '', panelPath(`/reports/${report.id}`));
      void showReport(report.id).catch((error) => message(error.message, true));
    };
    list.append(button);
  }
}

function textBlock(parent, heading, value) {
  if (value === undefined || value === null || value === '') return;
  const h = document.createElement('h3');
  h.textContent = heading;
  const p = document.createElement('p');
  p.className = 'body';
  p.textContent = value || '—';
  parent.append(h, p);
}

const canReview = () => ['reviewer', 'admin'].includes(actor?.role);

function field(parent, label, value = '', multiline = false) {
  const wrapper = document.createElement('label');
  wrapper.className = 'field';
  wrapper.textContent = label;
  const control = document.createElement(multiline ? 'textarea' : 'input');
  control.value = value;
  wrapper.append(control);
  parent.append(wrapper);
  return control;
}

async function change(id, action, values = {}) {
  try {
    await api(`/api/reports/${id}`, {method: 'PATCH',
      body: JSON.stringify({revision: selected.revision, action, ...values})});
    message('Сохранено');
    await showReport(id);
    await loadList();
  } catch (error) { message(error.message, true); }
}

function actionButton(parent, label, handler) {
  const button = document.createElement('button');
  button.textContent = label;
  button.onclick = handler;
  parent.append(button);
}

function disclosure(parent, title) {
  const details = document.createElement('details');
  details.className = 'technical';
  const summary = document.createElement('summary');
  summary.textContent = title;
  details.append(summary);
  parent.append(details);
  return details;
}

function readableHistory(history = [], reporterName = '') {
  const actions = {create: 'создал сообщение', triage: 'разобрал баг', claim: 'взял в работу',
    start: 'начал исправление', ask: 'задал вопрос', answer: 'ответил на вопрос',
    resolve: 'передал исправление на проверку', accept: 'принял исправление',
    reject: 'вернул на доработку', cancel: 'отменил баг', reopen: 'открыл баг снова', group: 'связал с другим багом'};
  const list = document.createElement('ol');
  list.className = 'history-list';
  for (const item of history) {
    const row = document.createElement('li');
    const name = item.action === 'create' ? reporterName : item.actor;
    row.append(document.createTextNode(`${name || 'Участник'} · ${new Date(item.at).toLocaleString()} · ${actions[item.action] || 'изменил карточку'} · ${statusLabels[item.status] || item.status}`));
    if (item.note) {
      const note = document.createElement('p');
      note.textContent = item.note;
      row.append(note);
    }
    list.append(row);
  }
  return list;
}

async function showReport(id) {
  if (panelMount && !validReportId(id)) throw new Error('Неверный номер карточки.');
  const generation = ++showing;
  const report = await api(`/api/reports/${id}`);
  if (generation !== showing) return;
  selected = report;
  if (audioUrl) URL.revokeObjectURL(audioUrl); audioUrl = '';
  const detail = $('#detail');
  detail.replaceChildren();
  const heading = document.createElement('h2');
  heading.textContent = selected.title;
  const status = document.createElement('span');
  status.className = `status status-${selected.status}`;
  status.textContent = statusLabels[selected.status] || selected.status;
  const meta = document.createElement('p');
  meta.className = 'muted status-line';
  meta.textContent = `${projectNames.get(selected.projectId) || 'Проект'} · ${selected.reporterName || 'Анонимный пользователь'} · ${new Date(selected.createdAt).toLocaleString()}`;
  detail.append(heading, status, meta);
  textBlock(detail, 'Описание', selected.description);
  if (selected.pageUrl) {
    const pageLink = document.createElement('a');
    pageLink.className = 'page-link';
    pageLink.href = selected.pageUrl;
    pageLink.target = '_blank';
    pageLink.rel = 'noopener noreferrer';
    pageLink.textContent = 'Открыть страницу, где найден баг';
    detail.append(pageLink);
  }
  if (imageUrl) URL.revokeObjectURL(imageUrl);
  imageUrl = '';
  if (selected.screenshotAvailable) {
    imageUrl = URL.createObjectURL(await api(`/api/reports/${id}/screenshot`, {responseType: 'blob'}));
    const img = document.createElement('img');
    img.className = 'report-image';
    img.alt = 'Выделенная область страницы';
    img.src = imageUrl;
    detail.append(img);
  }
  if (selected.attachmentAvailable) {
    const fileName = selected.attachmentName || 'attachment';
    const attachment = document.createElement('div');
    attachment.className = 'attachment-row';
    const name = document.createElement('span');
    name.textContent = `Вложение: ${fileName} (${Math.ceil(selected.attachmentSize / 1024)} КБ)`;
    const download = document.createElement('button');
    download.textContent = 'Скачать файл';
    download.onclick = async () => {
      try {
        const data = await api(`/api/reports/${id}/attachment`, {responseType: 'blob'});
        const objectUrl = URL.createObjectURL(data);
        const link = document.createElement('a');
        link.href = objectUrl;
        link.download = fileName;
        link.click();
        setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
      } catch (error) { message(error.message, true); }
    };
    attachment.append(name, download);
    detail.append(attachment);
  }
  if (selected.audioAvailable) {
    const voice = document.createElement('section');
    const heading = document.createElement('h3'); heading.textContent = 'Голосовое описание';
    const play = document.createElement('button'); play.textContent = 'Загрузить запись';
    const player = document.createElement('audio'); player.controls = true; player.hidden = true;
    play.onclick = async () => {
      play.disabled = true;
      try {
        const blob = await api(`/api/reports/${id}/audio`, {responseType: 'blob'});
        if (generation !== showing) return;
        audioUrl = URL.createObjectURL(blob); player.src = audioUrl; player.hidden = false; play.hidden = true;
      } catch (error) {message(error.message, true); play.disabled = false;}
    };
    voice.append(heading,play,player); detail.append(voice);
    const transcription = selected.transcription || {};
    const labels = {pending:'В очереди распознавания',processing:'Распознаём запись на сервере',ready:'',failed:'Не удалось распознать',unavailable:'Распознавание не настроено'};
    textBlock(voice, 'Расшифровка (автоматическая)', transcription.text || transcription.error || labels[transcription.state]);
    if (selected.voiceEnabled === true && ['failed','unavailable'].includes(transcription.state)) actionButton(voice, 'Повторить распознавание', async () => {
      try {await api(`/api/reports/${id}/transcription`, {method:'POST'}); await showReport(id);}
      catch (error) {message(error.message, true);}
    });
    if (['pending','processing'].includes(transcription.state)) actionButton(voice, 'Обновить расшифровку', () => showReport(id));
  }
  textBlock(detail, 'Что исправлено', selected.resolution);
  textBlock(detail, 'Результат проверки', selected.verificationNote);
  const technical = disclosure(detail, 'Технические сведения');
  textBlock(technical, 'Номер карточки', selected.id);
  textBlock(technical, 'Проект и контур', `${selected.projectId} · ${selected.environment}`);
  textBlock(technical, 'Версия приложения', selected.appVersion);
  textBlock(technical, 'Приоритет', selected.priority);
  textBlock(technical, 'Исполнитель', selected.assignee);
  textBlock(technical, 'Контакт автора', selected.reporterContact);
  textBlock(technical, 'ID автора', selected.reporterId);
  const appUser = selected.appUser || {};
  textBlock(technical, 'Пользователь приложения (не проверено)', [appUser.name, appUser.id, appUser.contact].filter(Boolean).join(' · '));
  textBlock(technical, 'Роль пользователя приложения (не проверено)', appUser.role || '—');
  textBlock(technical, 'Сессия браузера', selected.browserSessionId);
  textBlock(technical, 'Сетевой адрес и источник', [selected.clientIp, selected.clientIpSource].filter(Boolean).join(' · '));
  textBlock(technical, 'Браузер и устройство', selected.userAgent);
  textBlock(technical, 'Окно и масштаб', selected.viewport && Object.keys(selected.viewport).length ? JSON.stringify(selected.viewport) : '');
  textBlock(technical, 'Адрес страницы', selected.pageUrl);
  textBlock(technical, 'Как повторить', selected.steps);
  textBlock(technical, 'Ожидалось', selected.expected);
  textBlock(technical, 'Диагностика', (selected.diagnostics || []).map((item) =>
    `${item.occurredAt || item.at || ''} · ${item.eventType || item.type || ''} · ${item.message || ''}`
    + `${item.method ? ` · ${item.method}` : ''}${item.path ? ` ${item.path}` : ''}`
    + `${item.statusCode ? ` · HTTP ${item.statusCode}` : ''}${item.requestId ? ` · ${item.requestId}` : ''}`).join('\n'));
  textBlock(technical, 'Причина', selected.rootCause);
  if (Object.keys(selected.fixEvidence || {}).length) {
    textBlock(technical, 'Код и проверки', JSON.stringify(selected.fixEvidence, null, 2));
  }
  if (selected.duplicateOf) textBlock(technical, 'Связанный баг', selected.duplicateOf);
  const related = await api(`/api/reports/${id}/related`);
  if (related.length) textBlock(technical, 'Похожие баги', related.map((item) =>
    `${item.id} · ${item.title} · ${statusLabels[item.status]}`).join('\n'));
  actionButton(technical, 'Открыть HTML-отчёт', async () => {
    try {
      const blob = await api(`/api/reports/${id}/html`, {responseType: 'blob'});
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) { message(error.message, true); }
  });
  if (selected.pendingQuestion) textBlock(detail, 'Вопрос команды', selected.pendingQuestion);
  const actions = document.createElement('div');
  actions.className = 'actions review-actions';
  if (canReview() && selected.agentState === 'needs_decision') {
    const answer = field(actions, 'Ответ на вопрос', '', true);
    actionButton(actions, 'Отправить ответ', () => {
      if (!answer.value.trim()) return message('Введите ответ на вопрос.', true);
      void change(id, 'answer', {note: answer.value});
    });
  }
  if (canReview() && selected.status === 'ready_for_check') {
    const note = field(actions, 'Результат проверки или замечание', '', true);
    const submit = (action) => {
      if (!note.value.trim()) return message('Укажите результат проверки или замечание.', true);
      void change(id, action, {note: note.value});
    };
    actionButton(actions, 'Принять исправление', () => submit('accept'));
    actionButton(actions, 'Вернуть на доработку', () => submit('reject'));
  }
  if (actions.childElementCount) detail.append(actions);
  if (selected.history?.length) {
    const history = document.createElement('section');
    history.className = 'history';
    const title = document.createElement('h3');
    title.textContent = 'История изменений';
    history.append(title, readableHistory(selected.history, selected.reporterName));
    detail.append(history);
  }
}

async function enter() {
  if (!panelMount && !token) return;
  try {
    actor = await api('/api/me');
    const projects = await api('/api/projects');
    projectNames = new Map(projects.map((project) => [project.id, project.name]));
    if (!panelMount) sessionStorage.setItem('bug-kit-panel-token', token);
    $('#actor').textContent = actor.name;
    $('#header-session').hidden = false;
    $('#project').replaceChildren(new Option('Все доступные', ''));
    for (const project of projects) $('#project').add(new Option(project.name, project.id));
    $('#project-filter').hidden = projects.length <= 1;
    $(panelMount ? '#gateway-session' : '#login').hidden = true;
    $('#workspace').hidden = false;
    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    $('#from').value = `${month}-01`;
    $('#to').value = `${month}-${String(now.getDate()).padStart(2, '0')}`;
    await loadList();
    const path = panelMount && location.pathname.startsWith(panelMount)
      ? location.pathname.slice(panelMount.length - 1) : location.pathname;
    const id = /^\/reports\/([^/]+)$/.exec(path)?.[1];
    if (id && panelMount && !validReportId(id)) message('Неверный номер карточки.', true);
    else if (id) await showReport(id);
  } catch (error) {
    if (panelMount) {
      showGatewayError(error);
      return;
    }
    sessionStorage.removeItem('bug-kit-panel-token');
    token = '';
    $('#login-error').textContent = error.message;
    $('#login').hidden = false;
    $('#workspace').hidden = true;
    $('#header-session').hidden = true;
  }
}

async function loadLoginProjects() {
  const response = await fetch('/api/panel/projects');
  if (!response.ok) throw new Error('Не удалось загрузить проекты');
  const projects = await response.json();
  const select = $('#login-project');
  select.replaceChildren();
  for (const project of projects) select.add(new Option(project.name, project.id));
  $('#login-project-field').hidden = projects.length <= 1;
  $('#login-button').disabled = $('#register-button').disabled = !projects.length;
  if (!projects.length) $('#login-error').textContent = 'Для входа по PIN включите panelAccess в настройках проекта.';
}

async function signIn(mode) {
  $('#login-error').textContent = '';
  const body = {projectId: $('#login-project').value, name: $('#login-name').value.trim(),
    pin: $('#login-pin').value};
  if (!body.projectId || !body.name || !/^\d{4}$/.test(body.pin)) {
    $('#login-error').textContent = 'Укажите имя и PIN из четырёх цифр.';
    return;
  }
  $('#login-button').disabled = $('#register-button').disabled = true;
  try {
    const response = await fetch(`/api/panel/${mode}`, {method: 'POST',
      headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Не удалось войти');
    token = result.token;
    $('#login-pin').value = '';
    await enter();
  } catch (error) { $('#login-error').textContent = error.message; }
  finally { $('#login-button').disabled = $('#register-button').disabled = false; }
}

function summaryQuery() {
  const query = new URLSearchParams({from: $('#from').value, to: $('#to').value,
    groupBy: 'environment'});
  if ($('#project').value) query.set('project', $('#project').value);
  return query;
}

$('#refresh').onclick = () => loadList().catch((error) => message(error.message, true));
$('#project').onchange = $('#filter').onchange = () => { offset = 0; void loadList().catch((error) => message(error.message, true)); };
$('#previous').onclick = () => { offset = Math.max(0, offset - 100); void loadList().catch((error) => message(error.message, true)); };
$('#next').onclick = () => { offset += 100; void loadList().catch((error) => message(error.message, true)); };
$('#summary-html').onclick = async () => {
  try {
    const blob = await api(`/api/summary/html?${summaryQuery()}`, {responseType: 'blob'});
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (error) { message(error.message, true); }
};
$('#logout').onclick = async (event) => {
  event.preventDefault();
  if (panelMount) {
    try {
      const response = await fetch(panelLogout, {method: 'POST', mode: 'same-origin', credentials: 'same-origin'});
      if (!response.ok) throw new Error('Logout was rejected');
      const check = await fetch(panelPath('/api/me'), gatewayRequest);
      if (![401, 403].includes(check.status)) throw new Error('Gateway session is still active');
      showGatewayError(new Error('Сессия завершилась.'));
      location.replace($('#logout').href);
    } catch {
      message('Не удалось выйти. Повторите попытку.', true);
    }
    return;
  }
  try { await api('/api/panel/logout', {method: 'POST'}); } catch { /* Expired session is already signed out. */ }
  sessionStorage.removeItem('bug-kit-panel-token');
  token = '';
  location.href = '/';
};
if (panelMount) {
  window.addEventListener('pagehide', (event) => {
    if (event.persisted) $('#workspace').hidden = true;
  });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) location.reload();
  });
  void enter();
} else {
  $('#login-button').onclick = () => signIn('login');
  $('#register-button').onclick = () => signIn('register');
  $('#login-pin').onkeydown = (event) => { if (event.key === 'Enter') void signIn('login'); };
  void loadLoginProjects().catch((error) => { $('#login-error').textContent = error.message; });
  if (token) void enter();
}
