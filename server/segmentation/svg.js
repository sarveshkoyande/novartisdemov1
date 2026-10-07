// Render a Flow Planner design to an inline SVG â€” ported from app/diagram.py.
// Positions/sizes/colours come from drawing.js, the same source vsdx.js uses,
// so the on-screen view and the downloaded file are the same drawing.

const { DECISION_CHARS, DETAIL_CHARS, DETAIL_LINE_H, LABEL_CHARS, LABEL_LINE_H, MARGIN, charsFor, codes, colours, compact, extent, layout, normalise, route, wrap } = require('./drawing');

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function shape(node, x, y, w, h, fill, accent, dashed) {
  const stroke = `stroke="${accent}" stroke-width="1.6"`;
  const dash = dashed ? ' stroke-dasharray="6 4"' : '';
  const kind = node.type;

  if (kind === 'decision') {
    const cx = x + w / 2, cy = y + h / 2;
    const pts = `${cx},${y} ${x + w},${cy} ${cx},${y + h} ${x},${cy}`;
    return [`<polygon points="${pts}" fill="${fill}" ${stroke}${dash}/>`];
  }
  if (kind === 'datasource') {
    const ry = 11;
    return [
      `<path d="M${x},${y + ry} a${w / 2},${ry} 0 0 1 ${w},0 v${h - 2 * ry} a${w / 2},${ry} 0 0 1 ${-w},0 z" fill="${fill}" ${stroke}${dash}/>`,
      `<path d="M${x},${y + ry} a${w / 2},${ry} 0 0 0 ${w},0" fill="none" ${stroke}${dash}/>`,
    ];
  }
  if (kind === 'stop' || kind === 'exit') {
    return [`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${fill}" ${stroke}${dash}/>`];
  }
  const out = [`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="9" fill="${fill}" stroke="#DEDAD4"${dash}/>`];
  if (kind !== 'note') out.push(`<rect x="${x}" y="${y}" width="5" height="${h}" rx="2.5" fill="${accent}"/>`);
  return out;
}

function pane(node, x, y, w, h, accent) {
  const out = [
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="9" fill="#FFFFFF" stroke="${accent}" stroke-width="1.2"/>`,
    `<text x="${x + 12}" y="${y + 21}" font-size="12.5" font-weight="700" fill="#161616">${esc(node.label)}</text>`,
  ];
  let cy = y + 40;
  for (const box of (node.attrs || {}).boxes || []) {
    out.push(`<text x="${x + 12}" y="${cy}" font-size="10.5" font-weight="700" fill="#8A8681">${esc(box.title)}</text>`);
    cy += 16;
    const swatches = {};
    for (const sw of box.swatches || []) swatches[sw.label] = sw.colour;
    for (const line of box.lines || []) {
      const colour = swatches[line];
      if (colour) out.push(`<rect x="${x + 12}" y="${cy - 8}" width="9" height="9" rx="2" fill="${colour}"/>`);
      const tx = x + (colour ? 26 : 12);
      for (const part of wrap(line, 30)) {
        out.push(`<text x="${tx}" y="${cy}" font-size="11" fill="#555250">${esc(part)}</text>`);
        cy += 16;
      }
    }
    cy += 10;
  }
  return out;
}

function decisionLabel(node, x, y, w, h) {
  const lines = [...wrap(node.label, DECISION_CHARS).map((l) => [l, true]), ...wrap(node.detail, DECISION_CHARS).map((l) => [l, false])];
  const top = y + h / 2 - (lines.length * 15) / 2 + 12;
  return lines.map(([part, bold], i) => `<text x="${x + w / 2}" y="${top + i * 15}" font-size="11.5" font-weight="${bold ? 700 : 400}" text-anchor="middle" fill="${bold ? '#161616' : '#555250'}">${esc(part)}</text>`);
}

function blockLabel(node, x, y, w, h) {
  const kind = node.type;
  if (kind === 'decision') return decisionLabel(node, x, y, w, h);
  if (kind === 'stop') {
    return [`<text x="${x + w / 2}" y="${y + h / 2 + 4}" font-size="12" font-weight="700" text-anchor="middle" fill="#161616">${esc(node.label)}</text>`];
  }
  const out = [];
  const tx = x + 18;
  // A data source is drawn as a cylinder; start its text below the top cap
  // so the title doesn't sit on the ellipse's rim.
  let cy = y + 24 + (kind === 'datasource' ? 12 : 0);
  for (const part of wrap(node.label, charsFor(w).label)) {
    out.push(`<text x="${tx}" y="${cy}" font-size="13.5" font-weight="700" fill="#161616">${esc(part)}</text>`);
    cy += LABEL_LINE_H;
  }
  cy += 2;
  for (const part of wrap(node.detail, charsFor(w).detail)) {
    out.push(`<text x="${tx}" y="${cy}" font-size="11" fill="#555250">${esc(part)}</text>`);
    cy += DETAIL_LINE_H;
  }
  return out;
}

function codeChip(code, node, x, y) {
  if (node.type === 'decision' || node.type === 'stop') {
    return [`<text x="${(x - 6).toFixed(1)}" y="${(y + 12).toFixed(1)}" font-size="9.5" font-weight="700" text-anchor="end" fill="#A9B2B8" font-family="monospace">${esc(code)}</text>`];
  }
  return [`<text x="${(x + 8).toFixed(1)}" y="${(y - 5).toFixed(1)}" font-size="9.5" font-weight="700" text-anchor="start" fill="#A9B2B8" font-family="monospace">${esc(code)}</text>`];
}

function tbdChip(x, y, w) {
  return [
    `<rect x="${x + w - 44}" y="${y + 7}" width="36" height="15" rx="7.5" fill="#FBEAE8" stroke="#C4342B" stroke-width="0.8"/>`,
    `<text x="${x + w - 26}" y="${y + 18}" font-size="9" font-weight="700" text-anchor="middle" fill="#C4342B">TBD</text>`,
  ];
}

// Every other placed block is a potential obstacle for this one edge â€” the
// route itself decides whether it actually needs to detour around any of
// them (see drawing.js's route()). Excluding src/dst themselves matters:
// otherwise the very node the edge legitimately starts/ends AT would count
// as blocking its own connector.
function edgePoints(pos, edge) {
  const src = pos[edge.from];
  const dst = pos[edge.to];
  if (!src || !dst) return null;
  const obstacles = Object.entries(pos)
    .filter(([id]) => id !== edge.from && id !== edge.to)
    .map(([, rect]) => rect);
  let points = route(src, dst, obstacles);
  let [lx1, ly1] = points[points.length - 2];
  let [lx2, ly2] = points[points.length - 1];
  if (Math.abs(lx2 - lx1) < 1) ly2 += ly2 > ly1 ? -2 : 2;
  else lx2 += lx2 > lx1 ? -2 : 2;
  return [...points.slice(0, -1), [lx2, ly2]];
}

function edgeSvg(points, edge) {
  const path = 'M' + points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' L');
  const out = [`<path d="${path}" fill="none" stroke="#B4AFA8" stroke-width="1.6" marker-end="url(#arr)"/>`];
  if (edge.label) {
    const [ax, ay] = points[0], [bx, by] = points[1];
    out.push(`<text x="${((ax + bx) / 2 + 7).toFixed(1)}" y="${((ay + by) / 2 - 5).toFixed(1)}" font-size="10" font-weight="700" fill="#8A8681">${esc(edge.label)}</text>`);
  }
  return out;
}

// `opts.page` is for paginated output: one slice of the design (the
// segmentation region, or a single journey lane) pulled back to the
// top-left so it doesn't inherit the empty space above it in the full drawing.
function flowSvg(spec, title, codeMap, opts = {}) {
  const [nodes, edges] = normalise(spec);
  const laid = layout(nodes, edges);
  const pos = opts.page ? compact(laid) : laid;
  // Prefer the caller's stable, persisted codes (see drawing.js's
  // stableCodes) â€” the diagram's own printed numbers must match whatever a
  // chat edit resolves "B12" against, or the two would drift the moment a
  // block is deleted. Falls back to positional numbering only when no
  // stable map is supplied at all.
  const handle = codeMap || codes(nodes);

  // Routed BEFORE sizing the canvas: a collision-avoiding detour (see
  // drawing.js's route()) can reach further right than any block itself
  // does, and sizing the page from node positions alone would clip that
  // detour clean off the edge of the drawing instead of showing it.
  const edgeRoutes = edges.map((edge) => ({ edge, points: edgePoints(pos, edge) })).filter((r) => r.points);

  let [width, height] = extent(pos);
  for (const { points } of edgeRoutes) {
    for (const [x, y] of points) {
      width = Math.max(width, x);
      height = Math.max(height, y);
    }
  }
  width += MARGIN;
  height += MARGIN;

  const out = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width.toFixed(0)}" height="${height.toFixed(0)}" viewBox="0 0 ${width.toFixed(0)} ${height.toFixed(0)}" font-family="Arial, Helvetica, sans-serif">`,
    `<rect width="${width.toFixed(0)}" height="${height.toFixed(0)}" fill="#FCFCFC"/>`,
    '<defs><marker id="arr" markerWidth="9" markerHeight="9" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#B4AFA8"/></marker></defs>',
    `<text x="${MARGIN}" y="40" font-size="17" font-weight="700" fill="#161616">${esc(title)}</text>`,
  ];

  for (const { edge, points } of edgeRoutes) out.push(...edgeSvg(points, edge));

  for (const node of nodes) {
    const placed = pos[node.id];
    if (!placed) continue;
    const [x, y, w, h] = placed;
    const [fill, accent] = colours(node);
    const dashed = !!(node.tbd && node.tbd.length);
    if (node.type === 'note') {
      out.push(...pane(node, x, y, w, h, accent));
      out.push(...codeChip(handle[node.id], node, x, y));
      continue;
    }
    out.push(...shape(node, x, y, w, h, fill, accent, dashed));
    out.push(...blockLabel(node, x, y, w, h));
    out.push(...codeChip(handle[node.id], node, x, y));
    if (dashed && node.type !== 'decision' && node.type !== 'stop') out.push(...tbdChip(x, y, w));
  }

  out.push('</svg>');
  return out.join('\n');
}

module.exports = { flowSvg };
