// One-time migration: ports the hardcoded BASE_SECTIONS array (the form's
// entire structure, previously baked into the frontend HTML) into the new
// FormSection/FormField tables. Rather than hand-retranscribing ~90 dense
// lines of JS object literals (error-prone, easy to silently drop a field),
// this extracts the exact BASE_SECTIONS source text from the canonical HTML
// file and evaluates it in a sandbox — a mechanical, byte-faithful port,
// not a rewrite of the data. Safe to re-run: it wipes and re-seeds these
// two tables only (FieldEntry/BrandIndication/AgentSkill are untouched).
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { PrismaClient } = require('../generated/prisma');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');

const HTML_PATH = path.join(__dirname, '..', '..', '..', 'hqe-requirement-studio-mock_2.html');

function extractBaseSections(htmlSource) {
  // Declared `let` since loadFormSchemaFromDb started reassigning it; match
  // either keyword so this doesn't break again on the next such change.
  const startMarker = /(?:const|let|var)\s+BASE_SECTIONS\s*=\s*\[/.exec(htmlSource);
  const startIdx = startMarker ? startMarker.index : -1;
  if (startIdx === -1) throw new Error('Could not find the BASE_SECTIONS array declaration in ' + HTML_PATH);
  // Walk bracket depth from the opening `[` to find its exact matching `]`,
  // rather than assuming a fixed line range — resilient to the source file
  // being edited before this script is next re-run.
  const openIdx = startIdx + startMarker[0].length - 1;
  let depth = 0, i = openIdx;
  for (; i < htmlSource.length; i++) {
    if (htmlSource[i] === '[') depth++;
    else if (htmlSource[i] === ']') { depth--; if (depth === 0) break; }
  }
  if (depth !== 0) throw new Error('Unbalanced brackets while scanning BASE_SECTIONS');
  const arraySource = htmlSource.slice(openIdx, i + 1);
  const sandbox = {};
  vm.createContext(sandbox);
  return vm.runInContext(`(${arraySource})`, sandbox);
}

async function main() {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const baseSections = extractBaseSections(html);
  console.log(`Extracted ${baseSections.length} sections from ${path.basename(HTML_PATH)}`);

  const dbPath = path.join(__dirname, '..', 'dev.db');
  const adapter = new PrismaBetterSqlite3({ url: process.env.DATABASE_URL || `file:${dbPath}` });
  const prisma = new PrismaClient({ adapter });

  // FormSection gained a required formId when Form Management landed
  // (migration 20260729131500_add_form), after this script was first written.
  // Everything BASE_SECTIONS holds is the original single form, so it all
  // belongs to form-default; ensure that row exists before seeding into it.
  const FORM_ID = 'form-default';
  await prisma.form.upsert({
    where: { id: FORM_ID },
    update: {},
    create: {
      id: FORM_ID,
      name: 'Requirement Gathering Form',
      description: 'The original campaign requirement-gathering flow.',
      active: true,
      order: 0,
    },
  });

  await prisma.formField.deleteMany({});
  await prisma.formSection.deleteMany({ where: { formId: FORM_ID } });

  let sectionOrder = 0;
  let fieldCount = 0;
  for (const s of baseSections) {
    await prisma.formSection.create({
      data: {
        id: s.id,
        formId: FORM_ID,
        num: s.num,
        name: s.name,
        icon: s.ic,
        parentId: s.parentId || null,
        audienceGate: !!s.audienceGate,
        note: s.note || null,
        needsJson: JSON.stringify(s.needs),
        order: sectionOrder++,
      },
    });

    let fieldOrder = 0;
    for (const phase of ['preplan', 'plan', 'exec']) {
      for (const f of s.phases[phase] || []) {
        await prisma.formField.create({
          data: {
            sectionId: s.id,
            fieldKey: f.id,
            phase,
            label: f.n,
            type: f.type,
            owner: f.owner,
            bucket: f.bucket || null,
            source: f.src || null,
            optionsJson: f.opts ? JSON.stringify(f.opts) : null,
            condJson: f.cond ? JSON.stringify(f.cond) : null,
            drives: f.drives || null,
            cascadeFromField: f.cascadeFromField || null,
            locked: !!f.locked,
            lockedValue: f.lockedValue || null,
            wide: !!f.wide,
            order: fieldOrder++,
          },
        });
        fieldCount++;
        // The CMA Metadata Sheet's `metasheet` field type is one array
        // entry standing in for 45 real sub-fields (10 groups) — flatten
        // those into their own FormField rows too (fieldKey suffixed
        // `-g{gi}-f{fi}`), so the DB's field count is the real ~151-field
        // total, not the collapsed ~106 top-level entries.
        if (f.type === 'metasheet' && Array.isArray(f.groups)) {
          for (let gi = 0; gi < f.groups.length; gi++) {
            const g = f.groups[gi];
            for (let fi = 0; fi < g.fields.length; fi++) {
              await prisma.formField.create({
                data: {
                  sectionId: s.id,
                  fieldKey: `${f.id}-g${gi}-f${fi}`,
                  phase,
                  label: `${g.label}: ${g.fields[fi]}`,
                  type: 'text',
                  owner: f.owner,
                  bucket: f.bucket || null,
                  source: f.src || null,
                  order: fieldOrder++,
                },
              });
              fieldCount++;
            }
          }
        }
      }
    }
  }

  console.log(`Seeded ${baseSections.length} FormSection rows and ${fieldCount} FormField rows.`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
