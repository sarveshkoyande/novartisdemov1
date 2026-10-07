// Sections 3-4 plan: adds the Email Details and Journey Details sections
// with their once-per-campaign fields. Per-email fields 32-41 are not rows
// here (see email-journey-routes.js); the rail and journey builder render
// inside these two sections.
//
// Existing fields that continue are moved in place, never recreated, so
// saved answers survive (A/B 1.2.5-1.2.8 from Generic, refresh 1.8.3-1.8.4
// from Data Cloud). Idempotent.
//
//   node prisma/migrate-email-journey-details.js

require('dotenv').config();
const { PrismaClient } = require('../generated/prisma');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');

const AB = { logic: 'and', rules: [{ key: 'abTesting', value: 'Yes' }] };

const SECTIONS = [
  { id: 'emaildetails', num: '02', name: 'Email Details', icon: 'mail', needs: { preplan: [], plan: ['aor', 'cep'], exec: [] } },
  { id: 'journeydetails', num: '03', name: 'Journey Details', icon: 'route', needs: { preplan: [], plan: ['aor', 'cdm'], exec: [] } },
];

// [section, key, label, owner, from | null, extra]
const FIELDS = [
  ['emaildetails', '42', 'Behavior Chain', 'aor', null, { type: 'ta' }],
  ['emaildetails', '43', 'A/B Testing required?', 'cep', ['generic', '1.2.5']],
  ['emaildetails', '43.1', 'Approximate Audience Size', 'cep', ['generic', '1.2.6']],
  ['emaildetails', '43.2', 'How do you want the test split?', 'cep', ['generic', '1.2.7']],
  ['emaildetails', '43.3', 'How would you like your test to send?', 'cep', ['generic', '1.2.8']],
  ['emaildetails', '43.4', 'Metadata IDs to A/B test', 'cep', null, { type: 'text', cond: AB }],
  ['emaildetails', '44', 'Asset Handoff', 'aor', null, { type: 'text' }],
  ['emaildetails', '44.1', 'Content Brief (If applicable for Studio to complete creative)', 'aor', null, { type: 'file' }],
  ['emaildetails', '44.2', 'MAP Verified / approved PDF', 'aor', null, { type: 'file' }],
  ['emaildetails', '44.3', 'Source file ZIP', 'aor', null, { type: 'file' }],
  ['journeydetails', '50', 'Data Full Refresh or Incremental - Depends on type of Campaign', 'cdm', ['dc', '1.8.3']],
  ['journeydetails', '51', 'Refresh Frequency', 'cdm', ['dc', '1.8.4']],
];

async function main() {
  const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: process.env.DATABASE_URL || 'file:./dev.db' }) });
  const log = [];

  // Sections go right after General Campaign Details; everything else shifts.
  for (let i = 0; i < SECTIONS.length; i++) {
    const s = SECTIONS[i];
    if (await prisma.formSection.findUnique({ where: { id: s.id } })) continue;
    await prisma.formSection.updateMany({ where: { formId: 'form-default', order: { gte: 1 + i } }, data: { order: { increment: 1 } } });
    await prisma.formSection.create({ data: { id: s.id, formId: 'form-default', num: s.num, name: s.name, icon: s.icon, needsJson: JSON.stringify(s.needs), order: 1 + i } });
    log.push(`section ${s.id} created`);
  }

  for (let i = 0; i < FIELDS.length; i++) {
    const [sectionId, key, label, owner, from, extra = {}] = FIELDS[i];
    let row = await prisma.formField.findFirst({ where: { sectionId, fieldKey: key } });
    if (!row && from) row = await prisma.formField.findFirst({ where: { sectionId: from[0], fieldKey: from[1] } });
    const data = { sectionId, fieldKey: key, label, owner, phase: 'plan', order: i };
    if (extra.type) data.type = extra.type;
    if (extra.cond) data.condJson = JSON.stringify(extra.cond);
    if (row) {
      if (Object.entries(data).some(([k, v]) => row[k] !== v)) {
        await prisma.formField.update({ where: { id: row.id }, data });
        if (row.sectionId !== sectionId) {
          const moved = await prisma.fieldEntry.updateMany({ where: { fieldId: row.id }, data: { sectionId } });
          log.push(`moved ${row.sectionId}:${row.fieldKey} -> ${sectionId}:${key} (${moved.count} entries)`);
        } else log.push(`updated ${key}`);
      }
    } else {
      await prisma.formField.create({ data: { ...data, type: extra.type || 'text' } });
      log.push(`created ${key} ${label}`);
    }
  }

  console.log(log.join('\n') || 'nothing to change');
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
