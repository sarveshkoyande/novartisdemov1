// Enforces the CMA Metadata Sheet section's own documented rule — "It only
// comes into scope once Asset Scope is New Brand/New Indication, Enrollment
// Sign-Up is Yes, and Metadata Source is New metadata" (see the section's
// own `note`) — in the schema, not just prose. All 46 CMA fields had
// condJson: null, so nothing actually stopped the interview from asking
// about them on an Update Existing Campaign / Reuse-existing-metadata
// request, which relied entirely on the model reading and honoring the
// note every time. Same fix pattern as everything else this session: move
// a rule the model was expected to remember into code that can't be
// skipped.
'use strict';
const path = require('path');
const { PrismaClient } = require('../generated/prisma');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');

const CMA_COND = JSON.stringify({
  assetScope: ['newbrand', 'newind'],
  enrollment: 'yes',
  metadataSource: 'New metadata',
});

async function main() {
  const dbPath = path.join(__dirname, '..', 'dev.db');
  const adapter = new PrismaBetterSqlite3({ url: process.env.DATABASE_URL || `file:${dbPath}` });
  const prisma = new PrismaClient({ adapter });

  const result = await prisma.formField.updateMany({
    where: { sectionId: 'cma', condJson: null },
    data: { condJson: CMA_COND },
  });
  console.log(`CMA fields gated: ${result.count}`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
