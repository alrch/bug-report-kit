import {readFile} from 'node:fs/promises';

export function html2canvasPatches() {
  let applied=false;
  return {name:'html2canvas-capture-fidelity',setup(build){
    build.onEnd(()=>{if(!applied) throw new Error('html2canvas capture patches were not applied');});
    build.onLoad({filter:/html2canvas(?:\.esm)?\.js$/},async ({path})=>{
      let source=await readFile(path,'utf8');
      const replace=(marker,replacement)=>{
        if(source.split(marker).length!==2) throw new Error(`html2canvas changed; review patch: ${marker}`);
        source=source.replace(marker,replacement);
      };
      replace('img.src = SMALL_IMAGE;',"img.src = SMALL_IMAGE;\n            img.style.display = 'inline-block';");
      replace('var s = new XMLSerializer();',"img.style.transform = 'none';\n        var s = new XMLSerializer();");
      // Reversing only the corner order makes rounded mask paths self-intersect.
      // Reverse each Bezier's direction as well to cut out the entire surface.
      replace('this.formatPath(paths.slice(0).reverse());','this.formatPath(paths.slice(0).reverse().map(function(point) { return isBezierCurve(point) ? point.reverse() : point; }));');
      // Canvas shadow offsets and blur are device pixels, unlike scaled paths.
      replace('_this.ctx.shadowOffsetX = shadow.offsetX.number + maskOffset;','_this.ctx.shadowOffsetX = (shadow.offsetX.number + maskOffset) * _this.options.scale;');
      replace('_this.ctx.shadowOffsetY = shadow.offsetY.number;','_this.ctx.shadowOffsetY = shadow.offsetY.number * _this.options.scale;');
      replace('_this.ctx.shadowBlur = shadow.blur.number;','_this.ctx.shadowBlur = shadow.blur.number * _this.options.scale;');
      applied=true;
      return {contents:source,loader:'js'};
    });
  }};
}
