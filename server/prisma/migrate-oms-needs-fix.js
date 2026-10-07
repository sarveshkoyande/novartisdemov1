// Fixes a real bug: FormField.owner was reassigned across most of the OMS
// section's fields (aor -> oms) two migrations ago, but FormSection.needsJson
// — the list the client checks to decide whether owner-based read-only
// restriction even applies to a section at all — was never updated, still
// reading {"preplan":["aor"]}. Since that list only ever had one entry,
// RequestDetailPage's restrictOwner check (phaseNeeds.length > 1) stayed
// false, so no field in the OMS section was ever actually made read-only
// for a non-owner — AOR could see and edit oms-owned fields like Metadata
// Source freely, even though FormField.owner correctly said "oms" all along.
'use strict';
const path = require('path');
const { PrismaClient } = require('../generated/prisma');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');

async function main() {
  const dbPath = path.join(__dirname, '..', 'dev.db');
  const adapter = new PrismaBetterSqlite3({ url: process.env.DATABASE_URL || `file:${dbPath}` });
  const prisma = new PrismaClient({ adapter });

  const oms = await prisma.formSection.findUnique({ where: { id: 'oms' } });
  if (!oms) throw new Error('oms section not found');
  const needs = JSON.parse(oms.needsJson);
  needs.preplan = ['aor', 'oms'];
  needs.plan = Array.from(new Set([...(needs.plan || []), 'oms']));
  await prisma.formSection.update({ where: { id: 'oms' }, data: { needsJson: JSON.stringify(needs) } });
  console.log('oms needsJson updated to', JSON.stringify(needs));

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
