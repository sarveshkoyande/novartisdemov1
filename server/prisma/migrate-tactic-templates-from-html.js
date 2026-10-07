// One-time migration: ports the hardcoded CRF #N tactic generator functions
// (emailTacticSection/smsTacticSection/mdsTacticSection/automxTacticSection/
// touchpointSection, previously baked into the frontend HTML) into the new
// TacticFieldTemplate table. Same approach as migrate-sections-from-html.js —
// extracts the exact function source from the canonical HTML and evaluates
// it in a sandbox (a mechanical, byte-faithful port), rather than
// hand-retranscribing ~76 fields. Each generator is called with its tactic
// number argument set to the literal string "{n}", so `${crfGroup}`/`${n}`
// template interpolation naturally produces fieldKey/cascadeFromField
// strings like "1.6.t{n}.1" — the client substitutes the real number back in
// at render time. Safe to re-run: wipes and re-seeds TacticFieldTemplate only.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { PrismaClient } = require('../generated/prisma');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');

const HTML_PATH = path.join(__dirname, '..', '..', '..', 'hqe-requirement-studio-mock_2.html');

function extractFunctionSource(html, name) {
  const marker = `function ${name}(`;
  const startIdx = html.indexOf(marker);
  if (startIdx === -1) throw new Error(`Could not find "${marker}" in ${HTML_PATH}`);
  // Balance the parameter-list parens first — makeFanoutSection destructures
  // its argument ({crfGroup, idPrefix, ...}), so the naive "first { after the
  // function name" would stop at the closing brace of that destructure
  // instead of the function body's opening brace.
  const parenStart = html.indexOf('(', startIdx);
  let pdepth = 0, j = parenStart;
  for (; j < html.length; j++) {
    if (html[j] === '(') pdepth++;
    else if (html[j] === ')') { pdepth--; if (pdepth === 0) break; }
  }
  const braceIdx = html.indexOf('{', j + 1);
  let depth = 0, i = braceIdx;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) break; }
  }
  if (depth !== 0) throw new Error(`Unbalanced braces while scanning ${name}`);
  return html.slice(startIdx, i + 1);
}

const GENERATOR_NAMES = ['makeFanoutSection', 'emailTacticSection', 'smsTacticSection', 'mdsTacticSection', 'automxTacticSection', 'touchpointSection'];

// tacticType -> [generatorFnName, argument passed as the tactic number]
const TACTIC_CALLS = [
  ['email', 'emailTacticSection'],
  ['sms', 'smsTacticSection'],
  ['mds', 'mdsTacticSection'],
  ['automx', 'automxTacticSection'],
  ['touchpoint', 'touchpointSection'],
];

async function main() {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  // Each generator now tries fieldsFromTemplatesByPhase() first and only
  // falls back to its hardcoded array when that returns null — i.e. it reads
  // the very table this script fills. Stubbing it to null forces the
  // hardcoded path, which is the source of truth we're porting from.
  const sandbox = { fieldsFromTemplatesByPhase: () => null };
  vm.createContext(sandbox);
  const source = GENERATOR_NAMES.map(n => extractFunctionSource(html, n)).join('\n');
  vm.runInContext(source, sandbox);

  const dbPath = path.join(__dirname, '..', 'dev.db');
  const adapter = new PrismaBetterSqlite3({ url: process.env.DATABASE_URL || `file:${dbPath}` });
  const prisma = new PrismaClient({ adapter });

  await prisma.tacticFieldTemplate.deleteMany({});
  let total = 0;
  for (const [tacticType, fnName] of TACTIC_CALLS) {
    const section = sandbox[fnName]('{n}');
    let order = 0;
    for (const phase of ['preplan', 'plan', 'exec']) {
      for (const f of section.phases[phase] || []) {
        await prisma.tacticFieldTemplate.create({
          data: {
            tacticType, fieldKey: f.id, phase, label: f.n, type: f.type, owner: f.owner,
            bucket: f.bucket || null, source: f.src || null,
            optionsJson: f.opts ? JSON.stringify(f.opts) : null,
            condJson: f.cond ? JSON.stringify({ logic: 'and', rules: Object.entries(f.cond).map(([key, value]) => ({ key, value })) }) : null,
            drives: f.drives || null, cascadeFromField: f.cascadeFromField || null,
            locked: !!f.locked, lockedValue: f.lockedValue || null, wide: !!f.wide,
            order: order++,
          },
        });
        total++;
      }
    }
    console.log(`${tacticType}: ${order} fields`);
  }
  console.log(`Seeded ${total} TacticFieldTemplate rows.`);
  await prisma.$disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
