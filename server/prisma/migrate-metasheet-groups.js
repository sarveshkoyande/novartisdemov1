// One-time: backfills FormField.groupsJson for the CMA Metadata Sheet's
// `metasheet`-type field. migrate-sections-from-html.js flattened its 10
// groups/45 sub-fields into standalone FormField rows (fieldKey suffixed
// -g{gi}-f{fi}) for the admin table's field count, but never captured the
// groups structure on the metasheet field row itself — so building the live
// form from this table would render CMA's metasheet control with no groups
// at all. This restores it, verbatim from BASE_SECTIONS (hqe-requirement-
// studio-mock_2.html), so the live form's metasheet renderer keeps working
// once section rendering is sourced from the database instead of that array.
'use strict';
const path = require('path');
const { PrismaClient } = require('../generated/prisma');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');

const CMA_GROUPS = [
  { label: "Tact Franchise", fields: ["Name", "BU Name", "Description"] },
  { label: "Tact Brand", fields: ["Name", "Abbreviation", "Franchise", "Division", "Description", "Start Date"] },
  { label: "Tact Program", fields: ["Program Name", "Abbreviation", "Description", "Start Date"] },
  { label: "New Program Brand", fields: ["Program", "Brand"] },
  { label: "Tact Therapy", fields: ["Therapy Class Code", "Therapy Class Name"] },
  { label: "Tact Campaign", fields: ["Name", "Program", "Therapy", "Campaign Type", "Start Date", "Description", "Division", "USMM", "HCP", "Branded", "Metadata_Feed_Vendor"] },
  { label: "New Survey", fields: ["Survey Name", "Campaign Type", "Start Date", "Default"] },
  { label: "New Question", fields: ["Category", "Text", "Description", "Question Type", "Start Date"] },
  { label: "New Answer", fields: ["Tact Question", "Answer Text"] },
  { label: "Tact Source", fields: ["Description", "Medium", "Start Date", "Campaign", "Medium Source Code", "Purpose"] },
];

async function main() {
  const dbPath = path.join(__dirname, '..', 'dev.db');
  const adapter = new PrismaBetterSqlite3({ url: process.env.DATABASE_URL || `file:${dbPath}` });
  const prisma = new PrismaClient({ adapter });

  const field = await prisma.formField.findFirst({ where: { sectionId: 'cma', fieldKey: '1.4.6', type: 'metasheet' } });
  if (!field) {
    console.log('CMA metasheet field (cma / 1.4.6) not found — nothing to backfill.');
  } else {
    await prisma.formField.update({ where: { id: field.id }, data: { groupsJson: JSON.stringify(CMA_GROUPS) } });
    console.log(`Backfilled groupsJson on ${field.id} (${field.label}) — ${CMA_GROUPS.length} groups.`);
  }
  await prisma.$disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
