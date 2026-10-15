import {build} from 'esbuild';

await build({
  entryPoints: ['widget/widget.js'],
  outfile: 'dist/widget.js',
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2022'],
  legalComments: 'linked',
});
