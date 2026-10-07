// Trims the "and the CMA Metadata Sheet" clause off the OMS enrollment-
// trigger nudge — the CMA Metadata Sheet is a separate section/handoff
// with its own reminder rule (see the fields_remaining rule further down
// in nudge-rules), so naming it here too reads as OMS being asked for a
// document that isn't actually theirs to provide.
'use strict';
const path = require('path');
const { PrismaClient } = require('../generated/prisma');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');

async function main() {
  const dbPath = path.join(__dirname, '..', 'dev.db');
  const adapter = new PrismaBetterSqlite3({ url: process.env.DATABASE_URL || `file:${dbPath}` });
  const prisma = new PrismaClient({ adapter });

  const rule = await prisma.nudgeRule.findFirst({ where: { nudgeToOwner: 'oms', triggerFieldDrives: 'enrollment' } });
  if (!rule) throw new Error('OMS enrollment-trigger nudge rule not found');

  const newNudgeMessage = 'AOR has confirmed this campaign is triggered by an enrollment form sign-up. Please upload the required Source/Program/Survey details for this campaign.';
  await prisma.nudgeRule.update({ where: { id: rule.id }, data: { nudgeMessage: newNudgeMessage } });
  console.log('Updated nudgeMessage:', newNudgeMessage);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
