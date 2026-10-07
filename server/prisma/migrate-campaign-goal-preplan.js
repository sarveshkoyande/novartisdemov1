// Moves "Campiagn Goal" (generic.1.1.9) from plan phase to preplan — per
// direct instruction, it belongs in Pre-planning, positioned after the 9
// intake-generated fields (TactPlan ID through Campaign Name, order 0-8)
// rather than mixed in among them. Its order (9) was already the next slot
// after Campaign Name (order 8), so no reordering needed — just the phase
// flip.
'use strict';
const path = require('path');
const { PrismaClient } = require('../generated/prisma');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');

async function main() {
  const dbPath = path.join(__dirname, '..', 'dev.db');
  const adapter = new PrismaBetterSqlite3({ url: process.env.DATABASE_URL || `file:${dbPath}` });
  const prisma = new PrismaClient({ adapter });

  const field = await prisma.formField.findFirst({ where: { fieldKey: '1.1.9', sectionId: 'generic' } });
  if (!field) throw new Error('generic 1.1.9 (Campiagn Goal) not found');
  await prisma.formField.update({ where: { id: field.id }, data: { phase: 'preplan' } });
  console.log(`generic 1.1.9 (${field.label}): plan -> preplan, order stays ${field.order}`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
