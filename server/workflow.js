// Where a campaign is in the intake -> orchestration workflow, and who owes
// the next step. Computed from the same data the gates use (field values,
// handoffs, contacts, emails, section confirmations), so the agent's
// guidance, "what's pending with me" and the campaign's next-step banner can
// never drift from what the page will actually let people do.

const handoffs = require('./handoffs');
const orchestration = require('./orchestration');

const filled = (x) => x !== undefined && x !== null && String(x).trim() !== '' && String(x).trim() !== '[]';
const yes = (x) => String(x || '').trim().toLowerCase() === 'yes';

const AOR_FIELDS = ['21', '22', '22.1', '22.2', '22.3', '23', '24', '24.1', '25', '26', '27'];
const VISIBLE_IF = {
  '20.1': (v) => yes(v['20']),
  '20.2': (v) => yes(v['20']),
  '22.2': (v) => yes(v['22.1']),
  '22.3': (v) => yes(v['22.1']) && yes(v['22.2']),
  '24.1': (v) => /sms/i.test(String(v['11'] || '')),
};

// How the agent asks for each field: one specific question, an example for
// typed answers, and (where the stored value is free text) fixed choices.
const QUESTIONS = {
  '11': { q: 'Which channels will this campaign use?' },
  '20': { q: 'Should Send Time Optimization be turned on for this campaign?' },
  '20.1': { q: 'What time window should the emails be sent in?', hint: 'For example: 9am to 5pm' },
  '20.2': { q: 'Should the send time be picked at random inside that window?', choices: ['Yes', 'No'] },
  '22': { q: 'What type of campaign is this?' },
  '22.1': { q: 'Does this campaign have an enrolment form?' },
  '22.2': { q: 'Is a survey sheet available?' },
  '23': { q: 'What is the goal of this campaign?', hint: 'A sentence or two is fine' },
  '24': { q: 'How many emails will this campaign send?', hint: 'A number, for example 4' },
  '24.1': { q: 'How many SMS messages will it send?', hint: 'A number, for example 2' },
  '25': { q: 'When should the campaign go live?', hint: 'A date, for example 2026-11-02' },
  '26': { q: 'What From Name should the emails come from?', hint: 'For example: Cosentyx Patient Support' },
  '27': { q: 'What are the segment names?', hint: 'Separate several with commas, for example Cardiologists, Primary care' },
  '28': { q: 'What rules define each segment?', hint: 'For example: prescribed in the last 6 months' },
  '29': { q: 'Which specialties should be included?', hint: 'For example: Dermatology, Rheumatology' },
  '30': { q: 'Which specialties should be excluded?', hint: 'Type none if there are no exclusions' },
  '31': { q: 'When should someone leave this journey?', hint: 'For example: unsubscribes or completes enrolment' },
};

// Field info by number: { key: { id, label, type, options, phase } }.
async function labels(prisma) {
  const rows = await prisma.formField.findMany({ where: { sectionId: 'generic' } });
  return Object.fromEntries(rows.map((r) => [r.fieldKey, {
    id: r.id, label: r.label.replace(/\s*\*\s*$/, ''), type: r.type, phase: r.phase,
    options: r.optionsJson ? JSON.parse(r.optionsJson) : null,
    question: (QUESTIONS[r.fieldKey] || {}).q || `What should ${r.label} be?`,
    hint: (QUESTIONS[r.fieldKey] || {}).hint || '',
    choices: (QUESTIONS[r.fieldKey] || {}).choices || null,
  }]));
}

// Missing fields as objects (plain labels; the number is only used to jump to the field).
function missingFields(keys, v, label) {
  return keys.filter((k) => (VISIBLE_IF[k] ? VISIBLE_IF[k](v) : true) && !filled(v[k])).map((k) => ({ key: k, ...(label[k] || { label: k }) }));
}
const names = (list) => list.map((f) => f.label).join(', ');

// Ordered steps. status: done | active (can be worked now) | waiting (blocked
// on an earlier step). `owner` is a persona key.
async function steps(prisma, tactplanId, label) {
  label = label || (await labels(prisma));
  const [v, meta, hs, conf] = await Promise.all([
    handoffs.fieldValues(prisma, tactplanId),
    prisma.campaignMeta.findUnique({ where: { tactplanId } }),
    handoffs.status(prisma, tactplanId),
    orchestration.confirmations(prisma, tactplanId),
  ]);
  const h = Object.fromEntries(hs.map((x) => [x.id, x]));
  const out = [];
  // target: where the step is done – view (general | journey | orchestration |
  // flow), optional section id and field number – for "Take me there".
  const add = (owner, title, status, detail, where, target, fields) => out.push({ owner, title, status, detail: detail || '', where: where || '', target: target || null, fields: fields || [] });
  const firstKey = (list) => (list[0] || {}).key || '';

  const cdmMissing = missingFields(orchestration.CDM_FIELDS, v, label);
  add('cdm', 'Complete your General Campaign Details fields', cdmMissing.length ? 'active' : 'done',
    cdmMissing.length ? `Still to fill in: ${names(cdmMissing)}` : '', 'General tab → General Campaign Details',
    { view: 'general', section: 'generic', field: firstKey(cdmMissing) }, cdmMissing);

  const c = conf.contacts;
  add('cdm', 'Confirm the people mapping (Contact Details)', c.confirmedAt ? 'done' : c.missing.length ? (cdmMissing.length ? 'waiting' : 'active') : 'active',
    c.confirmedAt ? '' : c.missing.length ? `Before confirming: ${c.missing.join(', ')}` : 'The roles are prefilled from the brand defaults. Update any that are wrong, then click Confirm section. OMS is notified once you confirm.', 'Orchestration → Contact Details', { view: 'orchestration', section: 'contacts' });

  const omsMissing = [];
  if (!filled(v['19'])) omsMissing.push('Campaign code');
  if (!(meta && meta.brandCode)) omsMissing.push('Brand code');
  add('oms', 'Provide Campaign code and Brand code', !omsMissing.length ? 'done' : h.A.status === 'waiting' ? 'waiting' : 'active',
    omsMissing.length ? (h.A.status === 'waiting' ? 'Notified once CDM completes General Campaign Details and confirms the people mapping.' : `Needed: ${omsMissing.join(', ')}`) : '', 'Orchestration → Handoffs', { view: 'orchestration', section: 'handoffs' });

  const aorMissing = missingFields(AOR_FIELDS, v, label);
  add('aor', 'Complete the campaign details', aorMissing.length ? 'active' : 'done',
    aorMissing.length ? `Still to fill in: ${names(aorMissing)}` : '', 'General tab → General Campaign Details',
    { view: 'general', section: 'generic', field: firstKey(aorMissing) }, aorMissing);

  const segMissing = missingFields(orchestration.CDM_JOURNEY_FIELDS, v, label);
  add('cdm', 'Add segment rules, specialties and exit criteria', !segMissing.length ? 'done' : filled(v['27']) ? 'active' : 'waiting',
    !segMissing.length ? '' : filled(v['27']) ? `Still to fill in: ${names(segMissing)}` : 'Waiting for AOR to name the segments.', 'General tab → General Campaign Details',
    { view: 'general', section: 'generic', field: firstKey(segMissing) }, segMissing);

  if (h.B.status !== 'waiting') {
    add('cep', 'Complete the A/B testing details', h.B.status === 'done' ? 'done' : 'active', '', 'Email and Journey tab → Email Details', { view: 'journey', section: 'emaildetails', field: '43' });
  }

  const e = conf.emails;
  const drafted = !!(meta && meta.draftedAt);
  add('aor', 'Complete every email and confirm Emails', e.confirmedAt ? 'done' : drafted ? 'active' : 'waiting',
    e.confirmedAt ? '' : drafted ? (e.missing.length ? `Before confirming: ${e.missing.join(', ')}` : 'Ready – click Confirm section.') : 'Emails are drafted automatically once CDM\'s intake fields, Number of Emails and Segment Name are filled.',
    'Email and Journey tab → Email Details', { view: 'journey', section: 'emaildetails' });

  const j = conf.journeys;
  add('aor', 'Check the journeys and confirm Journeys', j.confirmedAt ? 'done' : drafted ? 'active' : 'waiting',
    j.confirmedAt ? '' : j.missing.length ? `Before confirming: ${j.missing.join(', ')}` : 'Ready – click Confirm section.', 'Email and Journey tab → Journey Details', { view: 'journey', section: 'journeydetails' });

  if (h.D.status !== 'waiting') {
    add('solutionArchitect', 'Generate the segmentation flow', h.D.status === 'done' ? 'done' : 'active', '', 'Flow tab', { view: 'flow' });
  }
  return { steps: out, golive: v['25'] || '' };
}

// The persona's own open steps plus who is up after them, for one campaign.
async function forPersona(prisma, tactplanId, persona, label) {
  const { steps: all, golive } = await steps(prisma, tactplanId, label);
  const mine = all.filter((s) => s.owner === persona && s.status !== 'done');
  const others = all.filter((s) => s.owner !== persona && s.status === 'active');
  return { mine, others, all, golive };
}

// "What's pending with me" across every campaign.
async function pendingFor(prisma, persona) {
  const label = await labels(prisma);
  const campaigns = await prisma.campaign.findMany({ where: { status: 'active' }, orderBy: { createdAt: 'desc' } });
  const out = [];
  for (const c of campaigns) {
    const { mine, golive } = await forPersona(prisma, c.id, persona, label);
    for (const s of mine.filter((x) => x.status === 'active')) {
      out.push({ tactplanId: c.id, name: c.name, pending: s.title + (s.detail ? ` — ${s.detail}` : ''), where: s.where, dueDate: golive });
    }
  }
  return out;
}

module.exports = { steps, forPersona, pendingFor };
