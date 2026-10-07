// One-time: rewrites existing FormField.condJson rows from the old flat
// object shape ({"audience":"hcp"}) into the new {logic,rules} shape the
// admin condition-builder widget reads/writes ({"logic":"and","rules":[
// {"key":"audience","value":"hcp"}]}). condMet() (client) already reads
// both shapes, so this isn't required for correctness — it's so every row
// looks consistent in the admin UI (the widget always renders from the new
// shape). Safe to re-run: rows already in the new shape are left alone.
'use strict';
const path = require('path');
const { PrismaClient } = require('../generated/prisma');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');

async function main() {
  const dbPath = path.join(__dirname, '..', 'dev.db');
  const adapter = new PrismaBetterSqlite3({ url: process.env.DATABASE_URL || `file:${dbPath}` });
  const prisma = new PrismaClient({ adapter });

  const fields = await prisma.formField.findMany({ where: { condJson: { not: null } } });
  let migrated = 0, skipped = 0;
  for (const f of fields) {
    const parsed = JSON.parse(f.condJson);
    if (Array.isArray(parsed.rules)) { skipped++; continue; } // already new shape
    const rules = Object.entries(parsed).map(([key, value]) => ({ key, value }));
    const newCond = { logic: 'and', rules };
    await prisma.formField.update({ where: { id: f.id }, data: { condJson: JSON.stringify(newCond) } });
    migrated++;
    console.log(`  ${f.fieldKey} (${f.label}): ${f.condJson} -> ${JSON.stringify(newCond)}`);
  }
  console.log(`Migrated ${migrated} condJson rows to the new shape (${skipped} already migrated).`);
  await prisma.$disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
