'use strict';

const SVG_NS = 'http://www.w3.org/2000/svg';
// Scanners need a light margin around the symbol; four modules is the minimum
// the specification allows.
const QUIET_ZONE = 4;

function buildSvg(code) {
  const extent = code.size + QUIET_ZONE * 2;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${extent} ${extent}`);
  svg.setAttribute('shape-rendering', 'crispEdges');

  const background = document.createElementNS(SVG_NS, 'rect');
  background.setAttribute('width', String(extent));
  background.setAttribute('height', String(extent));
  background.setAttribute('fill', '#ffffff');
  svg.append(background);

  // One rect per horizontal run rather than per module: fewer nodes, and the
  // runs are what the renderer would have to merge anyway.
  for (let row = 0; row < code.size; row += 1) {
    let start = -1;
    for (let col = 0; col <= code.size; col += 1) {
      const dark = col < code.size && code.modules[row][col] === 1;
      if (dark && start === -1) start = col;
      if (dark || start === -1) continue;
      const rect = document.createElementNS(SVG_NS, 'rect');
      rect.setAttribute('x', String(start + QUIET_ZONE));
      rect.setAttribute('y', String(row + QUIET_ZONE));
      rect.setAttribute('width', String(col - start));
      rect.setAttribute('height', '1');
      rect.setAttribute('fill', '#000000');
      svg.append(rect);
      start = -1;
    }
  }

  return svg;
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.close();
});

window.mullionQr.get().then((payload) => {
  if (!payload) return;
  document.getElementById('code').append(buildSvg(payload.code));
  // textContent, never innerHTML: the URL comes from an untrusted page.
  document.getElementById('url').textContent = payload.url;
});
