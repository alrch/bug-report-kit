import {build} from 'esbuild';
import {readFile} from 'node:fs/promises';

let fontProbePatched = false;
await build({
  // Tailwind's img { display:block } moves html2canvas's hidden baseline probe
  // onto a new line. Fix only that probe, without changing captured page styles.
  plugins: [{name: 'html2canvas-inline-font-probe', setup(build) {
    build.onLoad({filter: /html2canvas(?:\.esm)?\.js$/}, async ({path}) => {
      const source = await readFile(path, 'utf8');
      const marker = 'img.src = SMALL_IMAGE;';
      if (source.split(marker).length !== 2) throw new Error('html2canvas font probe changed; review baseline patch');
      fontProbePatched = true;
      return {contents: source.replace(marker, marker + "\n            img.style.display = 'inline-block';"), loader: 'js'};
    });
  }}],
  entryPoints: ['widget/widget.js'],
  outfile: 'dist/widget.js',
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2022'],
  legalComments: 'linked',
});

if (!fontProbePatched) throw new Error('html2canvas font probe patch was not applied');
