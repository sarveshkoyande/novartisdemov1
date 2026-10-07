// Entry point: campaign inputs in, a design spec / SVG / .vsdx out. Ported
// (and trimmed to the Segmentation region only, per the plan's scope
// boundary — the SOP's separate Email Journey component is a follow-up) from
// app/flow/planner.py in the reference project.

const sop = require('./sop');
const segmentation = require('./segmentation');
const journey = require('./journey');
const { FlowDesign } = require('./model');
const { flowSvg } = require('./svg');
const { flowVsdx } = require('./vsdx');
const { stableCodes } = require('./drawing');

// The block shapes/colours a chat edit can actually produce — kept to the
// vocabulary drawing.js already knows how to draw and colour (see its
// PALETTE/STATUS maps), so a chat-added block never comes out as an
// unstyled default box or an off-legend colour.
const NODE_TYPES = new Set(['entry', 'datasource', 'process', 'decision', 'segment', 'stop', 'exit', 'note']);
const STATUSES = new Set(['live', 'new', 'hold', 'built_not_live']);

function plan(inputs) {
  const design = new FlowDesign({ sopVersion: sop.VERSION });
  if (!inputs.audience) {
    design.warnings.push('Audience is not set, so the DTC rules were applied. Set Audience to HCP or DTC and regenerate.');
  }
  segmentation.build(design, inputs);
  if (inputs.journey) journey.build(design, inputs.journey, design.segments);
  return design;
}

// A block's printed code (B1, B2, ...) is assigned once and kept for the
// life of the diagram (see drawing.js's stableCodes) — `inputs.
// codeAssignments` is that persisted node-id -> code map, carried in
// FlowPlannerInputs the same way nodeOverrides/deletedNodeIds are. This
// derives it fresh against the CURRENT node list (covering any node that
// hasn't been assigned a code yet) without mutating the caller's map — the
// caller (the chat-edit endpoint, or the /generate route) is responsible
// for persisting whatever this returns back onto the campaign's inputs, or
// a code newly assigned in one response would be reassigned differently
// the next time a block is added.
function codeMapFor(inputs) {
  const spec = generate(inputs);
  return stableCodes(spec.nodes, inputs.codeAssignments);
}

// `blocks()` is the resolution step a chat edit uses both ways: to explain
// what's currently on the diagram (block list in the system prompt) and to
// look up which node id a referenced code like "B12" actually means.
function blocks(inputs) {
  const spec = generate(inputs);
  const codeById = stableCodes(spec.nodes, inputs.codeAssignments);
  return spec.nodes.map((n) => ({ code: codeById[n.id], id: n.id, label: n.label, detail: n.detail }));
}

// `nodeOverrides` (node id -> replacement detail text) is how a chat edit
// against a specific block ("set B12 to ...") actually sticks — the SOP
// rules that build most blocks have no underlying campaign field to change
// (a suppression check like "Age 18+?" is fixed boilerplate, not derived
// from anything the campaign record states), so the override is applied
// directly to the generated node rather than routed through FlowInputs.
// Keyed by node id, not the printed code, because ids are stable across a
// regeneration and codes are not.
function applyOverrides(spec, overrides) {
  if (!overrides || !Object.keys(overrides).length) return spec;
  const patch = (n) => (overrides[n.id] !== undefined ? { ...n, detail: overrides[n.id], tbd: [] } : n);
  return { ...spec, nodes: spec.nodes.map(patch), steps: spec.steps.map(patch) };
}

// Removing a block ("delete B6") means both dropping the node AND
// reconnecting whatever pointed at it straight to whatever it pointed at —
// otherwise the diagram would still draw two dangling half-arrows where the
// block used to be, or the two neighbours simply wouldn't touch at all. Each
// deletion is applied one at a time (in order given), which is what lets
// deleting several adjacent blocks in one request correctly bridge the gap
// across all of them rather than only across the first.
function applyDeletion(spec, nodeId) {
  const incoming = spec.edges.filter((e) => e.to === nodeId);
  const outgoing = spec.edges.filter((e) => e.from === nodeId);
  const bridged = [];
  for (const inEdge of incoming) {
    for (const outEdge of outgoing) {
      bridged.push({ from: inEdge.from, to: outEdge.to, ...(outEdge.label || inEdge.label ? { label: outEdge.label || inEdge.label } : {}) });
    }
  }
  const edges = spec.edges.filter((e) => e.from !== nodeId && e.to !== nodeId).concat(bridged);
  const keep = (n) => n.id !== nodeId;
  return { ...spec, nodes: spec.nodes.filter(keep), steps: spec.steps.filter(keep), edges };
}

function applyDeletions(spec, nodeIds) {
  if (!nodeIds || !nodeIds.length) return spec;
  return nodeIds.reduce(applyDeletion, spec);
}

// New blocks a chat edit added ("add a decision block asking X") — appended
// to the node list as plain data, not run back through the SOP builder,
// since they're the SA's own addition rather than anything the rules derive.
function applyCustomNodes(spec, customNodes) {
  if (!customNodes || !customNodes.length) return spec;
  const made = customNodes.map((c) => ({
    id: c.id,
    type: NODE_TYPES.has(c.type) ? c.type : 'process',
    label: c.label || c.id,
    detail: c.detail || '',
    region: 'segmentation',
    lane: null,
    attrs: {},
    status: STATUSES.has(c.status) ? c.status : null,
    tbd: [],
    rationale: 'Added via chat edit.',
    sop_ref: '',
  }));
  return { ...spec, nodes: [...spec.nodes, ...made], steps: [...spec.steps, ...made] };
}

// Moves a node to sit right after another in the node array — array order is
// also draw order (see drawing.js's layout: it walks the spine top-to-bottom
// in array order), so without this a block added via insertAfter/
// insertBetween would draw at the very bottom of the page no matter which
// existing block it's actually wired to, with its arrow running back up the
// whole diagram to reach it.
function moveAfter(spec, nodeId, anchorId) {
  const reorder = (list) => {
    const node = list.find((n) => n.id === nodeId);
    if (!node) return list;
    const without = list.filter((n) => n.id !== nodeId);
    const anchorIdx = without.findIndex((n) => n.id === anchorId);
    if (anchorIdx === -1) return list;
    return [...without.slice(0, anchorIdx + 1), node, ...without.slice(anchorIdx + 1)];
  };
  return { ...spec, nodes: reorder(spec.nodes), steps: reorder(spec.steps) };
}

// The graph-editing primitives a chat edit composes to do everything beyond
// a single block's own text: inserting a new block into the middle of an
// existing connection, swapping what two blocks show, or adding/removing a
// raw connection. Kept as small, composable ops (rather than one big
// "restructure the diagram" tool call) so each one is simple to reason
// about and to get right — a rewire is just "drop this edge, add these two".
function applyGraphOp(spec, op) {
  switch (op.kind) {
    case 'insertBetween': {
      const edges = spec.edges
        .filter((e) => !(e.from === op.fromId && e.to === op.toId))
        .concat([{ from: op.fromId, to: op.newNodeId }, { from: op.newNodeId, to: op.toId }]);
      return moveAfter({ ...spec, edges }, op.newNodeId, op.fromId);
    }
    case 'insertAfter': {
      // The new block inherits every downstream connection the anchor block
      // had — "connect the new block downstream" means the old direct
      // connection no longer exists at all, not that it exists alongside a
      // new branch.
      const outgoing = spec.edges.filter((e) => e.from === op.afterId);
      const rest = spec.edges.filter((e) => e.from !== op.afterId);
      const rewired = outgoing.map((e) => ({ ...e, from: op.newNodeId }));
      const edges = [...rest, { from: op.afterId, to: op.newNodeId }, ...rewired];
      return moveAfter({ ...spec, edges }, op.newNodeId, op.afterId);
    }
    case 'connect': {
      const label = op.label ? { label: op.label } : {};
      return { ...spec, edges: [...spec.edges, { from: op.fromId, to: op.toId, ...label }] };
    }
    case 'disconnect': {
      return { ...spec, edges: spec.edges.filter((e) => !(e.from === op.fromId && e.to === op.toId)) };
    }
    case 'swap': {
      const a = spec.nodes.find((n) => n.id === op.idA);
      const b = spec.nodes.find((n) => n.id === op.idB);
      if (!a || !b) return spec;
      const content = (n) => ({ type: n.type, label: n.label, detail: n.detail, attrs: n.attrs, status: n.status, tbd: n.tbd, rationale: n.rationale, sop_ref: n.sop_ref });
      const patch = (n) => (n.id === op.idA ? { ...n, ...content(b) } : n.id === op.idB ? { ...n, ...content(a) } : n);
      return { ...spec, nodes: spec.nodes.map(patch), steps: spec.steps.map(patch) };
    }
    case 'setStatus': {
      const patch = (n) => (n.id === op.id ? { ...n, status: STATUSES.has(op.status) ? op.status : null } : n);
      return { ...spec, nodes: spec.nodes.map(patch), steps: spec.steps.map(patch) };
    }
    // Whether a block draws inline, continuing straight down the main
    // vertical line, or off to the side of whatever it connects from —
    // same idea as the Stop pills next to a suppression check, just not
    // restricted to Stop-typed blocks. Only drawing.js's layout() actually
    // cares about this flag; nothing else about the block changes.
    case 'setBranch': {
      const patch = (n) => (n.id === op.id ? { ...n, attrs: { ...n.attrs, branch: op.branch === 'side' ? 'side' : undefined } } : n);
      return { ...spec, nodes: spec.nodes.map(patch), steps: spec.steps.map(patch) };
    }
    default:
      return spec;
  }
}

function applyGraphOps(spec, ops) {
  if (!ops || !ops.length) return spec;
  return ops.reduce(applyGraphOp, spec);
}

function generate(inputs) {
  let spec = plan(inputs).toSpec();
  spec = applyDeletions(spec, inputs.deletedNodeIds);
  spec = applyCustomNodes(spec, inputs.customNodes);
  spec = applyGraphOps(spec, inputs.graphOps);
  spec = applyOverrides(spec, inputs.nodeOverrides);
  return spec;
}

function svgFor(inputs, title) {
  const spec = generate(inputs);
  const codeMap = stableCodes(spec.nodes, inputs.codeAssignments);
  return flowSvg(spec, title || inputs.campaignName || 'Segmentation Flow', codeMap);
}

async function vsdxFor(inputs, title) {
  return flowVsdx(generate(inputs), title || inputs.campaignName || 'Segmentation Flow');
}

module.exports = { plan, generate, svgFor, vsdxFor, sop, blocks, codeMapFor };
