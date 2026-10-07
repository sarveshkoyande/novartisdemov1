// Sections 3-4: Email Details (one row per email) and Journey Details (one
// row per touchpoint, inside a segment). Sections 3-4 plan, U1-U5.
//
// Per-email fields 32-41 are defined here rather than as FormField rows:
// FormField is one value per campaign, and these repeat per email. The
// campaign-level fields (42-44.3, 50-51) are ordinary FormFields.

const handoffs = require('./handoffs');

// Lazy: orchestration requires this module for segment helpers.
const orch = () => require('./orchestration');

const EMAIL_FIELDS = [
  { key: '32', label: 'FUSE ID / Content ID', type: 'text' },
  { key: '33', label: 'FUSE Expiration date', type: 'date' },
  { key: '34', label: 'FUSE Approved date', type: 'date' },
  { key: '35', label: 'Retirement Date', type: 'date' },
  { key: '36', label: 'Email Name', type: 'text' },
  { key: '37', label: 'Email Deploy Date', type: 'date' },
  { key: '38', label: 'Personalization', type: 'sel', opts: ['Yes', 'No'] },
  { key: '38.1', label: 'Personalization Area / Field Name & Criteria', type: 'ta', showIf: { key: '38', value: 'Yes' } },
  { key: '39', label: 'Subject Line', type: 'list' },
  { key: '40', label: 'Pre Header', type: 'list' },
  { key: '41', label: 'Theme', type: 'text' },
];
const EMAIL_KEYS = new Set(EMAIL_FIELDS.map((f) => f.key));

// AOR owns emails; DM (the CDM persona) and AOR own journeys.
const EMAIL_EDITORS = new Set(['aor']);
const JOURNEY_EDITORS = new Set(['aor', 'cdm']);

const SEGMENTS_KEY = '27';
const GOLIVE_KEY = '25';

const splitSegments = (raw) => String(raw || '').split(/\n|;|,/).map((s) => s.trim()).filter(Boolean);

async function touchJourney(prisma, tactplanId) {
  await prisma.campaignMeta.upsert({ where: { tactplanId }, update: { journeyUpdatedAt: new Date() }, create: { tactplanId, journeyUpdatedAt: new Date() } });
}

function emailView(e) {
  return { id: e.id, position: e.position, values: JSON.parse(e.valuesJson || '{}'), autoKeys: JSON.parse(e.autoJson || '[]'), metadataId: e.metadataId, updatedAt: e.updatedAt };
}

async function listEmails(prisma, tactplanId) {
  const rows = await prisma.campaignEmail.findMany({ where: { tactplanId }, orderBy: { position: 'asc' } });
  const states = await handoffs.emailStates(prisma, tactplanId);
  const tps = await prisma.journeyTouchpoint.findMany({ where: { tactplanId, NOT: { emailId: null } } });
  return rows.map((r) => ({
    ...emailView(r),
    complete: (states.find((s) => s.id === r.id) || {}).complete || false,
    usedBy: tps.filter((t) => t.emailId === r.id).map((t) => ({ segment: t.segment, name: t.name })),
  }));
}

async function renumber(prisma, model, where, ids) {
  for (let i = 0; i < ids.length; i++) await prisma[model].updateMany({ where: { ...where, id: ids[i] }, data: { position: i } });
}

// Segments from field 27, plus any segment that still has touchpoints but
// was removed from 27 (shown as "Removed segment" so nothing is lost).
async function segmentsFor(prisma, tactplanId) {
  const v = await handoffs.fieldValues(prisma, tactplanId);
  const named = splitSegments(v[SEGMENTS_KEY]);
  const used = (await prisma.journeyTouchpoint.findMany({ where: { tactplanId }, select: { segment: true }, distinct: ['segment'] })).map((r) => r.segment);
  return { named, removed: used.filter((s) => !named.includes(s)), golive: v[GOLIVE_KEY] || '', values: v };
}

// Rename detection (plan DR4): a field-27 save that drops exactly one name
// and adds exactly one moves that segment's touchpoints to the new name.
async function reconcileSegments(prisma, tactplanId, before, after) {
  const gone = before.filter((s) => !after.includes(s));
  const added = after.filter((s) => !before.includes(s));
  if (gone.length === 1 && added.length === 1) {
    const moved = await prisma.journeyTouchpoint.updateMany({ where: { tactplanId, segment: gone[0] }, data: { segment: added[0] } });
    if (moved.count) await touchJourney(prisma, tactplanId);
  }
}

// Structured journey inputs for the Flow Planner (plan DR1/DR2/DR9): one
// array of touchpoints per segment, so a missing value stays on its own card.
async function journeyInputs(prisma, tactplanId) {
  const { named, golive } = await segmentsFor(prisma, tactplanId);
  const [tps, emails, meta] = await Promise.all([
    prisma.journeyTouchpoint.findMany({ where: { tactplanId }, orderBy: [{ segment: 'asc' }, { position: 'asc' }] }),
    prisma.campaignEmail.findMany({ where: { tactplanId } }),
    prisma.campaignMeta.findUnique({ where: { tactplanId } }),
  ]);
  const byId = new Map(emails.map((e) => [e.id, { ...e, values: JSON.parse(e.valuesJson || '{}') }]));
  const bySegment = {};
  for (const segment of named) {
    const list = tps.filter((t) => t.segment === segment);
    if (!list.length) continue;
    bySegment[segment] = {
      touchpoints: list.map((t) => {
        const e = t.emailId ? byId.get(t.emailId) : null;
        return {
          name: t.name || (e && e.values['36']) || '',
          type: 'Email',
          fuseId: e ? e.values['32'] || '' : '',
          metadataId: e ? e.metadataId || '' : '',
          deployDate: e ? e.values['37'] || '' : '',
          waitDays: t.waitDays,
          resendNeeded: t.resendNeeded,
          resendRule: t.resendRule,
          resendDays: t.resendDays,
          abTest: t.abTest,
        };
      }),
    };
  }
  return { journey: { goliveDate: golive, bySegment }, journeyUpdatedAt: meta ? meta.journeyUpdatedAt : null };
}

function register(app, prisma) {
  const guard = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof orch().LockedError) return res.status(423).json({ error: err.message });
      console.error('[email-journey]', err);
      res.status(500).json({ error: String(err.message || err) });
    }
  };
  const afterWrite = async (tactplanId) => {
    try {
      await handoffs.run(prisma, tactplanId);
    } catch (err) {
      console.error('[email-journey] handoffs failed:', err);
    }
  };

  app.get('/api/email-fields', (req, res) => res.json({ fields: EMAIL_FIELDS }));

  // ---- emails ----
  app.get('/api/campaigns/:id/emails', guard(async (req, res) => {
    await orch().ensureDrafts(prisma, req.params.id);
    res.json({ emails: await listEmails(prisma, req.params.id) });
  }));

  // body: { persona, after?: emailId | null (null/absent = end, "start" = first) }
  app.post('/api/campaigns/:id/emails', guard(async (req, res) => {
    const tactplanId = req.params.id;
    const { persona, after } = req.body || {};
    if (!EMAIL_EDITORS.has(persona)) return res.status(403).json({ error: 'Only AOR can add emails.' });
    await orch().assertUnlocked(prisma, tactplanId, 'emails');
    const rows = await prisma.campaignEmail.findMany({ where: { tactplanId }, orderBy: { position: 'asc' } });
    const created = await prisma.campaignEmail.create({ data: { tactplanId, position: rows.length, updatedBy: persona } });
    const ids = rows.map((r) => r.id);
    const at = after === 'start' ? 0 : after ? ids.indexOf(after) + 1 : ids.length;
    ids.splice(at < 0 ? ids.length : at, 0, created.id);
    await renumber(prisma, 'campaignEmail', { tactplanId }, ids);
    res.json({ email: created.id, emails: await listEmails(prisma, tactplanId) });
  }));

  // body: { persona, values?: {key: value}, metadataId? } — merged, not replaced.
  app.patch('/api/campaigns/:id/emails/:emailId', guard(async (req, res) => {
    const tactplanId = req.params.id;
    const { persona, values, metadataId } = req.body || {};
    if (!EMAIL_EDITORS.has(persona)) return res.status(403).json({ error: 'Only AOR can edit emails.' });
    await orch().assertUnlocked(prisma, tactplanId, 'emails');
    const row = await prisma.campaignEmail.findFirst({ where: { id: req.params.emailId, tactplanId } });
    if (!row) return res.status(404).json({ error: 'Email not found.' });
    const merged = JSON.parse(row.valuesJson || '{}');
    for (const [k, v] of Object.entries(values || {})) if (EMAIL_KEYS.has(k)) merged[k] = v;
    // A touched value is no longer the auto draft.
    const auto = JSON.parse(row.autoJson || '[]').filter((k) => !(values && k in values));
    await prisma.campaignEmail.update({
      where: { id: row.id },
      data: { valuesJson: JSON.stringify(merged), autoJson: JSON.stringify(auto), updatedBy: persona, ...(metadataId !== undefined ? { metadataId: metadataId || null } : {}) },
    });
    // Fuse ID and Metadata ID show on journey cards.
    if ((values && '32' in values) || metadataId !== undefined || (values && ('36' in values || '37' in values))) await touchJourney(prisma, tactplanId);
    await afterWrite(tactplanId);
    res.json({ emails: await listEmails(prisma, tactplanId) });
  }));

  app.delete('/api/campaigns/:id/emails/:emailId', guard(async (req, res) => {
    const tactplanId = req.params.id;
    const persona = req.query.persona;
    if (!EMAIL_EDITORS.has(persona)) return res.status(403).json({ error: 'Only AOR can delete emails.' });
    // Deleting frees its touchpoint, so a confirmed journey blocks it too.
    await orch().assertUnlocked(prisma, tactplanId, 'emails', 'journeys');
    const freed = await prisma.journeyTouchpoint.updateMany({ where: { tactplanId, emailId: req.params.emailId }, data: { emailId: null } });
    await prisma.campaignEmail.deleteMany({ where: { id: req.params.emailId, tactplanId } });
    const rest = await prisma.campaignEmail.findMany({ where: { tactplanId }, orderBy: { position: 'asc' } });
    await renumber(prisma, 'campaignEmail', { tactplanId }, rest.map((r) => r.id));
    if (freed.count) await touchJourney(prisma, tactplanId);
    await afterWrite(tactplanId);
    res.json({ emails: await listEmails(prisma, tactplanId) });
  }));

  app.post('/api/campaigns/:id/emails/reorder', guard(async (req, res) => {
    const { persona, ids } = req.body || {};
    if (!EMAIL_EDITORS.has(persona)) return res.status(403).json({ error: 'Only AOR can reorder emails.' });
    await orch().assertUnlocked(prisma, req.params.id, 'emails');
    await renumber(prisma, 'campaignEmail', { tactplanId: req.params.id }, ids || []);
    res.json({ emails: await listEmails(prisma, req.params.id) });
  }));

  // ---- touchpoints ----
  app.get('/api/campaigns/:id/touchpoints', guard(async (req, res) => {
    const tactplanId = req.params.id;
    await orch().ensureDrafts(prisma, tactplanId);
    const { named, removed } = await segmentsFor(prisma, tactplanId);
    const tps = await prisma.journeyTouchpoint.findMany({ where: { tactplanId }, orderBy: { position: 'asc' } });
    res.json({ segments: named, removedSegments: removed, touchpoints: tps });
  }));

  // body: { persona, segment, after?: touchpointId | "start" }
  app.post('/api/campaigns/:id/touchpoints', guard(async (req, res) => {
    const tactplanId = req.params.id;
    const { persona, segment, after } = req.body || {};
    if (!JOURNEY_EDITORS.has(persona)) return res.status(403).json({ error: 'Only AOR or the Delivery Manager can edit journeys.' });
    await orch().assertUnlocked(prisma, req.params.id, 'journeys');
    if (!segment) return res.status(400).json({ error: 'segment is required.' });
    const rows = await prisma.journeyTouchpoint.findMany({ where: { tactplanId, segment }, orderBy: { position: 'asc' } });
    const created = await prisma.journeyTouchpoint.create({ data: { tactplanId, segment, position: rows.length } });
    const ids = rows.map((r) => r.id);
    const at = after === 'start' ? 0 : after ? ids.indexOf(after) + 1 : ids.length;
    ids.splice(at < 0 ? ids.length : at, 0, created.id);
    await renumber(prisma, 'journeyTouchpoint', { tactplanId, segment }, ids);
    await touchJourney(prisma, tactplanId);
    res.json({ touchpoint: created.id });
  }));

  const TP_FIELDS = ['name', 'emailId', 'abTest', 'waitDays', 'resendNeeded', 'resendRule', 'resendDays', 'segment'];
  app.patch('/api/campaigns/:id/touchpoints/:tpId', guard(async (req, res) => {
    const tactplanId = req.params.id;
    const { persona, ...patch } = req.body || {};
    if (!JOURNEY_EDITORS.has(persona)) return res.status(403).json({ error: 'Only AOR or the Delivery Manager can edit journeys.' });
    await orch().assertUnlocked(prisma, req.params.id, 'journeys');
    const data = { auto: false };
    for (const k of TP_FIELDS) if (k in patch) data[k] = patch[k] === '' ? null : patch[k];
    if ('waitDays' in data && data.waitDays !== null) data.waitDays = Math.max(0, parseInt(data.waitDays, 10) || 0);
    if ('resendDays' in data && data.resendDays !== null) data.resendDays = Math.max(0, parseInt(data.resendDays, 10) || 0);
    try {
      await prisma.journeyTouchpoint.update({ where: { id: req.params.tpId }, data });
    } catch (err) {
      if (err.code === 'P2002') return res.status(409).json({ error: 'That email is already used by another touchpoint. Pick another.' });
      throw err;
    }
    await touchJourney(prisma, tactplanId);
    res.json({ ok: true });
  }));

  app.delete('/api/campaigns/:id/touchpoints/:tpId', guard(async (req, res) => {
    if (!JOURNEY_EDITORS.has(req.query.persona)) return res.status(403).json({ error: 'Only AOR or the Delivery Manager can edit journeys.' });
    await orch().assertUnlocked(prisma, req.params.id, 'journeys');
    const row = await prisma.journeyTouchpoint.findUnique({ where: { id: req.params.tpId } });
    if (!row) return res.json({ ok: true });
    await prisma.journeyTouchpoint.delete({ where: { id: row.id } });
    const rest = await prisma.journeyTouchpoint.findMany({ where: { tactplanId: row.tactplanId, segment: row.segment }, orderBy: { position: 'asc' } });
    await renumber(prisma, 'journeyTouchpoint', { tactplanId: row.tactplanId, segment: row.segment }, rest.map((r) => r.id));
    await touchJourney(prisma, row.tactplanId);
    res.json({ ok: true });
  }));

  app.post('/api/campaigns/:id/touchpoints/reorder', guard(async (req, res) => {
    const { persona, segment, ids } = req.body || {};
    if (!JOURNEY_EDITORS.has(persona)) return res.status(403).json({ error: 'Only AOR or the Delivery Manager can edit journeys.' });
    await orch().assertUnlocked(prisma, req.params.id, 'journeys');
    await renumber(prisma, 'journeyTouchpoint', { tactplanId: req.params.id, segment }, ids || []);
    await touchJourney(prisma, req.params.id);
    res.json({ ok: true });
  }));

  app.get('/api/campaigns/:id/journey-inputs', guard(async (req, res) => {
    res.json(await journeyInputs(prisma, req.params.id));
  }));
}

module.exports = { register, EMAIL_FIELDS, journeyInputs, reconcileSegments, splitSegments, SEGMENTS_KEY };
