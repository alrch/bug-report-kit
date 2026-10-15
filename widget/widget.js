import html2canvas from 'html2canvas';

const styles = `
  :host{all:initial;font:14px system-ui,sans-serif;color:#172033}
  *{box-sizing:border-box}
  button,textarea,input{font:inherit}
  button{cursor:pointer}
  .launcher{position:fixed;right:20px;bottom:20px;z-index:2147483000;border:0;border-radius:999px;padding:12px 18px;background:#2047d9;color:white;box-shadow:0 4px 18px #0004}
  .overlay{position:fixed;inset:0;z-index:2147483001;cursor:crosshair;background:#14213d30}
  .hint{position:absolute;top:18px;left:50%;transform:translateX(-50%);border-radius:8px;background:#fff;padding:10px 14px;box-shadow:0 2px 12px #0003}
  .box{position:absolute;border:2px solid #2047d9;background:#2047d933;pointer-events:none}
  .backdrop{position:fixed;inset:0;z-index:2147483002;background:#0008;display:grid;place-items:center;padding:16px}
  .card{width:min(520px,100%);max-height:90vh;overflow:auto;background:#fff;border-radius:12px;padding:20px;box-shadow:0 8px 40px #0004}
  h2{margin:0 0 12px;font-size:20px}
  .preview{display:block;max-width:100%;max-height:240px;object-fit:contain;margin:12px 0;border:1px solid #ddd}
  textarea{display:block;width:100%;min-height:110px;padding:10px;border:1px solid #aab2c1;border-radius:6px;resize:vertical}
  .row{display:flex;gap:8px;justify-content:flex-end;margin-top:14px}
  .row button{padding:8px 14px;border-radius:6px;border:1px solid #aab2c1;background:white}
  .row .primary{border-color:#2047d9;background:#2047d9;color:white}
  .error{color:#a52222}
  .success{color:#146338}
  .meta{color:#586579;font-size:12px;overflow-wrap:anywhere}
`;

const button = (label, className = '') => {
  const node = document.createElement('button');
  node.textContent = label;
  node.className = className;
  node.type = 'button';
  return node;
};

async function compress(canvas) {
  let current = canvas;
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

function init({serverUrl, projectKey, label = 'Сообщить о баге'} = {}) {
  if (!serverUrl || !projectKey) throw new Error('Нужны serverUrl и projectKey');
  const host = document.createElement('div');
  host.dataset.bugReportKit = '';
  document.body.append(host);
  const root = host.attachShadow({mode: 'open'});
  const css = document.createElement('style');
  css.textContent = styles;
  root.append(css);
  const launcher = button(label, 'launcher');
  root.append(launcher);
  const base = serverUrl.replace(/\/$/, '');

  function showForm({screenshot, selection, error = ''}) {
    launcher.hidden = true;
    const backdrop = document.createElement('div');
    backdrop.className = 'backdrop';
    const card = document.createElement('div');
    card.className = 'card';
    const title = document.createElement('h2');
    title.textContent = 'Сообщить о баге';
    const meta = document.createElement('p');
    meta.className = 'meta';
    meta.textContent = window.location.href.split('?')[0];
    const preview = document.createElement('img');
    preview.className = 'preview';
    preview.alt = 'Выделенная область';
    if (screenshot) preview.src = screenshot;
    else preview.hidden = true;
    const description = document.createElement('textarea');
    description.placeholder = 'Что произошло? Как повторить ошибку?';
    description.maxLength = 4000;
    const uploadLabel = document.createElement('label');
    uploadLabel.textContent = 'Если снимок не получился, приложите изображение: ';
    const upload = document.createElement('input');
    upload.type = 'file';
    upload.accept = 'image/png,image/jpeg,image/webp';
    uploadLabel.append(upload);
    upload.onchange = () => {
      const file = upload.files?.[0];
      if (!file) return;
      if (file.size > 2 * 1024 * 1024) { status.textContent = 'Изображение больше 2 МБ'; return; }
      const reader = new FileReader();
      reader.onload = () => { screenshot = String(reader.result); preview.src = screenshot; preview.hidden = false; status.textContent = ''; };
      reader.readAsDataURL(file);
    };
    const status = document.createElement('p');
    status.className = 'error';
    status.textContent = error;
    const actions = document.createElement('div');
    actions.className = 'row';
    const cancel = button('Отмена');
    cancel.onclick = () => { backdrop.remove(); launcher.hidden = false; };
    const send = button('Отправить', 'primary');
    send.onclick = async () => {
      if (!description.value.trim()) { status.textContent = 'Опишите проблему'; return; }
      send.disabled = true;
      status.textContent = 'Отправляем…';
      try {
        const response = await fetch(`${base}/api/reports`, {
          method: 'POST',
          headers: {'Content-Type': 'application/json', 'X-Project-Key': projectKey},
          body: JSON.stringify({
            description: description.value.trim(),
            pageUrl: window.location.href,
            viewport: {width: innerWidth, height: innerHeight, pixelRatio: devicePixelRatio},
            selection,
            screenshot,
          }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Не удалось отправить');
        status.className = 'success';
        status.textContent = `Отправлено: ${result.id}`;
        send.remove();
        cancel.textContent = 'Закрыть';
      } catch (cause) {
        status.className = 'error';
        status.textContent = cause.message || 'Не удалось отправить';
        send.disabled = false;
      }
    };
    actions.append(cancel, send);
    card.append(title, meta, preview, description, uploadLabel, status, actions);
    backdrop.append(card);
    root.append(backdrop);
    description.focus();
  }

  launcher.onclick = () => {
    launcher.hidden = true;
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'Выделите область мышью · Esc — отмена';
    const box = document.createElement('div');
    box.className = 'box';
    overlay.append(hint, box);
    root.append(overlay);
    let start = null;
    const onKey = (event) => {
      if (event.key === 'Escape') { overlay.remove(); launcher.hidden = false; window.removeEventListener('keydown', onKey); }
    };
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
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
      try {
        const scale = Math.min(2, Math.max(1, devicePixelRatio || 1));
        const page = await html2canvas(document.body, {
          x: scrollX, y: scrollY, width: innerWidth, height: innerHeight,
          scale, useCORS: true, imageTimeout: 3000, logging: false,
          ignoreElements: (element) => element.hasAttribute('data-bug-report-kit'),
        });
        const cropped = document.createElement('canvas');
        cropped.width = Math.round(selection.width * scale);
        cropped.height = Math.round(selection.height * scale);
        cropped.getContext('2d').drawImage(page,
          selection.x * scale, selection.y * scale, cropped.width, cropped.height,
          0, 0, cropped.width, cropped.height);
        showForm({screenshot: await compress(cropped), selection});
      } catch (cause) {
        showForm({screenshot: null, selection, error: `Снимок не получился: ${cause.message}. Можно приложить файл.`});
      }
    };
  };
  return {destroy: () => host.remove()};
}

window.BugReportKit = {init};
const script = document.currentScript;
if (script?.dataset.projectKey) {
  init({
    serverUrl: script.dataset.serverUrl || new URL(script.src).origin,
    projectKey: script.dataset.projectKey,
    label: script.dataset.label,
  });
}
