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
    const channels = placeholder.color.match(/[\d.]+/g)?.map(Number);
    if (channels?.length >= 3) {
      const alpha = (channels[3] ?? 1) * (parseFloat(placeholder.opacity) || 0);
      input.style.setProperty('color', `rgba(${channels[0]},${channels[1]},${channels[2]},${alpha})`, 'important');
    }
  }
}
