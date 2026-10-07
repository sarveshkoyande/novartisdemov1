// The fixed parts of the Flow Planner SOP — ported from the reference
// campaign-accelerator-api project's app/flow/sop.py + app/seed/flow_sop_rules.json.
// Data rather than code, same reasoning as the original: the SOP can be revised
// without touching the generator, and a generated flow can name the rule
// version it was built from.

const DATA = {
  version: '1.0.0',
  source: 'SOP_FlowPlanner_Segmentation_DRAFT v2 Indegene response 25_08_2026',
  legend: [
    { key: 'live', label: 'Live in Production', colour: '#1B7F51' },
    { key: 'new', label: 'New / Updated', colour: '#C8A302' },
    { key: 'hold', label: 'On hold / off', colour: '#C4342B' },
    { key: 'built_not_live', label: 'Built but not live / off', colour: '#8A8681' },
  ],
  taskResponsibilities: ['MDS', 'SFMC', 'OMS'],
  campaignTypeCadence: {
    'Ad Hoc': 'Adhoc',
    Adhoc: 'Adhoc',
    Cadenced: 'Cadenced',
    Automation: 'Cadenced',
    'Real-time & Cadenced': 'Cadenced',
  },
  text: {
    dedupe: 'Dedupe and pick the Dispo based on latest response timestamp to determine cadence timing.',
    disposition: 'Disposition 4 and 26',
    hcp_qualification: 'Qualification for Campaign - {campaign_type}',
    hcp_target_list: 'HCP {cadence} Target list',
    hidden_qna: 'Survey QnA pairs (Hidden)',
    segment_qna: 'Survey QnA pairs (Segment)',
    tbd: 'TBD',
    fulfilment_code_label: 'Fulfilment Campaign Code',
    source_pair_join: 'or',
    enrollment_sources_title: 'Enrollment Sources',
    unbranded_fork_label: 'Unbranded Campaign Code?',
    last_touchpoint_label: 'Last Touchpoint question code',
    last_touchpoint_answer_label: 'Answer code(s) linked to the question above',
    resend_decision: 'Email opened / Clicked?',
    resend_suffix: ' Resend',
    stop: 'Stop',
  },
  suppressions: {
    DTC: [
      { slug: 'age18', block: '18+ age check', label: 'Age 18+?' },
      { slug: 'campaign_optin', block: 'Campaign Opt In', label: 'Opted into Campaign?' },
      { slug: 'novartis_optin', block: 'All Novartis Opt In', label: 'Opted into All Novartis?' },
      { slug: 'therapy_optin', block: 'Therapy Class Opt In', label: 'Opted into Therapy Class?' },
      { slug: 'notice_language', block: 'Notice Language', label: 'Notice Language valid?' },
      { slug: 'email_consent', block: 'Consumer consents to use Email Address?', label: 'Consumer consents to use Email Address?' },
      { slug: 'retargeting_optin', block: 'Retargeting Opt In', label: 'Retargeting Opt In?' },
    ],
    HCP: [
      { slug: 'best_contact', block: 'BEST_CONTACT', label: 'BEST_CONTACT' },
      { slug: 'kaiser', block: 'Kaiser Suppression', label: 'Kaiser HCP Scrub' },
      { slug: 'rochester', block: 'University of Rochester', label: 'University of Rochester' },
      { slug: 'optout', block: 'Opt-out Suppression', label: 'Opt-out Suppression', field_ref: 'onboarding/optOut' },
      { slug: 'state_validation', block: 'State Validation', label: 'State Validation' },
      { slug: 'specialty_inclusion', block: 'Specialty Inclusion', label: 'Specialty Inclusion', field_ref: 'dc/specialtyInclusion' },
      { slug: 'specialty_exclusion', block: 'Specialty Exclusion', label: 'Specialty Exclusion', field_ref: 'dc/specialtyExclusion' },
      { slug: 'business_rules', block: 'Additional Business Rules', label: 'Additional Business Rules', field_ref: 'dc/businessRules' },
    ],
  },
};

const DTC = 'DTC';
const HCP = 'HCP';
const TBD = DATA.text.tbd;

function text(key, fmt) {
  if (!(key in DATA.text)) throw new Error(`no SOP text for '${key}'`);
  let out = DATA.text[key];
  if (fmt) for (const k of Object.keys(fmt)) out = out.replace(`{${k}}`, fmt[k]);
  return out;
}

function suppressions(audience) {
  return (DATA.suppressions[normaliseAudience(audience) || DTC] || []).slice();
}

function cadence(campaignType) {
  if (!campaignType) return null;
  return DATA.campaignTypeCadence[campaignType.trim()] || null;
}

function normaliseAudience(value) {
  if (!value) return null;
  const v = value.trim().toUpperCase();
  return v === DTC || v === HCP ? v : null;
}

module.exports = {
  VERSION: DATA.version,
  SOURCE: DATA.source,
  LEGEND: DATA.legend,
  TASK_RESPONSIBILITIES: DATA.taskResponsibilities,
  DTC,
  HCP,
  TBD,
  text,
  suppressions,
  cadence,
  normaliseAudience,
};
