// CSS box-shadow is unsupported by html2canvas. Some slider thumbs use a
// zero-blur spread shadow as their only visible outline. Paint that outline
// as a real border in the clone, without changing the slider's own geometry.
export function preserveCaptureControls(doc) {
  for (const summary of doc.querySelectorAll('summary')) {
    const style = doc.defaultView.getComputedStyle(summary);
    if (!['disclosure-closed','disclosure-open'].includes(style.listStyleType)
      || style.listStylePosition !== 'inside' || !summary.textContent) continue;
    const range = doc.createRange(); range.selectNodeContents(summary);
    const gap = range.getBoundingClientRect().left - summary.getBoundingClientRect().left - parseFloat(style.paddingLeft);
    if (gap <= 0 || gap > 2 * parseFloat(style.fontSize)) continue;
    const marker = doc.createElement('span');
    marker.textContent = summary.parentElement.open ? '▼' : '▶';
    Object.assign(marker.style, {display:'inline-block',width:`${gap}px`,fontSize:'.75em',color:style.color});
    summary.style.setProperty('list-style-type','none','important');
    summary.prepend(marker);
  }
  for (const slider of doc.querySelectorAll('[role="slider"]')) {
    const pseudo = doc.defaultView.getComputedStyle(slider, '::after');
    const ring = pseudo.boxShadow.match(/^(rgba?\([^)]+\)) 0px 0px 0px ([\d.]+)px$/);
    if (!ring || pseudo.position !== 'absolute' || pseudo.transform !== 'none'
      || parseFloat(pseudo.borderWidth) > 0 || pseudo.content === 'none') continue;
    const width = parseFloat(pseudo.width), height = parseFloat(pseudo.height);
    const left = parseFloat(pseudo.left), top = parseFloat(pseudo.top), spread = Number(ring[2]);
    if (![width,height,left,top,spread].every(Number.isFinite) || spread <= 0) continue;
    const outline = doc.createElement('span');
    outline.setAttribute('aria-hidden', 'true');
    Object.assign(outline.style, {position: 'absolute', pointerEvents: 'none',
      boxSizing: 'border-box', width: `${width + 2 * spread}px`, height: `${height + 2 * spread}px`,
      left: `${left - spread}px`, top: `${top - spread}px`, border: `${spread}px solid ${ring[1]}`,
      borderRadius: pseudo.borderRadius, backgroundColor: pseudo.backgroundColor});
    slider.append(outline);
  }
}
