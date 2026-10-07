// Same class of fix as migrate-oms-needs-fix.js: generic section's plan-phase
// needsJson listed ["aor","xm"], but no field in that section (any phase) is
// actually owner "xm" — a stale leftover from schema history. Harmless in
// practice (no xm-owned field exists there to be wrongly restricted), but a
// real "who's supposed to touch this" record shouldn't lie. Left dc's
// mismatch alone — that one's tangled up with the Data Cloud
// XM-vs-DCA ownership issue already flagged separately and deferred.
'use strict';
const path = require('path');
const { PrismaClient } = require('../generated/prisma');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');

async function main() {
  const dbPath = path.join(__dirname, '..', 'dev.db');
  const adapter = new PrismaBetterSqlite3({ url: process.env.DATABASE_URL || `file:${dbPath}` });
  const prisma = new PrismaClient({ adapter });

  const generic = await prisma.formSection.findUnique({ where: { id: 'generic' } });
  if (!generic) throw new Error('generic section not found');
  const needs = JSON.parse(generic.needsJson);
  needs.plan = ['aor'];
  await prisma.formSection.update({ where: { id: 'generic' }, data: { needsJson: JSON.stringify(needs) } });
  console.log('generic needsJson updated to', JSON.stringify(needs));

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
