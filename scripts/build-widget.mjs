import {build} from 'esbuild';
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
