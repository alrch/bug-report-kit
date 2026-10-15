const $ = (selector) => document.querySelector(selector);
let token = sessionStorage.getItem('bug-kit-token') || '';
let selected = null;
let imageUrl = '';
let offset = 0;
let actor = null;
const statusLabels = {new:'Новый',triaged:'Разобран',in_progress:'В работе',
  ready_for_check:'На проверке',closed:'Закрыт',cancelled:'Отменён'};

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {Authorization: `Bearer ${token}`, ...(options.body ? {'Content-Type': 'application/json'} : {})},
  });
  if (response.status === 401) throw new Error('Токен не принят');
  if (!response.ok) throw new Error((await response.json()).error || 'Ошибка сервера');
  return response;
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
  const items = await (await api(`/api/reports?${query}`)).json();
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
    const meta = document.createElement('span');
    meta.className = 'muted';
    meta.textContent = `${report.projectId} · ${report.environment} · ${statusLabels[report.status]} · ${new Date(report.createdAt).toLocaleString()}`;
    button.append(title, meta);
    button.onclick = () => { history.replaceState(null, '', `/reports/${report.id}`); void showReport(report.id); };
    list.append(button);
  }
}

function textBlock(parent, heading, value) {
  const h = document.createElement('h3');
  h.textContent = heading;
  const p = document.createElement('p');
  p.className = 'body';
  p.textContent = value || '—';
  parent.append(h, p);
}

const canReview = () => ['reviewer', 'admin'].includes(actor?.role);
const canDevelop = () => ['developer', 'admin'].includes(actor?.role);

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

async function showReport(id) {
  selected = await (await api(`/api/reports/${id}`)).json();
  const detail = $('#detail');
  detail.replaceChildren();
  const heading = document.createElement('h2');
  heading.textContent = selected.title;
  const meta = document.createElement('p');
  meta.className = 'muted';
  meta.textContent = `${selected.id} · ${selected.projectId} · ${selected.environment} · ${statusLabels[selected.status]} · ${selected.priority} · версия ${selected.appVersion || 'не указана'}`;
  detail.append(heading, meta);
  textBlock(detail, 'Адрес страницы', selected.pageUrl);
  textBlock(detail, 'Описание', selected.description);
  textBlock(detail, 'Как повторить', selected.steps);
  textBlock(detail, 'Ожидалось', selected.expected);
  textBlock(detail, 'Исполнитель', selected.assignee);
  if (selected.pendingQuestion) textBlock(detail, 'Ожидает ответа', selected.pendingQuestion);
  if (imageUrl) URL.revokeObjectURL(imageUrl);
  imageUrl = '';
  if (selected.screenshotAvailable) {
    imageUrl = URL.createObjectURL(await (await api(`/api/reports/${id}/screenshot`)).blob());
    const img = document.createElement('img');
    img.className = 'report-image';
    img.alt = 'Выделенная область страницы';
    img.src = imageUrl;
    detail.append(img);
  }
  textBlock(detail, 'Диагностика', selected.diagnostics.map((item) =>
    `${item.occurredAt || item.at || ''} · ${item.eventType || item.type || ''} · ${item.message || ''}`
    + `${item.method ? ` · ${item.method}` : ''}${item.path ? ` ${item.path}` : ''}`
    + `${item.statusCode ? ` · HTTP ${item.statusCode}` : ''}${item.requestId ? ` · ${item.requestId}` : ''}`).join('\n'));
  textBlock(detail, 'Причина', selected.rootCause);
  textBlock(detail, 'Исправление', selected.resolution);
  textBlock(detail, 'Код и проверки', JSON.stringify(selected.fixEvidence, null, 2));
  textBlock(detail, 'Приёмка', selected.verificationNote);
  if (selected.duplicateOf) textBlock(detail, 'Основной баг группы', selected.duplicateOf);
  const related = await (await api(`/api/reports/${id}/related`)).json();
  if (related.length) textBlock(detail, 'Похожие баги', related.map((item) =>
    `${item.id} · ${item.title} · ${statusLabels[item.status]}`).join('\n'));

  const note = field(detail, 'Комментарий, вопрос или ответ', '', true);
  const actions = document.createElement('div');
  actions.className = 'actions';
  if (canReview() && selected.status === 'new') {
    const priority = document.createElement('select');
    for (const value of ['low', 'normal', 'high', 'critical']) priority.add(new Option(value, value));
    priority.value = selected.priority;
    const label = document.createElement('label');
    label.className = 'field'; label.textContent = 'Приоритет '; label.append(priority); detail.append(label);
    actionButton(actions, 'Разобрать', () => change(id, 'triage', {priority: priority.value, note: note.value}));
  }
  if (canDevelop() && ['new', 'triaged', 'in_progress'].includes(selected.status) && !selected.assignee) {
    actionButton(actions, 'Взять в работу', () => change(id, 'claim'));
  }
  if (canDevelop() && selected.status === 'triaged' && selected.assignee === actor.name
    && selected.agentState !== 'needs_decision') actionButton(actions, 'Начать исправление', () => change(id, 'start'));
  if (canDevelop() && ['triaged', 'in_progress'].includes(selected.status)
    && selected.assignee === actor.name && selected.agentState !== 'needs_decision') {
    actionButton(actions, 'Задать вопрос', () => change(id, 'ask', {note: note.value}));
  }
  if (canReview() && selected.agentState === 'needs_decision') {
    actionButton(actions, 'Ответить', () => change(id, 'answer', {note: note.value}));
  }
  if (canDevelop() && selected.status === 'in_progress' && selected.assignee === actor.name
    && selected.agentState !== 'needs_decision') {
    const rootCause = field(detail, 'Причина бага', selected.rootCause, true);
    const resolution = field(detail, 'Что исправлено', selected.resolution, true);
    const repository = field(detail, 'Репозиторий', selected.fixEvidence.repositories?.[0]?.name || '');
    const ref = field(detail, 'Коммит или PR', selected.fixEvidence.repositories?.[0]?.ref || '');
    const check = field(detail, 'Проверка', selected.fixEvidence.checks?.[0]?.name || '');
    const result = field(detail, 'Результат проверки (passed)', selected.fixEvidence.checks?.[0]?.result || 'passed');
    actionButton(actions, 'Передать на проверку', () => change(id, 'resolve', {
      rootCause: rootCause.value, resolution: resolution.value,
      fixEvidence: {repositories: [{name: repository.value, ref: ref.value}],
        checks: [{name: check.value, result: result.value}]}, note: note.value,
    }));
  }
  if (canReview() && selected.status === 'ready_for_check') {
    actionButton(actions, 'Принять и закрыть', () => change(id, 'accept', {note: note.value}));
    actionButton(actions, 'Вернуть на доработку', () => change(id, 'reject', {note: note.value}));
  }
  if (canReview() && ['new', 'triaged'].includes(selected.status)) {
    actionButton(actions, 'Отменить', () => change(id, 'cancel', {note: note.value}));
  }
  if (canReview() && ['closed', 'cancelled'].includes(selected.status)) {
    actionButton(actions, 'Открыть снова', () => change(id, 'reopen', {note: note.value}));
  }
  if (canReview()) {
    const duplicate = field(detail, 'ID основного бага для группировки', selected.duplicateOf);
    actionButton(actions, 'Сохранить группу', () => change(id, 'group', {duplicateOf: duplicate.value, note: note.value}));
  }
  actionButton(actions, 'Открыть HTML-тикет', async () => {
    try {
      const blob = await (await api(`/api/reports/${id}/html`)).blob();
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (error) { message(error.message, true); }
  });
  detail.append(actions);
  textBlock(detail, 'История', selected.history.map((item) =>
    `${item.at} · ${item.actor} · ${item.action || 'change'} · ${statusLabels[item.status] || item.status}${item.note ? ` · ${item.note}` : ''}`).join('\n'));
}

async function enter() {
  token = $('#token').value.trim() || token;
  if (!token) return;
  try {
    actor = await (await api('/api/me')).json();
    const projects = await (await api('/api/projects')).json();
    sessionStorage.setItem('bug-kit-token', token);
    $('#actor').textContent = `${actor.name} · ${actor.role}`;
    $('#project').replaceChildren(new Option('Все доступные', ''));
    for (const project of projects) $('#project').add(new Option(project.name, project.id));
    $('#login').hidden = true;
    $('#workspace').hidden = false;
    const today = new Date().toISOString().slice(0, 10);
    $('#to').value = today;
    $('#from').value = `${today.slice(0, 8)}01`;
    await loadList();
    const id = /^\/reports\/([^/]+)$/.exec(location.pathname)?.[1];
    if (id) await showReport(id);
  } catch (error) { $('#login').querySelector('.muted').textContent = error.message; }
}

function summaryQuery() {
  const query = new URLSearchParams({from: $('#from').value, to: $('#to').value,
    groupBy: $('#group-by').value});
  if ($('#project').value) query.set('project', $('#project').value);
  return query;
}

async function showSummary() {
  try {
    const result = await (await api(`/api/summary?${summaryQuery()}`)).json();
    const summary = $('#summary');
    summary.replaceChildren();
    textBlock(summary, 'Создано', String(result.created));
    textBlock(summary, 'Принято исправлений', String(result.fixed));
    textBlock(summary, 'Созданные по статусу', result.byStatus.map((item) =>
      `${statusLabels[item.key]}: ${item.count}`).join('\n'));
    textBlock(summary, 'Группы исправлений', result.fixedGroups.map((item) =>
      `${item.key}: ${item.count}`).join('\n'));
  } catch (error) { message(error.message, true); }
}

$('#token').value = token;
$('#login-button').onclick = enter;
$('#refresh').onclick = () => loadList().catch((error) => message(error.message, true));
$('#project').onchange = $('#filter').onchange = () => { offset = 0; void loadList().catch((error) => message(error.message, true)); };
$('#previous').onclick = () => { offset = Math.max(0, offset - 100); void loadList().catch((error) => message(error.message, true)); };
$('#next').onclick = () => { offset += 100; void loadList().catch((error) => message(error.message, true)); };
$('#show-summary').onclick = showSummary;
$('#summary-html').onclick = async () => {
  try {
    const blob = await (await api(`/api/summary/html?${summaryQuery()}`)).blob();
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (error) { message(error.message, true); }
};
$('#logout').onclick = () => {sessionStorage.removeItem('bug-kit-token'); location.href = '/';};
if (token) void enter();
