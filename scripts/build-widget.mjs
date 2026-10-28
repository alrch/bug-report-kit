import {build} from 'esbuild';
import {copyFileSync} from 'node:fs';
import {html2canvasPatches} from './html2canvas-patches.mjs';

await build({
  plugins:[html2canvasPatches()],
  entryPoints:['widget/widget.js'],
  outfile:'dist/widget.js',
  bundle:true,
  minify:true,
  format:'iife',
  target:['es2022'],
  legalComments:'linked',
});

// Self-contained early feedback, without capture/html2canvas in the dependency graph.
await build({entryPoints:['widget/loader.js'], outfile:'dist/loader.js', bundle:true,
  minify:true, format:'iife', target:['es2022'], legalComments:'none'});

// Pinned ES module for SPA consumers. Capture is still loaded on demand by loader.
await build({entryPoints:['widget/client.js'], outfile:'dist/client.mjs', bundle:true,
  minify:true, format:'esm', target:['es2022'], legalComments:'none'});
copyFileSync('widget/client.d.mts', 'dist/client.d.mts');
