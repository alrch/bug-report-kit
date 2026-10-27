// Safari can report the zoomed visual size through innerWidth/innerHeight.
// The root retains layout dimensions; max also preserves desktop scrollbar space.
export function layoutViewport() {
  return {width:Math.max(document.documentElement.clientWidth, innerWidth),
    height:Math.max(document.documentElement.clientHeight, innerHeight)};
}
