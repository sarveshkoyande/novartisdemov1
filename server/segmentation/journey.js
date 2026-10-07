// SOP rows 10-17: the email journey, built once per segment. Ported from the
// reference project's app/flow/journeybuild.py plus the touchpoint and go-live
// reading from app/flow/inputs.py.
//
// Built only when the caller passes `inputs.journey`. Without it the planner
// stays segmentation-only, which is what the Flow tab shows today.
//
// Card text puts each parameter on its own line (Day, type, Fuse ID,
// Metadata ID, Go-Live). The reference joined them with " · ", which
// wrapped mid-parameter and made the IDs hard to read on a card.

const sop = require('./sop');
const { DECISION, EXIT, NOTE, RESEND, SEGMENT, TOUCHPOINT, FlowNode, slug } = require('./model');

const JOURNEY = 'journey';
const YES = new Set(['yes', 'y', 'true', 'required']);
const DAY_WORDS = { immediately: 0, 'same day': 0, 'same-day': 0, 'day of': 0 };

// One text value holding several items. Separators are tried from most to
// least deliberate, so "Fall push, wave 2" on one line stays one item.
function parseList(raw) {
  if (!raw || !String(raw).trim()) return [];
  const text = String(raw).trim();
  for (const sep of ['\n', ';', '|']) {
    if (text.includes(sep)) return text.split(sep).map((p) => p.trim()).filter(Boolean);
  }
  if (text.includes(',')) return text.split(',').map((p) => p.trim()).filter(Boolean);
  return [text];
}

function parseCount(raw) {
  const m = String(raw || '').match(/\d+/);
  if (!m) return null;
  const n = parseInt(m[0], 10);
  return n > 0 && n <= 50 ? n : null;
}

// "2", "2 days", "Wait 2 Days", "P2D", "1 week". Anything unreadable is null,
// so the card says "Day TBD" rather than inventing a schedule.
function parseDays(raw) {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim().toLowerCase();
  if (!text) return null;
  if (text in DAY_WORDS) return DAY_WORDS[text];
  const iso = text.match(/^p(\d+)d$/);
  if (iso) return parseInt(iso[1], 10);
  const m = text.match(/(\d+)\s*(day|d\b|week|w\b)?/);
  if (!m) return null;
  let n = parseInt(m[1], 10);
  if ((m[2] || '').startsWith('w')) n *= 7;
  return n >= 0 && n <= 365 ? n : null;
}

function parseDate(raw) {
  if (!raw || !String(raw).trim()) return null;
  const d = new Date(String(raw).trim());
  return Number.isNaN(d.getTime()) ? null : d;
}

function isoDate(d) {
  return d ? d.toISOString().slice(0, 10) : null;
}

// Parse the lists, take the longest as the real shape, and never emit fewer
// sends than the stated count. A missing value becomes TBD on that send only.
function touchpoints(j) {
  if (Array.isArray(j.touchpoints)) return structuredTouchpoints(j.touchpoints);
  const names = parseList(j.touchpointNames);
  const types = parseList(j.touchpointTypes);
  const waits = parseList(j.waits);
  const fuses = parseList(j.fuseIds);
  const metas = parseList(j.metadataIds);
  // Kept positional (blank lines preserved) so rule N lines up with touchpoint N.
  const resendRules = String(j.resendRule || '').includes('\n') ? String(j.resendRule).split('\n').map((p) => p.trim()) : parseList(j.resendRule);
  const stated = parseCount(j.touchpointCount);
  let total = Math.max(stated || 0, names.length, types.length, waits.length, fuses.length, metas.length);
  if (total === 0) total = 1;

  // Resend is per touchpoint ("Yes\nNo\nYes"); a single value applies to all.
  const resends = parseList(j.resendNeeded);
  const pick = (list, i) => (i >= 0 && i < list.length ? list[i] : null);

  const out = [];
  let day = 0;
  for (let i = 0; i < total; i++) {
    const tp = {
      index: i + 1,
      name: pick(names, i),
      type: pick(types, i) || types[0] || null,
      fuseId: pick(fuses, i),
      metadataId: pick(metas, i),
      resendNeeded: YES.has(String(resends.length === 1 ? resends[0] : pick(resends, i) || '').trim().toLowerCase()),
      resendRule: pick(resendRules, i) || (resendRules.length === 1 ? resendRules[0] : null),
      day: null,
      resendDay: null,
      missing: [],
    };
    for (const [key, value] of [['name', tp.name], ['type', tp.type], ['fuse_id', tp.fuseId], ['metadata_id', tp.metadataId]]) {
      if (!value) tp.missing.push(key);
    }
    // Day X: the first send opens the journey; each later one adds the wait
    // declared before it.
    if (i === 0) {
      day = 1;
      tp.day = 1;
    } else {
      const wait = parseDays(pick(waits, i - 1));
      if (wait === null) {
        tp.missing.push('day');
      } else {
        day += wait;
        tp.day = day;
      }
    }
    if (tp.resendNeeded) {
      const offset = parseDays(tp.resendRule);
      tp.resendDay = offset === null || tp.day === null ? null : tp.day + offset;
    }
    tp.displayName = tp.name || `Touchpoint ${tp.index}`;
    out.push(tp);
  }
  return out;
}

// The journey builder's shape: one object per card, so a missing value stays
// on its own card instead of shifting later values up (newline lists drop
// blanks). waitDays is the wait AFTER this card, before the next one; the
// resend goes out resendDays after its send.
const ENGAGEMENT = { open: 'No open', click: 'No click' };
function structuredTouchpoints(list) {
  let day = 1;
  return list.map((t, i) => {
    if (i > 0) {
      const wait = list[i - 1].waitDays;
      day = day === null || wait === null || wait === undefined ? null : day + Number(wait);
    }
    const resendNeeded = !!t.resendNeeded;
    const hasDays = t.resendDays !== null && t.resendDays !== undefined;
    const condition = ENGAGEMENT[t.resendRule] || t.resendRule || '';
    const tp = {
      index: i + 1,
      name: t.name || null,
      type: t.type || 'Email',
      fuseId: t.fuseId || null,
      metadataId: t.metadataId || null,
      deployDate: t.deployDate || null,
      resendNeeded,
      resendRule: resendNeeded ? [condition, hasDays ? `resend after ${t.resendDays} days` : ''].filter(Boolean).join(' - ') || null : null,
      day,
      resendDay: resendNeeded && hasDays && day !== null ? day + Number(t.resendDays) : null,
      missing: [],
    };
    for (const [key, value] of [['name', tp.name], ['fuse_id', tp.fuseId], ['metadata_id', tp.metadataId]]) if (!value) tp.missing.push(key);
    if (day === null) tp.missing.push('day');
    tp.displayName = tp.name || `Touchpoint ${tp.index}`;
    return tp;
  });
}

// SOP row 10: the legend state for this campaign's sends. A go-live already
// past reads as live, one ahead as new; without a date, built but not live.
function goliveStatus(j, today) {
  if (j.onHold) return { status: 'hold', date: null };
  const date = parseDate(j.goliveDate);
  if (!date) return { status: 'built_not_live', date: null };
  return { status: date <= today ? 'live' : 'new', date };
}

function legendPane(j, today) {
  const { status, date } = goliveStatus(j, today);
  const label = (sop.LEGEND.find((l) => l.key === status) || {}).label || status;
  const node = new FlowNode({
    id: 'pane.legend',
    type: NOTE,
    label: 'Legend',
    region: JOURNEY,
    detail: `Go-live ${isoDate(date) || sop.TBD} · ${label}`,
    attrs: {
      boxes: [{ title: 'Legend', lines: sop.LEGEND.map((l) => l.label), swatches: sop.LEGEND.map((l) => ({ label: l.label, colour: l.colour })) }],
      golive: isoDate(date),
      status,
    },
    status,
    sopRef: 'jny.10',
    rationale: 'Email status from comparing today against the go-live date — SOP row 10',
  });
  if (!date) node.markTbd('golive');
  return node;
}

function cardLines(day, tp, golive) {
  return [
    day !== null ? `Day ${day}` : `Day ${sop.TBD}`,
    `Type: ${tp.type || sop.TBD}`,
    `Fuse ID: ${tp.fuseId || sop.TBD}`,
    `Metadata ID: ${tp.metadataId || sop.TBD}`,
    `Go-Live: ${golive || sop.TBD}`,
  ].join('\n');
}

function buildSegment(design, j, segment, tps, status, golive) {
  const lane = segment;
  const base = `jny.${slug(segment)}`;
  const start = design.add(new FlowNode({
    id: `${base}.start`, type: SEGMENT, label: `Segment Name: ${segment}`, detail: '',
    region: JOURNEY, lane, attrs: { segment }, status, sopRef: 'jny.11',
    rationale: 'Segment carried through from the segmentation region — SOP row 11',
  }));
  const segNode = design.node(`seg.name.${slug(segment)}`);
  if (segNode) design.link(segNode, start);

  let previous = start;
  tps.forEach((tp, idx) => {
    // A send's own Email Deploy Date (37) wins; otherwise only the first send
    // inherits the campaign go-live and later ones are TBD.
    const sendGolive = tp.deployDate || (tp.index === 1 ? golive : null);
    const node = design.add(new FlowNode({
      id: `${base}.tp${tp.index}`, type: TOUCHPOINT, label: tp.displayName,
      detail: cardLines(tp.day, tp, sendGolive), region: JOURNEY, lane,
      attrs: { day: tp.day, touchpoint_type: tp.type, fuse_id: tp.fuseId, metadata_id: tp.metadataId, golive: sendGolive },
      status, sopRef: tp.index === 1 ? 'jny.12' : 'jny.15',
      rationale: tp.index === 1 ? 'First send — SOP row 12' : 'Subsequent send, day from the wait before it — SOP row 15',
    }));
    for (const key of tp.missing) node.markTbd(key);
    if (!sendGolive) node.markTbd('golive');
    design.link(previous, node, previous.type === DECISION ? 'Yes' : null);

    if (tp.resendNeeded) {
      const question = design.add(new FlowNode({
        id: `${base}.tp${tp.index}.q`, type: DECISION, label: sop.text('resend_decision'),
        detail: tp.resendRule || sop.TBD, region: JOURNEY, lane,
        attrs: { resend_rule: tp.resendRule }, status, sopRef: tp.index === 1 ? 'jny.13' : 'jny.16',
        rationale: 'Resend decision on the engagement rule — SOP row 13',
      }));
      if (!tp.resendRule) question.markTbd('resend_rule');
      const resend = design.add(new FlowNode({
        id: `${base}.tp${tp.index}.resend`, type: RESEND, label: tp.displayName + sop.text('resend_suffix'),
        detail: cardLines(tp.resendDay, tp, null), region: JOURNEY, lane,
        attrs: { day: tp.resendDay, touchpoint_type: tp.type, fuse_id: tp.fuseId, metadata_id: tp.metadataId, golive: null },
        status, sopRef: tp.index === 1 ? 'jny.14' : 'jny.17',
        rationale: 'Resend of the preceding touchpoint; go-live always TBD — SOP row 14',
      }));
      resend.markTbd('golive');
      if (tp.resendDay === null) resend.markTbd('day');
      design.link(node, question);
      design.link(question, resend, 'No');
      design.link(resend, idx === tps.length - 1 ? `${base}.exit` : `${base}.tp${tp.index + 1}`);
      previous = question;
    } else {
      previous = node;
    }
  });

  const exit = design.add(new FlowNode({
    id: `${base}.exit`, type: EXIT, label: 'Exit', detail: j.exitRule || 'Goal met or journey complete',
    region: JOURNEY, lane, status, sopRef: 'jny.exit', rationale: 'Exit rule after send',
  }));
  design.link(previous, exit, previous.type === DECISION ? 'Yes' : null);
}

function build(design, journeyInputs, segments, today = new Date()) {
  const j = journeyInputs || {};
  design.add(legendPane(j, today));
  const { status, date } = goliveStatus(j, today);
  const golive = isoDate(date);
  // `j.bySegment[name]` gives a segment its own touchpoints and emails; any
  // field it leaves out falls back to the campaign-wide value.
  for (const segment of segments) {
    const own = { ...j, ...((j.bySegment || {})[segment] || {}) };
    buildSegment(design, own, segment, touchpoints(own), status, golive);
  }
}

module.exports = { build, touchpoints, parseList, parseDays };
