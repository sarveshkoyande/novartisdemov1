// Flow Planner inputs, wire format and chat-edit patching — ported from the
// original Accelerate client's stores/useFlowPlannerStore.ts so the studio
// drives the same server generator (server/segmentation, /api/flow-planner/*).

export interface EnrollmentSource {
  name: string;
  code: string;
  qna: string;
}

export interface UnbrandedFork {
  present: boolean;
  campaignCode: string;
  lastTouchpointQuestion: string;
  lastTouchpointMetadataId: string;
  answerCodes: string; // comma-separated in the UI, split on generate
}

export interface FlowPlannerInputs {
  audience: 'DTC' | 'HCP' | '';
  campaignName: string;
  campaignCode: string;
  campaignType: string;
  goal: string;
  enrollmentSources: EnrollmentSource[];
  qna: string;
  metadataSheet: string;
  segments: string; // comma-separated in the UI, split on generate
  unbranded: UnbrandedFork;
  suppressionAnswers: Record<string, string>; // keyed by field_ref's field id (optOut, specialtyInclusion, specialtyExclusion, businessRules)
  // Direct text overrides for a printed block (node id -> replacement
  // detail text) — most blocks (suppression checks, Dedupe, the QnA
  // blocks) are fixed SOP boilerplate with no other input to change, so
  // editing them by their diagram code (e.g. "B12") only works this way.
  // See server/segmentation/index.js's applyOverrides.
  nodeOverrides: Record<string, string>;
  // Node ids removed from the diagram (e.g. "delete B6") — the generator
  // drops these nodes and reconnects their neighbours directly. See
  // server/segmentation/index.js's applyDeletion.
  deletedNodeIds: string[];
  // Brand-new blocks added via chat ("add a decision block asking X") —
  // appended to the generated node list as-is. See applyCustomNodes.
  customNodes: CustomNode[];
  // Structural edits beyond a single block's own text/existence: inserting
  // a new block into an existing connection, swapping two blocks' content,
  // recolouring, or a raw connect/disconnect. Applied in order. See
  // server/segmentation/index.js's applyGraphOp for the op shapes.
  graphOps: GraphOp[];
  // Per-segment journeys from the Journey Details builder (GET
  // /api/campaigns/:id/journey-inputs). Null until a journey exists, which
  // keeps the diagram segmentation-only.
  journey?: JourneyInputs | null;
  journeyUpdatedAt?: string | null;
  // A block's printed code (B1, B2, ...), assigned once and kept for the
  // life of the diagram rather than recomputed from node order on every
  // generation — see server/segmentation/drawing.js's stableCodes. Without
  // this, deleting one block silently renumbered every later one, so a code
  // referenced in an earlier chat message could point at the wrong block by
  // the time a later message used it. Node id -> printed code.
  codeAssignments: Record<string, string>;
}

export interface CustomNode {
  id: string;
  type: string;
  label: string;
  detail: string;
  status: string | null;
}

export type GraphOp =
  | { kind: 'insertBetween'; fromId: string; toId: string; newNodeId: string }
  | { kind: 'insertAfter'; afterId: string; newNodeId: string }
  | { kind: 'connect'; fromId: string; toId: string; label?: string }
  | { kind: 'disconnect'; fromId: string; toId: string }
  | { kind: 'swap'; idA: string; idB: string }
  | { kind: 'setStatus'; id: string; status: string | null }
  | { kind: 'setBranch'; id: string; branch: 'side' | 'down' };

export function emptyInputs(): FlowPlannerInputs {
  return {
    audience: '',
    campaignName: '',
    campaignCode: '',
    campaignType: '',
    goal: '',
    enrollmentSources: [{ name: '', code: '', qna: '' }],
    qna: '',
    metadataSheet: '',
    segments: '',
    unbranded: { present: false, campaignCode: '', lastTouchpointQuestion: '', lastTouchpointMetadataId: '', answerCodes: '' },
    suppressionAnswers: {},
    nodeOverrides: {},
    deletedNodeIds: [],
    customNodes: [],
    graphOps: [],
    codeAssignments: {},
  };
}

export interface JourneyTouchpointInput {
  name: string;
  type: string;
  fuseId: string;
  metadataId: string;
  deployDate: string;
  waitDays: number | null;
  resendNeeded: boolean;
  resendRule: string | null;
  resendDays: number | null;
  abTest: boolean;
}

export interface JourneyInputs {
  goliveDate: string;
  bySegment: Record<string, { touchpoints: JourneyTouchpointInput[] }>;
}

/** The wire shape the server's /api/flow-planner routes expect. */
export function toGenerateRequest(inputs: FlowPlannerInputs) {
  return {
    audience: inputs.audience || undefined,
    campaignName: inputs.campaignName,
    campaignCode: inputs.campaignCode,
    campaignType: inputs.campaignType,
    goal: inputs.goal,
    enrollmentSources: inputs.enrollmentSources.filter((s) => s.name || s.code || s.qna),
    qna: inputs.qna,
    metadataSheet: inputs.metadataSheet,
    segments: inputs.segments.split(',').map((s) => s.trim()).filter(Boolean),
    unbranded: {
      present: inputs.unbranded.present,
      campaignCode: inputs.unbranded.campaignCode,
      lastTouchpointQuestion: inputs.unbranded.lastTouchpointQuestion,
      lastTouchpointMetadataId: inputs.unbranded.lastTouchpointMetadataId,
      answerCodes: inputs.unbranded.answerCodes.split(',').map((s) => s.trim()).filter(Boolean),
    },
    suppressionAnswers: inputs.suppressionAnswers,
    nodeOverrides: inputs.nodeOverrides,
    deletedNodeIds: inputs.deletedNodeIds,
    customNodes: inputs.customNodes,
    graphOps: inputs.graphOps,
    codeAssignments: inputs.codeAssignments,
    journey: inputs.journey && Object.keys(inputs.journey.bySegment).length ? inputs.journey : undefined,
  };
}

// The flat shape /api/flow-planner/chat-edit's tool call returns — mirrors
// FlowPlannerInputs but with the nested unbranded/suppressionAnswers
// objects flattened, because a forced single tool call is far more reliable
// at filling a flat field list than a nested one.
export interface ChatEditPatch {
  audience?: 'DTC' | 'HCP' | '';
  campaignName?: string;
  campaignCode?: string;
  campaignType?: string;
  goal?: string;
  segments?: string;
  qna?: string;
  metadataSheet?: string;
  enrollmentSources?: EnrollmentSource[];
  unbrandedPresent?: boolean;
  unbrandedCampaignCode?: string;
  unbrandedLastTouchpointQuestion?: string;
  unbrandedAnswerCodes?: string;
  businessRules?: string;
  specialtyInclusion?: string;
  specialtyExclusion?: string;
  nodeOverrideId?: string;
  nodeOverrideText?: string;
  nodeDeleteId?: string;
  customNodes?: CustomNode[];
  graphOps?: GraphOp[];
}

export function patchToInputs(patch: ChatEditPatch, cur: FlowPlannerInputs): Partial<FlowPlannerInputs> {
  const real: Partial<FlowPlannerInputs> = {};
  if (patch.audience !== undefined) real.audience = patch.audience;
  if (patch.campaignName !== undefined) real.campaignName = patch.campaignName;
  if (patch.campaignCode !== undefined) real.campaignCode = patch.campaignCode;
  if (patch.campaignType !== undefined) real.campaignType = patch.campaignType;
  if (patch.goal !== undefined) real.goal = patch.goal;
  if (patch.segments !== undefined) real.segments = patch.segments;
  if (patch.qna !== undefined) real.qna = patch.qna;
  if (patch.metadataSheet !== undefined) real.metadataSheet = patch.metadataSheet;
  if (patch.enrollmentSources !== undefined) real.enrollmentSources = patch.enrollmentSources;
  const unbrandedChanged = patch.unbrandedPresent !== undefined || patch.unbrandedCampaignCode !== undefined || patch.unbrandedLastTouchpointQuestion !== undefined || patch.unbrandedAnswerCodes !== undefined;
  if (unbrandedChanged) {
    real.unbranded = {
      present: patch.unbrandedPresent ?? cur.unbranded.present,
      campaignCode: patch.unbrandedCampaignCode ?? cur.unbranded.campaignCode,
      lastTouchpointQuestion: patch.unbrandedLastTouchpointQuestion ?? cur.unbranded.lastTouchpointQuestion,
      lastTouchpointMetadataId: cur.unbranded.lastTouchpointMetadataId,
      answerCodes: patch.unbrandedAnswerCodes ?? cur.unbranded.answerCodes,
    };
  }
  const suppressionChanged = patch.businessRules !== undefined || patch.specialtyInclusion !== undefined || patch.specialtyExclusion !== undefined;
  if (suppressionChanged) {
    real.suppressionAnswers = {
      ...cur.suppressionAnswers,
      ...(patch.businessRules !== undefined ? { businessRules: patch.businessRules } : {}),
      ...(patch.specialtyInclusion !== undefined ? { specialtyInclusion: patch.specialtyInclusion } : {}),
      ...(patch.specialtyExclusion !== undefined ? { specialtyExclusion: patch.specialtyExclusion } : {}),
    };
  }
  if (patch.nodeOverrideId) {
    real.nodeOverrides = { ...cur.nodeOverrides, [patch.nodeOverrideId]: patch.nodeOverrideText ?? '' };
  }
  if (patch.nodeDeleteId && !cur.deletedNodeIds.includes(patch.nodeDeleteId)) {
    real.deletedNodeIds = [...cur.deletedNodeIds, patch.nodeDeleteId];
  }
  if (patch.customNodes?.length) {
    real.customNodes = [...cur.customNodes, ...patch.customNodes];
  }
  if (patch.graphOps?.length) {
    real.graphOps = [...cur.graphOps, ...patch.graphOps];
  }
  return real;
}

// ---------------------------------------------------------------------------
// Studio wiring: the generator's inputs are DERIVED from Campaign Memory on
// every generation, so the flow always reflects the latest campaign details.
// Only diagram-level edits (block overrides, deletions, added blocks, graph
// ops, stable block codes) and explicit Flow-chat field changes are stored
// separately, on planning.flow.edits.
// ---------------------------------------------------------------------------
const days = (v: string) => { const m = String(v || '').match(/([\d.]+)\s*(hour|day)/i); return m ? (m[2].toLowerCase() === 'hour' ? Number(m[1]) / 24 : Number(m[1])) : null; };

export function inputsFromCampaign(state: any): FlowPlannerInputs {
  const f = state.fields || {}, p = state.planning;
  const audience = String(f['18'] || '').toUpperCase();
  const segments = String(f['27'] || '').split(',').map(s => s.trim()).filter(Boolean);
  const touchpoints: JourneyTouchpointInput[] = (p?.emails || []).map((e: any, i: number) => {
    const t = p.touchpoints[i]?.fields || {};
    return {
      name: e.fields['36'] || `Email ${String(i + 1).padStart(2, '0')}`, type: f['11'] === 'SMS' ? 'SMS' : 'Email',
      fuseId: '', metadataId: '', deployDate: e.fields['37'] || '', waitDays: days(t['48']),
      resendNeeded: t['49'] === 'Yes', resendRule: t['49.1'] || null, resendDays: null, abTest: e.fields['43'] === 'Yes',
    };
  });
  const base: FlowPlannerInputs = {
    ...emptyInputs(),
    audience: audience === 'DTC' || audience === 'HCP' ? audience : '',
    campaignName: f['21'] || '', campaignCode: f['19'] || '', campaignType: f['22'] || '', goal: f['23'] || '',
    metadataSheet: f['22.3'] || '', segments: segments.join(', '),
    suppressionAnswers: { ...(f['28'] ? { businessRules: f['28'] } : {}), ...(f['29'] ? { specialtyInclusion: f['29'] } : {}), ...(f['30'] ? { specialtyExclusion: f['30'] } : {}) },
    journey: touchpoints.length ? { goliveDate: f['25'] || '', bySegment: Object.fromEntries((segments.length ? segments : ['All']).map(s => [s, { touchpoints }])) } : null,
  };
  const edits = p?.flow?.edits || {};
  return { ...base, ...edits, suppressionAnswers: { ...base.suppressionAnswers, ...(edits.suppressionAnswers || {}) } };
}

async function post(url: string, body: unknown) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  return res;
}

export async function generateFlow(inputs: FlowPlannerInputs): Promise<{ svg: string; codeAssignments: Record<string, string>; spec: any }> {
  return (await post('/api/flow-planner/generate', toGenerateRequest(inputs))).json();
}

export async function chatEditFlow(text: string, inputs: FlowPlannerInputs): Promise<{ patch: ChatEditPatch; summary: string; codeAssignments?: Record<string, string> }> {
  return (await post('/api/flow-planner/chat-edit', { text, currentInputs: toGenerateRequest(inputs) })).json();
}

export async function downloadVsdx(inputs: FlowPlannerInputs) {
  const blob = await (await post('/api/flow-planner/vsdx', toGenerateRequest(inputs))).blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${(inputs.campaignName || 'segmentation-flow').replace(/[^a-z0-9-]+/gi, '-')}.vsdx`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
