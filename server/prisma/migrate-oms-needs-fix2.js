// Fixes an over-restrictive cond I set when first building the OMS
// hierarchy/source fields: they were gated on assetScope being New Brand/
// New Indication, which hid them entirely for an "Update Existing
// Campaign" enrollment-triggered request. Per the user's own flow diagram
// (walked through together this session), Franchise/Brand/Program/.../
// Sources and the Source Type/Name/Suvery Q&A pairs 1-6 slots all sit
// downstream of "Survey metadata sheet generated" — reachable via EITHER
// the new-BU path (through CMA) OR the reuse-existing-metadata path, which
// converge before these fields. They should only depend on enrollment
// being Yes, same simple gate Metadata Source (1.4.5b) already uses — not
// on assetScope at all.
'use strict';
const path = require('path');
const { PrismaClient } = require('../generated/prisma');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');

const ENROLLMENT_ONLY_COND = JSON.stringify({ logic: 'and', rules: [{ key: 'enrollment', value: 'yes' }] });

async function main() {
  const dbPath = path.join(__dirname, '..', 'dev.db');
  const adapter = new PrismaBetterSqlite3({ url: process.env.DATABASE_URL || `file:${dbPath}` });
  const prisma = new PrismaClient({ adapter });

  // Every oms field except the trigger question (no cond needed) and the
  // ones that already have their own deliberately narrower cond
  // (Metadata Source: enrollment only — already correct; Attach Metadata
  // Sheet: enrollment + metadataSource=Existing — correct, only relevant
  // on the reuse path; Campaign Source Code: untouched, separate concern).
  const targets = await prisma.formField.findMany({
    where: { sectionId: 'oms', fieldKey: { notIn: ['1.4.1', '1.4.5b', '1.4.7', '1.4.5'] } },
  });
  for (const f of targets) {
    await prisma.formField.update({ where: { id: f.id }, data: { condJson: ENROLLMENT_ONLY_COND } });
  }
  console.log(`updated cond on ${targets.length} oms field(s) to enrollment-only.`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
