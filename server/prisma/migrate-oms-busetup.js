// One-off migration:
// 1. Fixes OMS - Enrollment Form Details field ownership — every field in
//    that section was seeded with owner "aor", even though the chat has
//    always talked about OMS owning enrollment-source detail. Flips the 12
//    fields that are genuinely OMS's job (Source Type/Name/QA pairs plus the
//    Franchise/Brand/Program/... hierarchy) to owner "oms"; leaves the 4
//    AOR-decision fields (trigger question, Metadata Source, Attach
//    Metadata Sheet, Campaign Source Code) alone.
// 2. Wires derivesFrom for the fields with a real, confirmed upstream
//    source (Brand, Therapy, Campaign <- Campaign Name) — anything without
//    a clean 1:1 source is deliberately left blank rather than guessed.
// 3. Creates a new BU Setup section (owner "xm"), the 17 fields from the
//    XM handoff spec, with derivesFrom wired wherever a real source exists
//    (Campaign Go-Live Date, Brand Name, Therapy class, Campaign Code,
//    Branded/Unbranded) and left blank everywhere else (Drug Name, Brand
//    Code, Enrollment Source, and the 9 Yes/No setup questions — none of
//    these are captured anywhere upstream today).
'use strict';
const path = require('path');
const { PrismaClient } = require('../generated/prisma');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');

const OMS_TO_OWNER_OMS = ['1.4.2', '1.4.3', '1.4.4', '1.4.8', '1.4.9', '1.4.10', '1.4.11', '1.4.12', '1.4.13', '1.4.14', '1.4.15', '1.4.16'];

const OMS_DERIVES_FROM = {
  '1.4.9': '1.1.3',   // OMS Brand    <- Generic Brand
  '1.4.12': '1.1.15', // OMS Therapy  <- Generic Therapy
  '1.4.13': '1.1.8',  // OMS Campaign <- Generic Campaign Name
};

// Same cond as the rest of the OMS section — only relevant for new brand /
// new indication launches.
const NEW_BU_COND = JSON.stringify({ assetScope: ['newbrand', 'newind'] });

// 1.9.x — NOT 1.6.x: that range is already used by the Email section
// (1.6.1 "# of Emails"). A first pass of this script used 1.6.x and
// collided with it; see migrate-phase-and-fieldkey-fix.js for the repair.
const BUSETUP_FIELDS = [
  { fieldKey: '1.9.1', label: 'Campaign Go-Live Date', type: 'date', derivesFrom: '1.1.19' },
  { fieldKey: '1.9.2', label: 'Brand Name', type: 'text', derivesFrom: '1.1.3' },
  { fieldKey: '1.9.3', label: 'Drug Name', type: 'text', derivesFrom: null },
  { fieldKey: '1.9.4', label: 'Therapy class', type: 'text', derivesFrom: '1.1.15' },
  { fieldKey: '1.9.5', label: 'Brand Code', type: 'text', derivesFrom: null },
  { fieldKey: '1.9.6', label: 'Campaign Code', type: 'text', derivesFrom: '1.1.10' },
  { fieldKey: '1.9.7', label: 'Branded/ Unbranded', type: 'sel', opts: ['Branded', 'Unbranded'], derivesFrom: '1.1.5' },
  { fieldKey: '1.9.8', label: 'Enrollment Source?', type: 'text', derivesFrom: null },
  { fieldKey: '1.9.9', label: 'Real-time enrollment setup required?', type: 'sel', opts: ['Yes', 'No'], derivesFrom: null },
  { fieldKey: '1.9.10', label: 'Data injection method?', type: 'sel', opts: ['MDS', 'OMS', 'Data Cloud'], derivesFrom: null },
  { fieldKey: '1.9.11', label: 'Source systems identified?', type: 'sel', opts: ['Yes', 'No'], derivesFrom: null },
  { fieldKey: '1.9.12', label: 'New data fields required?', type: 'sel', opts: ['Yes', 'No'], derivesFrom: null },
  { fieldKey: '1.9.13', label: 'Segment values/rules documented', type: 'sel', opts: ['Yes', 'No'], derivesFrom: null },
  { fieldKey: '1.9.14', label: 'Branded vs Unbranded mapping completed?', type: 'sel', opts: ['Yes', 'No'], derivesFrom: null },
  { fieldKey: '1.9.15', label: 'Model-based campaigns required?', type: 'sel', opts: ['Yes', 'No'], derivesFrom: null },
  { fieldKey: '1.9.16', label: 'HCP Master Data Extensions required?', type: 'sel', opts: ['Yes', 'No'], derivesFrom: null },
  { fieldKey: '1.9.17', label: 'Additional boundary systems identified?', type: 'sel', opts: ['Yes', 'No'], derivesFrom: null },
];

async function main() {
  const dbPath = path.join(__dirname, '..', 'dev.db');
  const adapter = new PrismaBetterSqlite3({ url: process.env.DATABASE_URL || `file:${dbPath}` });
  const prisma = new PrismaClient({ adapter });

  let ownerFixed = 0;
  for (const fieldKey of OMS_TO_OWNER_OMS) {
    const field = await prisma.formField.findFirst({ where: { fieldKey } });
    if (!field) { console.warn(`  ! ${fieldKey} not found — skipped owner fix`); continue; }
    await prisma.formField.update({ where: { id: field.id }, data: { owner: 'oms' } });
    ownerFixed++;
  }
  console.log(`owner fixed to "oms": ${ownerFixed} field(s)`);

  let derivesSet = 0;
  for (const [targetKey, sourceKey] of Object.entries(OMS_DERIVES_FROM)) {
    const target = await prisma.formField.findFirst({ where: { fieldKey: targetKey } });
    const source = await prisma.formField.findFirst({ where: { fieldKey: sourceKey } });
    if (!target || !source) { console.warn(`  ! ${targetKey} <- ${sourceKey}: one side not found — skipped`); continue; }
    await prisma.formField.update({ where: { id: target.id }, data: { derivesFrom: sourceKey } });
    derivesSet++;
  }
  console.log(`derivesFrom set on OMS fields: ${derivesSet}`);

  const existing = await prisma.formSection.findUnique({ where: { id: 'busetup' } });
  if (existing) {
    console.log('busetup section already exists — skipping section/field creation.');
  } else {
    const cma = await prisma.formSection.findUnique({ where: { id: 'cma' } });
    if (!cma) throw new Error('cma section not found — cannot place busetup before it.');
    // Take CMA's old order slot; push CMA one further back. num stays a
    // purely display string, same convention the rest of the sections use
    // (oms is order 2 but num "03" — num isn't order+1, it's the intended
    // reading position).
    await prisma.formSection.update({ where: { id: 'cma' }, data: { order: cma.order + 1 } });
    await prisma.formSection.create({
      data: {
        id: 'busetup',
        formId: 'form-default',
        num: '09',
        name: 'BU Setup',
        icon: '🏗',
        parentId: null,
        audienceGate: false,
        note: 'XM\'s setup checklist for a new Business Unit — runs in parallel with the CPF once Asset Scope is New Brand/New Indication. Blocked from submission until the CMA Metadata Sheet section is complete (see CMA\'s own note).',
        needsJson: JSON.stringify({ preplan: ['xm'], plan: [], exec: [] }),
        order: cma.order,
      },
    });
    for (let i = 0; i < BUSETUP_FIELDS.length; i++) {
      const f = BUSETUP_FIELDS[i];
      await prisma.formField.create({
        data: {
          sectionId: 'busetup',
          fieldKey: f.fieldKey,
          phase: 'preplan',
          label: f.label,
          type: f.type,
          owner: 'xm',
          bucket: 'newapp',
          source: '—',
          optionsJson: f.opts ? JSON.stringify(f.opts) : null,
          condJson: NEW_BU_COND,
          drives: null,
          cascadeFromField: null,
          derivesFrom: f.derivesFrom,
          locked: false,
          lockedValue: null,
          wide: false,
          order: i,
        },
      });
    }
    console.log(`busetup section created with ${BUSETUP_FIELDS.length} field(s).`);
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
