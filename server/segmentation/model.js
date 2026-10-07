// Node/edge vocabulary — ported from app/flow/model.py, trimmed of the
// journey-freezing/derivation-hash machinery this app doesn't have (no
// approval-gate content hashing here; `useVisioStore`'s own version list
// already covers "what changed and when").

const ENTRY = 'entry';
const DATASOURCE = 'datasource';
const PROCESS = 'process';
const DECISION = 'decision';
const SEGMENT = 'segment';
const NOTE = 'note';
const STOP = 'stop';
const TOUCHPOINT = 'touchpoint';
const RESEND = 'resend';
const EXIT = 'exit';

function slug(value, fallback) {
  const out = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return out || fallback || 'x';
}

class FlowNode {
  constructor({ id, type, label, region = 'segmentation', detail = '', lane = null, attrs = {}, status = null, rationale = '', sopRef = '' }) {
    this.id = id;
    this.type = type;
    this.label = label;
    this.region = region;
    this.detail = detail;
    this.lane = lane;
    this.attrs = attrs;
    this.status = status;
    this.tbd = [];
    this.rationale = rationale;
    this.sop_ref = sopRef;
  }

  markTbd(key) {
    if (!this.tbd.includes(key)) this.tbd.push(key);
  }

  toDict() {
    return {
      id: this.id,
      type: this.type,
      label: this.label,
      detail: this.detail,
      region: this.region,
      lane: this.lane,
      attrs: { ...this.attrs },
      status: this.status,
      tbd: this.tbd.slice(),
      rationale: this.rationale,
      sop_ref: this.sop_ref,
    };
  }
}

class FlowDesign {
  constructor({ sopVersion = '' } = {}) {
    this.nodes = [];
    this.edges = [];
    this.segments = [];
    this.warnings = [];
    this.sopVersion = sopVersion;
  }

  add(node) {
    this.nodes.push(node);
    return node;
  }

  link(src, dst, label = null) {
    const edge = { from: typeof src === 'string' ? src : src.id, to: typeof dst === 'string' ? dst : dst.id, label: label || undefined };
    this.edges.push(edge);
    return edge;
  }

  chain(nodes, label = null) {
    for (let i = 0; i < nodes.length - 1; i++) this.link(nodes[i], nodes[i + 1], label);
  }

  node(id) {
    return this.nodes.find((n) => n.id === id) || null;
  }

  get openItems() {
    const out = [];
    for (const n of this.nodes) for (const key of n.tbd) out.push(`${n.id}.${key}`);
    return out;
  }

  toSpec() {
    const nodes = this.nodes.map((n) => n.toDict());
    return {
      format: 1,
      sop_version: this.sopVersion,
      nodes,
      steps: nodes,
      edges: this.edges.map((e) => ({ from: e.from, to: e.to, ...(e.label ? { label: e.label } : {}) })),
      segments: this.segments.slice(),
      open_items: this.openItems,
      warnings: this.warnings.slice(),
    };
  }
}

module.exports = { ENTRY, DATASOURCE, PROCESS, DECISION, SEGMENT, NOTE, STOP, TOUCHPOINT, RESEND, EXIT, slug, FlowNode, FlowDesign };
