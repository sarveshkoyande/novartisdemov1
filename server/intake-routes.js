// Routes for the intake restructure: Orchestration contacts, the handoff
// tracker, and OMS's Brand code (sections 1-2 plan, U3-U5). Login is per
// persona and there is no server session, so the acting persona travels in
// the request, the same way comments carry authorPersona.

const handoffs = require('./handoffs');
const orchestration = require('./orchestration');

// Contact Details roles, in display order. kind decides the control:
// person = one AppUser id, people = JSON array of ids, organization = text.
const SLOTS = [
  { slot: 'contentOwner', label: 'Content Owners/Marketing Strategy', kind: 'person' },
  { slot: 'agency', label: 'Agency Name', kind: 'organization' },
  { slot: 'deliveryManager', label: 'Delivery Manager', kind: 'person' },
  { slot: 'deliveryCoordinator', label: 'Delivery Coordinator/Project Manager', kind: 'person' },
  { slot: 'solutionArchitect', label: 'Solution Architect', kind: 'person' },
  { slot: 'mds', label: 'MDS', kind: 'person' },
  { slot: 'cep', label: 'CEP', kind: 'person' },
  { slot: 'tagging', label: 'Tagging', kind: 'person' },
  { slot: 'proofRecipients', label: 'Proof Recipients', kind: 'people' },
];
const SLOT_IDS = new Set(SLOTS.map((s) => s.slot));

const BRAND_KEY = '14';
const CAMPAIGN_CODE_KEY = '19';

async function currentBrand(prisma, tactplanId) {
  const v = await handoffs.fieldValues(prisma, tactplanId);
  return String(v[BRAND_KEY] || '').trim() || null;
}

// Brings a campaign's contacts in line with its current Brand:
// - no rows yet: copy the brand's defaults once;
// - Brand changed: rows nobody edited are re-copied from the new brand,
//   edited rows keep their value and read as stale, and the tracker flags
//   the Brand code for OMS to review. While Contact Details is confirmed
//   (locked) nothing is re-copied; the view shows a reopen banner instead.
async function syncContacts(prisma, tactplanId) {
  const brand = await currentBrand(prisma, tactplanId);
  if (!brand) return { brand: null, changed: false };
  const [rows, defaults] = await Promise.all([
    prisma.campaignContact.findMany({ where: { tactplanId } }),
    prisma.brandContact.findMany({ where: { brand } }),
  ]);
  const def = new Map(defaults.map((d) => [d.slot, d.value]));
  const locked = await orchestration.isLocked(prisma, tactplanId, 'contacts');
  const bySlot = new Map(rows.map((r) => [r.slot, r]));
  let brandChanged = false;
  for (const { slot } of SLOTS) {
    const row = bySlot.get(slot);
    if (!row) {
      await prisma.campaignContact.create({ data: { tactplanId, slot, value: def.get(slot) || null, brand } });
    } else if (row.brand !== brand && !locked) {
      brandChanged = brandChanged || row.brand !== null;
      if (!row.edited) {
        await prisma.campaignContact.update({ where: { id: row.id }, data: { value: def.get(slot) || null, brand } });
      }
    } else if (!locked && !row.edited && !row.value && def.get(slot)) {
      // Brand defaults added after the campaign started fill roles still empty.
      await prisma.campaignContact.update({ where: { id: row.id }, data: { value: def.get(slot) } });
    }
  }
  if (brandChanged) await handoffs.flag(prisma, tactplanId, ['A'], 'brandChanged');
  return { brand, changed: brandChanged };
}

async function contactsView(prisma, tactplanId) {
  const { brand } = await syncContacts(prisma, tactplanId);
  const rows = await prisma.campaignContact.findMany({ where: { tactplanId } });
  const bySlot = new Map(rows.map((r) => [r.slot, r]));
  const hasDefaults = brand ? (await prisma.brandContact.count({ where: { brand } })) > 0 : false;
  const locked = await orchestration.isLocked(prisma, tactplanId, 'contacts');
  return {
    brand,
    hasDefaults,
    locked,
    // Brand changed after Contact Details was confirmed: defaults not re-copied.
    brandChangedWhileLocked: locked && rows.some((r) => r.brand && brand && r.brand !== brand),
    contacts: SLOTS.map((s) => {
      const r = bySlot.get(s.slot);
      const has = !!(r && r.value && r.value !== '[]');
      return {
        ...s,
        value: r ? r.value : null,
        auto: has && !r.edited,
        // Hand-set for a brand the campaign no longer has.
        stale: !!(r && r.edited && brand && r.brand !== brand),
      };
    }),
  };
}

// Writes one General Campaign Details answer the same way the form does
// (keyed by FormField id), so Intake shows it.
async function writeField(prisma, tactplanId, fieldKey, value) {
  const field = await prisma.formField.findFirst({ where: { sectionId: 'generic', fieldKey }, include: { section: true } });
  if (!field) return;
  await prisma.fieldEntry.upsert({
    where: { tactplanId_sectionId_fieldId: { tactplanId, sectionId: 'generic', fieldId: field.id } },
    update: { value: String(value), phase: field.phase },
    create: { tactplanId, sectionId: 'generic', sectionName: field.section.name, phase: field.phase, fieldId: field.id, fieldLabel: field.label, value: String(value) },
  });
}

function register(app, prisma) {
  const guard = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof orchestration.LockedError) return res.status(423).json({ error: err.message });
      console.error('[intake]', err);
      res.status(500).json({ error: String(err.message || err) });
    }
  };

  // ---- admin: brand default contacts ----
  app.get('/api/admin/brand-contacts', guard(async (req, res) => {
    const brand = String(req.query.brand || '');
    const rows = brand ? await prisma.brandContact.findMany({ where: { brand } }) : [];
    res.json({ slots: SLOTS, defaults: Object.fromEntries(rows.map((r) => [r.slot, r.value])) });
  }));

  app.post('/api/admin/brand-contacts', guard(async (req, res) => {
    const { brand, defaults } = req.body || {};
    if (!brand || !defaults || typeof defaults !== 'object') return res.status(400).json({ error: 'brand and defaults are required.' });
    for (const [slot, value] of Object.entries(defaults)) {
      if (!SLOT_IDS.has(slot)) continue;
      if (value === null || value === '' || (Array.isArray(value) && !value.length)) {
        await prisma.brandContact.deleteMany({ where: { brand, slot } });
      } else {
        const v = Array.isArray(value) ? JSON.stringify(value) : String(value);
        await prisma.brandContact.upsert({ where: { brand_slot: { brand, slot } }, update: { value: v }, create: { brand, slot, value: v } });
      }
    }
    res.json({ ok: true });
  }));

  // ---- campaign contacts ----
  app.get('/api/campaign-contacts', guard(async (req, res) => {
    const tactplanId = String(req.query.tactplanId || '');
    if (!tactplanId) return res.status(400).json({ error: 'tactplanId is required.' });
    res.json(await contactsView(prisma, tactplanId));
  }));

  app.put('/api/campaign-contacts', guard(async (req, res) => {
    const { tactplanId, slot, value, persona } = req.body || {};
    if (persona !== 'cdm') return res.status(403).json({ error: 'Only CDM can edit contacts.' });
    if (!tactplanId || !SLOT_IDS.has(slot)) return res.status(400).json({ error: 'tactplanId and a valid slot are required.' });
    const brand = await currentBrand(prisma, tactplanId);
    if (!brand) return res.status(409).json({ error: 'Set Brand (field 14) first.' });
    await orchestration.assertUnlocked(prisma, tactplanId, 'contacts');
    const v = Array.isArray(value) ? JSON.stringify(value) : value ? String(value) : null;
    await prisma.campaignContact.upsert({
      where: { tactplanId_slot: { tactplanId, slot } },
      update: { value: v, brand, edited: true },
      create: { tactplanId, slot, value: v, brand, edited: true },
    });
    res.json(await contactsView(prisma, tactplanId));
  }));

  // ---- handoffs ----
  app.get('/api/handoffs', guard(async (req, res) => {
    const tactplanId = String(req.query.tactplanId || '');
    if (!tactplanId) return res.status(400).json({ error: 'tactplanId is required.' });
    const meta = await prisma.campaignMeta.findUnique({ where: { tactplanId } });
    const v = await handoffs.fieldValues(prisma, tactplanId);
    res.json({
      handoffs: await handoffs.status(prisma, tactplanId),
      // Brand code itself is never sent — only whether it is set.
      brandCodeSet: !!(meta && meta.brandCode),
      campaignCode: v[CAMPAIGN_CODE_KEY] || '',
    });
  }));

  app.post('/api/handoffs/:id/done', guard(async (req, res) => {
    const { tactplanId, persona } = req.body || {};
    const h = handoffs.HANDOFFS.find((x) => x.id === req.params.id);
    if (!h || !h.target) return res.status(404).json({ error: 'Unknown handoff.' });
    if (persona !== h.target && persona !== 'cdm') return res.status(403).json({ error: 'Only the notified role or CDM can mark this done.' });
    const r = await prisma.triggerFiring.findUnique({ where: { tactplanId_triggerId: { tactplanId, triggerId: h.id } } });
    if (!r) return res.status(409).json({ error: 'This handoff has not fired yet.' });
    await prisma.triggerFiring.update({ where: { id: r.id }, data: { doneAt: new Date(), doneBy: persona } });
    res.json({ handoffs: await handoffs.status(prisma, tactplanId) });
  }));

  // OMS's shortcut from the tracker: Brand code (hidden) and, optionally,
  // Campaign code (written as a normal field 19 answer).
  app.post('/api/campaigns/:id/brand-code', guard(async (req, res) => {
    const tactplanId = req.params.id;
    const { brandCode, campaignCode, persona } = req.body || {};
    if (persona !== 'oms') return res.status(403).json({ error: 'Only OMS can set the Brand code.' });
    if (brandCode !== undefined) {
      const value = String(brandCode || '').trim() || null;
      await prisma.campaignMeta.upsert({ where: { tactplanId }, update: { brandCode: value }, create: { tactplanId, brandCode: value } });
      // A reviewed Brand code clears the brand-changed flag.
      const a = await prisma.triggerFiring.findUnique({ where: { tactplanId_triggerId: { tactplanId, triggerId: 'A' } } });
      if (a && a.flaggedJson) {
        const flags = JSON.parse(a.flaggedJson);
        delete flags.brandChanged;
        await prisma.triggerFiring.update({ where: { id: a.id }, data: { flaggedJson: JSON.stringify(flags) } });
      }
    }
    if (campaignCode !== undefined && String(campaignCode).trim()) await writeField(prisma, tactplanId, CAMPAIGN_CODE_KEY, String(campaignCode).trim());
    await handoffs.run(prisma, tactplanId);
    // Both of OMS's answers in: Handoff A is done.
    const meta = await prisma.campaignMeta.findUnique({ where: { tactplanId } });
    const v = await handoffs.fieldValues(prisma, tactplanId);
    const a = await prisma.triggerFiring.findUnique({ where: { tactplanId_triggerId: { tactplanId, triggerId: 'A' } } });
    if (a && !a.doneAt && meta && meta.brandCode && String(v[CAMPAIGN_CODE_KEY] || '').trim()) {
      await prisma.triggerFiring.update({ where: { id: a.id }, data: { doneAt: new Date(), doneBy: 'oms' } });
    }
    res.json({ handoffs: await handoffs.status(prisma, tactplanId), brandCodeSet: !!(meta && meta.brandCode) });
  }));
}

module.exports = { register, SLOTS, syncContacts };
