// Generate sample Flow Planner PDFs from two fixed demo briefs (DTC and HCP).
//
//   node scripts/flow-planner-demo-pdf.js [output-dir]   (default: <repo root>/flow-planner-output)
//
// Each PDF is: page 1 the inputs the planner used (and which intake field each
// came from), page 2 segmentation, then one page per segment journey. The demo
// briefs mirror the reference project's scripts/demo_flow_planner.py FULL brief.
//
// Pages are rendered as HTML with one inline SVG each and printed to PDF by
// headless Microsoft Edge, so no PDF library is needed.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const fp = require('../segmentation');
const { flowSvg } = require('../segmentation/svg');
const { normalise, stableCodes } = require('../segmentation/drawing');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

// [input label, value, intake field it comes from]
function briefRows(inputs) {
  const j = inputs.journey || {};
  const s = inputs.suppressionAnswers || {};
  const rows = [
    ['Audience', inputs.audience, 'Generic · 1.1.6 Audience'],
    ['Campaign name', inputs.campaignName, 'Generic · 1.1.9 Campaign Name'],
    ['Campaign code', inputs.campaignCode, 'Generic · 1.1.11 Campaign code'],
    ['Campaign type', inputs.campaignType, 'Generic · 1.1.12 Campaign Type'],
    ['Campaign goal', inputs.goal, 'Generic · 1.1.10 Campaign Goal'],
    ['Segments', (inputs.segments || []).join(', '), 'Generic · 1.1.13 Segments'],
    ['Go-live date', j.goliveDate, 'Generic · 1.1.19 Estimated GOLIVE Date'],
  ];
  if (inputs.audience === 'DTC') {
    (inputs.enrollmentSources || []).forEach((src, i) => {
      rows.push([`Enrollment source ${i + 1}`, `${src.name} · code ${src.code}`, 'OMS · 1.4.3 Source Name, 1.4.5 Campaign Source Code']);
      rows.push([`Source ${i + 1} QnA`, src.qna, 'OMS · 1.4.4 Survey Q&A pairs']);
    });
  }
  rows.push(['Survey QnA (segment)', inputs.qna, 'OMS · 1.4.4 Survey Q&A pairs']);
  if (inputs.audience === 'HCP') {
    rows.push(['Specialty inclusions', s.specialtyInclusion, 'Data Cloud · 1.8.6 Specialty Inclusions']);
    rows.push(['Specialty exclusions', s.specialtyExclusion, 'Data Cloud · 1.8.7 Specialty Exclusions']);
  }
  // One block per segment: each has its own touchpoints and emails.
  for (const segment of inputs.segments || []) {
    const sj = { ...j, ...((j.bySegment || {})[segment] || {}) };
    const list = (v) => String(v || '').split('\n');
    const names = list(sj.touchpointNames), fuses = list(sj.fuseIds), metas = list(sj.metadataIds), waits = list(sj.waits);
    const resends = list(sj.resendNeeded), rules = list(sj.resendRule);
    const at = (arr, i) => (arr.length === 1 ? arr[0] : arr[i]);
    const tps = names.map((n, i) => {
      const resend = /^y/i.test(at(resends, i) || '') ? `resend after ${at(rules, i) || 'TBD'}` : 'no resend';
      return `${i + 1}. ${n} — FUSE ${fuses[i] || 'TBD'}, Metadata ${metas[i] || 'TBD'}, ${resend}${i < names.length - 1 ? `, then wait ${waits[i] || 'TBD'}` : ''}`;
    });
    rows.push([`${segment} · touchpoints & emails`, tps.join('\n')]);
    rows.push([`${segment} · exit`, sj.exitRule || 'TBD']);
  }
  return rows;
}

const SHARED = {
  campaignName: 'Leqvio Fall Push',
  campaignCode: '20241888',
  campaignType: 'Cadenced',
  goal: 'Drive awareness and sample requests',
  segments: ['Cardiology Naive', 'Nephrology Experienced'],
  qna: 'Q: Currently treated? A: Yes; Q: Diagnosed? A: Yes',
  journey: {
    touchpointTypes: 'Email',
    goliveDate: '2026-01-15',
    bySegment: {
      'Cardiology Naive': {
        touchpointNames: 'Get the Facts\nDosing Guide\nSample Request',
        fuseIds: 'FA-11234478\nFA-11234479\nFA-11234480',
        metadataIds: 'M-1001A\nM-1002A\nM-1003A',
        waits: '2 days\n5 days',
        resendNeeded: 'Yes\nNo\nYes',
        resendRule: '4 days\n\n3 days',
        exitRule: 'Goal met - sample requested',
      },
      'Nephrology Experienced': {
        touchpointNames: 'Switching Evidence\nPatient Support',
        fuseIds: 'FA-11235001\nFA-11235002',
        metadataIds: 'M-2001B\nM-2002B',
        waits: '7 days',
        resendNeeded: 'No\nYes',
        resendRule: '\n5 days',
        exitRule: 'Goal met - support enrolled',
      },
    },
  },
  // Sample history for the demo. In the app this comes from the Flow tab's
  // version history (useVisioStore versions + approver decisions).
  changeLog: [
    { version: 'v1', date: '2026-09-29 10:02', change: 'Initial flow generated from campaign data', by: 'Flow Planner agent', status: 'Draft' },
    { version: 'v2', date: '2026-09-29 10:05', change: 'Sent for approval', by: 'Jordan Blake (Solution Architect)', status: 'In review' },
    { version: 'v3', date: '2026-09-29 11:40', change: 'Changes requested: add resend rule to all touchpoints', by: 'Sofia Reyes (Campaign Ops)', status: 'Changes requested' },
    { version: 'v4', date: '2026-09-29 12:10', change: 'Resend rule set to 4 days; flow regenerated and re-sent', by: 'Jordan Blake (Solution Architect)', status: 'In review' },
    { version: 'v5', date: '2026-09-29 14:25', change: 'Approved', by: 'Alex Kim (Campaign Ops)', status: 'Approved' },
    { version: 'v6', date: '2026-09-29 15:02', change: 'Approved', by: 'Sofia Reyes (Campaign Ops)', status: 'Approved' },
  ],
};

const BRIEFS = {
  DTC: {
    ...SHARED,
    audience: 'DTC',
    deletedNodeIds: ['seg.supp.therapy_optin', 'seg.supp.notice_language', 'seg.supp.email_consent', 'seg.supp.retargeting_optin'],
    enrollmentSources: [
      { name: 'VANRAFIA', code: '20242025', qna: 'Q: Currently treated? A: Yes' },
      { name: 'IPTACOPAN', code: '20221888', qna: 'Q: Diagnosed? A: Yes' },
    ],
  },
  HCP: {
    ...SHARED,
    audience: 'HCP',
    suppressionAnswers: { specialtyInclusion: 'Cardiology; Nephrology', specialtyExclusion: 'Oncology' },
  },
};

// Cut the design into pages: segmentation, then one page per journey lane
// (with the legend, which keys every block's colour on that page). A page
// keeps only edges whose two ends are both on it.
function pages(spec) {
  const [nodes, edges] = normalise(spec);
  const slice = (keep, title, subtitle) => {
    const ids = new Set(keep.map((n) => n.id));
    return { title, subtitle, nodes: keep, edges: edges.filter((e) => ids.has(e.from) && ids.has(e.to)) };
  };
  const out = [slice(nodes.filter((n) => (n.region || 'segmentation') === 'segmentation'), 'Segmentation', 'Qualification, suppressions and the segments the audience divides into')];
  const legend = nodes.find((n) => n.id === 'pane.legend');
  for (const segment of spec.segments || []) {
    const lane = nodes.filter((n) => n.region === 'journey' && n.lane === segment);
    if (lane.length) out.push(slice([...(legend ? [legend] : []), ...lane], `Email journey — ${segment}`, 'One segment, first send to exit'));
  }
  return out;
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function html(inputs) {
  const spec = fp.generate(inputs);
  const codeMap = stableCodes(spec.nodes, {});
  const diagramPages = pages(spec);
  const total = diagramPages.length + 2; // + inputs page + change log page
  const title = `${inputs.campaignName} — ${inputs.audience}`;
  const head = (t, sub, n) =>
    `<header><div><h1>${esc(t)}</h1><p>${esc(sub)}</p></div><div class="meta"><p>${esc(title)}</p><p>Page ${n} of ${total}</p></div></header>`;

  const rows = briefRows(inputs)
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v || '—').replace(/\n/g, '<br>')}</td></tr>`)
    .join('');
  let body = `<section>${head('Inputs', 'Every value the Flow Planner used', 1)}<table><thead><tr><th>Input</th><th>Value</th></tr></thead><tbody>${rows}</tbody></table></section>`;

  diagramPages.forEach((page, i) => {
    // Let CSS size the SVG to the page; its viewBox keeps the aspect ratio.
    // The page header already carries the title, so the drawing gets none.
    const svg = flowSvg(page, '', codeMap, { page: true }).replace(/<svg([^>]*?) width="\d+" height="\d+"/, '<svg$1');
    body += `<section>${head(page.title, page.subtitle, i + 2)}<div class="fig">${svg}</div></section>`;
  });

  const logRows = (inputs.changeLog || [])
    .map((e) => `<tr><td>${esc(e.version)}</td><td>${esc(e.date)}</td><td>${esc(e.change)}</td><td>${esc(e.by)}</td><td>${esc(e.status)}</td></tr>`)
    .join('') || '<tr><td colspan="5">No changes recorded yet.</td></tr>';
  body += `<section>${head('Change log', 'Every version of this flow and what each reviewer decided', total)}<table><thead><tr><th>Version</th><th>Date</th><th>Change</th><th>By</th><th>Status</th></tr></thead><tbody>${logRows}</tbody></table></section>`;

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
@page { size: A4 portrait; margin: 12mm; }
* { box-sizing: border-box; }
body { margin: 0; font-family: Arial, Helvetica, sans-serif; color: #161616; }
section { page-break-after: always; height: 272mm; display: flex; flex-direction: column; }
section:last-child { page-break-after: auto; }
header { display: flex; justify-content: space-between; border-bottom: 1px solid #DEDAD4; padding-bottom: 6px; margin-bottom: 10px; }
h1 { font-size: 16px; margin: 0; } header p { margin: 2px 0 0; font-size: 10px; color: #5C656D; }
.meta { text-align: right; }
.fig { flex: 1; min-height: 0; display: flex; justify-content: center; }
.fig svg { width: 100%; height: 100%; }
table { width: 100%; border-collapse: collapse; font-size: 10.5px; }
th { text-align: left; border-bottom: 1px solid #161616; padding: 5px 6px; }
td { border-bottom: 1px solid #DEDAD4; padding: 5px 6px; vertical-align: top; }
td.src { color: #5C656D; }
</style></head><body>${body}</body></html>`;
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForFile(file, timeoutMs = 60000) {
  const start = Date.now();
  let last = -1;
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(file)) {
      const size = fs.statSync(file).size;
      if (size > 0 && size === last) return;
      last = size;
    }
    sleep(500);
  }
  throw new Error(`Timed out waiting for ${file}`);
}

function main() {
  const outDir = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', '..', 'flow-planner-output'));
  fs.mkdirSync(outDir, { recursive: true });
  for (const [aud, inputs] of Object.entries(BRIEFS)) {
    const htmlPath = path.join(outDir, `flow-planner-${aud.toLowerCase()}.html`);
    let pdfPath = path.join(outDir, `flow-planner-${aud.toLowerCase()}.pdf`);
    fs.writeFileSync(htmlPath, html(inputs), 'utf8');
    // Windows locks a PDF while a viewer has it open; write beside it rather
    // than failing the whole run.
    try {
      if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);
    } catch (err) {
      if (err.code !== 'EBUSY' && err.code !== 'EPERM') throw err;
      const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, '');
      const alt = pdfPath.replace(/\.pdf$/, `_${stamp}.pdf`);
      console.log(`! ${path.basename(pdfPath)} is open in another program, writing ${path.basename(alt)} instead`);
      pdfPath = alt;
    }
    // Edge on Windows detaches from its launcher, so the call returns before
    // the PDF exists. A private profile per file stops two jobs being handed
    // to the same browser process, and the wait below blocks until the file
    // has been written and stopped growing.
    execFileSync(EDGE, ['--headless=new', '--disable-gpu', '--no-pdf-header-footer', `--user-data-dir=${path.join(os.tmpdir(), `flow-planner-edge-${aud.toLowerCase()}`)}`, `--print-to-pdf=${pdfPath}`, `file:///${htmlPath.replace(/\\/g, '/')}`], { stdio: 'ignore' });
    waitForFile(pdfPath);
    console.log(`wrote ${pdfPath}`);
  }
}

main();
