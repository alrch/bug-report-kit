export function openScreenshotPreview(root, src, trigger) {
  const dialog = document.createElement('dialog');
  dialog.className = 'screenshot-viewer';
  dialog.setAttribute('aria-label', 'Просмотр снимка');
  const toolbar = document.createElement('div');
  toolbar.className = 'screenshot-viewer-toolbar';
  const zoom = document.createElement('button');
  zoom.type = 'button'; zoom.textContent = 'Масштаб 1:1';
  zoom.setAttribute('aria-pressed', 'false');
  const close = document.createElement('button');
  close.type = 'button'; close.textContent = 'Закрыть снимок';
  const viewport = document.createElement('div');
  viewport.className = 'screenshot-viewer-viewport'; viewport.tabIndex = 0;
  viewport.setAttribute('aria-label', 'Снимок с прокруткой');
  const image = document.createElement('img');
  image.src = src; image.alt = 'Снимок выбранной области';
  zoom.onclick = () => {
    const actual = zoom.getAttribute('aria-pressed') !== 'true';
    zoom.setAttribute('aria-pressed', String(actual));
    zoom.textContent = actual ? 'Вписать в окно' : 'Масштаб 1:1';
    viewport.classList.toggle('is-actual', actual);
  };
  close.onclick = () => dialog.close();
  dialog.addEventListener('close', () => { dialog.remove(); trigger.focus(); }, {once:true});
  toolbar.append(zoom, close); viewport.append(image); dialog.append(toolbar, viewport);
  root.append(dialog); dialog.showModal(); close.focus();
}
