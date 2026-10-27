import {layoutViewport} from './viewport.js';
import html2canvas from 'html2canvas';

import {preserveCaptureControls} from './capture-controls.js';
import {preserveCaptureColors} from './capture-colors.js';
import {preserveCaptureText} from './capture-text.js';
import {sanitizeReportUrl} from '../shared/report-url.mjs';
export const safePageUrl = (href = window.location.href) => sanitizeReportUrl(href);

// Snapshot drawing buffers during a render frame, before WebGL's default
// preserveDrawingBuffer=false buffer is discarded by browser compositing.
function canvasFrames(canvases, {width,height}) {
  return new Promise(resolve => {
    let finished = false;
    const take = () => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      resolve(canvases.map(canvas => {
        const rect = canvas.getBoundingClientRect();
        if (!canvas.width || !canvas.height || !rect.width || !rect.height
          || rect.right <= 0 || rect.bottom <= 0 || rect.left >= width || rect.top >= height) return null;
        canvas.dispatchEvent(new Event('bug-report-kit:before-canvas-capture'));
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
  const bounds = layoutViewport();
  const canvases = [...document.querySelectorAll('canvas')];
  const frames = canvasFrames(canvases, bounds);
  // html2canvas synchronously clones the DOM before its first async image wait.
  // Keep this call before awaiting buffers so menus survive outside-clicks.
  const {width,height} = bounds;
  const originX = scrollX, originY = scrollY;
  // Pinch zoom magnifies the bitmap as well as the live page. Render enough
  // pixels for the current physical display density, with a bounded allocation
  // for very large viewports or extreme zoom (16M pixels, at most8192 per edge).
  const density = Math.max(1, devicePixelRatio || 1) * Math.max(1, window.visualViewport?.scale || 1);
  const scale = Math.min(density, Math.sqrt(16000000 / (width * height)), 8192 / width, 8192 / height);
  return html2canvas(document.body, {
    scale,
    // The frozen canvas and pointer.clientX/Y use layout-viewport coordinates.
    // Pinch pan is applied by the browser to both; adding it here applies it twice.
    x: originX, y: originY,
    width, height, windowWidth:width, windowHeight:height,
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
      preserveCaptureColors(doc);
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
    canvas.dataset.captureScrollX = String(originX);
    canvas.dataset.captureScrollY = String(originY);
    return canvas;
  });
}
