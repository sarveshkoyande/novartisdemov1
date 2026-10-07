// Seeds FormField.derivesFrom — the "don't ask for what we already know" map.
//
// A campaign restates the same handful of facts many times: Brand appears in
// Generic, again in OMS, and again as "Tact Brand: Name" / "New Program Brand:
// Brand" inside the CMA metadata sheet. Left alone, the interview asks for each
// one separately, which is most of what makes the form feel endless.
//
// Each entry names a TARGET field (by fieldKey) and the SOURCE field whose
// answer it can be inferred from. Nothing here auto-fills: the client turns
// these into a single batched proposal the user confirms once (the customer's
// rule is that defaults are only applied with approval).
//
// CMA's 45 sub-fields are addressed through their own flattened rows
// ("1.4.6-g{groupIndex}-f{fieldIndex}"), resolved below from the metasheet's
// groupsJson by label so a reordered sheet doesn't silently mis-map.
'use strict';
const path = require('path');
const { PrismaClient } = require('../generated/prisma');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');

// Source fields, for reference:
//   14 Brand · 17 Branded/Unbranded · 18 Audience Type · 21 Campaign Name
//   22 Campaign Type · 16 Therapeutic Area · 25 Desired campaign GO LIVE date
//   1.4.2 Source Type · 1.4.3 Source Name · 1.4.4 Survey Q&A pairs
//   1.4.8 Franchise · 1.4.10 Program · 1.4.14 Survey · 1.4.15 QA pair data
const DIRECT = {
  '1.4.9': '14',    // OMS Brand   <- Generic Brand
  '1.4.12': '16',  // OMS Therapy <- Generic Therapy
  '1.3.3': '25',   // Journey Start Date <- Estimated GOLIVE Date ("Cascaded from Overview")
};

// [group label, sub-field name] -> source fieldKey
const CMA = [
  ['Tact Franchise', 'Name', '1.4.8'],
  ['Tact Brand', 'Name', '14'],
  ['Tact Brand', 'Franchise', '1.4.8'],
  ['Tact Program', 'Program Name', '1.4.10'],
  ['New Program Brand', 'Program', '1.4.10'],
  ['New Program Brand', 'Brand', '14'],
  ['Tact Therapy', 'Therapy Class Name', '16'],
  ['Tact Campaign', 'Name', '21'],
  ['Tact Campaign', 'Program', '1.4.10'],
  ['Tact Campaign', 'Therapy', '16'],
  ['Tact Campaign', 'Campaign Type', '22'],
  ['Tact Campaign', 'Start Date', '25'],
  ['Tact Campaign', 'HCP', '18'],
  ['Tact Campaign', 'Branded', '17'],
  ['New Survey', 'Survey Name', '1.4.14'],
  ['New Survey', 'Campaign Type', '22'],
  ['New Survey', 'Start Date', '25'],
  ['New Question', 'Text', '1.4.4'],
  ['New Answer', 'Answer Text', '1.4.15'],
  ['Tact Source', 'Description', '1.4.2'],
  ['Tact Source', 'Medium', '1.4.3'],
  ['Tact Source', 'Start Date', '25'],
  ['Tact Source', 'Campaign', '21'],
];

async function main() {
  const dbPath = path.join(__dirname, '..', 'dev.db');
  const adapter = new PrismaBetterSqlite3({ url: process.env.DATABASE_URL || `file:${dbPath}` });
  const prisma = new PrismaClient({ adapter });

  const pairs = { ...DIRECT };

  const metasheet = await prisma.formField.findFirst({ where: { sectionId: 'cma', type: 'metasheet' } });
  if (!metasheet || !metasheet.groupsJson) {
    throw new Error('CMA metasheet has no groupsJson — run migrate-metasheet-groups.js first.');
  }
  const groups = JSON.parse(metasheet.groupsJson);
  for (const [groupLabel, fieldName, source] of CMA) {
    const gi = groups.findIndex(g => g.label === groupLabel);
    if (gi === -1) { console.warn(`  ! no group "${groupLabel}" — skipped`); continue; }
    const fi = groups[gi].fields.indexOf(fieldName);
    if (fi === -1) { console.warn(`  ! no field "${groupLabel}: ${fieldName}" — skipped`); continue; }
    pairs[`${metasheet.fieldKey}-g${gi}-f${fi}`] = source;
  }

  let applied = 0, missing = 0;
  for (const [targetKey, sourceKey] of Object.entries(pairs)) {
    const target = await prisma.formField.findFirst({ where: { fieldKey: targetKey } });
    if (!target) { console.warn(`  ! target ${targetKey} not found — skipped`); missing++; continue; }
    const source = await prisma.formField.findFirst({ where: { fieldKey: sourceKey } });
    if (!source) { console.warn(`  ! source ${sourceKey} not found — skipped`); missing++; continue; }
    await prisma.formField.update({ where: { id: target.id }, data: { derivesFrom: sourceKey } });
    applied++;
  }

  console.log(`derivesFrom seeded: ${applied} pair(s)${missing ? `, ${missing} skipped` : ''}.`);
  await prisma.$disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
