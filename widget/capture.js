import html2canvas from 'html2canvas';

import {preserveCaptureControls} from './capture-controls.js';
import {preserveCaptureText} from './capture-text.js';
import {sanitizeReportUrl} from '../shared/report-url.mjs';
export const safePageUrl = (href = window.location.href) => sanitizeReportUrl(href);

// Snapshot drawing buffers during a render frame, before WebGL's default
// preserveDrawingBuffer=false buffer is discarded by browser compositing.
function canvasFrames(canvases) {
  return new Promise(resolve => {
    let finished = false;
    const take = () => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      resolve(canvases.map(canvas => {
        if (!canvas.width || !canvas.height) return null;
        try {
          const frame = document.createElement('canvas');
          frame.width = canvas.width; frame.height = canvas.height;
          frame.getContext('2d').drawImage(canvas, 0, 0);
          // Detect unreadable cross-origin buffers before rendering the clone.
          frame.getContext('2d').getImageData(0, 0, 1, 1);
          return frame;
        } catch { return {error: true}; }
      }));
    };
    const timer = setTimeout(take, 250);
    requestAnimationFrame(take);
  });
}

export function captureViewport() {
  const canvases = [...document.querySelectorAll('canvas')];
  const frames = canvasFrames(canvases);
  // html2canvas synchronously clones the DOM before its first async image wait.
  // Keep this call before awaiting buffers so menus survive outside-clicks.
  const width = innerWidth, height = innerHeight;
  return html2canvas(document.body, {
    scale: Math.min(2, Math.max(1, devicePixelRatio || 1)),
    x: scrollX + (window.visualViewport?.offsetLeft || 0),
    y: scrollY + (window.visualViewport?.offsetTop || 0),
    width, height,
    useCORS: true, imageTimeout: 3000, logging: false, backgroundColor: '#fff',
    ignoreElements: element => element.hasAttribute('data-bug-report-kit')
      || (element instanceof HTMLImageElement && (!element.complete || element.naturalWidth === 0)),
    onclone: async doc => {
      // html2canvas temporarily resets transforms to measure untransformed boxes.
      // A CSS transition would animate that reset and return an intermediate box,
      // then the renderer would transform it again. Disable transitions only in
      // the isolated clone before any normalization or bounds measurement.
      for (const element of doc.querySelectorAll('*')) {
        element.style?.setProperty('transition', 'none', 'important');
      }
      preserveCaptureText(doc);
      preserveCaptureControls(doc);
      const snapshots = await frames;
      const clones = [...doc.querySelectorAll('canvas')];
      snapshots.forEach((frame, i) => {
        if (frame?.error) throw new Error('Canvas запрещает чтение снимка. Приложите изображение отдельно.');
        if (!frame || !clones[i]) return;
        const replacement = doc.createElement('canvas');
        for (const attr of clones[i].attributes) replacement.setAttribute(attr.name, attr.value);
        replacement.width = frame.width; replacement.height = frame.height;
        replacement.getContext('2d').drawImage(frame, 0, 0);
        clones[i].replaceWith(replacement);
      });
    },
  }).then(canvas => {
    canvas.dataset.captureCssWidth = String(width);
    canvas.dataset.captureCssHeight = String(height);
    return canvas;
  });
}
