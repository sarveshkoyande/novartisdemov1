// Orchestration section sign-off and auto-drafts
// (plan 2026-09-29-1730, U1-U3).
//
// - Each section (contacts / emails / journeys) gets one confirm by its owner.
//   A confirmed section is locked: every write route calls assertUnlocked and
//   gets 423 until the owner (or CDM) reopens it.
// - Emails and journeys are drafted once from the intake, as soon as CDM's
//   intake fields are complete, so the page opens filled rather than empty.

const handoffs = require('./handoffs');

const SECTIONS = {
  contacts: { owner: 'cdm', label: 'Contact Details' },
  emails: { owner: 'aor', label: 'Emails' },
  journeys: { owner: 'aor', label: 'Journeys' },
};

// CDM's first-pass fields. 19 (Campaign code) is OMS's, 21-27
// are AOR's; 20.1/20.2 only count when 20 = Yes. CDM's 28-31 (segment rules,
// specialties, exit criteria) need AOR's segments
// (27) first, so they are a later CDM step and don't gate confirming.
const CDM_FIELDS = ['10', '11', '12', '13', '14', '15', '16', '17', '18', '20', '20.1', '20.2'];
const CDM_JOURNEY_FIELDS = ['28', '29', '30', '31'];
const VISIBLE_IF = { '20.1': (v) => yes(v['20']), '20.2': (v) => yes(v['20']) };

const filled = (x) => x !== undefined && x !== null && String(x).trim() !== '' && String(x).trim() !== '[]';
const yes = (x) => String(x || '').trim().toLowerCase() === 'yes';

const DEFAULT_WAIT_DAYS = 3;
const EMAIL_SPACING_DAYS = 7;

class LockedError extends Error {
  constructor(section) {
    super(`${SECTIONS[section].label} is confirmed – reopen it to edit.`);
    this.status = 423;
  }
}

async function isLocked(prisma, tactplanId, section) {
  return !!(await prisma.sectionConfirmation.findUnique({ where: { tactplanId_section: { tactplanId, section } } }));
}

async function assertUnlocked(prisma, tactplanId, ...sections) {
  for (const s of sections) if (await isLocked(prisma, tactplanId, s)) throw new LockedError(s);
}

function intakeMissing(v, label) {
  return CDM_FIELDS.filter((k) => (VISIBLE_IF[k] ? VISIBLE_IF[k](v) : true) && !filled(v[k])).map((k) => (label && label[k]) || `Field ${k}`);
}

// What still blocks confirming a section; [] = ready.
async function missing(prisma, tactplanId, section) {
  const v = await handoffs.fieldValues(prisma, tactplanId);
  const rows = await prisma.formField.findMany({ where: { sectionId: 'generic' }, select: { fieldKey: true, label: true } });
  const label = Object.fromEntries(rows.map((r) => [r.fieldKey, r.label.replace(/\s*\*\s*$/, '')]));
  const out = intakeMissing(v, label);
  if (section === 'contacts') {
    const { SLOTS } = require('./intake-routes');
    const rows = await prisma.campaignContact.findMany({ where: { tactplanId } });
    const by = new Map(rows.map((r) => [r.slot, r.value]));
    for (const s of SLOTS) if (!filled(by.get(s.slot))) out.push(`${s.label} empty`);
  } else if (section === 'emails') {
    const states = await handoffs.emailStates(prisma, tactplanId);
    if (!states.length) out.push('No emails');
    const n = states.filter((s) => !s.complete).length;
    if (n) out.push(`${n} email${n === 1 ? '' : 's'} incomplete`);
  } else if (section === 'journeys') {
    const { splitSegments, SEGMENTS_KEY } = require('./email-journey-routes');
    const named = splitSegments(v[SEGMENTS_KEY]);
    const tps = await prisma.journeyTouchpoint.findMany({ where: { tactplanId } });
    if (!tps.length) out.push('No touchpoints');
    const noEmail = tps.filter((t) => !t.emailId).length;
    if (noEmail) out.push(`${noEmail} touchpoint${noEmail === 1 ? '' : 's'} without email`);
    if (tps.some((t) => !named.includes(t.segment))) out.push('Touchpoints in a removed segment');
  }
  return out;
}

async function confirmations(prisma, tactplanId) {
  const rows = await prisma.sectionConfirmation.findMany({ where: { tactplanId } });
  const by = new Map(rows.map((r) => [r.section, r]));
  const out = {};
  for (const [section, def] of Object.entries(SECTIONS)) {
    const r = by.get(section);
    out[section] = {
      owner: def.owner,
      confirmedAt: r ? r.confirmedAt : null,
      confirmedBy: r ? r.confirmedBy : null,
      missing: r ? [] : await missing(prisma, tactplanId, section),
    };
  }
  return out;
}

function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '';
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Drafts emails (field 24 of them) and one journey per segment (field 27)
// from the intake only. Runs once per campaign, after CDM's intake is done.
async function ensureDrafts(prisma, tactplanId) {
  const meta = await prisma.campaignMeta.findUnique({ where: { tactplanId } });
  if (meta && meta.draftedAt) return false;
  const v = await handoffs.fieldValues(prisma, tactplanId);
  if (intakeMissing(v).length) return false;
  const n = Math.min(50, parseInt(v['24'], 10) || 0);
  const { splitSegments, SEGMENTS_KEY } = require('./email-journey-routes');
  const segments = splitSegments(v[SEGMENTS_KEY]);
  // Need the email count and the segments (both AOR fields) to draft anything.
  if (!n || !segments.length) return false;
  if (await prisma.campaignEmail.count({ where: { tactplanId } })) {
    await markDrafted(prisma, tactplanId);
    return false;
  }

  const name = String(v['21'] || '').trim() || 'Email';
  const golive = String(v['25'] || '').slice(0, 10);
  const emails = [];
  for (let i = 0; i < n; i++) {
    const values = { '36': `${name} – Email ${i + 1}` };
    const date = golive ? addDays(golive, i * EMAIL_SPACING_DAYS) : '';
    if (date) values['37'] = date;
    emails.push(await prisma.campaignEmail.create({
      data: { tactplanId, position: i, valuesJson: JSON.stringify(values), autoJson: JSON.stringify(Object.keys(values)), updatedBy: 'system' },
    }));
  }
  // An email can sit on one touchpoint only, so the emails are split into
  // contiguous runs, one run per segment.
  const S = segments.length;
  for (let k = 0; k < S; k++) {
    const run = emails.slice(Math.floor((k * n) / S), Math.floor(((k + 1) * n) / S));
    const list = run.length ? run : [null];
    for (let i = 0; i < list.length; i++) {
      await prisma.journeyTouchpoint.create({
        data: {
          tactplanId,
          segment: segments[k],
          position: i,
          name: list[i] ? JSON.parse(list[i].valuesJson)['36'] : '',
          emailId: list[i] ? list[i].id : null,
          waitDays: i < list.length - 1 ? DEFAULT_WAIT_DAYS : null,
          auto: true,
        },
      });
    }
  }
  await markDrafted(prisma, tactplanId);
  await prisma.campaignMeta.update({ where: { tactplanId }, data: { journeyUpdatedAt: new Date() } });
  return true;
}

async function markDrafted(prisma, tactplanId) {
  await prisma.campaignMeta.upsert({ where: { tactplanId }, update: { draftedAt: new Date() }, create: { tactplanId, draftedAt: new Date() } });
}

async function logComment(prisma, tactplanId, body, mentions) {
  await prisma.comment.create({
    data: { tactplanId, sectionId: 'project', authorPersona: 'system', body, mentionsJson: JSON.stringify(mentions || []), source: 'agent' },
  });
}

async function confirm(prisma, tactplanId, section, persona) {
  const def = SECTIONS[section];
  if (!def) return { status: 400, error: 'Unknown section.' };
  if (persona !== def.owner) return { status: 403, error: `Only ${def.owner.toUpperCase()} can confirm ${def.label}.` };
  const miss = await missing(prisma, tactplanId, section);
  if (miss.length) return { status: 409, error: `Not ready to confirm: ${miss.join(', ')}.`, missing: miss };
  await prisma.sectionConfirmation.upsert({
    where: { tactplanId_section: { tactplanId, section } },
    update: { confirmedAt: new Date(), confirmedBy: persona },
    create: { tactplanId, section, confirmedBy: persona },
  });
  await logComment(prisma, tactplanId, `${def.label} confirmed by ${persona.toUpperCase()}.`);
  // Confirming Contact Details is what releases the OMS handoff.
  await handoffs.run(prisma, tactplanId);
  return { ok: true };
}

async function reopen(prisma, tactplanId, section, persona) {
  const def = SECTIONS[section];
  if (!def) return { status: 400, error: 'Unknown section.' };
  if (persona !== def.owner && persona !== 'cdm') return { status: 403, error: `Only ${def.owner.toUpperCase()} or CDM can reopen ${def.label}.` };
  const r = await prisma.sectionConfirmation.deleteMany({ where: { tactplanId, section } });
  if (r.count) await logComment(prisma, tactplanId, `${def.label} reopened for editing by ${persona.toUpperCase()}.`, [def.owner]);
  return { ok: true };
}

function register(app, prisma) {
  const guard = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      console.error('[orchestration]', err);
      res.status(500).json({ error: String(err.message || err) });
    }
  };
  const reply = async (res, tactplanId, r) => {
    if (r.error) return res.status(r.status).json({ error: r.error, missing: r.missing });
    res.json({ confirmations: await confirmations(prisma, tactplanId) });
  };

  app.get('/api/orchestration/:tp/confirmations', guard(async (req, res) => {
    await ensureDrafts(prisma, req.params.tp);
    res.json({ confirmations: await confirmations(prisma, req.params.tp) });
  }));
  app.post('/api/orchestration/:tp/confirm', guard(async (req, res) => {
    const { section, persona } = req.body || {};
    await reply(res, req.params.tp, await confirm(prisma, req.params.tp, section, persona));
  }));
  app.post('/api/orchestration/:tp/reopen', guard(async (req, res) => {
    const { section, persona } = req.body || {};
    await reply(res, req.params.tp, await reopen(prisma, req.params.tp, section, persona));
  }));
}

module.exports = { SECTIONS, CDM_FIELDS, CDM_JOURNEY_FIELDS, register, confirm, reopen, confirmations, missing, ensureDrafts, isLocked, assertUnlocked, LockedError, intakeMissing };
