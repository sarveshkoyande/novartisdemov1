// Replaces OMS's singular Source Type / Source Name / Suvery Q&A pairs
// (1.4.2/1.4.3/1.4.4) with a 6-slot repeat group: Source Type 1-6, Source
// Name 1-6, Suvery Q&A pairs 1-6. A real enrollment metadata sheet carries
// several distinct sources (e.g. Facebook Ad, Insta Ad, DTC Web Reg Form),
// each with its own source code and Q&A pairs — one singular field per
// concept couldn't hold more than one source at a time. 6 is a fixed upper
// bound (no dynamic-repeat-field mechanism exists in this schema yet); a
// campaign with fewer sources just leaves the unused numbered slots blank.
'use strict';
const path = require('path');
const { PrismaClient } = require('../generated/prisma');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');

const SOURCE_COUNT = 6;
const NEW_BU_COND = JSON.stringify({ assetScope: ['newbrand', 'newind'] });

async function main() {
  const dbPath = path.join(__dirname, '..', 'dev.db');
  const adapter = new PrismaBetterSqlite3({ url: process.env.DATABASE_URL || `file:${dbPath}` });
  const prisma = new PrismaClient({ adapter });

  const already = await prisma.formField.findFirst({ where: { sectionId: 'oms', fieldKey: '1.4.2.1' } });
  if (already) {
    console.log('Source repeat-group fields already exist — nothing to do.');
    await prisma.$disconnect();
    return;
  }

  const singular = await prisma.formField.findMany({ where: { sectionId: 'oms', fieldKey: { in: ['1.4.2', '1.4.3', '1.4.4'] } } });
  if (singular.length !== 3) throw new Error(`Expected 3 singular source fields, found ${singular.length} — aborting.`);
  for (const f of singular) {
    await prisma.formField.delete({ where: { id: f.id } });
  }
  console.log(`removed ${singular.length} singular source field(s).`);

  const specs = [];
  for (let i = 1; i <= SOURCE_COUNT; i++) specs.push({ fieldKey: `1.4.2.${i}`, label: `Source Type ${i}` });
  for (let i = 1; i <= SOURCE_COUNT; i++) specs.push({ fieldKey: `1.4.3.${i}`, label: `Source Name ${i}` });
  for (let i = 1; i <= SOURCE_COUNT; i++) specs.push({ fieldKey: `1.4.4.${i}`, label: `Suvery Q&A pairs ${i}` });

  // Re-sequence the whole section's `order` around the new block, same
  // relative position the singular fields used to occupy (right after the
  // trigger question, before Metadata Source).
  const rest = await prisma.formField.findMany({ where: { sectionId: 'oms' }, orderBy: { order: 'asc' } });
  const trigger = rest.find((f) => f.fieldKey === '1.4.1');
  const after = rest.filter((f) => f.fieldKey !== '1.4.1');

  let order = 0;
  if (trigger) await prisma.formField.update({ where: { id: trigger.id }, data: { order: order++ } });
  for (const spec of specs) {
    await prisma.formField.create({
      data: {
        sectionId: 'oms',
        fieldKey: spec.fieldKey,
        phase: 'preplan',
        label: spec.label,
        type: 'text',
        owner: 'oms',
        bucket: 'newapp',
        source: '—',
        optionsJson: null,
        condJson: NEW_BU_COND,
        drives: null,
        cascadeFromField: null,
        derivesFrom: null,
        locked: false,
        lockedValue: null,
        wide: false,
        order: order++,
      },
    });
  }
  for (const f of after) {
    await prisma.formField.update({ where: { id: f.id }, data: { order: order++ } });
  }
  console.log(`created ${specs.length} repeat-group source field(s), section re-sequenced.`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
