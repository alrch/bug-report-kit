const $ = (selector) => document.querySelector(selector);
let token = sessionStorage.getItem('bug-kit-token') || '';
let selected = null;
let imageUrl = '';
let offset = 0;

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
  $('#page').textContent = `${offset + 1}–${offset + items.length}`;
  for (const report of items) {
    const button = document.createElement('button');
    button.className = `item ${selected?.id === report.id ? 'active' : ''}`;
    const title = document.createElement('strong');
    title.textContent = report.description.slice(0, 100);
    const meta = document.createElement('span');
    meta.className = 'muted';
    meta.textContent = `${report.projectId} · ${report.environment} · ${report.status} · ${new Date(report.createdAt).toLocaleString()}`;
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

async function showReport(id) {
  selected = await (await api(`/api/reports/${id}`)).json();
  const detail = $('#detail');
  detail.replaceChildren();
  const heading = document.createElement('h2');
  heading.textContent = `Баг ${selected.id.slice(0, 8)}`;
  const meta = document.createElement('p');
  meta.className = 'muted';
  meta.textContent = `${selected.projectId} · ${selected.environment} · версия ${selected.appVersion || 'не указана'} · ${new Date(selected.createdAt).toLocaleString()}`;
  const url = document.createElement('p');
  url.className = 'body';
  url.textContent = selected.pageUrl;
  detail.append(heading, meta, url);
  textBlock(detail, 'Описание', selected.description);
  if (imageUrl) URL.revokeObjectURL(imageUrl);
  imageUrl = '';
  if (selected.screenshotAvailable) {
    const response = await api(`/api/reports/${id}/screenshot`);
    imageUrl = URL.createObjectURL(await response.blob());
    const img = document.createElement('img');
    img.className = 'report-image';
    img.alt = 'Выделенная область страницы';
    img.src = imageUrl;
    detail.append(img);
  }
  const statusLabel = document.createElement('label');
  statusLabel.textContent = 'Статус ';
  const status = document.createElement('select');
  for (const [value, label] of [['new','Новый'],['in_progress','В работе'],['ready_for_check','На проверке'],['closed','Закрыт']]) {
    const option = document.createElement('option');
    option.value = value; option.textContent = label; status.append(option);
  }
  status.value = selected.status;
  statusLabel.append(status);
  detail.append(statusLabel);
  const rootCause = document.createElement('textarea');
  rootCause.placeholder = 'Причина после разбора';
  rootCause.value = selected.rootCause;
  const resolution = document.createElement('textarea');
  resolution.placeholder = 'Что исправлено и как проверено';
  resolution.value = selected.resolution;
  const note = document.createElement('input');
  note.placeholder = 'Комментарий к изменению';
  note.style.width = '100%';
  const save = document.createElement('button');
  save.className = 'primary';
  save.textContent = 'Сохранить';
  save.onclick = async () => {
    try {
      selected = await (await api(`/api/reports/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({revision: selected.revision, status: status.value,
          rootCause: rootCause.value, resolution: resolution.value, note: note.value}),
      })).json();
      message('Сохранено');
      note.value = '';
      await loadList();
    } catch (error) { message(error.message, true); }
  };
  const exportButton = document.createElement('button');
  exportButton.textContent = 'Открыть HTML-отчёт';
  exportButton.onclick = async () => {
    try {
      const blob = await (await api(`/api/reports/${id}/html`)).blob();
      window.open(URL.createObjectURL(blob), '_blank', 'noopener');
    } catch (error) { message(error.message, true); }
  };
  detail.append(rootCause, resolution, note, save, exportButton);
  textBlock(detail, 'История', selected.history.map((event) =>
    `${event.at} · ${event.actor} · ${event.status}${event.note ? ` · ${event.note}` : ''}`).join('\n'));
}

async function enter() {
  token = $('#token').value.trim() || token;
  if (!token) return;
  try {
    const projects = await (await api('/api/projects')).json();
    sessionStorage.setItem('bug-kit-token', token);
    $('#project').replaceChildren(new Option('Все доступные', ''));
    for (const project of projects) $('#project').add(new Option(project.name, project.id));
    $('#login').hidden = true;
    $('#workspace').hidden = false;
    await loadList();
    const id = /^\/reports\/([^/]+)$/.exec(location.pathname)?.[1];
    if (id) await showReport(id);
  } catch (error) { $('#login').querySelector('.muted').textContent = error.message; }
}

$('#token').value = token;
$('#login-button').onclick = enter;
$('#refresh').onclick = () => loadList().catch((error) => message(error.message, true));
$('#project').onchange = $('#filter').onchange = () => { offset = 0; void loadList().catch((error) => message(error.message, true)); };
$('#previous').onclick = () => { offset = Math.max(0, offset - 100); void loadList().catch((error) => message(error.message, true)); };
$('#next').onclick = () => { offset += 100; void loadList().catch((error) => message(error.message, true)); };
$('#logout').onclick = () => {sessionStorage.removeItem('bug-kit-token'); location.href = '/';};
if (token) void enter();
