// One-off migration:
// 1. Moves "# of Emails" (email.1.6.1) and "# of SMS" (sms.1.10.1) from
//    preplan to plan phase. They were correctly built as real,
//    admin-manageable fields, just seeded into the wrong phase — the chat
//    interview and the form's phase filter both key off FormField.phase, so
//    both were surfacing them during Pre-planning even though volume sizing
//    is a Planning-stage decision.
// 2. Fixes a fieldKey collision migrate-oms-busetup.js introduced: BU
//    Setup's fields were seeded as "1.6.x", which collides with the
//    pre-existing Email section's "1.6.1" (# of Emails) — same key, two
//    different FormField rows. Renumbers BU Setup to the unused "1.9.x"
//    range instead.
'use strict';
const path = require('path');
const { PrismaClient } = require('../generated/prisma');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');

async function main() {
  const dbPath = path.join(__dirname, '..', 'dev.db');
  const adapter = new PrismaBetterSqlite3({ url: process.env.DATABASE_URL || `file:${dbPath}` });
  const prisma = new PrismaClient({ adapter });

  for (const fieldKey of ['1.6.1', '1.10.1']) {
    // Both keys are ambiguous post BU-Setup fix (1.6.1 exists on both
    // "email" and, briefly, "busetup" until step 2 below runs) — scope by
    // sectionId too so this is safe to run in either order.
    const target = await prisma.formField.findFirst({ where: { fieldKey, sectionId: { in: ['email', 'sms'] } } });
    if (!target) { console.warn(`  ! ${fieldKey} (email/sms) not found — skipped`); continue; }
    await prisma.formField.update({ where: { id: target.id }, data: { phase: 'plan' } });
    console.log(`${target.sectionId}.${fieldKey} (${target.label}): preplan -> plan`);
  }

  const busetupFields = await prisma.formField.findMany({ where: { sectionId: 'busetup' }, orderBy: { order: 'asc' } });
  if (busetupFields.length === 0) {
    console.log('no busetup fields found — nothing to renumber.');
  } else {
    for (const f of busetupFields) {
      const suffix = f.fieldKey.split('.').pop();
      const newKey = `1.9.${suffix}`;
      await prisma.formField.update({ where: { id: f.id }, data: { fieldKey: newKey } });
    }
    console.log(`busetup fieldKeys renumbered: ${busetupFields.length} field(s), 1.6.x -> 1.9.x`);
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
