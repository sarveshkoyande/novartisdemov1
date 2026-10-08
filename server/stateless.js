// Stateless server logic, shared by the local Express server (server.js) and the
// Vercel function (api/index.js): reading uploaded documents, and the Flow Planner
// generator / chat-edit / Visio export. Nothing here touches the database.
const mammoth = require('mammoth');
const XLSX = require('xlsx');
const JSZip = require('jszip');

// Parse an uploaded PDF / Word (.docx) / Excel (.xlsx/.xls/.csv) to plain
// text so the chat agent can read a pasted brief the same way it reads a
// typed message. Extension-driven (mimetypes are unreliable across browsers).
async function extractFileText(buffer, filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  if (ext === 'pdf') {
    // Loaded on demand: it pulls in a native graphics module that can fail to start on some hosts.
    const { PDFParse } = require('pdf-parse');
    const parser = new PDFParse({ data: buffer });
    const res = await parser.getText();
    return res.text || '';
  }
  if (ext === 'docx' || ext === 'doc') {
    const res = await mammoth.extractRawText({ buffer });
    return res.value || '';
  }
  if (ext === 'xlsx' || ext === 'xls' || ext === 'csv') {
    const wb = XLSX.read(buffer, { type: 'buffer' });
    // Flatten every sheet to CSV-ish text, sheet name as a header, so
    // structured cells survive as readable rows the model can interpret.
    return wb.SheetNames.map(name => `### Sheet: ${name}\n${XLSX.utils.sheet_to_csv(wb.Sheets[name])}`).join('\n\n');
  }
  if (ext === 'pptx') return pptxText(buffer);
  if (ext === 'txt' || ext === 'md') return buffer.toString('utf8');
  if (ext === 'ppt') throw new Error('Legacy .ppt files cannot be read. Save the deck as .pptx and upload it again.');
  throw new Error(`Unsupported file type ".${ext}". Upload a PDF, Word (.docx), PowerPoint (.pptx), Excel (.xlsx/.csv) or text (.txt) file.`);
}

// PowerPoint (.pptx) is a zip of slide XML: read each slide's text runs
// (<a:t>) in slide order, paragraph by paragraph, plus its speaker notes, so a
// briefing deck reads like a document with one "### Slide N" section each.
async function pptxText(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const num = (name) => Number(name.match(/(\d+)\.xml$/)[1]);
  const unescape = (t) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const textOf = (xml) => xml.split(/<\/a:p>/)
    .map((p) => [...p.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => unescape(m[1])).join('').trim())
    .filter(Boolean).join('\n');
  const slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => num(a) - num(b));
  const parts = [];
  for (const name of slides) {
    const n = num(name);
    const body = textOf(await zip.file(name).async('string'));
    const notesFile = zip.file(`ppt/notesSlides/notesSlide${n}.xml`);
    const notes = notesFile ? textOf(await notesFile.async('string')) : '';
    parts.push(`### Slide ${n}\n${body}${notes ? `\nSpeaker notes: ${notes}` : ''}`);
  }
  return parts.join('\n\n');
}

// Registers the Flow Planner routes. `ai` is the Claude client (or null when no key is set).
function register(app, { ai, model: MODEL }) {
  // Flow Planner: generates the SOP Segmentation-region diagram (rows 1-9)
  // straight from a campaign's own flow-planner inputs, ported from the
  // campaign-accelerator-api reference project's app/flow + app/drawing +
  // app/visio modules. Stateless by design — inputs live client-side in
  // useFlowPlannerStore, same pattern as useVisioStore/useTimelineStore, so
  // this route is just a pure function over whatever the client sends.
  const flowPlanner = require('./segmentation');

  app.post('/api/flow-planner/generate', (req, res) => {
    try {
      const inputs = req.body || {};
      const spec = flowPlanner.generate(inputs);
      const svg = flowPlanner.svgFor(inputs);
      // Whatever code any brand-new block just received (see codeMapFor) has
      // to be saved back onto the campaign's own inputs, or the next
      // generation would assign that same node a different number — the
      // caller persists this alongside the svg/spec.
      const codeAssignments = flowPlanner.codeMapFor(inputs);
      res.json({ spec, svg, codeAssignments });
    } catch (err) {
      console.error('[server] Flow Planner generate failed:', err);
      res.status(500).json({ error: 'Flow Planner generation failed.', detail: String(err.message || err) });
    }
  });

  app.post('/api/flow-planner/vsdx', async (req, res) => {
    try {
      const inputs = req.body || {};
      const buffer = await flowPlanner.vsdxFor(inputs);
      const filename = `${(inputs.campaignName || 'segmentation-flow').replace(/[^a-z0-9-]+/gi, '-')}.vsdx`;
      res.setHeader('Content-Type', 'application/vnd.ms-visio.drawing');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(buffer);
    } catch (err) {
      console.error('[server] Flow Planner vsdx export failed:', err);
      res.status(500).json({ error: 'Flow Planner .vsdx export failed.', detail: String(err.message || err) });
    }
  });

  // Chat-driven editing of the Flow Planner's own inputs (the fields
  // FlowPlannerPanel shows — audience, campaign identity, enrollment sources,
  // segments, the unbranded fork, suppression answers) — the Solution
  // Architect's plain-English edit ("set audience to HCP", "add a segment
  // called PsO Bio Naive") is turned into a patch on those fields via one
  // forced tool call, rather than a bare-keyword parser. This is a distinct
  // data model from the old canvas-based /api/visio-agent above (which edited
  // an mxGraph-style node/edge graph that no longer exists in this UI) — that
  // endpoint has no live caller left; this one is what the Flow tab's chat
  // edit commands actually reach now.
  function flowPlannerEditTool() {
    return {
      name: 'update_flow_planner_inputs',
      description: "Apply the user's requested change(s) to the Flow Planner's segmentation inputs. Only include fields the user actually asked to change — omit everything else so it's left untouched.",
      input_schema: {
        type: 'object',
        properties: {
          audience: { type: 'string', enum: ['DTC', 'HCP', ''], description: 'Leave out unless the user asked to change audience.' },
          campaignName: { type: 'string' },
          campaignCode: { type: 'string' },
          campaignType: { type: 'string', description: 'e.g. Ad Hoc, Cadenced, Automation, Model based, Real-time' },
          goal: { type: 'string' },
          segments: { type: 'string', description: 'Comma-separated segment names. If the user asks to ADD a segment, include the full resulting list, not just the new one.' },
          qna: { type: 'string', description: 'Survey / metadata sheet QnA text.' },
          metadataSheet: { type: 'string' },
          enrollmentSources: {
            type: 'array',
            description: 'The full resulting list of enrollment sources if the user asked to add/change/remove one — not just the changed entry.',
            items: {
              type: 'object',
              properties: { name: { type: 'string' }, code: { type: 'string' }, qna: { type: 'string' } },
              required: [],
            },
          },
          unbrandedPresent: { type: 'boolean', description: 'Whether the campaign goal requires capture from an unbranded source.' },
          unbrandedCampaignCode: { type: 'string' },
          unbrandedLastTouchpointQuestion: { type: 'string' },
          unbrandedAnswerCodes: { type: 'string', description: 'Comma-separated answer codes.' },
          businessRules: { type: 'string', description: 'Additional MDS business-rules suppression answer.' },
          specialtyInclusion: { type: 'string' },
          specialtyExclusion: { type: 'string' },
          // Most printed blocks (suppression checks, Dedupe, the QnA blocks)
          // have no underlying input field at all — a check like "Age 18+?" is
          // fixed SOP boilerplate, not derived from anything the campaign
          // record states. Editing THOSE only works by overriding the block
          // directly, addressed by the code printed on the diagram (B1, B2,
          // ...), which the system prompt below lists for the current design.
          blockCode: { type: 'string', description: 'The printed block code (e.g. "B12") the user referred to — set this whenever they mention a block by its code rather than by field name.' },
          blockText: { type: 'string', description: "The block's new text, when editing by blockCode." },
          deleteBlockCode: { type: 'string', description: 'Set this INSTEAD of blockCode/blockText when the user asks to delete/remove a block. The block is removed and its neighbours on the diagram are connected directly to each other.' },

          // --- adding a new block --------------------------------------
          addBlockLabel: { type: 'string', description: 'Set this to add a brand-new block to the diagram. Its short title, as it should appear on the block.' },
          addBlockDetail: { type: 'string', description: 'The new block\'s body text, if the user gave one.' },
          addBlockDecision: { type: 'boolean', description: 'True if the user described this as a yes/no check or decision (e.g. "ask whether X") — draws it as a diamond.' },
          addBlockType: { type: 'string', enum: ['entry', 'datasource', 'process', 'decision', 'segment', 'stop', 'exit', 'note'], description: 'Explicit shape, if the user\'s wording implies one (e.g. "add a stop" or "add a data source") — overrides addBlockDecision.' },
          addBlockStatus: { type: 'string', enum: ['live', 'new', 'hold', 'built_not_live'], description: 'Legend colour for the new block, only if the user asked for one.' },
          addBlockAfterCode: { type: 'string', description: 'An existing block\'s code (e.g. "B5") the new block connects downstream from. The new block takes over whatever that block used to connect to — this is how "add X after B5" or "insert X between B5 and B7" both work; for the latter also see addBlockBeforeCode.' },
          addBlockBeforeCode: { type: 'string', description: 'Use together with addBlockAfterCode to place the new block precisely between two SPECIFIC existing blocks that are already directly connected, rather than however addBlockAfterCode\'s block currently connects onward.' },
          addBlockBranch: { type: 'string', enum: ['down', 'side'], description: 'Set to "side" when the new block is a branch off the main line rather than a continuation of it — a "No"/rejection arm, an alternate path, anything the user describes as branching off sideways. Draws it beside addBlockAfterCode\'s block instead of below it, the same way the diagram\'s existing Stop pills sit beside a suppression check. Defaults to "down".' },

          // --- swap / recolour / branch / raw connect ---------------------
          swapBlockCodeA: { type: 'string', description: 'Set together with swapBlockCodeB to swap what two existing blocks show (their text and shape trade places; their position and connections do not move).' },
          swapBlockCodeB: { type: 'string' },
          recolorBlockCode: { type: 'string', description: 'An existing block to recolour.' },
          recolorStatus: { type: 'string', enum: ['live', 'new', 'hold', 'built_not_live'], description: 'The legend colour to apply — these are the only four colours the diagram\'s own legend defines, so map the user\'s request to whichever is closest (e.g. green/done -> live, amber/new -> new, red/off -> hold, grey/inactive -> built_not_live) rather than inventing a colour.' },
          setBranchBlockCode: { type: 'string', description: 'An EXISTING block to move to the side (branch) or back onto the main line — e.g. "make B6 branch off to the side" or "put B6 back on the main line".' },
          setBranchDirection: { type: 'string', enum: ['down', 'side'], description: 'Required together with setBranchBlockCode.' },
          connectFromCode: { type: 'string', description: 'Set together with connectToCode to draw a new connection between two existing blocks that are not already connected, without moving or removing anything else.' },
          connectToCode: { type: 'string' },
          connectLabel: { type: 'string', description: 'Optional label on the new connection (e.g. "Yes").' },
          disconnectFromCode: { type: 'string', description: 'Set together with disconnectToCode to remove one specific existing connection, without deleting either block.' },
          disconnectToCode: { type: 'string' },

          summary: { type: 'string', description: 'One short, friendly sentence confirming what was changed, to show the user in chat. Required even if nothing was changed (explain why, e.g. the request was unclear, or a block code does not exist on the current diagram).' },
        },
        required: ['summary'],
      },
    };
  }

  function findBlock(currentInputs, code) {
    if (!code) return null;
    return flowPlanner.blocks(currentInputs || {}).find((b) => b.code.toLowerCase() === String(code).toLowerCase()) || null;
  }

  function slugId(label) {
    const slug = String(label || 'block').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'block';
    return `custom.${slug}.${Math.random().toString(36).slice(2, 7)}`;
  }

  app.post('/api/flow-planner/chat-edit', async (req, res) => {
    const { text, currentInputs } = req.body || {};
    if (!ai) return res.status(503).json({ error: 'ANTHROPIC_FOUNDRY_API_KEY / ANTHROPIC_FOUNDRY_RESOURCE not configured on the server.' });
    if (!text) return res.status(400).json({ error: 'text is required.' });

    const blockList = flowPlanner.blocks(currentInputs || {})
      .map((b) => `${b.code}: ${b.label}${b.detail ? ` — ${b.detail}` : ''}`)
      .join('\n');
    const system = `You edit the inputs for a Campaign Accelerator campaign's Segmentation Flow diagram generator. ` +
      `Current input values (JSON): ${JSON.stringify(currentInputs || {})}. ` +
      `The CURRENT diagram's printed blocks, in order (code: label — current text):\n${blockList}\n\n` +
      `If the user names a field (audience, campaign name, segments, ...), set that field. ` +
      `If the user instead refers to a block by its printed code (e.g. "B12") or unambiguously by the block's own label/text above, set blockCode + blockText instead — most blocks have no other input to change. ` +
      `If the user asks to delete/remove a block, set deleteBlockCode instead (not blockCode/blockText). ` +
      `If the user asks to add a new block, set addBlockLabel (+ addBlockDetail/addBlockDecision/addBlockType/addBlockStatus as given) and, whenever there's an obvious block it should connect downstream from, addBlockAfterCode (and addBlockBeforeCode if they named both ends of an existing connection to insert into). Set addBlockBranch to "side" when the user describes it as a branch, a "No"/rejection arm, or an alternate path off the side — leave it "down" for a block that continues the main line. ` +
      `If the user asks to swap two blocks, set swapBlockCodeA + swapBlockCodeB. To change a block's colour, set recolorBlockCode + recolorStatus. To move an EXISTING block to the side or back onto the main line, set setBranchBlockCode + setBranchDirection. To connect or disconnect two blocks directly (no new block involved), use connectFromCode/connectToCode or disconnectFromCode/disconnectToCode. ` +
      `Do not just describe a structural change in summary without setting the matching field(s) above — nothing happens unless you set them. ` +
      `Call update_flow_planner_inputs with only what the user actually asked to change.`;

    try {
      const response = await ai.messages.create({
        model: MODEL,
        max_tokens: 1024,
        system,
        messages: [{ role: 'user', content: text }],
        tools: [flowPlannerEditTool()],
        tool_choice: { type: 'tool', name: 'update_flow_planner_inputs' },
      });
      const toolBlock = response.content.find((b) => b.type === 'tool_use');
      if (!toolBlock) return res.json({ patch: {}, summary: "Didn't catch a Flow-input change in that — try naming the field, or a block's code (e.g. \"B12\"), and what to do with it." });
      const {
        summary, blockCode, blockText, deleteBlockCode,
        addBlockLabel, addBlockDetail, addBlockDecision, addBlockType, addBlockStatus, addBlockAfterCode, addBlockBeforeCode, addBlockBranch,
        swapBlockCodeA, swapBlockCodeB, recolorBlockCode, recolorStatus, setBranchBlockCode, setBranchDirection,
        connectFromCode, connectToCode, connectLabel, disconnectFromCode, disconnectToCode,
        ...patch
      } = toolBlock.input || {};

      const unknown = (code) => res.json({ patch: {}, summary: `${code} isn't a block on the current diagram — regenerate first if you just changed audience or segments, or check the code shown next to the block.` });

      if (blockCode) {
        const found = findBlock(currentInputs, blockCode);
        if (!found) return unknown(blockCode);
        patch.nodeOverrideId = found.id;
        patch.nodeOverrideText = blockText ?? '';
      }
      if (deleteBlockCode) {
        const found = findBlock(currentInputs, deleteBlockCode);
        if (!found) return unknown(deleteBlockCode);
        patch.nodeDeleteId = found.id;
      }
      if (addBlockLabel) {
        const newId = slugId(addBlockLabel);
        const isSide = addBlockBranch === 'side';
        patch.customNodes = [{ id: newId, type: addBlockType || (addBlockDecision ? 'decision' : 'process'), label: addBlockLabel, detail: addBlockDetail || '', status: addBlockStatus || null }];
        const graphOps = [];
        if (addBlockAfterCode && addBlockBeforeCode && !isSide) {
          const from = findBlock(currentInputs, addBlockAfterCode);
          const to = findBlock(currentInputs, addBlockBeforeCode);
          if (!from) return unknown(addBlockAfterCode);
          if (!to) return unknown(addBlockBeforeCode);
          graphOps.push({ kind: 'insertBetween', fromId: from.id, toId: to.id, newNodeId: newId });
        } else if (addBlockAfterCode && isSide) {
          // A side branch adds to what its anchor connects to, rather than
          // replacing it — "add a No arm off B5" should leave B5's own
          // downstream connection exactly as it was.
          const anchor = findBlock(currentInputs, addBlockAfterCode);
          if (!anchor) return unknown(addBlockAfterCode);
          graphOps.push({ kind: 'connect', fromId: anchor.id, toId: newId });
          graphOps.push({ kind: 'setBranch', id: newId, branch: 'side' });
        } else if (addBlockAfterCode) {
          const anchor = findBlock(currentInputs, addBlockAfterCode);
          if (!anchor) return unknown(addBlockAfterCode);
          graphOps.push({ kind: 'insertAfter', afterId: anchor.id, newNodeId: newId });
        }
        if (graphOps.length) patch.graphOps = graphOps;
      }
      if (setBranchBlockCode && setBranchDirection) {
        const found = findBlock(currentInputs, setBranchBlockCode);
        if (!found) return unknown(setBranchBlockCode);
        patch.graphOps = [...(patch.graphOps || []), { kind: 'setBranch', id: found.id, branch: setBranchDirection }];
      }
      if (swapBlockCodeA && swapBlockCodeB) {
        const a = findBlock(currentInputs, swapBlockCodeA);
        const b = findBlock(currentInputs, swapBlockCodeB);
        if (!a) return unknown(swapBlockCodeA);
        if (!b) return unknown(swapBlockCodeB);
        patch.graphOps = [...(patch.graphOps || []), { kind: 'swap', idA: a.id, idB: b.id }];
      }
      if (recolorBlockCode) {
        const found = findBlock(currentInputs, recolorBlockCode);
        if (!found) return unknown(recolorBlockCode);
        patch.graphOps = [...(patch.graphOps || []), { kind: 'setStatus', id: found.id, status: recolorStatus }];
      }
      if (connectFromCode && connectToCode) {
        const from = findBlock(currentInputs, connectFromCode);
        const to = findBlock(currentInputs, connectToCode);
        if (!from) return unknown(connectFromCode);
        if (!to) return unknown(connectToCode);
        patch.graphOps = [...(patch.graphOps || []), { kind: 'connect', fromId: from.id, toId: to.id, label: connectLabel }];
      }
      if (disconnectFromCode && disconnectToCode) {
        const from = findBlock(currentInputs, disconnectFromCode);
        const to = findBlock(currentInputs, disconnectToCode);
        if (!from) return unknown(disconnectFromCode);
        if (!to) return unknown(disconnectToCode);
        patch.graphOps = [...(patch.graphOps || []), { kind: 'disconnect', fromId: from.id, toId: to.id }];
      }

      // Any block this edit just added needs its code assigned NOW and
      // handed back for the client to persist — otherwise it stays
      // code-less until the next /generate call assigns it whatever number
      // happens to be next AT THAT TIME, which is not necessarily the same
      // number this response's own summary might reference.
      const codeAssignments = patch.customNodes?.length
        ? flowPlanner.codeMapFor({
            ...currentInputs,
            customNodes: [...(currentInputs?.customNodes || []), ...patch.customNodes],
            graphOps: [...(currentInputs?.graphOps || []), ...(patch.graphOps || [])],
          })
        : undefined;

      res.json({ patch, summary: summary || 'Updated.', ...(codeAssignments ? { codeAssignments } : {}) });
    } catch (err) {
      console.error('[server] Flow Planner chat-edit failed:', err);
      res.status(500).json({ error: 'Flow Planner chat-edit failed.', detail: String(err.message || err) });
    }
  });
}

module.exports = { extractFileText, register };
