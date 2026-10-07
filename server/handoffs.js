// Cross-role handoffs for the intake (sections 1-2 plan, U4; sections 3-4
// plan, U3). Evaluated on the server after every write that can complete
// one, so form, chat and every browser share one result and each handoff
// fires once per campaign (TriggerFiring's unique key is the guarantee).
//
// A handoff is declarative: which field numbers must be filled, any extra
// condition, who is told, and what they are told. `evaluate` is pure so the
// conditions can be tested without a database.

const filled = (v) => v !== undefined && v !== null && String(v).trim() !== '';
const yes = (v) => String(v || '').trim().toLowerCase() === 'yes';
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => String(a + i));

// Fields hidden by a visibility rule don't count toward "complete".
// Mirrors the strict `ref` rules written by migrate-general-campaign-details.js.
const VISIBLE_IF = {
  '20.1': (v) => yes(v['20']),
  '20.2': (v) => yes(v['20']),
  '22.2': (v) => yes(v['22.1']),
  '22.3': (v) => yes(v['22.1']) && yes(v['22.2']),
};
const visible = (key, v) => (VISIBLE_IF[key] ? VISIBLE_IF[key](v) : true);
const allFilled = (keys, v) => keys.every((k) => !visible(k, v) || filled(v[k]));

// Every General Campaign Details number from 11 to 31, sub-fields included.
const FIELDS_11_31 = [...range(11, 20), '20.1', '20.2', '21', '22', '22.1', '22.2', '22.3', '23', '24', '24.1', ...range(25, 31)];

// CDM's first-pass fields: everything CDM fills before OMS and AOR are needed.
const CDM_FIRST_PASS = [...range(10, 18), '20', '20.1', '20.2'];

// `slot` is the Contact Details role whose confirmed contact the message
// names; null when the target role has no contact slot (OMS).
const HANDOFFS = [
  {
    id: 'A',
    title: 'OMS: Campaign code and Brand code',
    target: 'oms',
    slot: null,
    // Fires once CDM has finished their General fields AND confirmed the
    // people mapping (Contact Details), not as soon as the brand is known.
    met: ({ v, contactsConfirmed }) => allFilled(CDM_FIRST_PASS, v) && !!contactsConfirmed,
    message: () => 'CDM has completed the General Campaign Details and confirmed the contact mapping. Please provide the Campaign code (field 19) and the Brand code from Orchestration.',
  },
  {
    id: 'B',
    title: 'CEP: email A/B details',
    target: 'cep',
    slot: 'cep',
    met: ({ v, brandCode }) => allFilled(['14', '15', '16', '17', '18', '19', '22', '25', '27'], v) && filled(brandCode),
    message: () => 'Campaign details and Brand code are ready. Please complete the A/B testing details (43-43.4) in Email Details.',
  },
  {
    id: 'C',
    title: 'OMS: metadata sheet',
    target: 'oms',
    slot: null,
    met: ({ v }) => yes(v['22.1']) && String(v['18'] || '').trim().toUpperCase() === 'DTC',
    message: () => 'This DTC campaign has an enrolment form. Please attach the metadata sheet.',
  },
  {
    id: 'D',
    title: 'Solution Architect: segmentation flow',
    target: 'solutionArchitect',
    slot: 'solutionArchitect',
    met: ({ v }) => allFilled(FIELDS_11_31, v),
    message: () => 'Fields 11-31 are complete. Open the Flow tab: the segmentation flow generates automatically on your first visit.',
  },
  // Sections 3-4: recorded as ready, nobody notified (generation not built).
  {
    id: 'E',
    title: 'HQE metadata sheet (generation not built)',
    target: null,
    slot: null,
    met: ({ v, emails }) => emails.length > 0 && emails.every((e) => e.complete) && allFilled(['42', '44'], v),
    message: () => '',
  },
  {
    id: 'F',
    title: 'UTM matrix (generation not built)',
    target: null,
    slot: null,
    met: ({ emails }) => emails.length > 0 && emails.every((e) => e.complete && filled(e.metadataId)),
    message: () => '',
  },
];

// ctx: { v: {fieldKey: value}, brandCode, contactsConfirmed, emails: [{complete, metadataId}] }
function evaluate(ctx) {
  const full = { v: {}, brandCode: null, emails: [], ...ctx };
  return HANDOFFS.filter((h) => h.met(full)).map((h) => h.id);
}

// ---- database side ---------------------------------------------------------

// Values by field number for one campaign. Entries are saved under the
// FormField id; older rows used the fieldKey itself, so both are accepted.
async function fieldValues(prisma, tactplanId) {
  const [fields, entries] = await Promise.all([
    prisma.formField.findMany({ select: { id: true, fieldKey: true } }),
    prisma.fieldEntry.findMany({ where: { tactplanId } }),
  ]);
  const keyById = new Map(fields.map((f) => [f.id, f.fieldKey]));
  const v = {};
  for (const e of entries) {
    const key = keyById.get(e.fieldId) || e.fieldId;
    if (filled(e.value) || v[key] === undefined) v[key] = e.value;
  }
  return v;
}

// Per-email completeness for triggers E/F: required per-email fields that are
// visible (38.1 only when 38 is Yes). Loaded lazily so sections 1-2 work
// without any emails.
const EMAIL_REQUIRED = ['32', '33', '34', '35', '36', '37', '38', '39', '40', '41'];
async function emailStates(prisma, tactplanId) {
  const rows = await prisma.campaignEmail.findMany({ where: { tactplanId } });
  return rows.map((r) => {
    const vals = JSON.parse(r.valuesJson || '{}');
    const need = yes(vals['38']) ? [...EMAIL_REQUIRED, '38.1'] : EMAIL_REQUIRED;
    const complete = need.every((k) => (Array.isArray(vals[k]) ? vals[k].some(filled) : filled(vals[k])));
    return { id: r.id, complete, metadataId: r.metadataId };
  });
}

async function contactLine(prisma, tactplanId, slot) {
  if (!slot) return '';
  const [row, confirmed] = await Promise.all([
    prisma.campaignContact.findUnique({ where: { tactplanId_slot: { tactplanId, slot } } }),
    prisma.sectionConfirmation.findUnique({ where: { tactplanId_section: { tactplanId, section: 'contacts' } } }),
  ]);
  if (!row || !row.value) return ' (No contact for this campaign yet.)';
  if (!confirmed) return ` Contact (not yet confirmed by CDM): ${await userName(prisma, row.value)}.`;
  return ` Contact: ${await userName(prisma, row.value)}.`;
}

async function userName(prisma, id) {
  const user = await prisma.appUser.findUnique({ where: { id } }).catch(() => null);
  return user ? user.name : id;
}

// Fires every newly met handoff for a campaign. Safe to call after any write;
// a handoff that already fired hits the unique key and is skipped.
async function run(prisma, tactplanId) {
  const [v, meta, emails, contacts] = await Promise.all([
    fieldValues(prisma, tactplanId),
    prisma.campaignMeta.findUnique({ where: { tactplanId } }),
    emailStates(prisma, tactplanId),
    prisma.sectionConfirmation.findUnique({ where: { tactplanId_section: { tactplanId, section: 'contacts' } } }),
  ]);
  const ctx = { v, brandCode: meta && meta.brandCode, emails, contactsConfirmed: !!contacts };
  const fired = [];
  const already = new Set((await prisma.triggerFiring.findMany({ where: { tactplanId }, select: { triggerId: true } })).map((r) => r.triggerId));
  for (const h of HANDOFFS) {
    if (!h.met(ctx)) {
      // Fired earlier but no longer met: a field was cleared or changed. It
      // stays fired; the tracker just says so.
      if (already.has(h.id)) await flag(prisma, tactplanId, [h.id], 'fieldsChanged');
      continue;
    }
    if (already.has(h.id)) continue;
    try {
      await prisma.triggerFiring.create({ data: { tactplanId, triggerId: h.id } });
    } catch (err) {
      if (err.code === 'P2002') continue; // already fired
      throw err;
    }
    fired.push(h.id);
    if (!h.target) continue;
    await prisma.comment.create({
      data: {
        tactplanId,
        sectionId: 'project',
        authorPersona: 'system',
        body: h.message() + (await contactLine(prisma, tactplanId, h.slot)),
        mentionsJson: JSON.stringify([h.target]),
        source: 'agent',
      },
    });
  }
  return fired;
}

// waiting | notified | done, per handoff, for the Orchestration tracker.
async function status(prisma, tactplanId) {
  const rows = await prisma.triggerFiring.findMany({ where: { tactplanId } });
  const byId = new Map(rows.map((r) => [r.triggerId, r]));
  return HANDOFFS.map((h) => {
    const r = byId.get(h.id);
    return {
      id: h.id,
      title: h.title,
      target: h.target,
      status: !r ? 'waiting' : r.doneAt ? 'done' : h.target ? 'notified' : 'ready',
      firedAt: r ? r.firedAt : null,
      doneAt: r ? r.doneAt : null,
      doneBy: r ? r.doneBy : null,
      flags: r && r.flaggedJson ? JSON.parse(r.flaggedJson) : {},
    };
  });
}

// Marks fired handoffs as changed-since-notified when a field they depend on
// is edited afterwards. The handoff never re-fires.
async function flag(prisma, tactplanId, triggerIds, key) {
  for (const triggerId of triggerIds) {
    const r = await prisma.triggerFiring.findUnique({ where: { tactplanId_triggerId: { tactplanId, triggerId } } });
    if (!r) continue;
    const flags = { ...(r.flaggedJson ? JSON.parse(r.flaggedJson) : {}), [key]: true };
    await prisma.triggerFiring.update({ where: { id: r.id }, data: { flaggedJson: JSON.stringify(flags) } });
  }
}

module.exports = { CDM_FIRST_PASS, HANDOFFS, FIELDS_11_31, evaluate, run, status, flag, fieldValues, emailStates };
