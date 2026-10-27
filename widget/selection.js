import {layoutViewport} from './viewport.js';
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
export function updateRect(rect, mode, dx, dy, width, height) {
  const rw = clamp(rect.width, Math.min(24, width), width), rh = clamp(rect.height, Math.min(24, height), height);
  rect = {x:clamp(rect.x,0,width-rw), y:clamp(rect.y,0,height-rh), width:rw, height:rh};
  if (mode === 'move') return {...rect, x:clamp(rect.x + dx, 0, width - rect.width), y:clamp(rect.y + dy, 0, height - rect.height)};
  let left = rect.x, top = rect.y, right = left + rect.width, bottom = top + rect.height;
  if (mode.includes('w')) left = clamp(left + dx, 0, right - 24);
  if (mode.includes('e')) right = clamp(right + dx, left + 24, width);
  if (mode.includes('n')) top = clamp(top + dy, 0, bottom - 24);
  if (mode.includes('s')) bottom = clamp(bottom + dy, top + 24, height);
  return {x:left, y:top, width:right-left, height:bottom-top};
}

export function selectionControls(overlay, box, hint, onConfirm, onCancel, onWithout, bounds = layoutViewport(), origin = {x:0,y:0}) {
  const {width,height} = bounds;
  const point = event => {
    const layer = overlay.getBoundingClientRect();
    return {x:clamp(event.clientX-layer.left-origin.x,0,width),
      y:clamp(event.clientY-layer.top-origin.y,0,height)};
  };
  let rect = null, drag = null;
  box.tabIndex = 0; box.setAttribute('role', 'group'); box.setAttribute('aria-label', 'Область снимка');
  const tools = document.createElement('div'); tools.className = 'selection-tools';
  const make = (text, label, action) => {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.setAttribute('aria-label', label); b.onclick = action; tools.append(b); return b;
  };
  const confirm = make('✓', 'Подтвердить выделение', () => {if (rect && !drag) onConfirm({...rect});});
  const clear = make('×', 'Снять выделение', () => {rect = null; drag = null; render();});
  make('Без снимка', 'Продолжить без снимка', onWithout);
  make('Отмена', 'Отменить снимок', onCancel).className = 'selection-cancel';
  tools.onpointerdown = event => event.stopPropagation();
  overlay.append(tools);
  const placeTools = () => {
    const v = window.visualViewport;
    if (!v) return;
    const scale = v.scale || 1;
    Object.assign(tools.style, {bottom:'auto',left:`${v.offsetLeft+v.width/2}px`,top:`${v.offsetTop+v.height-80/scale}px`,transform:`translateX(-50%) scale(${1/scale})`,transformOrigin:'50% 0'});
  };
  placeTools();
  window.visualViewport?.addEventListener('resize', placeTools);
  window.visualViewport?.addEventListener('scroll', placeTools);
  for (const edge of ['nw','n','ne','e','se','s','sw','w']) {
    const handle = document.createElement('button'); handle.type = 'button'; handle.dataset.edge = edge;
    handle.className = `selection-handle handle-${edge}`; handle.setAttribute('aria-label', `Изменить границу ${edge}`);
    handle.onkeydown = event => {
      if (!rect || !['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const step = event.shiftKey ? 10 : 1;
      rect = updateRect(rect, edge, event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0,
        event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0, width, height); render();
    };
    box.append(handle);
  }
  const render = () => {
    box.hidden = !rect;
    confirm.disabled = !rect || rect.width < 24 || rect.height < 24;
    clear.disabled = !rect;
    hint.textContent = rect ? 'Передвиньте рамку или её границы, затем нажмите ✓' : 'Выделите проблемную область';
    if (rect) Object.assign(box.style, {left:`${rect.x+origin.x}px`,top:`${rect.y+origin.y}px`,width:`${rect.width}px`,height:`${rect.height}px`});
  };
  overlay.onpointerdown = event => {
    if (event.button !== 0 || event.isPrimary === false || drag) return;
    const {x,y} = point(event);
    const mode = event.target.dataset.edge || (box.contains(event.target) ? 'move' : 'draw');
    drag = {id:event.pointerId, x, y, mode, original:rect && {...rect}};
    if (mode === 'draw') rect = {x,y,width:0,height:0};
    overlay.setPointerCapture(event.pointerId); event.preventDefault(); render();
  };
  overlay.onpointermove = event => {
    if (!drag || event.pointerId !== drag.id) return;
    const {x,y} = point(event);
    rect = drag.mode === 'draw' ? {x:Math.min(x,drag.x),y:Math.min(y,drag.y),width:Math.abs(x-drag.x),height:Math.abs(y-drag.y)}
      : updateRect(drag.original, drag.mode, x-drag.x, y-drag.y, width, height);
    render();
  };
  overlay.onpointerup = event => {
    if (!drag || event.pointerId !== drag.id) return;
    overlay.onpointermove(event); drag = null; if (rect.width < 24 || rect.height < 24) rect = null; render();
  };
  overlay.onpointercancel = event => {
    if (!drag || event.pointerId !== drag.id) return;
    rect = drag.original; drag = null; render();
  };
  box.onkeydown = event => {
    if (event.target !== box || !rect || !['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const step = event.shiftKey ? 10 : 1;
    rect = updateRect(rect, 'move', event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0,
      event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0, width, height); render();
  };
  render();
  return {confirm:()=>confirm.click(), dispose(){window.visualViewport?.removeEventListener('resize',placeTools);window.visualViewport?.removeEventListener('scroll',placeTools);}};
}
