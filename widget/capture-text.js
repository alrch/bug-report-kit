// html2canvas 1.4 ignores text-overflow and paints placeholders as input text.
// Materialize these browser-only text styles in its isolated clone.
export function preserveCaptureText(doc) {
  const view = doc.defaultView;
  for (const element of doc.body.querySelectorAll('*')) {
    const style = view.getComputedStyle(element);
    if (style.textOverflow !== 'ellipsis' || style.whiteSpace !== 'nowrap'
      || element.childNodes.length !== 1 || element.firstChild.nodeType !== 3
      || element.scrollWidth <= element.clientWidth) continue;
    const available = element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    if (available <= 0) continue;
    const text = element.textContent;
    const parts = [...new Intl.Segmenter(undefined, {granularity: 'grapheme'}).segment(text)].map(part => part.segment);
    const range = doc.createRange();
    const fits = count => {
      element.firstChild.data = parts.slice(0, count).join('') + '…';
      range.selectNodeContents(element);
      return range.getBoundingClientRect().width <= available;
    };
    let low = 0, high = parts.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (fits(middle)) low = middle;
      else high = middle - 1;
    }
    fits(low);
    // Layout and clipping remain the browser's original dimensions.
  }
  for (const input of doc.querySelectorAll('input[placeholder],textarea[placeholder]')) {
    if (input.value || !input.placeholder) continue;
    const placeholder = view.getComputedStyle(input, '::placeholder');
    if (!/^rgba?\(/.test(placeholder.color)) continue;
    if (input.tagName === 'TEXTAREA') input.value = input.placeholder;
    const channels = placeholder.color.match(/[\d.]+/g)?.map(Number);
    if (channels?.length >= 3) {
      const alpha = (channels[3] ?? 1) * (parseFloat(placeholder.opacity) || 0);
      input.style.setProperty('color', `rgba(${channels[0]},${channels[1]},${channels[2]},${alpha})`, 'important');
    }
  }
  // Native textarea painting in html2canvas is single-line. Let the clone's
  // normal layout engine wrap its value, retaining the visible scroll window.
  for (const textarea of doc.querySelectorAll('textarea')) {
    const style = view.getComputedStyle(textarea);
    const box = doc.createElement('div');
    for (const property of style) box.style.setProperty(property, style.getPropertyValue(property));
    box.style.setProperty('overflow', 'hidden', 'important');
    const text = doc.createElement('div');
    Object.assign(text.style, {
      whiteSpace: textarea.wrap === 'off' ? 'pre' : 'pre-wrap',
      overflowWrap: 'break-word',
      width: `${textarea.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)}px`,
      transform: `translate(${-textarea.scrollLeft}px, ${-textarea.scrollTop}px)`,
    });
    text.textContent = textarea.value;
    box.append(text);
    textarea.replaceWith(box);
  }

}
