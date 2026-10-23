// html2canvas 1.x understands legacy rgb/hsl but computed styles may contain
// color(srgb ...), oklch(), etc. Resolve those colors with the browser's own
// sRGB canvas conversion, exclusively in the detached capture document.
const MODERN_COLOR = /\b(?:color(?:-mix)?|oklab|oklch|lab|lch)\(/i;
const PROPERTIES = ['color', 'background-color', 'border-top-color', 'border-right-color',
  'border-bottom-color', 'border-left-color', 'outline-color', 'text-decoration-color',
  'column-rule-color', '-webkit-text-stroke-color', 'box-shadow', 'text-shadow',
  'background-image', 'fill', 'stroke'];

export function preserveCaptureColors(doc) {
  const view = doc.defaultView;
  const canvas = doc.createElement('canvas');
  canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d', {willReadFrequently: true});
  const cache = new Map();
  const resolve = color => {
    if (cache.has(color)) return cache.get(color);
    if (!view.CSS.supports('color', color)) return color;
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
    const resolved = `rgba(${r}, ${g}, ${b}, ${a / 255})`;
    cache.set(color, resolved);
    return resolved;
  };
  const convert = value => {
    let output = '', rest = value;
    while (MODERN_COLOR.test(rest)) {
      const index = rest.search(MODERN_COLOR);
      const opening = rest.indexOf('(', index);
      let depth = 1, end = opening + 1;
      while (end < rest.length && depth) {
        if (rest[end] === '(') depth++;
        else if (rest[end] === ')') depth--;
        end++;
      }
      if (depth) break;
      output += rest.slice(0, index) + resolve(rest.slice(index, end));
      rest = rest.slice(end);
    }
    return output + rest;
  };
  for (const element of doc.querySelectorAll('*')) {
    if (!element.style) continue;
    const style = view.getComputedStyle(element);
    for (const property of PROPERTIES) {
      const value = style.getPropertyValue(property);
      if (MODERN_COLOR.test(value)) element.style.setProperty(property, convert(value), 'important');
    }
  }
}
