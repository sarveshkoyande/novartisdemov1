require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { AnthropicFoundry } = require('@anthropic-ai/foundry-sdk');
const { PrismaClient } = require('./generated/prisma');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
const multer = require('multer');
const { PDFParse } = require('pdf-parse');
const mammoth = require('mammoth');
const XLSX = require('xlsx');
const JSZip = require('jszip');

const app = express();

// ---------------------------------------------------------------------------
// Diagnostics. The browser can only ever report "fetch threw" for anything
// that fails below the HTTP layer — wrong origin, connection refused, reset
// mid-flight — so the single most useful question is whether the request
// arrives here AT ALL. Every request is logged on arrival and again on
// completion; if the browser reports an error and nothing appears here, the
// request never reached this process and the problem is on the client side
// (usually the page being served from somewhere other than this server).
// ---------------------------------------------------------------------------
const started = new Date().toISOString();
console.log(`[server] pid=${process.pid} node=${process.version} boot=${started}`);

let reqSeq = 0;
app.use((req, res, next) => {
  const id = ++reqSeq;
  const t0 = Date.now();
  const origin = req.get('origin') || req.get('referer') || '-';
  const len = req.get('content-length') || '0';
  console.log(`[req ${id}] --> ${req.method} ${req.originalUrl} origin=${origin} bytes=${len} ip=${req.ip}`);
  res.on('finish', () => {
    console.log(`[req ${id}] <-- ${res.statusCode} ${req.method} ${req.originalUrl} ${Date.now() - t0}ms`);
  });
  // Fires when the client hangs up before the response completed — this is
  // what a browser-side "Failed to fetch" looks like from in here.
  res.on('close', () => {
    if (!res.writableEnded) {
      console.warn(`[req ${id}] !!! client disconnected before response completed after ${Date.now() - t0}ms`);
    }
  });
  next();
});

app.use(cors());
app.use(express.json({ limit: '500kb' }));

// A body larger than the limit, or malformed JSON, surfaces here rather than
// as a silent hang — both would otherwise look like "backend unreachable".
app.use((err, req, res, next) => {
  if (err && (err.type === 'entity.too.large' || err instanceof SyntaxError)) {
    console.error(`[server] rejected body: ${err.type || 'invalid JSON'} (${err.message})`);
    return res.status(413).json({ error: `Request body rejected: ${err.type || 'invalid JSON'}` });
  }
  return next(err);
});

process.on('uncaughtException', err => {
  console.error('[server] FATAL uncaughtException:', err && err.stack || err);
});
process.on('unhandledRejection', err => {
  console.error('[server] unhandledRejection:', err && err.stack || err);
});
['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'].forEach(sig => {
  process.on(sig, () => { console.warn(`[server] received ${sig} — exiting`); process.exit(0); });
});
process.on('exit', code => console.warn(`[server] process exiting with code ${code}`));

// In-memory upload handling for the chat's file-parse feature — files are
// parsed to text and discarded, never written to disk. 15 MB cap.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

const { extractFileText, register: registerStateless } = require('./stateless');

// POST /api/upload (multipart, field name "file") -> { filename, text }.
// The client then feeds `text` into the normal agent-fill flow, so an
// uploaded brief behaves exactly like a long typed message.
app.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  try {
    const text = (await extractFileText(req.file.buffer, req.file.originalname)).trim();
    if (!text) return res.status(422).json({ error: 'Could not extract any text from that file (it may be scanned/image-only).' });
    // Guard against a giant document blowing the model's context — keep the
    // first ~24k chars, which is plenty for a campaign brief.
    res.json({ filename: req.file.originalname, text: text.slice(0, 24000) });
  } catch (err) {
    console.error('[server] File parse failed:', err);
    res.status(400).json({ error: String(err.message || err) });
  }
});

// Claude on Microsoft Foundry. The SDK builds
// https://{resource}.services.ai.azure.com/anthropic/ from `resource` and
// sends the key as the x-api-key header; `resource` and `baseURL` are
// mutually exclusive, so only one of them is passed.
const apiKey = process.env.ANTHROPIC_FOUNDRY_API_KEY;
const foundryResource = process.env.ANTHROPIC_FOUNDRY_RESOURCE;
if (!apiKey || !foundryResource) {
  console.warn('[server] ANTHROPIC_FOUNDRY_API_KEY / ANTHROPIC_FOUNDRY_RESOURCE not set — the agent routes will return 503 until server/.env has both.');
}
const ai = apiKey && foundryResource ? new AnthropicFoundry({ apiKey, resource: foundryResource }) : null;
const MODEL = process.env.CLAUDE_DEPLOYMENT || 'claude-opus-4-8';
// Anthropic requires an explicit output cap. 16k keeps a long multi-field
// propose_fill well within limits while staying under the SDK's HTTP timeout
// for non-streaming requests (the SSE stream below is our own, not the model's).
const MAX_OUTPUT_TOKENS = 16000;
// Large multi-field messages (e.g. "fill the whole CMA sheet", 45 fields
// across 10 groups) are deliberately chunked to at most 10 fields per
// propose_fill call, one call per turn (see BASE_SYSTEM_PROMPT) — cramming
// everything into a single call was unreliable (dropped/partial
// assignments). 15 rounds is headroom for match_section + a chunk's worth
// of tool calls plus any read/nav calls in the same turn, not for looping
// through every chunk at once.
const MAX_TOOL_ROUNDS = 15;

// Real backend for the New Campaign Request modal's Brand/Indication search —
// SQLite via Prisma (prisma/schema.prisma: BrandIndication), seeded with fake
// brand-master data by prisma/seed.js. Stands in for a real TactPlan/MDS feed.
const prisma = new PrismaClient({
  adapter: new PrismaBetterSqlite3({ url: process.env.DATABASE_URL || 'file:./dev.db' }),
});

// Orchestration contacts, handoff tracker, Brand code, emails and journeys.
const handoffs = require('./handoffs');
const intakeRoutes = require('./intake-routes');
intakeRoutes.register(app, prisma);
const emailJourneyRoutes = require('./email-journey-routes');
emailJourneyRoutes.register(app, prisma);
const orchestration = require('./orchestration');
orchestration.register(app, prisma);
const workflow = require('./workflow');

// Who owes what next on one campaign, from the current persona's view.
app.get('/api/campaigns/:id/next-steps', async (req, res) => {
  try {
    res.json(await workflow.forPersona(prisma, req.params.id, String(req.query.persona || '')));
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// GET /api/brands?q=kis -> distinct brand names matching the query, for the
// Brand field's search-as-you-type dropdown.
app.get('/api/brands', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  const rows = await prisma.brandIndication.findMany({
    where: q ? { brand: { contains: q } } : undefined,
    distinct: ['brand'],
    select: { brand: true },
    orderBy: { brand: 'asc' },
    take: 25,
  });
  res.json({ brands: rows.map(r => r.brand) });
});

// GET /api/indications?brand=Kisqali -> that brand's known indications, for
// the Indication field's dropdown once a brand has been picked/typed.
app.get('/api/indications', async (req, res) => {
  const brand = (req.query.brand || '').toString().trim();
  if (!brand) return res.json({ indications: [] });
  const rows = await prisma.brandIndication.findMany({
    where: { brand: { equals: brand } },
    select: { indication: true },
    orderBy: { indication: 'asc' },
  });
  res.json({ indications: rows.map(r => r.indication) });
});

// GET /api/brand-lookup?brand=Kisqali&indication=... -> drives the modal's
// Asset Scope inference: brand+indication both on record => Update Existing
// Campaign; brand on record but this indication isn't => New Indication
// Launch; brand not on record at all => New Brand Launch stays available.
app.get('/api/brand-lookup', async (req, res) => {
  const brand = (req.query.brand || '').toString().trim();
  const indication = (req.query.indication || '').toString().trim();
  if (!brand) return res.json({ brandKnown: false, indicationKnown: false });

  const brandMatches = await prisma.brandIndication.findMany({ where: { brand: { equals: brand } } });
  const brandKnown = brandMatches.length > 0;
  const indicationKnown = brandKnown && !!indication &&
    brandMatches.some(m => m.indication.toLowerCase() === indication.toLowerCase());
  res.json({ brandKnown, indicationKnown });
});

// ===========================================================================
// Admin: Brand & Indication list management — full CRUD on the same
// BrandIndication rows the New Campaign modal's autofill already reads (see
// /api/brands, /api/indications, /api/brand-lookup above). This is the
// "brand list, and within each a list of indications" admin pane.
// ===========================================================================
app.get('/api/admin/brand-indications', async (req, res) => {
  const rows = await prisma.brandIndication.findMany({ orderBy: [{ brand: 'asc' }, { indication: 'asc' }] });
  res.json({ rows });
});

app.post('/api/admin/brand-indications', async (req, res) => {
  const { brand, indication, brandedUnbranded, therapeuticArea } = req.body || {};
  if (!brand || !indication || !brandedUnbranded) return res.status(400).json({ error: 'brand, indication and brandedUnbranded are all required.' });
  try {
    const row = await prisma.brandIndication.create({ data: { brand, indication, brandedUnbranded, therapeuticArea: therapeuticArea || "" } });
    res.json({ row });
  } catch (err) {
    res.status(400).json({ error: err.code === 'P2002' ? 'That brand/indication pair already exists.' : err.message });
  }
});

app.put('/api/admin/brand-indications/:id', async (req, res) => {
  const { brand, indication, brandedUnbranded, therapeuticArea } = req.body || {};
  try {
    const row = await prisma.brandIndication.update({
      where: { id: Number(req.params.id) },
      data: {
        ...(brand !== undefined ? { brand } : {}),
        ...(indication !== undefined ? { indication } : {}),
        ...(brandedUnbranded !== undefined ? { brandedUnbranded } : {}),
        ...(therapeuticArea !== undefined ? { therapeuticArea } : {}),
      },
    });
    res.json({ row });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/admin/brand-indications/:id', async (req, res) => {
  try {
    await prisma.brandIndication.delete({ where: { id: Number(req.params.id) } });
    res.json({ ok: true });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// ===========================================================================
// Admin: user directory — every real stakeholder type (not just XM/CDM),
// each with their organization and, where relevant, the one brand they're
// mapped to. Separate from the demo login personas (client/personas.ts):
// this is real-people bookkeeping, not a login list. The earlier separate
// Agency + agency-to-brand-access models were removed — organization plus
// this same user's own brand mapping already said who has access to what;
// a second access-list was accounting for that fact twice.
// ===========================================================================
app.get('/api/admin/users', async (req, res) => {
  const users = await prisma.appUser.findMany({ orderBy: [{ roleType: 'asc' }, { name: 'asc' }] });
  res.json({ users });
});

app.post('/api/admin/users', async (req, res) => {
  const { name, email, roleType, organization, brand } = req.body || {};
  if (!name || !roleType) return res.status(400).json({ error: 'name and roleType are required.' });
  try {
    const user = await prisma.appUser.create({ data: { name, email: email || null, roleType, organization: organization || null, brand: brand || null } });
    res.json({ user });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/admin/users/:id', async (req, res) => {
  const { name, email, roleType, organization, brand } = req.body || {};
  try {
    const user = await prisma.appUser.update({
      where: { id: req.params.id },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(email !== undefined ? { email: email || null } : {}),
        ...(roleType !== undefined ? { roleType } : {}),
        ...(organization !== undefined ? { organization: organization || null } : {}),
        ...(brand !== undefined ? { brand: brand || null } : {}),
      },
    });
    res.json({ user });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/admin/users/:id', async (req, res) => {
  try {
    await prisma.appUser.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// ===========================================================================
// Persisted form entries — every field value actually saved, tagged by its
// stage (phase column: preplan/plan/exec) so the chat agent can ground
// answers about already-entered data in a real query (get_entries tool
// below) instead of only ever proposing new fills or relying on whatever
// happens to still be in the conversation's history.
// ===========================================================================

// POST /api/entries — bulk upsert. Called after a section Save or a
// confirmed chat-fill proposal with every currently-filled field in that
// section (client: hqe-requirement-studio-mock_2.html's syncSectionEntries()).
app.post('/api/entries', async (req, res) => {
  const { tactplanId, entries } = req.body || {};
  if (!tactplanId || !Array.isArray(entries)) {
    return res.status(400).json({ error: 'tactplanId and entries[] are required.' });
  }
  // Segment names before the save, to spot a rename of field 27.
  const segmentsBefore = emailJourneyRoutes.splitSegments((await handoffs.fieldValues(prisma, tactplanId))[emailJourneyRoutes.SEGMENTS_KEY]);
  for (const e of entries) {
    if (!e.sectionId || !e.fieldId || !e.phase) continue;
    await prisma.fieldEntry.upsert({
      where: { tactplanId_sectionId_fieldId: { tactplanId, sectionId: e.sectionId, fieldId: e.fieldId } },
      update: { value: String(e.value ?? ''), phase: e.phase, sectionName: e.sectionName || e.sectionId, fieldLabel: e.fieldLabel || e.fieldId },
      create: {
        tactplanId, sectionId: e.sectionId, sectionName: e.sectionName || e.sectionId,
        phase: e.phase, fieldId: e.fieldId, fieldLabel: e.fieldLabel || e.fieldId, value: String(e.value ?? ''),
      },
    });
  }
  // Form and chat both save through here, so this is where handoffs fire
  // (once each) and where a Brand change re-syncs the campaign's contacts.
  // A failure here must not lose the save itself.
  let fired = [];
  try {
    await intakeRoutes.syncContacts(prisma, tactplanId);
    const segmentsAfter = emailJourneyRoutes.splitSegments((await handoffs.fieldValues(prisma, tactplanId))[emailJourneyRoutes.SEGMENTS_KEY]);
    await emailJourneyRoutes.reconcileSegments(prisma, tactplanId, segmentsBefore, segmentsAfter);
    fired = await handoffs.run(prisma, tactplanId);
  } catch (err) {
    console.error('[server] handoff evaluation failed:', err);
  }
  res.json({ ok: true, count: entries.length, fired });
});

// GET /api/entries?tactplanId=&phase=&sectionId= — for debugging/inspection;
// also what the get_entries agent tool queries under the hood.
app.get('/api/entries', async (req, res) => {
  const { tactplanId, phase, sectionId } = req.query;
  if (!tactplanId) return res.status(400).json({ error: 'tactplanId is required.' });
  const rows = await prisma.fieldEntry.findMany({
    where: {
      tactplanId: tactplanId.toString(),
      ...(phase ? { phase: phase.toString() } : {}),
      ...(sectionId ? { sectionId: sectionId.toString() } : {}),
    },
    orderBy: [{ sectionId: 'asc' }, { fieldId: 'asc' }],
  });
  res.json({ entries: rows });
});

// GET /api/section-state?tactplanId= -> which sections are submitted (locked).
// Values already persist via /api/entries above; without this the lock state
// lived only in the browser's memory, so a reload silently reopened every
// section the user had submitted.
app.get('/api/section-state', async (req, res) => {
  const { tactplanId } = req.query;
  if (!tactplanId) return res.status(400).json({ error: 'tactplanId is required.' });
  try {
    const rows = await prisma.sectionState.findMany({
      where: { tactplanId: tactplanId.toString(), submitted: true },
      select: { sectionId: true },
    });
    res.json({ submitted: rows.map(r => r.sectionId) });
  } catch (err) {
    console.error('[server] section-state read failed:', err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

// POST /api/section-state — upsert one section's submitted flag.
app.post('/api/section-state', async (req, res) => {
  const { tactplanId, sectionId, submitted } = req.body || {};
  if (!tactplanId || !sectionId) {
    return res.status(400).json({ error: 'tactplanId and sectionId are required.' });
  }
  const flag = Boolean(submitted);
  try {
    await prisma.sectionState.upsert({
      where: { tactplanId_sectionId: { tactplanId, sectionId } },
      update: { submitted: flag },
      create: { tactplanId, sectionId, submitted: flag },
    });
    res.json({ ok: true, sectionId, submitted: flag });
  } catch (err) {
    console.error('[server] section-state write failed:', err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

// ===========================================================================
// Schema-driven form structure (FormSection/FormField) — replaces the
// hardcoded BASE_SECTIONS array that used to be the only source of truth,
// baked into the frontend. GET /api/schema is what the client fetches to
// render the form; the /api/admin/* routes are real CRUD, so adding/
// removing/editing a field is now an API call instead of a code change.
// Per-tactic/touchpoint fan-out (Email #1, Touch Point #2, ...) is NOT
// stored here — it's inherently dynamic per campaign and stays computed
// client-side from these base sections, same as computeSections() did.
// ===========================================================================

function parseFieldJson(f) {
  return {
    ...f,
    opts: f.optionsJson ? JSON.parse(f.optionsJson) : undefined,
    cond: f.condJson ? JSON.parse(f.condJson) : undefined,
    groups: f.groupsJson ? JSON.parse(f.groupsJson) : undefined,
    optionsJson: undefined,
    condJson: undefined,
    groupsJson: undefined,
  };
}

// Excel export of the live FormField table (schema, not entered values —
// see /api/entries for that) for the admin UI's "Export" button.
app.get('/api/admin/export', async (req, res) => {
  const fields = await prisma.formField.findMany({
    include: { section: true },
    orderBy: [{ section: { order: 'asc' } }, { order: 'asc' }],
  });
  const header = ['sectionId', 'sectionName', 'fieldKey', 'phase', 'label', 'type', 'owner', 'bucket', 'source', 'options', 'cond', 'drives', 'cascadeFromField', 'derivesFrom', 'locked', 'lockedValue', 'wide'];
  const rows = fields.map((f) => [
    f.sectionId, f.section.name, f.fieldKey, f.phase, f.label, f.type, f.owner,
    f.bucket || '', f.source || '', f.optionsJson || '', f.condJson || '',
    f.drives || '', f.cascadeFromField || '', f.derivesFrom || '', f.locked, f.lockedValue || '', f.wide,
  ]);
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
  ws['!cols'] = [{ wch: 12 }, { wch: 26 }, { wch: 14 }, { wch: 9 }, { wch: 40 }, { wch: 10 }, { wch: 8 }, { wch: 10 }, { wch: 24 }, { wch: 24 }, { wch: 20 }, { wch: 12 }, { wch: 16 }, { wch: 7 }, { wch: 14 }, { wch: 6 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'FormField');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="FormField_export.xlsx"');
  res.send(buf);
});

// Forms — the layer above sections, so future flows (FormB, FormC, ...)
// don't have to be shoehorned into one hardcoded structure. Each FormSection
// belongs to exactly one Form; the New Campaign Request modal's "Which
// form?" picker reads this list directly.
app.get('/api/forms', async (req, res) => {
  const forms = await prisma.form.findMany({ orderBy: { order: 'asc' } });
  res.json({ forms });
});

app.post('/api/admin/forms', async (req, res) => {
  const { name, description, active, order } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required.' });
  try {
    const form = await prisma.form.create({
      data: {
        name, description: description || null, active: active === undefined ? true : !!active,
        order: order ?? (await prisma.form.count()),
      },
    });
    res.json({ form });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/admin/forms/:id', async (req, res) => {
  const { name, description, active, order } = req.body || {};
  try {
    const form = await prisma.form.update({
      where: { id: req.params.id },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description: description || null } : {}),
        ...(active !== undefined ? { active: !!active } : {}),
        ...(order !== undefined ? { order } : {}),
      },
    });
    res.json({ form });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.delete('/api/admin/forms/:id', async (req, res) => {
  try {
    // Sections cascade (schema.prisma Form.sections onDelete: Cascade), taking
    // their fields with them (FormSection.fields already cascades too) — a
    // deliberate all-or-nothing delete, no orphaned sections left dangling.
    await prisma.form.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.get('/api/schema', async (req, res) => {
  const formId = req.query.formId || 'form-default';
  const sections = await prisma.formSection.findMany({
    where: { formId },
    include: { fields: { orderBy: { order: 'asc' } } },
    orderBy: { order: 'asc' },
  });
  res.json({
    sections: sections.map((s) => ({
      ...s,
      needs: JSON.parse(s.needsJson),
      needsJson: undefined,
      fields: s.fields.map(parseFieldJson),
    })),
  });
});

app.post('/api/admin/sections', async (req, res) => {
  const { id, formId, num, name, icon, parentId, audienceGate, note, needs, order } = req.body || {};
  if (!id || !name) return res.status(400).json({ error: 'id and name are required.' });
  try {
    const section = await prisma.formSection.create({
      data: {
        id, formId: formId || 'form-default', num: num || '', name, icon: icon || '▣', parentId: parentId || null,
        audienceGate: !!audienceGate, note: note || null,
        needsJson: JSON.stringify(needs || { preplan: [], plan: [], exec: [] }),
        order: order ?? (await prisma.formSection.count({ where: { formId: formId || 'form-default' } })),
      },
    });
    res.json({ section });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/admin/sections/:id', async (req, res) => {
  const { formId, num, name, icon, parentId, audienceGate, note, needs, order } = req.body || {};
  try {
    const section = await prisma.formSection.update({
      where: { id: req.params.id },
      data: {
        ...(formId !== undefined ? { formId } : {}),
        ...(num !== undefined ? { num } : {}),
        ...(name !== undefined ? { name } : {}),
        ...(icon !== undefined ? { icon } : {}),
        ...(parentId !== undefined ? { parentId: parentId || null } : {}),
        ...(audienceGate !== undefined ? { audienceGate: !!audienceGate } : {}),
        ...(note !== undefined ? { note } : {}),
        ...(needs !== undefined ? { needsJson: JSON.stringify(needs) } : {}),
        ...(order !== undefined ? { order } : {}),
      },
    });
    res.json({ section });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.delete('/api/admin/sections/:id', async (req, res) => {
  try {
    await prisma.formField.deleteMany({ where: { sectionId: req.params.id } });
    await prisma.formSection.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.post('/api/admin/sections/:id/fields', async (req, res) => {
  const { fieldKey, phase, label, type, owner, bucket, source, opts, cond, drives, cascadeFromField, derivesFrom, locked, lockedValue, wide, order } = req.body || {};
  if (!fieldKey || !phase || !label || !type || !owner) {
    return res.status(400).json({ error: 'fieldKey, phase, label, type, and owner are required.' });
  }
  try {
    const field = await prisma.formField.create({
      data: {
        sectionId: req.params.id, fieldKey, phase, label, type, owner,
        bucket: bucket || null, source: source || null,
        optionsJson: opts ? JSON.stringify(opts) : null,
        condJson: cond ? JSON.stringify(cond) : null,
        drives: drives || null, cascadeFromField: cascadeFromField || null,
        derivesFrom: derivesFrom || null,
        locked: !!locked, lockedValue: lockedValue || null, wide: !!wide,
        order: order ?? (await prisma.formField.count({ where: { sectionId: req.params.id } })),
      },
    });
    res.json({ field: parseFieldJson(field) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/admin/fields/:id', async (req, res) => {
  const { fieldKey, phase, label, type, owner, bucket, source, opts, cond, drives, cascadeFromField, derivesFrom, locked, lockedValue, wide, order } = req.body || {};
  try {
    const field = await prisma.formField.update({
      where: { id: req.params.id },
      data: {
        ...(fieldKey !== undefined ? { fieldKey } : {}),
        ...(phase !== undefined ? { phase } : {}),
        ...(label !== undefined ? { label } : {}),
        ...(type !== undefined ? { type } : {}),
        ...(owner !== undefined ? { owner } : {}),
        ...(bucket !== undefined ? { bucket } : {}),
        ...(source !== undefined ? { source } : {}),
        ...(opts !== undefined ? { optionsJson: opts ? JSON.stringify(opts) : null } : {}),
        ...(cond !== undefined ? { condJson: cond ? JSON.stringify(cond) : null } : {}),
        ...(drives !== undefined ? { drives } : {}),
        ...(cascadeFromField !== undefined ? { cascadeFromField } : {}),
        ...(derivesFrom !== undefined ? { derivesFrom: derivesFrom || null } : {}),
        ...(locked !== undefined ? { locked: !!locked } : {}),
        ...(lockedValue !== undefined ? { lockedValue } : {}),
        ...(wide !== undefined ? { wide: !!wide } : {}),
        ...(order !== undefined ? { order } : {}),
      },
    });
    res.json({ field: parseFieldJson(field) });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.delete('/api/admin/fields/:id', async (req, res) => {
  try {
    await prisma.formField.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// Nudge rules — what used to be hardcoded branches in the client's
// runReactCheckpoint() (which section submitting nudges whom, what "phase
// complete" means) as real, admin-editable rows. See NudgeRule in
// schema.prisma and evaluateNudgeRules() in the client for how these fire.
app.get('/api/nudge-rules', async (req, res) => {
  const rules = await prisma.nudgeRule.findMany({ where: { active: true }, orderBy: { order: 'asc' } });
  res.json({ rules });
});

app.get('/api/admin/nudge-rules', async (req, res) => {
  const rules = await prisma.nudgeRule.findMany({ orderBy: { order: 'asc' } });
  res.json({ rules });
});

app.post('/api/admin/nudge-rules', async (req, res) => {
  const { trigger, triggerSectionId, triggerPhase, triggerFieldDrives, triggerValue, triggerSectionIds, triggerFieldKey, conditionsJson, message, nudgeMessage, nudgeToOwner, active, order } = req.body || {};
  if (!trigger || !message) return res.status(400).json({ error: 'trigger and message are required.' });
  try {
    const rule = await prisma.nudgeRule.create({
      data: {
        trigger, triggerSectionId: triggerSectionId || null, triggerPhase: triggerPhase || null,
        triggerFieldDrives: triggerFieldDrives || null, triggerValue: triggerValue || null,
        triggerSectionIds: triggerSectionIds || null, triggerFieldKey: triggerFieldKey || null,
        conditionsJson: conditionsJson || null,
        message, nudgeMessage: nudgeMessage || null, nudgeToOwner: nudgeToOwner || null,
        active: active !== undefined ? !!active : true,
        order: order ?? (await prisma.nudgeRule.count()),
      },
    });
    res.json({ rule });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/admin/nudge-rules/:id', async (req, res) => {
  const { trigger, triggerSectionId, triggerPhase, triggerFieldDrives, triggerValue, triggerSectionIds, triggerFieldKey, conditionsJson, message, nudgeMessage, nudgeToOwner, active, order } = req.body || {};
  try {
    const rule = await prisma.nudgeRule.update({
      where: { id: req.params.id },
      data: {
        ...(trigger !== undefined ? { trigger } : {}),
        ...(triggerSectionId !== undefined ? { triggerSectionId: triggerSectionId || null } : {}),
        ...(triggerPhase !== undefined ? { triggerPhase: triggerPhase || null } : {}),
        ...(triggerFieldDrives !== undefined ? { triggerFieldDrives: triggerFieldDrives || null } : {}),
        ...(triggerValue !== undefined ? { triggerValue: triggerValue || null } : {}),
        ...(triggerSectionIds !== undefined ? { triggerSectionIds: triggerSectionIds || null } : {}),
        ...(triggerFieldKey !== undefined ? { triggerFieldKey: triggerFieldKey || null } : {}),
        ...(conditionsJson !== undefined ? { conditionsJson: conditionsJson || null } : {}),
        ...(message !== undefined ? { message } : {}),
        ...(nudgeMessage !== undefined ? { nudgeMessage: nudgeMessage || null } : {}),
        ...(nudgeToOwner !== undefined ? { nudgeToOwner: nudgeToOwner || null } : {}),
        ...(active !== undefined ? { active: !!active } : {}),
        ...(order !== undefined ? { order } : {}),
      },
    });
    res.json({ rule });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// CRF #N tactic field templates — Email/SMS/MDS Suppression/Automatrix/
// Touch Point per-tactic content, now real admin-editable rows instead of
// hardcoded in the client's emailTacticSection()/mdsTacticSection()/etc.
// generator functions. Grouped by tacticType since one row template fans
// out into N real sections per campaign (email-t1, email-t2, ...).
app.get('/api/tactic-templates', async (req, res) => {
  const rows = await prisma.tacticFieldTemplate.findMany({ orderBy: [{ tacticType: 'asc' }, { order: 'asc' }] });
  res.json({ templates: rows.map(parseFieldJson) });
});

app.get('/api/admin/tactic-templates', async (req, res) => {
  const rows = await prisma.tacticFieldTemplate.findMany({ orderBy: [{ tacticType: 'asc' }, { order: 'asc' }] });
  res.json({ templates: rows.map(parseFieldJson) });
});

app.post('/api/admin/tactic-templates', async (req, res) => {
  const { tacticType, fieldKey, phase, label, type, owner, bucket, source, opts, cond, drives, cascadeFromField, locked, lockedValue, wide, order } = req.body || {};
  if (!tacticType || !fieldKey || !phase || !label || !type || !owner) {
    return res.status(400).json({ error: 'tacticType, fieldKey, phase, label, type, and owner are required.' });
  }
  try {
    const row = await prisma.tacticFieldTemplate.create({
      data: {
        tacticType, fieldKey, phase, label, type, owner,
        bucket: bucket || null, source: source || null,
        optionsJson: opts ? JSON.stringify(opts) : null,
        condJson: cond ? JSON.stringify(cond) : null,
        drives: drives || null, cascadeFromField: cascadeFromField || null,
        locked: !!locked, lockedValue: lockedValue || null, wide: !!wide,
        order: order ?? (await prisma.tacticFieldTemplate.count({ where: { tacticType } })),
      },
    });
    res.json({ template: parseFieldJson(row) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/admin/tactic-templates/:id', async (req, res) => {
  const { fieldKey, phase, label, type, owner, bucket, source, opts, cond, drives, cascadeFromField, locked, lockedValue, wide, order } = req.body || {};
  try {
    const row = await prisma.tacticFieldTemplate.update({
      where: { id: req.params.id },
      data: {
        ...(fieldKey !== undefined ? { fieldKey } : {}),
        ...(phase !== undefined ? { phase } : {}),
        ...(label !== undefined ? { label } : {}),
        ...(type !== undefined ? { type } : {}),
        ...(owner !== undefined ? { owner } : {}),
        ...(bucket !== undefined ? { bucket: bucket || null } : {}),
        ...(source !== undefined ? { source: source || null } : {}),
        ...(opts !== undefined ? { optionsJson: opts ? JSON.stringify(opts) : null } : {}),
        ...(cond !== undefined ? { condJson: cond ? JSON.stringify(cond) : null } : {}),
        ...(drives !== undefined ? { drives: drives || null } : {}),
        ...(cascadeFromField !== undefined ? { cascadeFromField: cascadeFromField || null } : {}),
        ...(locked !== undefined ? { locked: !!locked } : {}),
        ...(lockedValue !== undefined ? { lockedValue: lockedValue || null } : {}),
        ...(wide !== undefined ? { wide: !!wide } : {}),
        ...(order !== undefined ? { order } : {}),
      },
    });
    res.json({ template: parseFieldJson(row) });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.delete('/api/admin/tactic-templates/:id', async (req, res) => {
  try {
    await prisma.tacticFieldTemplate.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// Campaign Ops' planning timeline (the "Plan" tab) — one row per request,
// an ETA date per milestone. Keyed by tactplanId, same id REQUESTS/FieldEntry
// already use, so it ties to the same request without a separate id scheme.
app.get('/api/plan-milestones', async (req, res) => {
  const rows = await prisma.planMilestone.findMany();
  res.json({ milestones: rows });
});

app.put('/api/plan-milestones/:tactplanId', async (req, res) => {
  const { discoveryEta, cpfEta, crfEta } = req.body || {};
  try {
    const row = await prisma.planMilestone.upsert({
      where: { tactplanId: req.params.tactplanId },
      update: {
        ...(discoveryEta !== undefined ? { discoveryEta: discoveryEta || null } : {}),
        ...(cpfEta !== undefined ? { cpfEta: cpfEta || null } : {}),
        ...(crfEta !== undefined ? { crfEta: crfEta || null } : {}),
      },
      create: {
        tactplanId: req.params.tactplanId,
        discoveryEta: discoveryEta || null,
        cpfEta: cpfEta || null,
        crfEta: crfEta || null,
      },
    });
    res.json({ milestone: row });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Campaigns created at runtime (New Request modal or chat's
// propose_new_campaign) — see schema.prisma's Campaign model doc comment
// for why this exists: the client's static REQUESTS seed array is demo
// data only, and previously that same array was the ONLY place a newly
// created campaign lived, so a server restart or full reload silently
// erased it from the portfolio (and broke any /requests/:id deep link into
// it) even though its FieldEntry/Comment rows were already durable.
function campaignRowToJson(row) {
  return {
    id: row.id, name: row.name, brand: row.brand, ic: row.ic, color: row.color,
    phase: row.phase, phaseLabel: row.phaseLabel, updated: row.updated, daysOpen: row.daysOpen,
    status: row.status, indication: row.indication, channels: row.channels, golive: row.golive,
    ready: row.ready, fieldsResolved: row.fieldsResolved, daysToGolive: row.daysToGolive,
    owners: JSON.parse(row.ownersJson), action: JSON.parse(row.actionJson),
    actionText: JSON.parse(row.actionTextJson), mineTo: JSON.parse(row.mineToJson),
  };
}

app.get('/api/campaigns', async (req, res) => {
  const rows = await prisma.campaign.findMany({ orderBy: { createdAt: 'desc' } });
  res.json({ campaigns: rows.map(campaignRowToJson) });
});

app.post('/api/campaigns', async (req, res) => {
  const c = req.body || {};
  if (!c.id || !c.name || !c.brand) {
    return res.status(400).json({ error: 'id, name, and brand are required.' });
  }
  try {
    const row = await prisma.campaign.upsert({
      where: { id: c.id },
      update: {},
      create: {
        id: c.id, name: c.name, brand: c.brand, ic: c.ic || '', color: c.color || '#5B6B7A',
        phase: c.phase || 'preplan', phaseLabel: c.phaseLabel || 'Pre-planning', updated: c.updated || 'just now',
        daysOpen: c.daysOpen ?? 0, status: c.status || 'active', indication: c.indication || '',
        channels: c.channels || '', golive: c.golive || '—', ready: c.ready || '0%',
        fieldsResolved: c.fieldsResolved || '0 / 151', daysToGolive: c.daysToGolive || '—',
        ownersJson: JSON.stringify(c.owners || []), actionJson: JSON.stringify(c.action || {}),
        actionTextJson: JSON.stringify(c.actionText || {}), mineToJson: JSON.stringify(c.mineTo || []),
      },
    });
    res.json({ campaign: campaignRowToJson(row) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Per-section conversation threads (see schema.prisma's Comment model doc
// comment). Client groups the flat list by sectionId itself — one request
// fetch per campaign, not one per section, since a request typically has a
// dozen+ sections and firing that many round-trips would be wasteful.
// source:"human" only — Conversations is people talking to each other;
// notify_stakeholders/nudge posts (source:"agent") are real notifications
// (see /api/notifications below) but don't belong in this thread, same way
// an email client doesn't put its own "you have a new notification" toasts
// inside your actual inbox threads.
app.get('/api/comments/:tactplanId', async (req, res) => {
  const rows = await prisma.comment.findMany({
    where: { tactplanId: req.params.tactplanId, source: 'human' },
    orderBy: { createdAt: 'asc' },
  });
  res.json({ comments: rows.map(c => ({ ...c, mentions: c.mentionsJson ? JSON.parse(c.mentionsJson) : [] })) });
});

// Notification bell — real data, not a separate table: any comment that
// @mentions a given persona/role (manual @mentions, notify_stakeholders,
// or a fired nudge — see evaluateNudgeRules() in the client) already IS a
// notification for that role, across every campaign, so this just filters
// the existing comment stream down to the ones a given role was mentioned
// in, newest first. Deliberately NOT filtered by source — a human @mention
// is just as much a real notification as an agent one; only the
// Conversations drawer (above) restricts itself to source:"human".
app.get('/api/notifications', async (req, res) => {
  const role = req.query.role;
  if (!role) return res.json({ notifications: [] });
  const rows = await prisma.comment.findMany({ orderBy: { createdAt: 'desc' }, take: 200 });
  const notifications = rows
    .map(c => ({ ...c, mentions: c.mentionsJson ? JSON.parse(c.mentionsJson) : [] }))
    .filter(c => c.mentions.includes(role));
  res.json({ notifications });
});

app.post('/api/comments', async (req, res) => {
  const { tactplanId, sectionId, authorPersona, body, mentions, source } = req.body || {};
  if (!tactplanId || !sectionId || !authorPersona || !body) {
    return res.status(400).json({ error: 'tactplanId, sectionId, authorPersona, and body are required.' });
  }
  try {
    const row = await prisma.comment.create({
      data: {
        tactplanId, sectionId, authorPersona, body,
        mentionsJson: mentions && mentions.length ? JSON.stringify(mentions) : null,
        source: source === 'agent' ? 'agent' : 'human',
      },
    });
    res.json({ comment: { ...row, mentions: mentions || [] } });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/admin/nudge-rules/:id', async (req, res) => {
  try {
    await prisma.nudgeRule.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// ===========================================================================
// Real agentic loop — modeled directly on govex's lib/agent.ts (see
// github.com/sarveshkoyande/govex). The model itself decides which tool to
// call and when, narrates a short plain-language sentence before each call,
// and never mutates the form directly: the only "write" tool (propose_fill)
// stages a proposal that the client renders with Confirm/Cancel, exactly
// like govex's propose_create_action/propose_draft_question. This replaces
// the earlier hardcoded 4-step client pipeline — the sequence of tool calls
// below is the model's choice, not a scripted order.
// ===========================================================================

const BASE_SYSTEM_PROMPT = `You are the Novartis Accelerate assistant — a form-filling agent embedded in a pharma campaign requirement-gathering platform, not a general-purpose chatbot. If asked what you are or who made you, answer in that identity (the platform's assistant) — never describe yourself as "a large language model" or name the vendor behind you; that's an implementation detail, not who you are here. Most messages are free text — sometimes hurried, informal, with typos, in any language — describing a form section and values for fields in it. Some messages are just questions about data already entered into the form, with nothing new to fill. Some messages are corrections or preferences about how YOU should behave going forward, not about the form at all. Some messages are just plain chat (greetings, questions about the platform) with no fields to fill. Some messages ask to move to a different stage of the process. Some messages ask to register a brand-new campaign that doesn't exist yet. You have these tools:

- match_section(query): locates which section of the form the user means and returns its real field names. ALWAYS pass the user's ENTIRE original message as query — never extract just a fragment or sub-topic of it (e.g. don't pass just "tact franchise" from a message that says "let's fill the whole cma sheet, for the tact franchise..." — pass the whole message). Matching is substring-based against section names/aliases, so the full message gives it the best chance; a cherry-picked fragment can accidentally match nothing or match the wrong thing.
- propose_fill(sectionId, assignments): stages field:value pairs for the user to confirm. This does NOT write anything to the form yet — it only proposes. For a normal-sized message, batch every assignment you can extract into ONE propose_fill call for that section — do not call it once per group/topic. BUT: if the message specifies more than 10 fields for one section (e.g. "fill the whole CMA sheet" with all ten groups), do NOT try to fit them all in one call and do NOT call propose_fill more than once in the same turn for that section. Instead: stage only the FIRST 10 fields (in the order the fields appear on the form) as a single propose_fill call, then end your turn — do not call propose_fill again this turn. Tell the user exactly which fields/groups you staged and that the rest are queued; once they confirm this batch and say "continue" (or similar), stage the next 10 from the same original message, and so on. This exists because attempting to cram 30-45+ fields into one call is unreliable — it produces partial/dropped assignments — and because staging everything at once with no pacing overwhelms the confirm-review step. 10 fields, one confirmed batch at a time. EXCEPTION — OMS enrollment sources (the numbered Source Type/Source Name/Suvery Q&A pairs trios, up to 6 sources = 18 fields): these are exempt from the 10-field cap. Stage every source you found from the metadata sheet in ONE single propose_fill call, however many that is (up to 18 fields for 6 sources) — never split them into a first batch plus a "continue for the rest" follow-up. They are one coherent unit (the whole sheet's worth of sources), not an arbitrary long list, and splitting them reads as broken pacing rather than careful review.
- get_orchestration_state(): read-only contacts and handoff statuses for this campaign. Handoffs to OMS, CEP and the Solution Architect are sent automatically by the system when their fields are complete, so never notify those roles yourself for them. Orchestration sections are auto-filled and signed off once per section: Contact Details by CDM, Emails and Journeys by AOR (set_section_confirmation). A confirmed section is locked until its owner or CDM reopens it; CDM can only confirm once its first-pass fields (10-18, 20) are complete; CDM fields 28-31 come after AOR names the segments (27). All General Campaign Details fields (10-31) are on the General tab (formerly called Intake). Never ask for or mention a Brand code value; OMS enters it in Orchestration.
- get_entries(sectionId?, phase?): looks up field values already saved to the form (real persisted data, not memory/history) — optionally filtered to one section and/or one stage (preplan/plan/exec). Use this whenever the user asks what's already been entered, confirmed, or set for something — never answer from conversation history or a guess when this tool can ground the answer in what's actually saved.
- learn_skill(title, rule): permanently records a correction or preference about how you should behave, so it applies automatically on every future turn from now on — not just this session. Use this when the user is correcting your behavior, stating a standing preference, or clarifying a rule for how to handle something going forward ("always do X", "don't do Y", "when someone says Z, you should..."), as opposed to a one-off form-fill or a question. This is a judgment call you make from the message's intent — there is no fixed keyword list for it. "rule" should be the general, reusable instruction (not campaign-specific data); "title" is a short label for it.
- navigate_stage(stage, section?, field?): moves the user to a tab (general = the General tab holding General Campaign Details 10-31 / journey = the Email and Journey tab / flow / orchestration). The tabs are exactly General, Email and Journey, Flow and Orchestration, optionally opening a section (form section id such as generic, emaildetails, journeydetails; or contacts / handoffs on Orchestration) and highlighting a field number (e.g. "28"). When you tell the user their next step, offer to take them there and call this if they agree or ask "take me there". Use this whenever the user asks to go to, move to, advance to, switch to, or proceed to a stage by name — this is a real UI navigation, not a form-fill, so don't call match_section or propose_fill for it.
- get_missing_fields(sectionId?): returns the fields still needing input for the current user and phase — real data computed by the client (ownership, conditional visibility, cascades all included), optionally filtered to one section. Read-only.
- record_quiz_answer(sectionId, field, value): records ONE field's answer immediately (no staging, no confirm step) during a guided quiz — see the Progress & Guided-Fill skill below. Only use this for an answer the user just gave to a question you asked about that exact field; for freeform text describing multiple values, use propose_fill instead.
- open_campaign(tactplanId): navigates to a different campaign already in the portfolio. Only for an id/name that's actually in the portfolio list — see the New Campaign Intake skill below for a campaign that doesn't exist yet.
- record_new_campaign_field(field, value): records ONE field of a brand-new campaign's intake immediately — see the New Campaign Intake skill immediately below; this is your only reliable memory of intake progress, use it every time.
- propose_new_campaign(tactplanId, channels, assetScope, newBrand, brand, indication, therapeuticArea, brandedUnbranded, audience, campaignName): stages a brand-new campaign request for the user to confirm and create — see the New Campaign Intake skill immediately below for how to get there.
- notify_stakeholders(opsMessage, otherTeamsMessage): posts a REAL, persisted notification the mentioned roles will see in their own notification bell (not just chat text) — call it ONLY when the user explicitly asks you to notify a team; never automatically, and never after creating a campaign (handoffs to OMS, CEP and the Solution Architect are sent by the system). NOT the Conversations drawer — that's the human-to-human thread, and these posts are deliberately excluded from it.
- ask_choice(question, options): asks one question as real clickable buttons instead of prose — see the Guided Mode skill below. Do NOT also ask the same question in your own preceding text before calling it — any narration you write ahead of a tool call is shown to the user as its own message, so writing "Which agency is running this campaign?" in prose and THEN calling ask_choice with that same question produces two consecutive bubbles asking the identical thing, which reads as the question repeating itself. This isn't just literal question repeats: a DECLARATIVE sentence that gives away the same fact the upcoming question asks about reads exactly the same way to the user — e.g. writing "The sheet gives a Survey Code of 51251 — that maps to the Survey field." and THEN calling ask_choice with "The sheet lists Survey Code 51251 — shall I use that for the Survey field?" is the identical bug in different clothing: same value, same field, said twice in a row. If you have something to say before this question (e.g. acknowledging the previous answer, or "let me record that, then wrap up intake"), keep it to that — anything specific to what the question itself is about (the value, the field, the fact being confirmed) belongs ONLY in the tool call's question argument, never spoken first in any form.

GUIDED MODE skill — some users want to type paragraphs; others are tired, in a hurry, or would rather just click through short choices one at a time. There is a real, explicit "Guided mode" toggle in the UI — when it is on you will see "GUIDED MODE IS CURRENTLY ON" appended below; while that is present, skip straight to the one-at-a-time, ask_choice-first behavior described below for every turn, no need to ask which mode they want first. EXCEPTION: propose_derived_fills (see "Derived values" further down) — that's staging already-known values as ONE card for ONE confirm click, not asking several open questions, so it stays a single batch call even here; do not unwind it into individual "should I use X?" confirmations one at a time.
- ask_choice IS RESERVED FOR GUIDED MODE — only reach for it while "GUIDED MODE IS CURRENTLY ON" is present below. When it is NOT present, the user is unguided: ask everything as plain prose, full stop — no clickable options, no buttons, ever, no matter how short or obvious the answer set is. This covers EVERY short-answer-set question anywhere in the product, not just form fields — e.g. "brief or attachment vs. answer questions" (New Campaign Intake step 1), "start a new campaign vs. open an existing one," Branded/Unbranded, yes/no, channel choice, all of it. Having only 2-3 sensible answers is not by itself a reason to use ask_choice — that reasoning is exactly the mistake to avoid. The ONLY ask_choice call permitted while unguided is the specific "one field at a time or type them all" pacing offer described further down — every other question, however short its answer set, is plain prose while unguided. Unguided means unguided — if you catch yourself about to call ask_choice without that note present, that is the bug; ask in a normal sentence instead and let them type their answer.
- THE NEXT MESSAGE ALWAYS ANSWERS THE QUESTION YOU JUST ASKED — full stop, whether it's a click on one of your ask_choice options OR plain typed text (a TactPlan ID, a campaign name, anything). You already know which field the question was about — you just wrote it one message ago. Record that value, for that exact field, with one record_new_campaign_field call — then move straight to the next field the NEW CAMPAIGN INTAKE STATE block lists as still missing. Trust that block completely: it is rebuilt fresh every turn from the real conversation, so a field it lists as already recorded IS correctly recorded — proceed on that basis without re-examining, re-verifying, or narrating anything about it. Silence about a just-recorded field is correct; the only visible action is asking the next question.
- While Guided Mode IS on: reach for ask_choice by default any time a question's real-world answer is a small fixed or realistically-enumerable set: Branded/Unbranded, HCP/DTC-style audience type, asset scope, a stage name, yes/no, channel choice (offer "Email"/"SMS"/"Both", expanding "Both" to both channels yourself when you stage the result). This also covers domain lists that aren't literally fixed but are realistically short and knowable from context — e.g. if the audience is HCP and the brand/indication is oncology, the relevant physician specialties are a genuinely short, known list (Medical Oncology, Hematology-Oncology, Radiation Oncology, Surgical Oncology, and so on) — offer THOSE specific values as clickable options rather than asking an open "what specialty?" question. When you're honestly unsure whether a short real list exists, it's fine to still call ask_choice with your best few plausible examples plus something like "Something else" as the last option, so the user can either click or type past it. Only ask genuinely open text (a name, a free description, a value with no realistic short list) as plain prose — there's nothing to make clickable there.
  - Campaign Goal specifically is one of these open-text fields, by explicit rule, not a judgment call: it's a long-form textarea field in the schema (type "ta"), meant for a real descriptive sentence or two about what this campaign is trying to achieve — never offer it as ask_choice, and never reduce it to a pick from a short list of canned goals ("Drive new patient enrollment," "Improve adherence," etc.), even under Guided Mode. Ask for it in plain prose and let the answer be as long and specific as the user wants to make it.
- The ask_choice buttons themselves ARE the call to action — the question text plus the options is the complete turn. Do not append a further sentence telling them to click one ("Pick one above and we'll take it from there," "Go ahead and choose," etc.) — that's saying the same thing twice. End the turn right after the options.
- Whenever you're about to ask for MORE THAN ONE missing thing at once (a "here's what's still needed" list of several fields, in new campaign intake or anywhere else) AND Guided Mode is not already on, first call ask_choice with something like "Want to go one at a time so you can just click through, or type them all in one go?" and options ["Guide me one at a time", "I'll type them all"] — this is the one and only ask_choice call allowed while unguided, since it's the offer to turn Guided Mode-style pacing on, not a form-field question. Do NOT also dump the full missing-field list as plain text in that same turn; let the user choose the pace first. If they pick "I'll type them all" (or just start typing answers unprompted), fall back to listing what's needed as a normal bulleted question (per FORMATTING) — no further ask_choice calls. If they pick "Guide me one at a time" (or ask to be walked through/guided/one by one), proceed exactly as if Guided Mode were on: one field per turn, ask_choice wherever the answer set is knowable, until nothing required is left.
- This applies wherever you'd otherwise ask several things in one breath, not only new campaign intake — the same pattern applies to the requirements interview's own multi-question moments too.

NEW CAMPAIGN INTAKE skill — triggered when the user wants to register, create, start, or spin up a brand-new campaign (not fill an existing one). Required fields, and ONLY these 10, ASKED IN EXACTLY THIS ORDER (they are General Campaign Details fields 10-18 plus Campaign Name 21, which CDM captures at the start) — note the two that sound alike are asking completely different things, never conflate them:
  1. TactPlan ID — the identifier the user types themselves, e.g. "TP-88500". Plain typed text, never ask_choice, never invent one — this always comes first, before anything else, and is genuinely required (not optional). Being the ONE typed-only field in this list doesn't change how ANY other field is asked — go straight back to ask_choice for field 2 the moment this one's answered, same as if TactPlan ID weren't typed at all. Under Guided Mode especially, don't let "the last field was plain text" carry over into treating the next one as plain text too — decide each field's format independently, per the Guided Mode skill above.
  2. channels (field 11) — Email / SMS / both
  3. asset scope (field 12, Request Type) — New Brand Launch / New Indication Launch / Update Existing Campaign
  4. new brand? (field 13) — Yes / No
  5. brand (field 14, product name) — the drug/product itself, e.g. "Cosentyx" — offer real brands from the portfolio (or plausible ones) as ask_choice options, per the Guided Mode skill.
  6. indication (field 15) — the condition it treats, e.g. "Plaque Psoriasis (PsO)"
  7. therapeutic area (field 16) — e.g. "Dermatology", "Cardiology"
  8. branded/unbranded (field 17) — NOT the product name; whether the campaign shows the product name and logo ("Branded") or is disease-awareness only ("Unbranded")
  9. audience (field 18) — only "HCP" or "DTC"; offer exactly those two as ask_choice options, never specialty-suffixed variants.
  10. campaign name (field 21) — a free-text working title for this campaign.
Do not ask for an agency: the agency is a Contact Details role, prefilled from the brand's defaults in Orchestration.
IMPORTANT — this flow does NOT need any campaign to be open, and is completely separate from THE REQUIREMENTS INTERVIEW below. Do NOT call get_interview_state, get_missing_fields, or open_campaign as a prerequisite to asking these 10 fields — they are gathered straight from conversation via propose_new_campaign, not from an existing campaign's schema. Once the user has clearly chosen "start a new campaign" (by typing it or clicking that choice), that decision is SETTLED for the rest of this intake — do not re-ask "which campaign?" or "start new or open existing?" again in this flow; proceed straight to step 1 below and keep asking only for the 10 required fields, in the order listed above, until propose_new_campaign is called.
Do not track progress from memory of the conversation — call record_new_campaign_field the moment the user gives a value for any of the 10 (typed or clicked), then check the NEW CAMPAIGN INTAKE STATE block (rebuilt fresh every turn, appended near the end of this prompt) for exactly which fields are already recorded and which are still missing before deciding what to ask next. That block is ground truth; your own recollection of earlier turns is not — if they ever disagree, the block wins. Never ask about a field the block lists as already recorded, and never skip ahead of the first field the block lists as still missing.
1. Ask, in one short line, whether they'd like to share a brief or attachment to work from, or would rather just answer a few quick questions instead. Either is fine — let them pick. Answering this question comes before even the TactPlan ID — it is not a gate that requires a campaign to be open. Ask this in plain prose UNLESS Guided Mode is on — it is a normal two-option question like any other in this flow, not the special pacing offer described in the Guided Mode skill below (that one is specifically "one field at a time vs. type them all," a different question, and the only ask_choice call allowed while unguided).
2. If they answer with real details right away (in this message or the next), call record_new_campaign_field for every value you can identify, then reflect back exactly what you understood — as a table (see FORMATTING below), one row per field. Then, for whatever the NEW CAMPAIGN INTAKE STATE block still lists as missing, follow the Guided Mode skill above instead of dumping them all as one paragraph. Getting the reflected values wrong and having the user silently work around it is worse than asking one more question.
3. Once the NEW CAMPAIGN INTAKE STATE block shows all 10 recorded, call propose_new_campaign with those exact values. Never invent a value for a required field — ask for it, and never invent the TactPlan ID in particular.
4. After propose_new_campaign, tell them in one sentence that it's staged for their review, not created yet, and that clicking Create Campaign on the card both creates it AND takes them straight there — no separate confirmation step, nothing to tell you about. Do not call match_section or propose_fill anywhere in this flow — there is no section to match against; the campaign doesn't exist until this is confirmed.
5. Clicking that button is a client-side action, and it does not send you a message directly — but the UI automatically fires a follow-up turn the instant the campaign is created and its page has loaded, whose message is the literal sentinel [[system:campaign_created]] (never show that literal text to the user, same convention as [[system:review_progress]] below). This sentinel is no longer sent automatically. Do NOT ask "have you confirmed it yet?" or interrogate them about whether they clicked it. You will never need to guess or poll for this — if you ever end a turn with nothing left to do but "wait and see if it got created," that's a bug: the continuation turn already handles it automatically.
After the campaign is created, do NOT notify stakeholder teams, do NOT offer to copy from earlier campaigns, and do NOT start a field-by-field Pre-planning interview on your own. The CAMPAIGN WORKFLOW block (appended each turn) decides what happens next; the UI shows the user their next step. Only ask about fields when the user asks to fill the form.

CTA skill — never end a turn parked on a rhetorical question with nothing concrete attached to answer it — "want me to continue?", "ready to proceed?", "should I start X?" and then stopping is not acceptable; there must always be an obvious next move. This applies after every propose_fill/propose_new_campaign/notify_stakeholders/derived-fill confirmation, and after status updates like "here's where things stand" — a status update alone is not a stopping point.
- While Guided Mode is ON: satisfy this with ask_choice — that exact question, with options like ["Yes, go ahead", "Not yet"] (or more specific labels when they exist, e.g. ["Start the Pre-planning questions", "Not yet"]) — and, per the Guided Mode skill above, that's the whole turn; don't also restate the question in prose afterward.
- While Guided Mode is OFF (unguided): do NOT call ask_choice for this — just ask the concrete next question directly in prose ("Ready to start the Pre-planning questions?" or better, go straight into asking the first one) and let them answer in their own words. The point is never leaving them with nothing to do next, not forcing a button.
If the user replies with something like "now what" or "no what" to one of your turns, that is a signal you left them without a real next action — treat it as a bug in your own last turn, not a user error, and immediately follow up with a concrete next step (ask_choice if guided, plain prose if not) rather than re-explaining the same status again.

UPLOADED FILE skill — a message that starts with 'Uploaded file "filename":' is a PDF/Word/Excel the user just attached, already converted to text (Excel/CSV sheets are flattened to '### Sheet: name' + CSV rows, one section per sheet). Treat the columns in each row as field:value pairs, matching column headers to real field labels the same way you'd match a typed sentence — call match_section with the sheet's context (e.g. section/sheet name, or the whole uploaded block if it's short enough) to find the right section, then propose_fill with one assignment per column that has a real counterpart among that section's fields. Skip columns with no matching field rather than guessing. For the CMA Metadata Sheet specifically: an uploaded metadata file is exactly the "reusing existing metadata" path — extract every matching row/column into that section's fields the same way, then tell the user plainly which columns you found homes for and which (if any) had no matching field, so nothing silently gets dropped.
An enrollment metadata/survey sheet (what OMS attaches for the "Attach Metadata Sheet" field) has a distinct shape worth recognizing: one column per enrollment source (each headed with a channel description like "Facebook Ad" and a Source Code), and below that a Question Code/Question Text/Answer Code/Answer Text table where a checkmark-style marker (e.g. "ü") in a source's column means that Q&A pair is passed for that source. Read it as: one enrollment source per marked column → one numbered OMS source slot (Source Type N = the channel description, Source Name N = the Source Code, Suvery Q&A pairs N = that column's own marked Question: Answer pairs) — see the numbered-fields note in the Guided quiz section above. Match_section on "OMS" / "enrollment" to find the section, then propose_fill across as many Source Type/Name/Q&A trios as sources you found (up to 6) — ALL of them in that one propose_fill call, never split across a first batch and a follow-up (see the propose_fill exception above) — and say plainly how many sources you found and staged.

Progress & Guided-Fill skill — three behaviors, always driven by you, never a repeated template:

1. Status reviews. If the user asks a "what's left / how am I doing / what's still needed" question, OR the message is the literal sentinel [[system:review_progress]] (a silent check-in fired by the UI after something changed — never show that literal text to the user; see also [[system:campaign_created]] in the New Campaign Intake skill above, same convention), call get_missing_fields for the current phase and report what's outstanding in your own words, naming a few actual field labels, not just a count. If nothing is missing, say so briefly in one sentence and don't call the tool for nothing to report.
2. Fill-from-text. Unchanged — the existing match_section / propose_fill flow above, for messages that describe values in free text.
THE REQUIREMENTS INTERVIEW — this is your main job, and these rules come from the customer directly. Follow them exactly.

Call get_interview_state at the start of any turn where you are gathering requirements for an EXISTING, already-open campaign (currentPage is set) — never as a way to figure out which campaign to work on, and never during New Campaign Intake (see that skill above, which is entirely separate and needs no open campaign). It tells you the current stage, what is still open in each stage, the next questions to ask (already prioritised — ask these, in this order, and do not substitute your own), and how many fields could be filled from answers already given.

The stages run in order: Objective, Audience, Trigger & scope, Journey, Content, Data & technical. The order is not arbitrary — a handful of answers (# of Emails, # of SMS, # of touch points, audience, channels, asset scope, enrollment) decide which sections and fields exist at all. Getting them early is what stops you asking about things that turn out not to apply.

CRITICAL — how to route a message that contains field values. ALWAYS try to match those values against stageOpen FIRST (it is in every get_interview_state result, and each entry carries its own sectionId). If they match, call propose_fill with that sectionId and do NOT call match_section at all. Only fall back to match_section when the message explicitly names a part of the form ("fill the CMA sheet", "in the Journey section") or when nothing in stageOpen matches.

This matters because match_section works by finding a section NAME in the message, and people describing their campaign say "brand is Cosentyx, agency is Ogilvy" — they never say "Generic/Overview". Leading with match_section there produces a no-match, and you then either ask a pointless disambiguation question or drop good answers. Neither is acceptable: the sectionId was already in your hand.

When the user answers with more than you asked for, capture ALL of it in one propose_fill. Match each value against stageOpen (the full set of open fields in this stage) — not just the handful in nextQuestions. Anything that matches nothing in stageOpen, say so explicitly instead of silently discarding it.

If something they volunteered maps to a field that exists but is not open yet — check the blocked list from get_missing_fields, which gives the reason — tell them the specific reason ("Therapy isn't editable until the Planning stage") and that they will be asked for it then. Do NOT promise to remember or park a value: nothing stores it, and the user will re-supply it when that field opens. Being straight about that is better than an assurance the platform cannot honour.

FORMATTING skill — the chat renders full markdown (bold, italics, bullets, numbered lists, and tables), and picking the right shape matters as much as the content: a five-field turn written as one solid paragraph is unreadable, and a two-value answer forced into a table is just as bad the other way.
- A TABLE is right when you're reflecting back or listing several structured field:value pairs at once — new campaign intake, "here's what I have so far", a comparison across a few items. One row per field/item, short column headers, no more than 4-5 columns (the chat column has room for a table, not a spreadsheet).
- BULLETS are right for the requirements-interview questions themselves, for a list of options, or for steps to take. One bullet per item, never a run-on sentence listing them. For interview questions specifically: start each bullet with the field name in **bold**, exactly as it appears in nextQuestions, then an em dash, then a short plain-English description of what's wanted, with any "usually comes from X" hint in *italics* at the end — "- **Campaign Type** — is this a one-off send or an always-on program? *usually from the TactPlan brief*".
- PLAIN PROSE is right for one or two values, a yes/no answer, or normal conversation — don't manufacture a table or bullet list out of a single sentence's worth of information.
- Bold field names, values and counts when you mention them in prose too. Keep paragraphs to two or three sentences and use a blank line between them. Markdown headings (#) are still unnecessary here — the chat column doesn't need document-style section breaks.

How to conduct it:
- Ask the questions in nextQuestions — a small group at a time, never more than what that list gives you.
- Never ask about technical or tactical detail while an earlier stage is still open. If the user volunteers something out of order, take it — capture it with propose_fill — and then return to where you were. Steer, don't refuse.
- Ask a follow-up ONLY when an answer is incomplete or ambiguous. A clear answer gets recorded and you move on.
- When a stage's remaining count reaches zero, say so, summarise in two or three sentences what that stage established (name the actual values), and confirm before starting the next stage. Keep that summary cumulative — the user should always be able to see the requirements taking shape.
- Flag missing or unknown information explicitly rather than quietly skipping it.
- For per-tactic work, finish one tactic completely before starting the next. The queue already enforces this; don't fight it by jumping between Email #1 and Email #2.
- Never invent a value, and never apply a default because it seems reasonable. If you think a default applies, propose it and let the user approve it.

Derived values. When get_interview_state reports derivableCount above zero, those are fields whose answers follow from what the user has ALREADY told you (Brand is restated in OMS and several times inside the CMA sheet, and so on). Call propose_derived_fills to stage them all at once, tell the user plainly what you are filling and where it came from, and let them confirm. Do this as soon as the count is non-zero — it is the single biggest reduction in questions you can offer. Never ask for a field one at a time when it could have been derived. THIS APPLIES EVEN UNDER GUIDED MODE — Guided Mode's "one thing per turn" rule is about not dumping several OPEN QUESTIONS on the user at once; it is not a reason to unwind one propose_derived_fills batch into a string of individual "should I use X?" confirmations. A batch of already-known values staged as ONE card the user confirms with ONE click is already exactly the single-action-per-turn shape Guided Mode wants — five separate confirm-prompts for five values the user already gave you during intake is the opposite of that, not a careful application of it.

0. The remaining list is authoritative. get_missing_fields returns two things: "remaining" (fields that are blank AND actually fillable right now) and "blocked" (fields that are blank but that the form is currently rendering read-only, each with a reason). NEVER ask the user to fill, and never call propose_fill or record_quiz_answer for, anything that is not in "remaining" — the write will be refused and you will have asked for something impossible. Only "remaining" counts toward any number you report. If the user brings up a blocked field themselves, say plainly why it can't be edited right now (submitted and read-only / filled in automatically by the platform / belongs to a different stakeholder / its phase isn't open yet) and point them at the section's Edit button where that applies. Don't volunteer the blocked list unprompted.

3. Guided quiz. Triggered when the user asks to get started, be walked through what's left, or asks you to ask them one by one. Call get_missing_fields first. Then ask about exactly ONE missing field per turn, in plain conversational English (the same style as your normal prose — mention where the value usually comes from if you have that context). Wait for their reply. If it's an answer, call record_quiz_answer with that exact field and value, then ask about the next missing field in the same reply. If they say skip/pass/not sure, move to the next field without recording anything. If they ask an unrelated question or issue a correction mid-quiz, handle it with the normal tools first, then resume asking about the next missing field — don't lose your place. When nothing is left, close with a short, freshly-worded wrap-up sentence, not a template.
   Multi-value fields, general case (anything conceptually a list rather than a single answer, with no dedicated numbered fields for it): after recording the first value, ask "is there another one?" (via ask_choice — Yes/No is a fixed set). If yes, ask for the next one and record it into the SAME field by combining it with what's already there (comma-separated: "Source A, Source B"), not by overwriting the first answer or leaving it uncaptured — then ask again whether there's another, looping until they say no. Don't assume a field only ever has one value just because you only asked once before.
   OMS enrollment sources specifically ARE dedicated numbered fields, NOT this comma-join pattern: "Source Type 1"/"Source Name 1"/"Suvery Q&A pairs 1" through "...6" — one full trio per distinct enrollment source (e.g. a "Facebook Ad" source and an "Insta Ad" source from the same metadata sheet are Source Type 1/Source Name 1/Suvery Q&A pairs 1 and Source Type 2/Source Name 2/Suvery Q&A pairs 2, never combined into one field). When extracting from an uploaded metadata sheet (see UPLOADED FILE skill below) or asking conversationally, fill slot 1 with the first source found, slot 2 with the second, and so on in the order they appear; leave any unused slots (up to 6) untouched rather than padding them. Each source's own Suvery Q&A pairs value should hold that source's own Question: Answer pairs only (semicolon-separated is fine), not the whole sheet's pairs mixed together. Stage ALL sources found (up to 6, up to 18 fields) in ONE propose_fill call — do not batch these into a first few sources plus a "continue for the rest" follow-up; see the propose_fill exception above.
   CRITICAL — never ask "What's the Source Type for your first enrollment source?" (or Source Name, or Suvery Q&A pairs) with GUESSED options before checking for the metadata sheet first, AND — before any of that — check ownership (see OWNERSHIP GATE immediately below, not an optional afterthought: check it FIRST, every single time, even inside this same paragraph's own instruction). These three fields are meant to be DERIVED from the campaign's enrollment metadata sheet (see UPLOADED FILE skill), not guessed at with plausible-sounding channel names like "Facebook Ad / Instagram Ad / Website Form" — those aren't real data, they're invented, and every one of them risks being wrong. If get_missing_fields' remaining list includes any Source Type/Source Name/Suvery Q&A pairs slot AND the current persona is OMS (see OWNERSHIP GATE) AND no metadata sheet has been shared in this conversation yet, the FIRST thing to ask — before any of the numbered source fields — is whether they have the enrollment metadata sheet to share, e.g. "The fastest way to get your enrollment sources right is from the metadata sheet — do you have it handy to attach?" Only fall back to asking the numbered fields conversationally, one source at a time with NO guessed options (plain prose, let them type the real channel name), if they say they don't have the sheet.
   OWNERSHIP GATE on all of the above — these Source Type/Source Name/Suvery Q&A pairs fields (and the metadata-sheet question that precedes them) belong to OMS, and get_missing_fields'/get_interview_state's "remaining" list is already scoped to whoever is currently logged in. Only ask about the metadata sheet, or any numbered source field, when the CURRENT persona is the one who actually owns them (their remaining list is what surfaced them) — never ask an AOR user (or any other non-owning persona) about the metadata sheet or source fields, including right after they answer the enrollment-trigger question. NAMED FAILURE CASE, because this exact one keeps recurring: AOR (or any non-OMS persona) answers "Enrollment Sign-Up: Yes" → you correctly say, in prose, something like "I will request the OMS team to upload the required enrollment form details" → and then, in THAT SAME message or turn, you ALSO call ask_choice asking "Do you have the enrollment metadata sheet handy to attach?" — that second half is the bug. Saying the acknowledgment sentence does NOT license following it up with the metadata-sheet question anyway; the acknowledgment IS the complete turn for a non-owning persona, full stop, no ask_choice call attached to it. For a non-owning persona, the correct move is the one already described in the New Campaign Intake skill's step 6/notify_stakeholders language: acknowledge in one line that OMS will need to act on this, then move straight to THAT persona's own next open field — never redirect their turn into someone else's questions, and never let the CRITICAL paragraph above about "ask for the sheet first" fire for a persona who isn't OMS, no matter how naturally it seems to follow from what they just answered.
   STOP after the enrollment sources are confirmed — do not immediately roll on into other open OMS fields (Metadata Source, Franchise, Program, Survey, or anything else) in the same breath. Confirming the numbered Source Type/Source Name/Suvery Q&A pairs trio is a real milestone on its own: the client fires a segmentation-flow handoff to the Solution Architect the instant that confirm lands. Your very next message should be ONE short sentence acknowledging exactly that — the sources are confirmed and the segmentation flow/Solution Architect notification is underway — and nothing else. Then apply the CTA skill (further below): ask, as its own explicit yes/no ("Want to keep going with the rest of the OMS fields now, or pick this up later?"), rather than silently continuing into the next question as if it were the same breath. Only proceed to Metadata Source/Franchise/Program/etc. after they say yes.

Rules:
- Only reach for match_section/propose_fill when the message is actually about filling in NEW form values. If it's a greeting or a general question with nothing to fill, just reply directly and briefly, in persona — do not call match_section on a "hello".
- If the user is asking a question about existing data ("what's the brand we set for OMS", "what did we put for the campaign name", "what's still empty in planning"), call get_entries — do not guess from memory, and do not call propose_fill for a read-only question.
- If the user is correcting how you behave or stating a standing preference (not campaign data), call learn_skill instead of just apologizing and moving on — the correction should actually persist. Confirm in your final reply what you've learned, in one short sentence.
- Write like a helpful colleague sitting next to the user: warm, plain English, contractions fine. The UI already renders the raw field:value list on the staged-changes card, so your text should not repeat it as a list — your job is to say what it means in sentences. Stay brief; two or three sentences is usually plenty.
- When you do call a tool, first say one short conversational sentence about what you're doing. "Let me pull up the Campaign Metadata fields for you." reads right; "Invoking match_section." does not.
- ALWAYS call match_section before propose_fill — never guess a section id or field name from memory.
- Only call propose_fill after match_section has told you the section's real field names. Only include a field in assignments if the user's text actually specifies a value for it — never invent one. Field names must be copied verbatim from the list match_section returned.
- If match_section finds no match, end your turn asking the user which section they mean — do not guess.
- After calling propose_fill, close by reading back what you staged in natural prose, naming the actual values rather than just the field labels — "I've put Cosentyx down as the brand and Q3 2026 for the launch window; take a look and confirm when it looks right." If you had to interpret something loosely, say so in the same breath. Never say the values were applied or saved — they are staged until the user confirms.
- You have the full conversation history. If the user is correcting or amending a value from earlier in this conversation (e.g. "my mistake, brand is X", "actually make it Y") rather than starting a new request, reuse the section already established earlier — do not call match_section on the correction fragment alone (a bare value like "brand is X" will not match any section by itself). Only call match_section again if the user is clearly now talking about a different section.`;

// Every active AgentSkill's rule gets folded into the system prompt on every
// turn — a correction learned once (via learn_skill) applies from then on,
// not just for the rest of that conversation. This is what makes learn_skill
// actually change future behavior instead of just being logged somewhere.
async function buildSystemPrompt() {
  const skills = await prisma.agentSkill.findMany({ where: { active: true }, orderBy: { createdAt: 'asc' } });
  if (skills.length === 0) return BASE_SYSTEM_PROMPT;
  const learned = skills.map(s => `- ${s.title}: ${s.rule}`).join('\n');
  return `${BASE_SYSTEM_PROMPT}\n\nLearned behavioral corrections (apply these — they were taught by real usage, not hypothetical):\n${learned}`;
}

// GET /api/skills — admin visibility into every learned correction, and how
// they're worded (so it's inspectable, not a black box).
app.get('/api/skills', async (req, res) => {
  const skills = await prisma.agentSkill.findMany({ orderBy: { createdAt: 'desc' } });
  res.json({ skills });
});

// DELETE /api/skills/:id — admin can retract a learned correction that turns
// out to be wrong, without touching code.
app.delete('/api/skills/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid skill id.' });
  await prisma.agentSkill.delete({ where: { id } }).catch(() => {});
  res.json({ ok: true });
});

function buildToolDeclarations() {
  return [
    {
      name: 'match_section',
      description: "Find which form section the user's message refers to, and return that section's real field names.",
      input_schema: {
        type: 'object',
        properties: { query: { type: 'string', description: "The user's ENTIRE original message, verbatim — not a fragment or extracted sub-topic. Matching is substring-based, so passing the whole message maximizes the chance of finding the section name/alias wherever it appears." } },
        required: ['query'],
      },
    },
    {
      name: 'propose_fill',
      description: 'Stage field:value assignments for one section for the user to confirm. Does not write to the form.',
      input_schema: {
        type: 'object',
        properties: {
          sectionId: { type: 'string' },
          assignments: {
            type: 'array',
            items: {
              type: 'object',
              properties: { field: { type: 'string' }, value: { type: 'string' } },
              required: ['field', 'value'],
            },
          },
        },
        required: ['sectionId', 'assignments'],
      },
    },
    {
      name: 'get_entries',
      description: 'Look up field values already saved to this campaign request, optionally filtered to one section and/or one stage (preplan/plan/exec). Read-only — grounds answers about existing data in what is actually persisted.',
      input_schema: {
        type: 'object',
        properties: {
          sectionId: { type: 'string', description: 'Optional — restrict to one section id.' },
          phase: { type: 'string', enum: ['preplan', 'plan', 'exec'], description: 'Optional — restrict to one stage.' },
        },
        required: [],
      },
    },
    {
      name: 'get_orchestration_state',
      description: 'Read-only: this campaign Contact Details (each role, its contact, auto-filled or edited), per-section confirmation (contacts/emails/journeys: confirmed by whom, or what is still missing) and the handoff tracker (A OMS codes, B CEP, C OMS metadata sheet, D Solution Architect flow, E HQE, F UTM) with waiting/notified/done status. Use for "who are we waiting on", "who is the CEP contact", "has OMS been told".',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'set_section_confirmation',
      description: 'Confirm (locks) or reopen (unlocks) one Orchestration section for this campaign as the current user. Contact Details: CDM confirms. Emails and Journeys: AOR confirms. Reopen: the owner or CDM. Only call when the user explicitly asks to confirm or reopen; on failure, tell them what is missing.',
      input_schema: {
        type: 'object',
        properties: {
          section: { type: 'string', enum: ['contacts', 'emails', 'journeys'] },
          action: { type: 'string', enum: ['confirm', 'reopen'] },
        },
        required: ['section', 'action'],
      },
    },
    {
      name: 'learn_skill',
      description: 'Permanently record a correction or standing preference about your own behavior, so it applies on every future turn from now on — not just this session.',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short label for this rule.' },
          rule: { type: 'string', description: 'The general, reusable instruction to follow going forward — not campaign-specific data.' },
        },
        required: ['title', 'rule'],
      },
    },
    {
      name: 'navigate_stage',
      description: 'Take the user to a tab, and optionally a section and field, of the open campaign. Use when the user asks to go somewhere ("go to Orchestration", "take me to field 28", "take me there" after you named a next step).',
      input_schema: {
        type: 'object',
        properties: {
          stage: { type: 'string', enum: ['general', 'journey', 'flow', 'orchestration'], description: 'general = the General tab (General Campaign Details 10-31), journey = the Email and Journey tab (Email Details, Journey Details), flow = Flow, orchestration = contacts, handoffs and the delivery sequence.' },
          section: { type: 'string', description: 'Optional. Form section id (generic, emaildetails, journeydetails, ...) or, on orchestration, contacts | handoffs.' },
          field: { type: 'string', description: 'Optional field number to highlight, e.g. "28".' },
        },
        required: ['stage'],
      },
    },
    {
      name: 'get_missing_fields',
      description: 'Return the fields still needing input for the current user and phase (ownership, conditional visibility, and cascades already applied client-side), optionally filtered to one section. Read-only.',
      input_schema: {
        type: 'object',
        properties: { sectionId: { type: 'string', description: 'Optional — restrict to one section id.' } },
        required: [],
      },
    },
    {
      name: 'get_interview_state',
      description: "Where the requirements interview stands: the current stage, per-stage progress, the next small group of questions to ask (already prioritised and capped), and how many fields could be filled from answers already given. Start every interview turn with this.",
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'propose_derived_fills',
      description: "Stage every field that can be inferred from answers already given (e.g. Brand restated across OMS and the CMA sheet) as ONE batch for the user to confirm. Does not write. Call when get_interview_state reports a non-zero derivable count.",
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'record_quiz_answer',
      description: "Record one field's answer immediately during a guided quiz — no staging, no confirm step. Only for an answer to a question you just asked about that exact field.",
      input_schema: {
        type: 'object',
        properties: {
          sectionId: { type: 'string' },
          field: { type: 'string', description: 'The field label, copied verbatim from get_missing_fields.' },
          value: { type: 'string' },
        },
        required: ['sectionId', 'field', 'value'],
      },
    },
    {
      name: 'open_campaign',
      description: 'Navigate the user to a different campaign request by its TactPlan id, when they ask to open/view/switch to/go to a campaign that is in the portfolio list. Only call this when they actually want to go there now, not merely because you mentioned that campaign in your reply.',
      input_schema: {
        type: 'object',
        properties: { tactplanId: { type: 'string', description: "The exact TactPlan id from the portfolio list, e.g. 'TP-88213'." } },
        required: ['tactplanId'],
      },
    },
    {
      name: 'ask_choice',
      description: "Ask the user ONE question, rendered in the UI as real clickable buttons instead of a paragraph they have to read and type a reply to — see the Guided Mode skill. Use this for a single yes/no or short-fixed-list question (e.g. offering Guided Mode itself, Branded/Unbranded, HCP/DTC, a stage name, an asset scope). Clicking a button sends that exact label back as the user's next message, so write each option exactly as you'd want it to read if the user had typed it themselves. Do not use this for a question with a genuinely open-ended answer (a name, a free-text description) — just ask normally in your reply instead.",
      input_schema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The single question to ask, in plain conversational English.' },
          options: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 8, description: '2-8 short button labels, each a complete, unambiguous answer on its own. Include a catch-all like "Something else" as the last option if the list might not be exhaustive.' },
        },
        required: ['question', 'options'],
      },
    },
    {
      name: 'notify_stakeholders',
      description: "Post a real, persisted notification the mentioned roles will see in their own notification bell — not the Conversations drawer (that's human-to-human only, these are deliberately excluded from it), and not just chat text. Call this ONCE, right after a brand-new campaign's intake (Generic/Overview) is confirmed created and open — never for an existing campaign the user is just continuing to fill in.",
      input_schema: {
        type: 'object',
        properties: {
          opsMessage: { type: 'string', description: 'Message to Campaign Ops — the new campaign needs project setup, a timeline, and team member allocation. Write it as a real handoff note, not a template.' },
          otherTeamsMessage: { type: 'string', description: 'Message to the other stakeholder roles (XM, MDS, CEP, Data Cloud Architect) — intake has been created, timelines are still to be determined.' },
        },
        required: ['opsMessage', 'otherTeamsMessage'],
      },
    },
    {
      name: 'record_new_campaign_field',
      description: "Record ONE field of the New Campaign Intake the moment the user answers it — no staging, no confirm step, same immediacy as record_quiz_answer. Call this every single time, right after the user gives a value for any of the required fields, BEFORE you ask your next question. This is the ONLY reliable memory of intake progress — a fresh NEW CAMPAIGN INTAKE STATE block is rebuilt from these calls on every turn, so don't rely on your own recollection of the conversation to know what's already been answered.",
      input_schema: {
        type: 'object',
        properties: {
          field: { type: 'string', enum: ['channels', 'assetScope', 'newBrand', 'brand', 'indication', 'therapeuticArea', 'brandedUnbranded', 'audience', 'campaignName'] },
          value: { type: 'string', description: 'For channels, comma-separate if more than one, e.g. "Email, SMS".' },
        },
        required: ['field', 'value'],
      },
    },
    {
      name: 'propose_new_campaign',
      description: "Stage a brand-new campaign request (a fresh TactPlan) for the user to review and create. Use this when the user wants to register, create, start, or spin up a NEW campaign — this is a different thing from filling an existing one, and match_section/propose_fill do not apply (there is no section yet, because there is no campaign yet). Only call this once you actually have all the required fields — see the New Campaign Intake skill for how to get there; do not call it with guessed or placeholder values.",
      input_schema: {
        type: 'object',
        properties: {
          tactplanId: { type: 'string', description: "The TactPlan id the user typed, e.g. 'TP-88500'. Required — never invent one." },
          channels: { type: 'array', items: { type: 'string', enum: ['Email', 'SMS'] }, description: 'Field 11 Channels Type. One or both.' },
          assetScope: { type: 'string', enum: ['New Brand Launch', 'New Indication Launch', 'Update Existing Campaign'], description: 'Field 12 Request Type (Asset Scope).' },
          newBrand: { type: 'string', enum: ['Yes', 'No'], description: 'Field 13 New Brand?' },
          brand: { type: 'string', description: 'Field 14 Brand.' },
          indication: { type: 'string', description: 'Field 15 Indication.' },
          therapeuticArea: { type: 'string', description: 'Field 16 Therapeutic Area.' },
          brandedUnbranded: { type: 'string', enum: ['Branded', 'Unbranded'], description: 'Field 17.' },
          audience: { type: 'string', enum: ['HCP', 'DTC'], description: 'Field 18 Audience Type.' },
          campaignName: { type: 'string', description: 'Field 21 Campaign Name (working title; AOR can change it later).' },
        },
        required: ['tactplanId', 'channels', 'assetScope', 'newBrand', 'brand', 'indication', 'therapeuticArea', 'brandedUnbranded', 'audience', 'campaignName'],
      },
    },
  ];
}

// Lowercases and collapses punctuation to single spaces — deliberately does
// NOT strip spaces the way the old normLabel() did. Stripping spaces before
// substring-matching let two adjacent words accidentally spell out a short
// id: "preferd contact method" (typo for "preferred") collapsed to
// "preferdcontactmethod", which contains "dc" (Data Cloud's id) purely by
// coincidence of where "preferd" ends and "contact" begins. Keeping spaces
// and requiring whole-word/whole-phrase matches (see wordMatch below) makes
// that class of accidental cross-word collision structurally impossible.
function normPhrase(s) { return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
function wordMatch(paddedQuery, needle) { return !!needle && paddedQuery.includes(' ' + needle + ' '); }

// Executed server-side, for real — not the model. `sections` comes from the
// client's own SECTIONS/SECTION_ALIASES data (see hqe-requirement-studio-mock_2.html)
// so this stays in sync with the actual form without duplicating that data here.
async function executeTool(name, args, ctx) {
  if (name === 'match_section') {
    // Match against the turn's actual original message, not args.query — the
    // model doesn't reliably pass the full message despite the system prompt
    // asking for it (it sometimes extracts just a sub-topic fragment), and
    // this is fully deterministic to get right server-side instead.
    const fullText = ctx.originalText || args.query || '';
    // A long document (an uploaded file's flattened text, in practice —
    // typed messages don't run this long) accumulates incidental id-word
    // hits the longer it goes: an enrollment metadata sheet's own body
    // rows mention "Email" (as in "Email Address") many times over,
    // greedily winning tier 1's exact-id match for the Email section
    // before OMS's alias tier ever gets a turn, even though nothing about
    // the message is actually about email. A real document's own subject
    // is established early — its title, sheet name, header row — so once
    // text runs long, match only that opening window rather than the
    // whole body where unrelated section-shaped words pile up.
    const matchWindow = fullText.length > 1200 ? fullText.slice(0, 600) : fullText;
    const qRaw = normPhrase(matchWindow);
    if (!qRaw) return { error: 'Empty query.' };
    const q = ' ' + qRaw + ' ';
    // Two tiers, not one flat "longest key wins" pass — that backfired: a
    // long CMA-fill message can legitimately contain the word "enrollment"
    // several times as ordinary content ("enrollment process", "post
    // enrollment survey"), and OMS's alias list includes bare "enrollment"
    // (10 chars) — longer than "cma" (3 chars) — so it won on length even
    // though it was incidental, not a section reference.
    // Tier 1: exact section id/name only. These are deliberately short but
    // precise (ids especially) — an id match is essentially never incidental
    // content, unlike a broad alias word. Tier 2 (generic aliases) only runs
    // if tier 1 finds nothing, and still prefers the longest alias there.
    let best = null, bestKeyLen = 0;
    for (const s of ctx.sections) {
      const keys = [s.id, s.name].map(normPhrase).filter(Boolean);
      for (const k of keys) {
        if (wordMatch(q, k) && k.length > bestKeyLen) { best = s; bestKeyLen = k.length; }
      }
    }
    if (!best) {
      for (const s of ctx.sections) {
        const keys = (s.aliases || []).map(normPhrase).filter(Boolean);
        for (const k of keys) {
          if (wordMatch(q, k) && k.length > bestKeyLen) { best = s; bestKeyLen = k.length; }
        }
      }
    }
    if (!best) return { error: `No section matched "${args.query}". Known sections: ${ctx.sections.map(s => s.name).join(', ')}.` };
    return { sectionId: best.id, sectionName: best.name, fields: best.fields };
  }
  if (name === 'propose_fill') {
    const section = ctx.sections.find(s => s.id === args.sectionId);
    if (!section) return { error: `Unknown sectionId "${args.sectionId}".` };
    const rawAssignments = Array.isArray(args.assignments) ? args.assignments : [];
    // The model only ever knows fields by label (that's all the tool schema
    // gives it — `field`, a string). The client's Confirm button writes
    // straight into fieldValues keyed by fieldId, so without resolving the
    // real id here every propose_fill card in the app "Applied to the form"
    // and silently wrote nothing — same bug propose_derived_fills had.
    const assignments = rawAssignments.map((a) => {
      const wanted = String(a.field || '').trim().toLowerCase();
      const match = (section.fields || []).find((f) => (f.n || '').trim().toLowerCase() === wanted);
      return { fieldId: match ? match.id : undefined, fieldLabel: a.field, value: a.value };
    });
    return { proposed: true, sectionId: section.id, sectionName: section.name, assignments, note: 'Staged, not written yet — awaiting user confirmation in the UI.' };
  }
  if (name === 'get_entries') {
    if (!ctx.tactplanId) return { error: 'No campaign request is open — nothing to look up.' };
    const rows = await prisma.fieldEntry.findMany({
      where: {
        tactplanId: ctx.tactplanId,
        ...(args.sectionId ? { sectionId: args.sectionId } : {}),
        ...(args.phase ? { phase: args.phase } : {}),
      },
      orderBy: [{ sectionId: 'asc' }, { fieldId: 'asc' }],
    });
    return {
      entries: rows.map(r => ({ section: r.sectionName, phase: r.phase, field: r.fieldLabel, value: r.value })),
      count: rows.length,
    };
  }
  if (name === 'get_orchestration_state') {
    if (!ctx.tactplanId) return { error: 'No campaign request is open.' };
    const [contacts, status, users] = await Promise.all([
      prisma.campaignContact.findMany({ where: { tactplanId: ctx.tactplanId } }),
      handoffs.status(prisma, ctx.tactplanId),
      prisma.appUser.findMany(),
    ]);
    const name = (v) => {
      if (!v) return null;
      let ids;
      try { ids = JSON.parse(v); } catch { ids = v; }
      const one = (id) => (users.find((u) => u.id === id) || {}).name || id;
      return Array.isArray(ids) ? ids.map(one).join(', ') : one(ids);
    };
    return {
      contacts: intakeRoutes.SLOTS.map((sl) => {
        const r = contacts.find((c) => c.slot === sl.slot);
        return { role: sl.label, contact: r ? name(r.value) : null, source: r && r.value ? (r.edited ? 'edited' : 'brand default') : null };
      }),
      sections: await orchestration.confirmations(prisma, ctx.tactplanId),
      // Brand code is never exposed, only whether handoffs moved.
      handoffs: status.map((h) => ({ id: h.id, what: h.title, status: h.doneBy === 'migration' ? 'done before tracking' : h.status, notifiedAt: h.firedAt, doneAt: h.doneAt })),
    };
  }
  if (name === 'set_section_confirmation') {
    if (!ctx.tactplanId) return { error: 'No campaign request is open.' };
    const fn = args.action === 'reopen' ? orchestration.reopen : orchestration.confirm;
    const r = await fn(prisma, ctx.tactplanId, args.section, ctx.persona);
    if (r.error) return { error: r.error, missing: r.missing };
    return { done: true, section: args.section, action: args.action };
  }
  if (name === 'learn_skill') {
    const title = String(args.title || '').trim();
    const rule = String(args.rule || '').trim();
    if (!title || !rule) return { error: 'title and rule are both required.' };
    const skill = await prisma.agentSkill.create({ data: { title, rule } });
    return { learned: true, id: skill.id, title, rule };
  }
  if (name === 'navigate_stage') {
    const alias = { intake: 'general', timeline: 'orchestration', execution: 'journey' };
    const stage = alias[args.stage] || args.stage;
    const valid = ['general', 'journey', 'flow', 'orchestration'];
    if (!valid.includes(stage)) return { error: `Unknown stage "${args.stage}".` };
    return { navigated: true, stage, section: args.section || undefined, field: args.field || undefined };
  }
  if (name === 'ask_choice') {
    const question = String(args.question || '').trim();
    const options = Array.isArray(args.options) ? args.options.map(o => String(o || '').trim()).filter(Boolean) : [];
    if (!question || options.length < 2) return { error: 'question and at least 2 options are required.' };
    return { asked: true, question, options };
  }
  if (name === 'notify_stakeholders') {
    if (!ctx.tactplanId) return { error: 'No campaign request is open — nothing to notify about.' };
    const opsMessage = String(args.opsMessage || '').trim();
    const otherTeamsMessage = String(args.otherTeamsMessage || '').trim();
    if (!opsMessage || !otherTeamsMessage) return { error: 'opsMessage and otherTeamsMessage are both required.' };
    return { notified: true, tactplanId: ctx.tactplanId, opsMessage, otherTeamsMessage };
  }
  if (name === 'record_new_campaign_field') {
    const validFields = ['tactplanId', 'channels', 'assetScope', 'newBrand', 'brand', 'indication', 'therapeuticArea', 'brandedUnbranded', 'audience', 'campaignName'];
    if (!validFields.includes(args.field)) return { error: `Unknown field "${args.field}".` };
    const value = String(args.value ?? '').trim();
    if (!value) return { error: 'value is required.' };
    return { recorded: true, field: args.field, value };
  }
  if (name === 'propose_new_campaign') {
    const required = ['tactplanId', 'assetScope', 'newBrand', 'brand', 'indication', 'therapeuticArea', 'brandedUnbranded', 'audience', 'campaignName'];
    const missing = required.filter(k => !String(args[k] || '').trim());
    const channels = Array.isArray(args.channels) ? args.channels.filter(Boolean) : [];
    if (!channels.length) missing.push('channels');
    if (missing.length) return { proposed: false, missing };
    // The intake conversation stays in the chat history after the campaign is
    // created; never stage the same campaign a second time.
    const exists = await prisma.campaign.findUnique({ where: { id: String(args.tactplanId).trim() } });
    if (exists) return { proposed: false, error: `Campaign ${exists.id} already exists. Do not stage it again; the intake is finished.` };
    return {
      proposed: true,
      fields: {
        tactplanId: String(args.tactplanId).trim(),
        newBrand: args.newBrand,
        brand: String(args.brand).trim(),
        therapeuticArea: String(args.therapeuticArea).trim(),
        indication: String(args.indication).trim(),
        brandedUnbranded: args.brandedUnbranded,
        audience: String(args.audience).trim(),
        assetScope: args.assetScope,
        campaignName: String(args.campaignName).trim(),
        channels,
      },
      note: 'Staged, not created yet — awaiting user confirmation in the UI.',
    };
  }
  if (name === 'open_campaign') {
    // Only honour an id that's actually in the portfolio list this turn
    // sent — the model must never be able to navigate somewhere that
    // doesn't exist, same guard the old home-agent endpoint had.
    const portfolio = Array.isArray(ctx.portfolio) ? ctx.portfolio : [];
    const found = portfolio.find(r => r.id === args.tactplanId);
    if (!found) return { navigated: false, error: `"${args.tactplanId}" isn't in the portfolio list.` };
    return { navigated: true, tactplanId: found.id, name: found.name };
  }
  if (name === 'get_missing_fields') {
    const remaining = Array.isArray(ctx.remaining) ? ctx.remaining : [];
    const filtered = args.sectionId ? remaining.filter(r => r.sectionId === args.sectionId) : remaining;
    // `blocked` is empty-but-unfillable: fields the user owns that are still
    // blank but that the form is currently rendering read-only. They are NOT
    // part of the count — they exist so the reason can be explained if asked.
    return { remaining: filtered, count: filtered.length, blocked: ctx.blocked || [] };
  }
  if (name === 'get_interview_state') {
    if (!ctx.interview) return { error: 'No campaign request is open.' };
    return ctx.interview;
  }
  if (name === 'propose_derived_fills') {
    const derived = ctx.derived || [];
    if (derived.length === 0) return { proposed: false, count: 0, note: 'Nothing can be derived yet.' };
    // Grouped per section because the client's proposal card is per-section —
    // one card each, all confirmable, rather than one mixed card that can't map
    // its rows back to fields.
    const bySection = {};
    derived.forEach(d => { (bySection[d.sectionId] = bySection[d.sectionId] || { sectionId: d.sectionId, sectionName: d.sectionName, assignments: [] })
      // fieldId (not just the label in `field`) — the client's Confirm button
      // writes assignments straight into fieldValues keyed by fieldId, same
      // as propose_fill's assignments; without it "Applied to the form"
      // silently wrote to fieldValues[undefined] and nothing landed.
      .assignments.push({ fieldId: d.fieldId, fieldLabel: d.field, value: d.value }); });
    return { proposed: true, derived: true, count: derived.length, groups: Object.values(bySection) };
  }
  if (name === 'record_quiz_answer') {
    const section = ctx.sections.find(s => s.id === args.sectionId);
    if (!section) return { error: `Unknown sectionId "${args.sectionId}".` };
    const field = String(args.field || '').trim();
    const value = String(args.value ?? '');
    if (!field) return { error: 'field is required.' };
    return { applied: true, sectionId: section.id, sectionName: section.name, field, value };
  }
  return { error: `Unknown tool "${name}".` };
}

// Concatenated text of an assistant message. The Messages API returns a list
// of content blocks (text / tool_use / thinking), not a flat .text string.
function assistantText(message) {
  return (message.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
}

// Deterministic backstop for the recurring "self-doubt" narration bug — the
// model periodically writes a sentence second-guessing a value it JUST
// correctly recorded ("My mistake — that recorded to the wrong field",
// "the earlier turn accidentally recorded a placeholder there") even
// though the underlying data was never actually wrong (inferIntakeDraftFromHistory
// and the NEW CAMPAIGN INTAKE STATE block are both correct — this is purely
// cosmetic narration). Two rounds of prompt wording (an explicit rule, then
// a shorter positive-only rewrite meant to avoid priming the exact bad
// phrasing) both reduced but did not eliminate it — verified live, it still
// slipped through after the rewrite. Rather than iterate on prompt wording
// a third time, strip any paragraph matching this narrow, specific pattern
// before it ever reaches the client: the value is always correctly
// recorded regardless, and the real next question follows immediately
// after in the same or next message, so dropping the self-doubt paragraph
// loses nothing the user needs.
const SELF_DOUBT_PATTERN = /\b(wrong field|accidentally recorded|recorded a placeholder|let me fix (it|that)|my mistake|stray entry)\b/i;
function stripSelfDoubtNarration(text) {
  if (!text) return text;
  const paragraphs = text.split(/\n\s*\n/);
  const kept = paragraphs.filter((p) => !SELF_DOUBT_PATTERN.test(p));
  return kept.join('\n\n').trim();
}

// Deterministic backstop for another recurring narration bug: the model
// writes its acknowledgment-plus-next-question in prose ("Branded,
// confirmed. Next — who's the target audience for this campaign?") and
// THEN calls ask_choice with that exact same question, producing two
// consecutive bubbles asking the identical thing. The system prompt
// already says not to do this (see ask_choice's own tool description) —
// verified live that instruction alone doesn't reliably hold, same as the
// self-doubt narration above. This strips the trailing paragraph of the
// pre-tool-call narration when it restates the upcoming ask_choice
// question, keeping only the acknowledgment part ahead of it.
const STOPWORDS = new Set(['the', 'a', 'an', 'to', 'for', 'of', 'that', 'this', 'is', 'i', 'you', 'your', 'and', 'or', 'it', 'be', 'use', 'shall', 'so', 'on', 'in']);
function stripUpcomingAskChoiceQuestion(text, content) {
  if (!text) return text;
  const askChoiceBlock = (content || []).find((b) => b.type === 'tool_use' && b.name === 'ask_choice');
  const question = askChoiceBlock && askChoiceBlock.input && askChoiceBlock.input.question;
  if (!question) return text;
  const normalize = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const nq = normalize(question);
  if (!nq) return text;
  // Beyond a literal substring match, catch a DECLARATIVE sentence that
  // just restates the same fact the question is about in different words
  // ("The sheet gives a Survey Code of 51251 — that maps to the Survey
  // field." right before ask_choice asks "...shall I use 51251 for the
  // Survey field?") — same bug, different clothing. Heuristic: if most of
  // the question's own significant words (numbers, codes, and words of 4+
  // letters, stopwords dropped) already appear in the trailing paragraph,
  // and that paragraph isn't much longer than the question itself, it's a
  // restatement, not new information — drop it too.
  const significantWords = (s) =>
    normalize(s)
      .split(' ')
      .filter((w) => w && !STOPWORDS.has(w) && (/\d/.test(w) || w.length >= 4));
  const qWords = new Set(significantWords(question));
  const isRestatement = (paragraph) => {
    const np = normalize(paragraph);
    if (np.includes(nq)) return true;
    if (!qWords.size) return false;
    const pWords = significantWords(paragraph);
    if (!pWords.length || pWords.length > qWords.size * 2.5) return false;
    const overlap = pWords.filter((w) => qWords.has(w)).length;
    return overlap / qWords.size >= 0.6;
  };
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  while (paragraphs.length && isRestatement(paragraphs[paragraphs.length - 1])) {
    paragraphs.pop();
  }
  return paragraphs.join('\n\n').trim();
}

// The Anthropic tool-use loop, shared by both SSE agent routes below.
// Replaces Gemini's stateful `chat` object: the Messages API is stateless, so
// `messages` IS the conversation and gets round-tripped through the client via
// the existing "history" SSE event — same client contract as before, the array
// is opaque to it.
//
// Callers pass `onResult` to emit their own route-specific SSE events
// (proposal / learned / navigate) off a tool result.
async function runAgentTurn({ system, tools, messages, execute, ctx, send, onResult }) {
  const request = { model: MODEL, max_tokens: MAX_OUTPUT_TOKENS, system, tools };
  let response = await ai.messages.create({ ...request, messages });

  let rounds = 0;
  while (response.stop_reason === 'tool_use' && rounds < MAX_TOOL_ROUNDS) {
    rounds++;
    // The one-sentence narration the model writes before calling a tool.
    const reasoning = stripUpcomingAskChoiceQuestion(stripSelfDoubtNarration(assistantText(response)), response.content);
    if (reasoning) send('reasoning', { text: reasoning });

    // The assistant turn must be echoed back verbatim — every tool_use block
    // needs a matching tool_result in the next user turn or the API rejects it.
    messages.push({ role: 'assistant', content: response.content });

    const toolResults = [];
    let askedChoice = false;
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      send('tool_start', { name: block.name });
      let result;
      try { result = await execute(block.name, block.input || {}, ctx); }
      catch (err) { result = { error: err instanceof Error ? err.message : 'Tool execution failed.' }; }
      send('tool', { name: block.name, result });
      onResult(block.name, result);
      if (block.name === 'ask_choice' && result?.asked) askedChoice = true;

      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(result),
        is_error: Boolean(result && result.error),
      });
    }
    messages.push({ role: 'user', content: toolResults });

    // ask_choice is a terminal action for the turn — the question (rendered
    // as buttons, or downgraded to plain text when Guided Mode is off) IS
    // the complete reply. Verified live, repeatedly: giving the model one
    // more round after it reliably wrote a redundant "pick one above"/"go
    // ahead and choose" sentence restating what the question+options
    // already said, despite an explicit prompt instruction not to — prompt
    // wording alone kept losing to the model's own habit of always closing
    // with a sentence. Ending the turn here instead of calling the model
    // again removes the opportunity for that sentence to exist at all.
    if (askedChoice) return { finalText: '', messages };

    response = await ai.messages.create({ ...request, messages });
  }

  // Only persist the closing turn when it has no unanswered tool calls —
  // hitting MAX_TOOL_ROUNDS leaves tool_use blocks with no tool_result, and
  // storing those would make the NEXT turn fail validation on resend.
  if (response.stop_reason !== 'tool_use') {
    messages.push({ role: 'assistant', content: response.content });
  }
  return { finalText: stripSelfDoubtNarration(assistantText(response)), messages };
}

// SSE agent loop — same event-per-step granularity as govex's streamAgentTurn:
// "reasoning" (the model's one-sentence narration before a tool call),
// "tool_start"/"tool" (a named skill actually executing), "proposal" (a
// propose_fill result, ready for the client's existing Confirm/Cancel card),
// "final" (closing text), "error".
// Deterministic backstop for New Campaign Intake progress tracking —
// verified live that the model reliably does NOT call
// record_new_campaign_field despite being told to (checked actual message
// history: only ask_choice tool calls ever appeared), so the
// NEW CAMPAIGN INTAKE STATE block below was silently dead code, always
// showing all 9 fields as missing, providing zero protection against the
// exact re-asking/confusing-fields bug it was built to fix. This instead
// derives the same draft straight from the conversation transcript itself
// — no model cooperation required, so it can't silently stop working the
// way the tool-call approach did. Matches each question — an ask_choice
// call, or (for TactPlan ID, deliberately never ask_choice) the model's own
// plain-text question — to one of the 9 canonical fields by keyword, then
// takes the next user message after it as that field's answer.
const INTAKE_FIELD_KEYWORDS = [
  { field: 'brandedUnbranded', kws: ['branded or unbranded', 'branded/unbranded'] },
  { field: 'newBrand', kws: ['new brand?', 'is this a new brand', 'brand new to', 'new brand for'] },
  { field: 'therapeuticArea', kws: ['therapeutic area', 'therapy area'] },
  { field: 'brand', kws: ['brand/product', 'brand or product', 'which brand', 'which product', 'product is this', 'product for this'] },
  { field: 'indication', kws: ['indication', 'condition is this', 'condition this'] },
  { field: 'audience', kws: ['audience'] },
  { field: 'assetScope', kws: ['asset scope', 'request type'] },
  { field: 'campaignName', kws: ['campaign name', 'campaign be called', 'name this campaign', 'call this campaign'] },
  { field: 'channels', kws: ['channel'] },
  { field: 'tactplanId', kws: ['tactplan id', 'tactplan number', 'tactplan identifier'] },
];

function messageText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(b => b.type === 'text').map(b => b.text).join('');
}

function inferIntakeDraftFromHistory(messages) {
  const draft = {};
  const msgs = Array.isArray(messages) ? messages : [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role !== 'assistant') continue;
    const askChoice = Array.isArray(m.content) ? m.content.find(b => b.type === 'tool_use' && b.name === 'ask_choice') : null;
    // TactPlan ID is deliberately asked as plain prose, never ask_choice —
    // the ask_choice-only version of this function could never see it
    // answered, so the "authoritative" state block kept telling the model
    // TactPlan ID was still missing right after the user had just given it,
    // and the model (reasonably, given a block it's told to trust over its
    // own memory) concluded it must have gone to the wrong field. Falls
    // back to the assistant's own prose when there's no ask_choice call —
    // but only text containing "?", since a later reflect-back table
    // ("TactPlan ID  TP-456789") also mentions every field name without
    // ever asking anything, and would otherwise get mistaken for a fresh
    // question and pair the wrong next message as its "answer".
    const questionText = askChoice
      ? String((askChoice.input && askChoice.input.question) || '')
      : (messageText(m.content).includes('?') ? messageText(m.content) : '');
    const question = questionText.toLowerCase();
    if (!question) continue;
    const matched = INTAKE_FIELD_KEYWORDS.find(fk => fk.kws.some(k => question.includes(k)));
    if (!matched) continue;
    for (let j = i + 1; j < msgs.length; j++) {
      if (msgs[j].role !== 'user') continue;
      const content = msgs[j].content;
      // Every tool_use (including ask_choice) gets an immediate synthetic
      // tool_result message pushed right after it — {role:'user', content:
      // [{type:'tool_result', ...}]}, required by the Anthropic API, NOT
      // the human's actual answer. Skip past it instead of treating it as
      // the reply: breaking here unconditionally made this function always
      // read an empty answer and never look further, so record_new_campaign
      // -style tracking of ask_choice-driven fields (i.e. ALWAYS, under
      // Guided Mode) silently recorded nothing — exactly the "asked again"
      // bug this whole mechanism exists to prevent.
      if (Array.isArray(content) && content.length && content.every(b => b.type === 'tool_result')) continue;
      const answer = messageText(content).trim();
      if (answer) draft[matched.field] = answer;
      break;
    }
  }
  return draft;
}

app.post('/api/agent-fill', async (req, res) => {
  const { sections, text, history, tactplanId, remaining, blocked, interview, derived, persona, phase, portfolio, currentPage, myPending, guidedMode, newCampaignDraft } = req.body || {};
  if (!ai) return res.status(503).json({ error: 'ANTHROPIC_FOUNDRY_API_KEY / ANTHROPIC_FOUNDRY_RESOURCE not configured on the server.' });
  if (!Array.isArray(sections) || sections.length === 0 || !text) {
    return res.status(400).json({ error: 'sections[] and text are required.' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  // originalText is the actual raw message for this turn — match_section
  // matches against this directly rather than trusting whatever fragment
  // the model chooses to pass as its query argument (it doesn't reliably
  // pass the full message despite being told to; this sidesteps that by
  // not depending on model compliance for something we can do deterministically).
  // tactplanId scopes get_entries to the campaign request currently open.
  const ctx = {
    sections, originalText: text, tactplanId: tactplanId || null,
    remaining: Array.isArray(remaining) ? remaining : [],
    blocked: Array.isArray(blocked) ? blocked : [],
    interview: interview || null,
    derived: Array.isArray(derived) ? derived : [],
    persona: persona || null, phase: phase || null,
    portfolio: Array.isArray(portfolio) ? portfolio : [],
  };

  try {
    // Client resends the prior turn's history (from the "history" event
    // below) so corrections like "my mistake, brand is X" land in the same
    // conversation instead of starting a blank one each request — there's
    // no server-side session store, so the client is the source of truth
    // for continuity, same effect as govex's ChatSession.historyJson.
    const messages = (Array.isArray(history) ? history : []).concat([{ role: 'user', content: text }]);

    // Portfolio-wide awareness, on every turn regardless of which page sent
    // it — this used to be exclusive to the (now-retired) separate
    // home-agent endpoint, which meant the form-fill agent here could only
    // ever talk about the one campaign whose sections it was handed. The
    // client now sends the same portfolio list from every page, plus which
    // campaign (if any) is currently open, so this one agent can act as
    // portfolio assistant AND form-filler in the same conversation instead
    // of being two different assistants depending on where the chat panel
    // happens to be mounted.
    const portfolioNote = Array.isArray(portfolio) && portfolio.length
      ? `\n\nPORTFOLIO AWARENESS. You have visibility into every campaign request, not just the one whose form (if any) is open below — here is the full list (id, name, brand, phase, status): ${JSON.stringify(portfolio)}. ${currentPage ? `The user currently has ${currentPage.name} (${currentPage.tactplanId}) open — favor that campaign when the question is ambiguous about which one they mean, but you may still answer about any other campaign in the list by name or id.` : "The user is on the portfolio hub right now — no specific campaign is open, so 'sections'/'match_section'/'propose_fill' below describe the shared form structure, not a specific campaign's data; ground any specific-campaign question in the portfolio list, and only call form-filling tools once the user is actually working an open campaign. EXCEPTION: if the user is partway through New Campaign Intake (see that skill above), this note is NOT a cue to ask 'which campaign' again — intake gathers its 8 fields straight from conversation and genuinely needs no campaign open at all; ignore this note for that flow and just keep asking the next missing intake field."} Never invent a campaign that isn't in this list.`
      : '';

    // "What's pending with me" data — real, computed client-side from the
    // exact same mineTo/actionText fields the portfolio table's own
    // "assigned to me" stat and per-row status text use (see
    // buildPortfolioContext in useAgentFill.ts), never something the model
    // is asked to infer. Sent on every turn, same as PORTFOLIO AWARENESS,
    // so the welcome-screen "What's pending with me" quick-pick (and any
    // later ad-hoc "what's on my plate" question) always renders from
    // ground truth, on the landing page or from inside any open campaign.
    // Computed on the server from the live workflow (workflow.js), not from
    // the static per-campaign labels the client used to send.
    const livePending = persona ? await workflow.pendingFor(prisma, persona).catch(() => null) : null;
    const myPendingList = livePending || myPending;
    const myPendingNote = Array.isArray(myPendingList)
      ? `\n\nMY PENDING ITEMS (authoritative — this is the complete, real list of campaigns with something pending on the current persona; never invent an item not in it, and never invent a due date not given here): ${JSON.stringify(myPendingList)}. If the user asks "what's pending with me" (including via that exact quick-pick button) or anything equivalent ("what's on my plate", "what do I owe"), respond with a markdown table — columns Campaign | What's Pending | Due Date — one row per item in this list, using the tactplanId's campaign name for Campaign, the pending text verbatim, and the dueDate verbatim (leave the cell blank, not a guess or "TBD", when dueDate is empty). If the list is empty, say in one sentence that nothing's currently pending on them rather than producing an empty table.`
      : '';

    // Where the open campaign is in the workflow, so "what next?" and
    // "I've finished the intake" get a real answer instead of silence.
    let workflowNote = '';
    if (tactplanId && persona) {
      const wf = await workflow.forPersona(prisma, tactplanId, persona).catch(() => null);
      if (wf) {
        workflowNote = `

CAMPAIGN WORKFLOW for ${tactplanId} (authoritative, recomputed this turn). The current user is ${String(persona).toUpperCase()}. Their open steps, in order: ${JSON.stringify(wf.mine)}. Steps other roles can work on now: ${JSON.stringify(wf.others.map((s) => ({ owner: s.owner, title: s.title })))}. The intended sequence is: (1) CDM completes the General tab fields; (2) you congratulate them that General Campaign Details are complete and take them to confirm the people mapping in Orchestration; (3) CDM updates any contact that is wrong and clicks Confirm section; (4) only then is OMS notified automatically to provide the Campaign code and Brand code, so tell CDM that OMS has been notified once it happens (never earlier). Whenever the user asks what to do next, says they finished something (e.g. "done with intake"), or you have just saved fields for them, end your reply with a short "Next:" line: their first open step with its detail and where to do it; if they have none open, say their part is done for now and name who is up next and what they are doing (handoffs to other roles are sent automatically; never offer to notify them yourself). Never claim a step is done unless this list says so. This campaign already exists: any earlier new-campaign intake conversation in the history is finished, so never call propose_new_campaign or record_new_campaign_field for it and never treat the user's message as a campaign name or a correction to the intake unless they clearly say so. A short reply that fits the first missing field of their open step (for example a Yes or No) is an answer to that field.`;
      }
    }

    // The UI's explicit Guided Mode toggle, sent on every turn while it's
    // on — a stronger, standing version of the same behavior the model can
    // also reach for on its own via the Guided Mode skill.
    const guidedModeNote = guidedMode
      ? '\n\nGUIDED MODE IS CURRENTLY ON (the user toggled it on in the UI). Ask about exactly ONE thing per turn, no exceptions — never list several missing fields at once while this is on. Use ask_choice for every question, including open-ended ones where you can suggest a short list of realistic example answers instead of leaving it fully blank (the user can still type something else if none fit). Stay in this mode for every subsequent turn until the user turns it off or clearly asks to switch back.'
      : '';

    // Computed fresh every turn from record_new_campaign_field calls, same
    // "don't trust your own memory of the conversation, trust this
    // rebuilt-every-turn block instead" fix that get_interview_state already
    // is for the requirements interview. Before this, the model tracked New
    // Campaign Intake progress purely from re-reading the chat transcript,
    // which reliably broke down under guided-mode's rapid one-click turns —
    // it would re-ask fields already answered, or mistake one field's answer
    // for a different field's (e.g. treating "Cosentyx" as an attempted
    // answer to "which agency" right after already asking brand).
    const ALL_INTAKE_FIELDS = ['tactplanId', 'channels', 'assetScope', 'newBrand', 'brand', 'indication', 'therapeuticArea', 'brandedUnbranded', 'audience', 'campaignName'];
    const clientDraft = newCampaignDraft && typeof newCampaignDraft === 'object' ? newCampaignDraft : {};
    // messages includes the current turn's user text, which is harmless
    // here (it's a fresh answer to whatever was last asked, not yet part
    // of an assistant/ask_choice pair unless it was the very-just-sent one).
    const draft = { ...clientDraft, ...inferIntakeDraftFromHistory(messages) };
    const doneFields = ALL_INTAKE_FIELDS.filter(f => draft[f]);
    const missingFields = ALL_INTAKE_FIELDS.filter(f => !draft[f]);
    // New Campaign Intake only exists before the campaign does. With a campaign
    // open, the rebuilt draft says "all 10 done, stage it now" for every message.
    const intakeNote = !tactplanId && (doneFields.length || missingFields.length)
      ? `\n\nNEW CAMPAIGN INTAKE STATE (authoritative, rebuilt fresh this turn from record_new_campaign_field calls — trust this over your own memory of the conversation): already recorded — ${doneFields.length ? doneFields.map(f => `${f}=${JSON.stringify(draft[f])}`).join(', ') : '(none yet)'}. Still missing — ${missingFields.length ? missingFields.join(', ') : '(none — all 10 done, call propose_new_campaign now)'}. If you are in the New Campaign Intake flow, ask ONLY for the first field listed under "still missing", in that order, and do not ask about anything already listed under "already recorded" even if it resembles a field that IS still missing (e.g. "brand" and "brandedUnbranded" are different fields — check this list, not your guess).`
      : '';

    const turn = await runAgentTurn({
      system: (await buildSystemPrompt()) + portfolioNote + myPendingNote + workflowNote + guidedModeNote + intakeNote,
      tools: buildToolDeclarations(),
      messages,
      execute: executeTool,
      ctx,
      send,
      onResult: (name, result) => {
        if (name === 'propose_fill' && result?.proposed) send('proposal', result);
        // One card per section, each flagged `derived` so the client can label
        // it as inferred rather than as something the user just typed.
        if (name === 'propose_derived_fills' && result?.proposed) {
          (result.groups || []).forEach(g => send('proposal', { ...g, derived: true }));
        }
        if (name === 'learn_skill' && result?.learned) send('learned', result);
        if (name === 'navigate_stage' && result?.navigated) send('navigate', result);
        if (name === 'open_campaign' && result?.navigated) send('open_campaign', result);
        if (name === 'propose_new_campaign' && result?.proposed) send('new_campaign_proposal', result);
        if (name === 'notify_stakeholders' && result?.notified) send('notify_stakeholders', result);
        if (name === 'ask_choice' && result?.asked) {
          // Verified live, repeatedly: the model reaches for ask_choice on
          // short-answer-set questions (brand, indication, Branded/
          // Unbranded, ...) even with an explicit "unguided means unguided,
          // never call ask_choice" instruction in the system prompt right
          // above it — prompt-only enforcement of this kept failing the
          // same way the intake field-tracking did. Enforced deterministically
          // instead: when the UI's Guided Mode toggle is off, the button UI
          // never reaches the client at all, regardless of what the model
          // decided to call — downgraded to the same plain-text event a
          // normal reply uses, options included, phrased as a sentence.
          if (guidedMode) {
            send('ask_choice', result);
          } else {
            const optionsText = result.options.length ? ` (${result.options.join(' / ')})` : '';
            send('reasoning', { text: `${result.question}${optionsText}` });
          }
        }
        if (name === 'record_quiz_answer' && result?.applied) send('quiz_answer', result);
        if (name === 'record_new_campaign_field' && result?.recorded) send('new_campaign_field', result);
      },
    });

    send('final', { text: turn.finalText });
    send('history', { history: turn.messages });
    res.end();
  } catch (err) {
    console.error('[server] Agent turn failed:', err);
    send('error', { error: 'Agent turn failed.', detail: String(err.message || err) });
    res.end();
  }
});

// ===========================================================================
// Home agent — the assistant on the campaign-hub screen. No request is open
// there, so it has no form to fill: its job is to answer across the whole
// portfolio and to open the campaign the user is asking about. Deliberately a
// single non-streaming turn rather than the SSE tool loop, because it reasons
// over one small array the client already has in memory; there is nothing to
// look up and nothing to stage, so streaming would add machinery for no gain.
// ===========================================================================
const HOME_SYSTEM_PROMPT = `You are the Novartis Accelerate assistant on the campaign hub — the screen listing every campaign request. If asked what you are, answer as the platform's assistant; never describe yourself as a large language model or name the vendor behind you.

You are given the user's role and a JSON array of every campaign request: id (the TactPlan ID), name, brand, phase, assignedToMe, yourAction, owners. That array is ALL you know. It is portfolio-level only — it does NOT contain the individual form field values inside a campaign.

What you do:
- Answer questions about the portfolio: what needs their input, what's in which phase, what's assigned to them, which brands are in flight. Ground every answer in the array; never invent a campaign, a date, or a status.
- When the user names or clearly points at one campaign ("open Kisqali", "the Cosentyx one", "TP-88213"), resolve it to that request's id and return it so the platform can open it.
- If a question needs detail inside a campaign (specific field values, what's filled in), say plainly that you'd need to open that campaign first, and offer to open it.
- If nothing matches what they asked for, say so rather than guessing at the nearest campaign.

How to write:
- The chat renders markdown. Use a short lead-in line, then a bullet list when naming more than two campaigns, with the campaign name in **bold**. Keep it to a few sentences plus the list. No headings, no tables.
- Never use an em dash. Use a regular hyphen.

NEW CAMPAIGN INTAKE. When an "intake" object is present, you are collecting the details needed to create a campaign request, and that is your only job for the turn. It gives you: fields (id, label, hint, options), values collected so far, derived (things the platform worked out itself), and missing (the field ids still needed).

- Ask for the FIRST field in "missing", one field per turn. Name it in **bold**, add a short plain-English line about what it is. If it has options, list them.
- Read the user's reply generously. If they answer more than you asked ("it's branded, for HCPs in oncology"), capture all of it. If their answer is unusable for the field you asked about, say why and ask again rather than guessing.
- Put everything you understood into "captured", keyed by field id. For a field with options, the value MUST be one of those options verbatim. Never put a value in "captured" that the user did not give you.
- If "derived" contains an entry, the platform already worked that field out. Say so in one short sentence with the reason given, do not ask for it, and move to the next missing field in the same reply.
- When the message is the literal [[intake:start]], that is the user clicking "Start a new campaign", not something they typed. Open with one short line saying you'll take them through it, then ask the first field. Do not echo the sentinel.
- Do not announce that the campaign has been created. The platform creates it once every field is in and tells the user itself.

Reply with ONLY a JSON object, no prose around it, no code fence:
{"text": "<your reply in markdown>", "open": "<TactPlan id to open, or null>", "captured": {"<field id>": "<value>"}}
Set "open" only when the user actually wants to go to that campaign now, not merely because you mentioned it. Include "captured" only during an intake; leave it out otherwise.`;

app.post('/api/home-agent', async (req, res) => {
  const { text, history, requests, persona, intake } = req.body || {};
  if (!ai) return res.status(503).json({ error: 'ANTHROPIC_FOUNDRY_API_KEY / ANTHROPIC_FOUNDRY_RESOURCE not configured on the server.' });
  if (!text) return res.status(400).json({ error: 'text is required.' });

  const list = Array.isArray(requests) ? requests : [];
  const messages = (Array.isArray(history) ? history : []).concat([{
    role: 'user',
    content: `Viewing as: ${persona || 'unknown role'}\n`
      + `Campaign requests:\n${JSON.stringify(list)}\n`
      + (intake ? `\nintake:\n${JSON.stringify(intake)}\n` : '')
      + `\nMessage: ${text}`,
  }]);

  try {
    const response = await ai.messages.create({
      model: MODEL, max_tokens: 1400, system: HOME_SYSTEM_PROMPT, messages,
    });
    const raw = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();

    // The model is asked for bare JSON, but occasionally wraps it in a fence or
    // a sentence. Recover the object rather than failing the turn over syntax.
    let parsed = null;
    try { parsed = JSON.parse(raw); }
    catch { const m = raw.match(/\{[\s\S]*\}/); if (m) { try { parsed = JSON.parse(m[0]); } catch {} } }

    const reply = parsed && typeof parsed.text === 'string' ? parsed.text : raw;
    // Only honour an id that actually exists in what the client sent — the
    // model must never be able to navigate somewhere that isn't on this list.
    const wanted = parsed && parsed.open ? String(parsed.open) : null;
    const open = wanted && list.some(r => r.id === wanted) ? wanted : null;

    res.json({
      text: reply, open,
      captured: parsed && parsed.captured && typeof parsed.captured === 'object' ? parsed.captured : null,
      history: messages.concat([{ role: 'assistant', content: response.content }]),
    });
  } catch (err) {
    console.error('[server] Home agent turn failed:', err);
    res.status(500).json({ error: 'Agent turn failed.', detail: String(err.message || err) });
  }
});

// ===========================================================================
// Visio Diagram agent — same real agentic-loop shape as /api/agent-fill
// above (one model, real tool calls, SSE per-step events), pointed at the
// AI-driven diagram editor instead of the form. The graph (nodes/edges) is
// NOT persisted server-side or in the database: the client is the source of
// truth (see hqe-requirement-studio-mock_2.html's diagramGraph/localStorage),
// exactly like the old flow-canvas data before it and like TactPlan/brand
// data elsewhere in this app — "Google Drive" here is a realistic mock, not
// a real Drive API integration (no OAuth/credentials exist in this project).
// The model never mutates the graph directly: propose_diagram_edit only
// resolves and validates operations against the graph the client sent this
// turn; the client stages them as a "Preview Changes" card and only mutates
// its own state once the user clicks Apply — same separation as
// propose_fill/confirmFillProposal.
// ===========================================================================
const DIAGRAM_SYSTEM_PROMPT = `You are the Diagram Chat for Novartis Accelerate's AI-driven Visio journey-diagram editor. Users describe edits in plain language; you translate them into structured graph operations. You are NOT a general chatbot — stay focused on the diagram.

The canvas uses exactly these node types (shapes are fixed, do not invent new ones):
- "process": rectangle, yellow fill — a normal campaign step (e.g. "Email 1", "Send Welcome Email").
- "decision": diamond, orange outline — a yes/no branch (e.g. "Valid Email?", "Age > 18?").
- "start" / "end": rounded pill, purple outline — the journey's start or terminal/stop node.
- "datasource": cylinder — a data source (e.g. "Enrollment Source", "Opt-in Database", "CRM"). Never use "process" for a data source — the cylinder shape is meaningful to users, always preserve it.
- "infobox": blue rectangle — informational blocks (e.g. "Campaign Information", "Segment", "Metadata").

Nodes may also carry a "status" for the legend dot: "production" (green, live), "new" (yellow), "hold" (red, on hold), "inactive" (grey, never turned on). Only set status if the user's request implies one — do not invent one.

You have one tool: propose_diagram_edit(summary, operations). It does NOT change anything itself — it only stages a preview the user must click Apply on. ALWAYS call this tool for any request that changes the diagram (move/delete/rename/add/connect/recolor/reshape/auto-layout) — never claim you made a change without calling it. If the user asks a read-only question about the diagram (e.g. "what's connected to Email 2?"), answer directly from the graph JSON you were given instead of calling the tool.

Each item in "operations" is one of:
- {op:"add_node", type, label, afterNodeId?, position?("above"|"below"|"left"|"right"), status?} — afterNodeId/position anchor the new node relative to an existing node (by id or label text); omit both to place it near the canvas center. connectFrom defaults to true (auto-wires an edge to the anchor).
- {op:"move_node", nodeId, relativeTo, position("above"|"below"|"left"|"right")} — nodeId/relativeTo may be a node id OR its label text.
- {op:"delete_node", nodeId}
- {op:"rename_node", nodeId, label}
- {op:"recolor_node", nodeId, fillColor?, borderColor?, status?} — colors are CSS hex strings.
- {op:"set_shape", nodeId, shape} — shape is one of the five types above.
- {op:"add_edge", from, to, label?}
- {op:"delete_edge", from, to}
- {op:"auto_layout"} — reorganizes spacing/alignment/routing, preserving logical order.

Rules:
- nodeId/from/to/relativeTo/afterNodeId may reference a node by its exact id (e.g. "d3") OR by matching/substring-matching its label — you do not need to know the real id, the server resolves it against the graph you were given.
- A multi-step request (e.g. "add a decision after Email 3; if yes continue to Email 4, if no resend after 5 days") should become several operations in ONE propose_diagram_edit call, not one call per step.
- If the graph is empty and the user describes a whole journey, emit a full sequence of add_node (+ add_edge as needed) operations bootstrapping it — the client auto-arranges a first-time population, so exact x/y is not your concern (there is no x/y in this schema).
- Before calling the tool, output exactly one short, plain sentence stating what you're about to do — no chit-chat, no first-person filler.
- Keep the "summary" argument short (one line) — it is shown as the preview card's headline.`;

function buildDiagramToolDeclarations() {
  return [
    {
      name: 'propose_diagram_edit',
      description: 'Stage one or more diagram graph operations for the user to preview and apply. Does not mutate the diagram itself.',
      input_schema: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'One-line description of the overall edit, shown as the preview card headline.' },
          operations: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                op: { type: 'string', enum: ['add_node', 'move_node', 'delete_node', 'rename_node', 'recolor_node', 'set_shape', 'add_edge', 'delete_edge', 'auto_layout'] },
                nodeId: { type: 'string' },
                type: { type: 'string', enum: ['process', 'decision', 'start', 'end', 'datasource', 'infobox'] },
                shape: { type: 'string', enum: ['process', 'decision', 'start', 'end', 'datasource', 'infobox'] },
                label: { type: 'string' },
                status: { type: 'string', enum: ['production', 'new', 'hold', 'inactive'] },
                afterNodeId: { type: 'string' },
                relativeTo: { type: 'string' },
                position: { type: 'string', enum: ['above', 'below', 'left', 'right'] },
                connectFrom: { type: 'boolean' },
                fillColor: { type: 'string' },
                borderColor: { type: 'string' },
                from: { type: 'string' },
                to: { type: 'string' },
              },
              required: ['op'],
            },
          },
        },
        required: ['summary', 'operations'],
      },
    },
  ];
}

// Resolves a node reference (id, exact label, or substring of label) against
// the graph the client sent this turn — the model is told it may reference
// nodes by label text, so this has to actually work, not just pass ids through.
function resolveDiagramNodeRef(graph, ref) {
  if (!ref) return null;
  const nodes = graph.nodes || [];
  return nodes.find(n => n.id === ref)
    || nodes.find(n => (n.label || '').toLowerCase() === String(ref).toLowerCase())
    || nodes.find(n => (n.label || '').toLowerCase().includes(String(ref).toLowerCase()))
    || null;
}

// Executed server-side, for real — validates/resolves operations against the
// actual graph rather than trusting the model's node references verbatim,
// same "deterministic where it matters" approach as match_section above.
async function executeDiagramTool(name, args, ctx) {
  if (name !== 'propose_diagram_edit') return { error: `Unknown tool "${name}".` };
  const graph = ctx.graph || { nodes: [], edges: [] };
  const ops = Array.isArray(args.operations) ? args.operations : [];
  const resolved = [];
  for (const op of ops) {
    if (!op || !op.op) continue;
    const out = { ...op };
    // For add_node, anchors are optional and may legitimately not resolve
    // (a brand-new empty graph) — leave as literal text, client falls back
    // to a default position. For every other op, an unresolved reference
    // means the edit can't be applied, so it's dropped rather than silently
    // operating on the wrong node.
    if (['move_node', 'delete_node', 'rename_node', 'recolor_node', 'set_shape'].includes(op.op)) {
      const n = resolveDiagramNodeRef(graph, op.nodeId);
      if (!n && graph.nodes.length) continue; // known graph, unresolved ref — skip
      if (n) out.nodeId = n.id;
    }
    if (op.op === 'move_node') {
      const anchor = resolveDiagramNodeRef(graph, op.relativeTo);
      if (anchor) out.relativeTo = anchor.id;
    }
    if (op.op === 'add_node' && (op.afterNodeId || op.relativeTo)) {
      const anchor = resolveDiagramNodeRef(graph, op.afterNodeId || op.relativeTo);
      if (anchor) { out.afterNodeId = anchor.id; delete out.relativeTo; }
    }
    if (op.op === 'add_edge' || op.op === 'delete_edge') {
      const a = resolveDiagramNodeRef(graph, op.from), b = resolveDiagramNodeRef(graph, op.to);
      if (a) out.from = a.id;
      if (b) out.to = b.id;
    }
    resolved.push(out);
  }
  if (!resolved.length) return { error: 'No operations could be resolved against the current diagram.' };
  return { proposed: true, summary: args.summary || 'Proposed diagram edit', operations: resolved };
}

// SSE agent loop for the Diagram Chat — same event shape as /api/agent-fill
// (reasoning/tool_start/tool/proposal/final/error/history) so the client's
// existing SSE parsing pattern (see vbSendChat) needed no new plumbing.
app.post('/api/visio-agent', async (req, res) => {
  const { graph, text, history, tactplanId } = req.body || {};
  if (!ai) return res.status(503).json({ error: 'ANTHROPIC_FOUNDRY_API_KEY / ANTHROPIC_FOUNDRY_RESOURCE not configured on the server.' });
  if (!text) return res.status(400).json({ error: 'text is required.' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const ctx = { graph: graph && graph.nodes ? graph : { nodes: [], edges: [] }, tactplanId: tactplanId || null };

  try {
    // The graph is sent inline with the message (not just in a tool result)
    // so the model can answer read-only questions without needing a tool
    // round-trip, and so it always has real current node ids/labels to
    // reference even on the very first turn.
    const messageWithGraph = `Current diagram graph (JSON):\n${JSON.stringify(ctx.graph)}\n\nUser message: ${text}`;
    const messages = (Array.isArray(history) ? history : []).concat([{ role: 'user', content: messageWithGraph }]);

    const turn = await runAgentTurn({
      system: DIAGRAM_SYSTEM_PROMPT,
      tools: buildDiagramToolDeclarations(),
      messages,
      execute: executeDiagramTool,
      ctx,
      send,
      onResult: (name, result) => {
        if (name === 'propose_diagram_edit' && result?.proposed) send('proposal', result);
      },
    });

    send('final', { text: turn.finalText });
    send('history', { history: turn.messages });
    res.end();
  } catch (err) {
    console.error('[server] Diagram agent turn failed:', err);
    send('error', { error: 'Diagram agent turn failed.', detail: String(err.message || err) });
    res.end();
  }
});

// Flow Planner routes live in stateless.js (shared with the Vercel function).
registerStateless(app, { ai, model: MODEL });

// Phase 0 pipe check for the new React client (accelerate-app/client) — used
// by its bare-shell App.tsx to confirm the dev proxy / production build
// actually reaches this server before any real UI is ported over.
// Campaign Studio (redesigned NORA UI) — see studio-routes.js.
require('./studio-routes').register(app, prisma, { ai, model: MODEL, extractFileText });

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'novartis-accelerate-server' });
});

// Final cutover: the React client (client/) is the real app now — every
// page has been ported and verified live against this same server this
// session. public/index.html (the original single-file monolith) is kept
// in the repo as reference/backup but is no longer served.
app.use(express.static(path.join(__dirname, '..', 'client', 'dist')));

// SPA fallback — React Router owns client-side routes (/requests/:id,
// /calendar, /admin, ...), which don't correspond to real files on disk.
// Without this, a direct load or refresh on any route but "/" 404s at the
// Express layer before React ever gets a chance to render. Must come AFTER
// every API route and the static middleware above (so real API 404s and
// real static assets are never swallowed by this), and only responds to
// GET (POST/PUT/DELETE with no matching route should still 404 normally).
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, '..', 'client', 'dist', 'index.html'));
});

const PORT = process.env.PORT || 4300;
app.listen(PORT, () => console.log(`Novartis Accelerate server running on http://localhost:${PORT}`));
