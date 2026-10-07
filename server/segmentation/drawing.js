// Layout, sizing and colour â€” ported from app/drawing.py. One layout, shared
// by the SVG renderer and the .vsdx writer, so the two are the same drawing
// in two formats rather than two drawings of the same data.

const MARGIN = 40;
const TOP = 74;
const NW = 264, NH = 66;
const DW = 240, DH = 92;
const SW = 130, SH = 40;
const PANE_W = 250;
const ROW_GAP = 46;
const COL_W = 330;
const STOP_DX = 60;
const RESEND_DX = 40;

const PALETTE = {
  entry: ['#E7F1F5', '#14607A'],
  datasource: ['#FBF3DA', '#8A6508'],
  process: ['#F2F2F2', '#8A8681'],
  decision: ['#FBF3DA', '#C8A302'],
  segment: ['#EEEAF6', '#5B4B8A'],
  touchpoint: ['#FFF0EA', '#FF4E00'],
  resend: ['#FFF6F2', '#FF8A5B'],
  stop: ['#FBEAE8', '#C4342B'],
  exit: ['#E7F2EC', '#1B7F51'],
  note: ['#FFFFFF', '#B4AFA8'],
};
const DEFAULT = ['#F6F8FA', '#8A8681'];

const STATUS = {
  live: ['#E7F2EC', '#1B7F51'],
  new: ['#FBF3DA', '#C8A302'],
  hold: ['#FBEAE8', '#C4342B'],
  built_not_live: ['#F2F2F2', '#8A8681'],
};

const LABEL_CHARS = 32;
const DETAIL_CHARS = 40;
const DECISION_CHARS = 26;
const LABEL_LINE_H = 17;
const DETAIL_LINE_H = 14;

function normalise(spec) {
  let nodes, edges;
  if (Array.isArray(spec)) {
    nodes = spec.slice();
    edges = [];
  } else {
    nodes = spec.nodes || spec.steps || [];
    edges = spec.edges || [];
  }
  if (nodes.length && !nodes.some((n) => n.id)) {
    nodes = nodes.map((n, i) => ({ ...n, id: `n${i}` }));
    edges = nodes.slice(0, -1).map((_, i) => ({ from: `n${i}`, to: `n${i + 1}` }));
  }
  return [nodes, edges];
}

function colours(node) {
  if (node.status && STATUS[node.status]) return STATUS[node.status];
  return PALETTE[node.type] || DEFAULT;
}

function wrap(text, width) {
  const out = [];
  for (const paragraph of String(text || '').split('\n')) {
    let current = '';
    for (let word of paragraph.split(/\s+/).filter(Boolean)) {
      while (word.length > width) {
        if (current) {
          out.push(current);
          current = '';
        }
        out.push(word.slice(0, width));
        word = word.slice(width);
      }
      const candidate = `${current} ${word}`.trim();
      if (candidate.length <= width) current = candidate;
      else {
        out.push(current);
        current = word;
      }
    }
    if (current) out.push(current);
  }
  return out;
}

function size(node) {
  const kind = node.type;
  const label = node.label || '';
  const detail = node.detail || '';

  if (kind === 'decision') {
    const lines = wrap(label, DECISION_CHARS).length + wrap(detail, DECISION_CHARS).length;
    return [DW, Math.max(DH, 46 + lines * 15)];
  }
  if (kind === 'stop') return [SW, SH];
  if (kind === 'note') {
    const boxes = (node.attrs || {}).boxes || [];
    const lines = boxes.reduce((sum, b) => sum + (b.lines || []).length, 0);
    return [PANE_W, 34 + boxes.length * 26 + lines * 16];
  }

  // A dense block widens (up to 1.5x) before it grows tall: try each width
  // and keep the first whose text fits in MAX_LINES; otherwise the widest.
  const capRoom = kind === 'datasource' ? 22 : 0;
  let w = NW, lines = 0;
  for (w of WIDTHS) {
    const { label: lc, detail: dc } = charsFor(w);
    lines = wrap(label, lc).length + wrap(detail, dc).length;
    if (lines <= MAX_LINES) break;
  }
  const { label: lc, detail: dc } = charsFor(w);
  const height = 14 + wrap(label, lc).length * LABEL_LINE_H + wrap(detail, dc).length * DETAIL_LINE_H + 12 + capRoom;
  return [w, Math.max(NH, height)];
}

const WIDTHS = [NW, Math.round(NW * 1.25), Math.round(NW * 1.5)];
const MAX_LINES = 6;

// Characters per line scale with the block's width, so a wider block wraps less.
function charsFor(w) {
  return { label: Math.floor((LABEL_CHARS * w) / NW), detail: Math.floor((DETAIL_CHARS * w) / NW) };
}

function layout(nodes, edges) {
  const pos = {};
  const seg = nodes.filter((n) => (n.region || 'segmentation') === 'segmentation');

  const panes = seg.filter((n) => n.type === 'note');
  const segments = seg.filter((n) => n.type === 'segment');
  // A "side branch" sits off to the right of wherever it connects from,
  // instead of continuing straight down the main vertical line â€” every
  // suppression's Stop pill has always drawn this way, since a rejection
  // isn't the campaign's main path. `attrs.branch === 'side'` puts any
  // OTHER block there too (a chat-added "No" arm, a rejected-path note,
  // ...) without needing its own node type the way Stop got one; it draws
  // at its own real size (see `size()`) rather than a fixed pill.
  const sideBranches = seg.filter((n) => n.type !== 'note' && n.type !== 'segment' && (n.type === 'stop' || (n.attrs && n.attrs.branch === 'side')));
  const sideBranchIds = new Set(sideBranches.map((n) => n.id));
  const spine = seg.filter((n) => !['note', 'segment'].includes(n.type) && !sideBranchIds.has(n.id));

  const spineX = MARGIN + PANE_W + MARGIN;
  // Column width follows the widest box, so a widened block never runs into its side branch.
  const boxW = (list) => Math.max(NW, ...list.filter((n) => !['note', 'decision', 'stop'].includes(n.type)).map((n) => size(n)[0]));
  const CW = boxW(spine);
  let y = TOP;

  const left = panes.find((p) => p.id === 'pane.left');
  if (left) {
    const [w, h] = size(left);
    pos[left.id] = [MARGIN, TOP, w, h];
  }

  const branchSource = {};
  for (const edge of edges) if (sideBranchIds.has(edge.to)) branchSource[edge.to] = edge.from;

  for (const node of spine) {
    const [w, h] = size(node);
    pos[node.id] = [spineX + (CW - w) / 2, y, w, h];
    y += h + ROW_GAP;
  }

  for (const branch of sideBranches) {
    const [w, h] = size(branch);
    const src = branchSource[branch.id];
    const sy = src && pos[src] ? pos[src][1] + (pos[src][3] - h) / 2 : TOP;
    pos[branch.id] = [spineX + CW + STOP_DX, sy, w, h];
  }

  // How far right the side-branch column actually reaches, so the
  // enrollment-sources pane (drawn further right still) never overlaps a
  // branch wider than the old fixed Stop-pill width used to guarantee.
  const sideBranchW = sideBranches.length ? Math.max(...sideBranches.map((n) => size(n)[0])) : SW;
  const right = panes.find((p) => p.id === 'pane.right');
  if (right) {
    const [w, h] = size(right);
    pos[right.id] = [spineX + CW + STOP_DX + sideBranchW + MARGIN, TOP, w, h];
  }

  segments.forEach((node, i) => {
    const [w, h] = size(node);
    pos[node.id] = [spineX + i * COL_W - (NW - w) / 2, y, w, h];
  });
  if (segments.length) y += NH + ROW_GAP;

  // Journey region (SOP rows 10-17): one lane per segment below everything
  // the segmentation drew, with the legend pane to the left.
  const jny = nodes.filter((n) => n.region === 'journey');
  if (!jny.length) return pos;
  y += ROW_GAP;
  const legend = jny.find((n) => n.id === 'pane.legend');
  if (legend) {
    const [w, h] = size(legend);
    pos[legend.id] = [MARGIN, y, w, h];
  }

  const lanes = new Map();
  for (const node of jny) {
    if (node.id === 'pane.legend') continue;
    const key = node.lane || '';
    if (!lanes.has(key)) lanes.set(key, []);
    lanes.get(key).push(node);
  }

  // A resend hangs beside its decision rather than under it, the way the
  // SOP's reference images draw it, so the Yes arm running down to the next
  // send never passes through the resend box.
  const hasResend = jny.some((n) => n.type === 'resend');
  const JW = boxW(jny);
  const laneW = hasResend ? JW + RESEND_DX + JW + MARGIN : Math.max(COL_W, JW + MARGIN);

  [...lanes.values()].forEach((members, i) => {
    let ly = y;
    const lx = spineX + i * laneW;
    const byId = new Map(members.map((n) => [n.id, n]));
    for (const node of members) {
      if (node.type === 'resend') continue;
      const [w, h] = size(node);
      pos[node.id] = [lx + (JW - w) / 2, ly, w, h];
      if (node.id.endsWith('.q')) {
        const resend = byId.get(node.id.slice(0, -2) + '.resend');
        if (resend) {
          const [rw, rh] = size(resend);
          pos[resend.id] = [lx + JW + RESEND_DX, ly + (h - rh) / 2, rw, rh];
        }
      }
      ly += h + ROW_GAP;
    }
  });

  return pos;
}

// Shift a page's drawing to the top-left of its own canvas. A slice cut out
// of the full design (one journey lane, say) keeps the coordinates it had
// there, so without this it would arrive with the whole segmentation
// column's height as blank space above it. Only paginated output needs this.
function compact(pos) {
  const vals = Object.values(pos);
  if (!vals.length) return pos;
  const dx = MARGIN - Math.min(...vals.map(([x]) => x));
  const dy = TOP - Math.min(...vals.map(([, y]) => y));
  const out = {};
  for (const [k, [x, y, w, h]] of Object.entries(pos)) out[k] = [x + dx, y + dy, w, h];
  return out;
}

function directRoute(src, dst) {
  const [sx, sy, sw, sh] = src;
  const [dx, dy, dw, dh] = dst;
  const overlap = sy < dy + dh && dy < sy + sh;

  let start, end;
  if (overlap && dx >= sx + sw) {
    start = [sx + sw, sy + sh / 2];
    end = [dx, dy + dh / 2];
  } else if (overlap && dx + dw <= sx) {
    start = [sx, sy + sh / 2];
    end = [dx + dw, dy + dh / 2];
  } else {
    start = [sx + sw / 2, sy + sh];
    end = [dx + dw / 2, dy];
  }

  if (Math.abs(start[0] - end[0]) < 1 || Math.abs(start[1] - end[1]) < 1) return [start, end];

  if (start[1] === end[1] || overlap) {
    const mid = (start[0] + end[0]) / 2;
    return [start, [mid, start[1]], [mid, end[1]], end];
  }
  const mid = (start[1] + end[1]) / 2;
  return [start, [start[0], mid], [end[0], mid], end];
}

// Shrinking each rect by PAD before testing means a segment that only
// touches a box's edge â€” which is what every route's own start/end point
// does, since it's anchored ON the src/dst boundary â€” doesn't count as a
// collision with that box, while still catching a line that genuinely
// crosses through it.
const OBSTACLE_PAD = 2;
const DETOUR_GUTTER = 24;

function segmentHitsRect(p1, p2, rect) {
  const [rx, ry, rw, rh] = rect;
  const x0 = Math.min(p1[0], p2[0]);
  const x1 = Math.max(p1[0], p2[0]);
  const y0 = Math.min(p1[1], p2[1]);
  const y1 = Math.max(p1[1], p2[1]);
  return x0 < rx + rw - OBSTACLE_PAD && x1 > rx + OBSTACLE_PAD && y0 < ry + rh - OBSTACLE_PAD && y1 > ry + OBSTACLE_PAD;
}

function pathBlocked(points, obstacles) {
  for (let i = 0; i < points.length - 1; i++) {
    for (const rect of obstacles) {
      if (segmentHitsRect(points[i], points[i + 1], rect)) return true;
    }
  }
  return false;
}

// The direct route (a straight L/Z bend between two boxes) has no idea what
// else is on the page â€” a connection that skips past a deleted block, or
// reconnects a side branch back into the main line, can end up drawing
// straight through an unrelated block sitting in between, which is exactly
// what makes it impossible to tell by eye whether an edit actually rewired
// what it claims to. `obstacles` is every OTHER node's placed rectangle;
// when the direct path would cross one, this reroutes out to a lane clear
// of everything between the two ends â€” same idea as a subway map or a PCB
// trace routing around a component instead of through it â€” rather than
// trying to solve general-purpose pathfinding.
function route(src, dst, obstacles) {
  const direct = directRoute(src, dst);
  if (!obstacles || !obstacles.length || !pathBlocked(direct, obstacles)) return direct;

  const start = direct[0];
  const end = direct[direct.length - 1];
  const top = Math.min(start[1], end[1], src[1], dst[1]);
  const bottom = Math.max(start[1], end[1], src[1] + src[3], dst[1] + dst[3]);

  // The detour lane sits clear of every obstacle whose row range the route
  // actually passes through â€” not just src and dst's own rows â€” so a skip
  // edge over several blocks clears all of them, not just the two ends.
  let clearX = Math.max(src[0] + src[2], dst[0] + dst[2], start[0], end[0]);
  for (const rect of obstacles) {
    const [ox, oy, ow, oh] = rect;
    if (oy < bottom && oy + oh > top) clearX = Math.max(clearX, ox + ow);
  }
  clearX += DETOUR_GUTTER;

  const detour = [start, [clearX, start[1]], [clearX, end[1]], end];
  // A detour is only worth taking if it's actually clear â€” if something
  // still blocks it (a dense cluster of side branches, say), showing the
  // direct route is more honest than a "fixed" line that still crosses
  // something, just somewhere else.
  return pathBlocked(detour, obstacles) ? direct : detour;
}

function codes(nodes) {
  const out = {};
  nodes.forEach((n, i) => (out[n.id] = `B${i + 1}`));
  return out;
}

// The printed codes (B1, B2, ...) used to be purely positional â€” recomputed
// fresh from node order on every single generation. That meant deleting B6
// silently renamed every later block one number down, so "B6" stopped
// meaning the block a person had just been looking at and started meaning
// whatever used to be B7 â€” a chat edit (or a person) referencing a code
// from even one turn ago could silently land on the wrong block with no
// error, because the code always resolves to SOME real block, just not the
// one it used to.
//
// `assignments` is a node id -> code map persisted across edits (see
// FlowPlannerInputs.codeAssignments). Once a node has been assigned a code
// it keeps it for the rest of this diagram's life, however many other
// blocks are added or removed around it â€” a genuinely new node (a fresh
// chat-added block, or the SOP builder's own new node when audience/
// segments change) gets the next number that has never been used, so
// codes are only ever added, never reused or renumbered.
function stableCodes(nodes, assignments) {
  const out = { ...(assignments || {}) };
  let maxUsed = 0;
  for (const code of Object.values(out)) {
    const n = parseInt(String(code).replace(/^B/, ''), 10);
    if (!Number.isNaN(n) && n > maxUsed) maxUsed = n;
  }
  for (const node of nodes) {
    if (!out[node.id]) {
      maxUsed += 1;
      out[node.id] = `B${maxUsed}`;
    }
  }
  return out;
}

function extent(pos) {
  const vals = Object.values(pos);
  const width = vals.length ? Math.max(...vals.map(([x, , w]) => x + w)) : 600;
  const height = vals.length ? Math.max(...vals.map(([, y, , h]) => y + h)) : 400;
  return [width, height];
}

module.exports = {
  MARGIN, TOP, NW, NH, DW, DH, SW, SH, PANE_W, ROW_GAP, COL_W, STOP_DX,
  charsFor, LABEL_CHARS, DETAIL_CHARS, DECISION_CHARS, LABEL_LINE_H, DETAIL_LINE_H,
  normalise, colours, wrap, size, layout, route, codes, stableCodes, extent, compact,
};
