// The pictures of the figureChoices scenarios (issues #98 and #247), shared by e2e/server.ts and e2e/layout.spec.ts.
// It imports nothing and starts nothing, so a test may import it.
/** Issue #98: a picture of a stacked division of a 400 × 300 rectangle whose shared id draws a square `size` wide. */
export const divisionFigure = (top: number, size: number, extra = "", script = "") => ({
  svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"${extra}>${script}<defs><rect id="shape" width="${size}" height="${size}" fill="#4a6"/></defs><rect width="400" height="${top}" fill="#ccd"/><rect y="${top}" width="400" height="${300 - top}" fill="#eef"/><use href="#shape"/><text x="200" y="290" text-anchor="middle" font-size="20">${top} px above</text></svg>`,
  alt: `The question takes ${top} of 300 pixels; a square ${size} pixels wide marks the picture.`,
});
export const FIGURE_NARROW = divisionFigure(60, 40, ' onload="document.title=\'figure ran\'"', "<script>document.title='figure ran'</script>");
export const FIGURE_WIDE = divisionFigure(240, 320);
