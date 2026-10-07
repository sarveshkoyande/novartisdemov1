// Campaign Studio routes — the backend for the redesigned NORA intake UI
// (client/src/studio). Three jobs:
//   1. Persist each studio campaign's planning state (StudioCampaign table).
//   2. Turn uploaded material (PDF/Word/Excel + notes) into campaign field
//      values, so "Mapped from your material" in the review screen is real.
//   3. Map a NORA chat message onto campaign fields with Claude.
// The client keeps a deterministic local mapper as a fallback, so both AI
// routes answer 503 (not a fake result) when no model is configured.
const multer = require('multer');
const schema = require('./studio/campaign-schema.json');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 10 } });

// Fields NORA may write, by planning section. Mirrors groups in
// client/src/studio/planningModel.ts; inherited Touchpoint fields 45–47 are
// derived client-side and never set directly.
const SECTION_IDS = {
  Contact: ['1', '2', '3', '4', '5', '6', '7', '8', '9'],
  // 19 (Campaign Code) is deliberately absent: OMS provides it, never NORA.
  General: ['10', '11', '12', '13', '14', '15', '16', '17', '18', '20', '20.1', '20.2', '21', '22', '22.1', '22.2', '23', '24', '24.1', '25', '26', '27', '28', '29', '30', '31'],
  Email: ['32', '33', '34', '35', '36', '37', '38', '38.1', '39', '40', '41', '42', '43', '43.1', '43.2', '43.3', '43.4', '44', '44.2', '44.3'],
  Touchpoint: ['48', '49', '49.1'],
};
const byId = Object.fromEntries(schema.fields.map((f) => [f.id, f]));

function fieldCatalog() {
  return Object.entries(SECTION_IDS).map(([section, ids]) =>
    `## ${section}${['Email', 'Touchpoint'].includes(section) ? ' (repeating — one per email; use index)' : ''}\n` +
    ids.filter((id) => byId[id]).map((id) => `- ${id}: ${byId[id].field} — ${byId[id].control}. ${byId[id].rules}`).join('\n'),
  ).join('\n\n');
}

const RECORD_TOOL = {
  name: 'record_fields',
  description: 'Record campaign field values that the user material or message explicitly states.',
  input_schema: {
    type: 'object',
    properties: {
      values: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            section: { type: 'string', enum: Object.keys(SECTION_IDS) },
            index: { type: 'integer', description: 'Zero-based email/touchpoint index. 0 for General and Contact.' },
            id: { type: 'string', description: 'Field id from the catalog, e.g. "10" or "20.1".' },
            value: { type: 'string', description: 'Value as stated. Use "Pending" when the text says it is pending/unknown/TBD. Use "Yes"/"No" for yes/no fields. Dates as YYYY-MM-DD.' },
          },
          required: ['section', 'index', 'id', 'value'],
        },
      },
      reply: { type: 'string', description: 'A short note to a campaign manager in plain, friendly language. Two or three short paragraphs separated by a blank line: (1) what you captured, in at most two short sentences that summarise by area (campaign details, project team, emails, touchpoints) rather than listing every detail — no field numbers or ids, no jargon; (2) the details you could not find, named in everyday words in one short sentence. Do not say who will provide them — the app shows that separately; (3) only if relevant, one short caveat such as a known source conflict. No lists, no markdown, no question marks.' },
    },
    required: ['values', 'reply'],
  },
};

function systemPrompt(emailCount) {
  return `You are NORA, the Requirement Collection Agent for a pharmaceutical campaign intake tool.
Extract ONLY values that the text explicitly states. Never invent values, options, people, IDs or dates.
TACTPlan ID is a manual identifier: record it only if literally present. Never record the Campaign Code: it is provided by OMS, not by the user, even if the text contains one.
For single-select fields, use one of the values listed in the rules when the text clearly matches; otherwise record the text as given.
The campaign currently has ${emailCount} email(s). Email/Touchpoint index 0 is "Email 01". If the text mentions an email beyond the current count, still record it — the client will add it. If the text states a number of emails, record field 24.
Field catalog:
${fieldCatalog()}`;
}

async function mapWithClaude(ai, model, text, emailCount, contextLine) {
  const response = await ai.messages.create({
    model,
    max_tokens: 4000,
    system: systemPrompt(emailCount),
    tools: [RECORD_TOOL],
    tool_choice: { type: 'tool', name: 'record_fields' },
    messages: [{ role: 'user', content: `${contextLine}\n\n<text>\n${text.slice(0, 60000)}\n</text>` }],
  });
  const call = response.content.find((b) => b.type === 'tool_use');
  const input = call?.input || {};
  const values = (Array.isArray(input.values) ? input.values : []).filter((v) =>
    v && SECTION_IDS[v.section]?.includes(String(v.id)) && String(v.value || '').trim(),
  ).map((v) => ({ section: v.section, index: Math.max(0, Number(v.index) || 0), id: String(v.id), value: String(v.value).trim() }));
  return { values, reply: String(input.reply || '') };
}

function toJson(row) {
  return { id: row.id, brand: row.brand, title: row.title, stage: row.stage, state: JSON.parse(row.stateJson), createdAt: row.createdAt, updatedAt: row.updatedAt };
}

function register(app, prisma, { ai, model, extractFileText }) {
  // Brand discovery list — the same BrandIndication master the rest of the
  // app uses, flattened to one row per brand + indication.
  app.get('/api/studio/brands', async (req, res) => {
    const rows = await prisma.brandIndication.findMany({ orderBy: [{ brand: 'asc' }, { indication: 'asc' }] });
    res.json({ brands: rows.map((r) => ({ name: r.brand, indication: r.indication, therapeuticArea: r.therapeuticArea, branded: r.brandedUnbranded })) });
  });

  app.get('/api/studio/campaigns', async (req, res) => {
    const rows = await prisma.studioCampaign.findMany({ orderBy: { updatedAt: 'desc' } });
    res.json({ campaigns: rows.map(toJson) });
  });

  app.get('/api/studio/campaigns/:id', async (req, res) => {
    const row = await prisma.studioCampaign.findUnique({ where: { id: req.params.id } });
    if (!row) return res.status(404).json({ error: 'Campaign not found.' });
    res.json({ campaign: toJson(row) });
  });

  app.post('/api/studio/campaigns', async (req, res) => {
    const { brand, state } = req.body || {};
    if (!brand || !state) return res.status(400).json({ error: 'brand and state are required.' });
    const row = await prisma.studioCampaign.create({ data: { brand, title: '', stage: 'upload', stateJson: JSON.stringify(state) } });
    res.json({ campaign: toJson(row) });
  });

  app.put('/api/studio/campaigns/:id', async (req, res) => {
    const { state, stage, title, brand } = req.body || {};
    if (!state) return res.status(400).json({ error: 'state is required.' });
    try {
      const row = await prisma.studioCampaign.update({
        where: { id: req.params.id },
        data: { stateJson: JSON.stringify(state), ...(stage ? { stage } : {}), ...(title !== undefined ? { title: String(title) } : {}), ...(brand ? { brand: String(brand) } : {}) },
      });
      res.json({ campaign: toJson(row) });
    } catch {
      res.status(404).json({ error: 'Campaign not found.' });
    }
  });

  app.delete('/api/studio/campaigns/:id', async (req, res) => {
    await prisma.studioCampaign.deleteMany({ where: { id: req.params.id } });
    res.json({ ok: true });
  });

  // Upload screen: parse every file to text, then (when a model is
  // configured) map the combined text onto fields. Always returns the
  // extracted text so the client can fall back to its local mapper.
  app.post('/api/studio/extract', upload.array('files'), async (req, res) => {
    const notes = String(req.body?.notes || '');
    const parts = [];
    const failed = [];
    for (const file of req.files || []) {
      try {
        parts.push(`### ${file.originalname}\n${await extractFileText(file.buffer, file.originalname)}`);
      } catch (err) {
        failed.push({ name: file.originalname, error: String(err.message || err) });
      }
    }
    if (notes.trim()) parts.push(`### Notes\n${notes}`);
    const text = parts.join('\n\n');
    if (!ai || !text.trim()) return res.json({ text, failed, values: [], reply: '', ai: false });
    try {
      const result = await mapWithClaude(ai, model, text, Number(req.body?.emailCount) || 0, 'Campaign material supplied by the Delivery Manager:');
      res.json({ text, failed, ...result, ai: true });
    } catch (err) {
      console.error('[studio] extract mapping failed:', err.message || err);
      res.json({ text, failed, values: [], reply: '', ai: false });
    }
  });

  // NORA conversation turn.
  app.post('/api/studio/nora', async (req, res) => {
    const { text, section, emailCount } = req.body || {};
    if (!text) return res.status(400).json({ error: 'text is required.' });
    if (!ai) return res.status(503).json({ error: 'No model configured.' });
    try {
      res.json(await mapWithClaude(ai, model, String(text), Number(emailCount) || 0, `The user is working in the ${section || 'General'} section. Unqualified email/touchpoint details refer to the active object.`));
    } catch (err) {
      console.error('[studio] nora mapping failed:', err.message || err);
      res.status(502).json({ error: String(err.message || err) });
    }
  });
}

module.exports = { register };
