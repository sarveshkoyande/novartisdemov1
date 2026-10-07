// SOP rows 1-9: the segmentation region. Ported from
// app/flow/segmentation.py in the reference project, with the derivation-
// citation plumbing (`derived_from`, field refs into a versioned intake
// record) stripped out — this app has no approval-gate content hashing to
// feed, so a node only needs its label/detail/tbd flags, not a proof of
// where each value came from.
//
// Inputs come from a dedicated flow-planner field set (see client
// useFlowPlannerStore.ts), not the existing Intake tab fields — a deliberate
// choice so this generator isn't coupled to whatever the Intake form happens
// to be shaped like today.

const sop = require('./sop');
const { NOTE, DATASOURCE, PROCESS, DECISION, SEGMENT, FlowNode, slug } = require('./model');

function note(id, label, boxes, sopRef, rationale) {
  return new FlowNode({
    id,
    type: NOTE,
    label,
    detail: boxes.map((b) => b.title).join(' · '),
    attrs: { boxes },
    rationale,
    sopRef,
  });
}

function leftPane(inp) {
  const { campaignName: name, campaignCode: code, campaignType: ctype } = inp;
  const box1 = [
    `Campaign Name: ${name || sop.TBD}`,
    `Campaign Code: ${code || sop.TBD}`,
    `${sop.text('fulfilment_code_label')}:`,
  ];
  const boxes = [
    { title: 'Campaign', lines: box1 },
    { title: 'Task Responsibility', lines: sop.TASK_RESPONSIBILITIES.slice() },
    {
      title: 'Legend',
      lines: sop.LEGEND.map((l) => l.label),
      swatches: sop.LEGEND.map((l) => ({ label: l.label, colour: l.colour })),
    },
    { title: 'Campaign Type', lines: [ctype || sop.TBD] },
  ];
  const node = note('pane.left', 'Campaign', boxes, 'seg.1', 'Campaign identity, responsibilities and legend — SOP row 1');
  if (!name) node.markTbd('campaign_name');
  if (!code) node.markTbd('campaign_code');
  if (!ctype) node.markTbd('campaign_type');
  return node;
}

function rightPane(inp) {
  if (inp.audience === sop.HCP) return null;
  const sources = inp.enrollmentSources || [];
  const lines = [];
  sources.forEach((src, i) => {
    lines.push(`Source ${i + 1}: ${src.name || sop.TBD}`);
    lines.push(`  Campaign Source Code: ${src.code || sop.TBD}`);
    lines.push(`  QnA: ${src.qna || sop.TBD}`);
  });
  const node = note(
    'pane.right',
    sop.text('enrollment_sources_title'),
    [{ title: sop.text('enrollment_sources_title'), lines: lines.length ? lines : [sop.TBD] }],
    'seg.2',
    'Enrollment sources with their codes and segment QnA pairs — SOP row 2',
  );
  if (!sources.length) node.markTbd('enrollment_sources');
  return node;
}

function dataSource(inp) {
  if (inp.audience === sop.HCP) {
    const ctype = inp.campaignType;
    const cad = sop.cadence(ctype);
    const lines = [sop.text('hcp_qualification', { campaign_type: ctype || sop.TBD }), sop.text('hcp_target_list', { cadence: cad || sop.TBD })];
    const node = new FlowNode({
      id: 'seg.source',
      type: DATASOURCE,
      label: 'Qualification for Campaign',
      detail: lines.join(' / '),
      attrs: { lines },
      sopRef: 'seg.3',
      rationale: 'HCP target list qualified by campaign type — SOP row 3, HCP column',
    });
    if (!cad) node.markTbd('cadence');
    return node;
  }

  const { campaignName: name, campaignType: ctype, campaignCode: code } = inp;
  const lines = [[name, ctype, code].filter(Boolean).join(', ') || sop.TBD];
  const sources = inp.enrollmentSources || [];
  if (sources.length) {
    const join = sop.text('source_pair_join');
    sources.forEach((src, i) => {
      if (i) lines.push(join);
      lines.push(`${src.name || sop.TBD}, ${src.code || sop.TBD}`);
    });
  } else {
    lines.push(sop.TBD);
  }
  lines.push(sop.text('disposition'));

  const node = new FlowNode({
    id: 'seg.source',
    type: DATASOURCE,
    label: 'Campaign Source',
    detail: lines.join(' / '),
    attrs: { lines },
    sopRef: 'seg.3',
    rationale: 'Campaign identity and enrollment source codes — SOP row 3, DTC column',
  });
  if (!sources.length) node.markTbd('enrollment_sources');
  return node;
}

function dedupe() {
  return new FlowNode({ id: 'seg.dedupe', type: PROCESS, label: 'Dedupe', detail: sop.text('dedupe'), sopRef: 'seg.4', rationale: 'Fixed SOP step — row 4' });
}

function suppressions(design, inp) {
  const audience = inp.audience || sop.DTC;
  const built = [];
  for (const rule of sop.suppressions(audience)) {
    const ref = rule.field_ref;
    let value = null;
    if (ref) {
      const [, fieldId] = ref.split('/', 2);
      value = (inp.suppressionAnswers || {})[fieldId] || null;
    }
    const node = design.add(
      new FlowNode({
        id: `seg.supp.${rule.slug}`,
        type: DECISION,
        label: rule.label,
        detail: value && value !== rule.label ? value : '',
        attrs: { block: rule.block },
        sopRef: 'seg.5',
        rationale: `MDS suppression '${rule.block}' — SOP row 5, ${audience} column`,
      }),
    );
    built.push(node);
  }
  design.chain(built);
  return built;
}

function qnaBlock(inp, which) {
  const hidden = which === 'hidden';
  return new FlowNode({
    id: `seg.qna.${which}`,
    type: PROCESS,
    label: sop.text(hidden ? 'hidden_qna' : 'segment_qna'),
    detail: inp.qna || sop.TBD,
    sopRef: hidden ? 'seg.6' : 'seg.8',
    rationale: hidden ? 'Hidden survey QnA pairs from the metadata sheet — SOP row 6' : 'Segment survey QnA pairs from the metadata sheet — SOP row 8',
  });
}

function unbrandedFork(design, inp) {
  const unbranded = inp.unbranded || {};
  const code = unbranded.campaignCode;
  const head = design.add(
    new FlowNode({
      id: 'seg.fork.decision',
      type: DECISION,
      label: sop.text('unbranded_fork_label'),
      detail: `Campaign source code = ${code || sop.TBD}`,
      attrs: { campaign_code: code },
      sopRef: 'seg.7',
      rationale: 'Campaign goal requires capture from an unbranded source — SOP row 7',
    }),
  );
  if (!code) head.markTbd('campaign_code');

  const question = unbranded.lastTouchpointQuestion;
  const metadata = unbranded.lastTouchpointMetadataId;
  const qNode = design.add(
    new FlowNode({
      id: 'seg.fork.question',
      type: DECISION,
      label: sop.text('last_touchpoint_label'),
      detail: `${question || sop.TBD} · Metadata ID: ${metadata || sop.TBD}`,
      attrs: { question_code: question, metadata_id: metadata },
      sopRef: 'seg.7',
      rationale: 'Last touchpoint question code and Metadata ID in the unbranded flow — SOP row 7, Decision 1',
    }),
  );
  if (!question) qNode.markTbd('question_code');
  if (!metadata) qNode.markTbd('metadata_id');

  const answers = unbranded.answerCodes || [];
  const aNode = design.add(
    new FlowNode({
      id: 'seg.fork.answer',
      type: DECISION,
      label: sop.text('last_touchpoint_answer_label'),
      detail: answers.length ? answers.join(', ') : sop.TBD,
      attrs: { answer_codes: answers },
      sopRef: 'seg.7',
      rationale: 'Answer codes linked to the last touchpoint question — SOP row 7, Decision 2',
    }),
  );
  if (!answers.length) aNode.markTbd('answer_codes');

  design.link(head, qNode, 'Yes');
  design.link(qNode, aNode);
  return aNode;
}

function segmentNodes(design, names, recommended) {
  return names.map((name, i) => {
    const node = design.add(
      new FlowNode({
        id: `seg.name.${slug(name, String(i + 1))}`,
        type: SEGMENT,
        label: `Segment Name: ${name}`,
        detail: '',
        attrs: { segment: name, recommended },
        sopRef: 'seg.9',
        rationale: recommended
          ? 'Segment name recommended from the campaign goal and survey text for the SA to confirm — SOP row 9'
          : 'Segment name taken from the campaign record — SOP row 9',
      }),
    );
    if (recommended || name === sop.TBD) node.markTbd('segment_name');
    return node;
  });
}

/**
 * Resolve segment names per SOP row 9: declared names win, then TBD.
 * (The reference project additionally tries an LLM recommendation from the
 * campaign goal/survey text; that step is not ported here — no model call
 * is wired up in accelerate-app for this yet, so an empty declaration goes
 * straight to a single TBD segment lane, same terminal outcome the SOP
 * describes for "nothing to infer from" either way.)
 */
function resolveSegments(inp) {
  const declared = (inp.segments || []).map((s) => s.trim()).filter(Boolean);
  if (declared.length) return { names: declared, recommended: false };
  return { names: [sop.TBD], recommended: true };
}

function build(design, inp) {
  design.add(leftPane(inp));
  const pane = rightPane(inp);
  if (pane) design.add(pane);

  const spine = [design.add(dataSource(inp)), design.add(dedupe())];
  design.chain(spine);

  const supps = suppressions(design, inp);
  let tail = spine[spine.length - 1];
  if (supps.length) {
    design.link(tail, supps[0]);
    tail = supps[supps.length - 1];
  }

  // The SOP's "Survey QnA pairs (Hidden)" block (row 6) is left out on
  // request: it repeated the segment QnA text and only ever rendered TBD in
  // practice. The suppressions now lead straight into the unbranded fork, or
  // into the segment QnA block.
  if (inp.unbranded && inp.unbranded.present) {
    const forkTail = unbrandedFork(design, inp);
    design.link(tail, 'seg.fork.decision');
    tail = forkTail;
  }

  const segmentQna = design.add(qnaBlock(inp, 'segment'));
  design.link(tail, segmentQna);

  const { names, recommended } = resolveSegments(inp);
  design.segments = names;
  const nodes = segmentNodes(design, names, recommended);
  for (const node of nodes) design.link(segmentQna, node);
  return nodes;
}

module.exports = { build };
