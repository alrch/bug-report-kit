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
      // html2canvas paints the SVG element's CSS box, then draws the serialized
      // SVG into its content box. Serializing the same border/padding/margin
      // paints a second, inset frame and shifts/scales the drawing. Keep CSS
      // layout/decorations in the outer renderer and serialize only its content.
      const svgSource = source.match(/var s = new XMLSerializer\(\);[\s\S]*?_this\.intrinsicHeight = img\.height\.baseVal\.value;/)?.[0];
      if (!svgSource) throw new Error('html2canvas SVG container changed');
      const expectedSvg = `var s = new XMLSerializer();
        var bounds = parseBounds(context, img);
        img.setAttribute('width', bounds.width + "px");
        img.setAttribute('height', bounds.height + "px");
        _this.svg = "data:image/svg+xml," + encodeURIComponent(s.serializeToString(img));
        _this.intrinsicWidth = img.width.baseVal.value;
        _this.intrinsicHeight = img.height.baseVal.value;`;
      if (svgSource.replace(/\s+/g, ' ') !== expectedSvg.replace(/\s+/g, ' ')) throw new Error('html2canvas SVG container changed; review serialization');
      replace(svgSource, `var s = new XMLSerializer();
        var bounds = contentBox(_this);
        var svg = img.cloneNode(true);
        for (var property of ['border', 'padding', 'margin']) svg.style.setProperty(property, '0', 'important');
        svg.style.setProperty('box-sizing', 'content-box', 'important');
        svg.style.setProperty('transform', 'none', 'important');
        svg.style.setProperty('background', 'transparent', 'important');
        svg.style.setProperty('box-shadow', 'none', 'important');
        svg.style.setProperty('opacity', '1', 'important');
        svg.style.setProperty('width', bounds.width + 'px', 'important');
        svg.style.setProperty('height', bounds.height + 'px', 'important');
        svg.setAttribute('width', bounds.width + "px");
        svg.setAttribute('height', bounds.height + "px");
        _this.svg = "data:image/svg+xml," + encodeURIComponent(s.serializeToString(svg));
        _this.intrinsicWidth = bounds.width;
        _this.intrinsicHeight = bounds.height;`);
      // Reversing only the corner order makes rounded mask paths self-intersect.
      // Reverse each Bezier's direction as well to cut out the entire surface.
      replace('this.formatPath(paths.slice(0).reverse());','this.formatPath(paths.slice(0).reverse().map(function(point) { return isBezierCurve(point) ? point.reverse() : point; }));');
      // A CSS transform can move local viewport edges through the cutout. Use
      // an enclosing outer contour so the rounded hole stays inside its mask.
      const mask = source.match(/CanvasRenderer\.prototype\.mask = function \(paths\) \{[\s\S]*?this\.formatPath/);
      if (!mask) throw new Error('html2canvas mask changed; review outer contour');
      const expanded = mask[0]
        .replaceAll('this.ctx.moveTo(0, 0)', 'this.ctx.moveTo(-MASK_OFFSET, -MASK_OFFSET)')
        .replaceAll('this.ctx.lineTo(this.canvas.width, 0)', 'this.ctx.lineTo(this.canvas.width + MASK_OFFSET, -MASK_OFFSET)')
        .replaceAll('this.ctx.lineTo(this.canvas.width, this.canvas.height)', 'this.ctx.lineTo(this.canvas.width + MASK_OFFSET, this.canvas.height + MASK_OFFSET)')
        .replaceAll('this.ctx.lineTo(0, this.canvas.height)', 'this.ctx.lineTo(-MASK_OFFSET, this.canvas.height + MASK_OFFSET)')
        .replaceAll('this.ctx.lineTo(0, 0)', 'this.ctx.lineTo(-MASK_OFFSET, -MASK_OFFSET)');
      if (expanded === mask[0]) throw new Error('html2canvas mask bounds changed');
      replace(mask[0], expanded);
      // Canvas shadow offsets and blur are device pixels, unlike scaled paths.
      replace('_this.ctx.shadowOffsetX = shadow.offsetX.number + maskOffset;','_this.ctx.shadowOffsetX = (shadow.offsetX.number + maskOffset) * _this.options.scale;');
      replace('_this.ctx.shadowOffsetY = shadow.offsetY.number;','_this.ctx.shadowOffsetY = shadow.offsetY.number * _this.options.scale;');
      replace('_this.ctx.shadowBlur = shadow.blur.number;','_this.ctx.shadowBlur = shadow.blur.number * _this.options.scale;');
      applied=true;
      return {contents:source,loader:'js'};
    });
  }};
}
