// One-off, after migrate-general-campaign-details.js: every existing campaign
// whose handoff conditions are already met gets those handoffs recorded as
// done by "migration", with no notification. Otherwise its next edit would
// send a pile of late notifications for work that already happened.
// Idempotent: the unique key skips anything already recorded.
//
//   node prisma/backfill-handoffs.js

require('dotenv').config();
const { PrismaClient } = require('../generated/prisma');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
const handoffs = require('../handoffs');

async function main() {
  const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: process.env.DATABASE_URL || 'file:./dev.db' }) });
  const ids = (await prisma.fieldEntry.findMany({ distinct: ['tactplanId'], select: { tactplanId: true } })).map((r) => r.tactplanId);
  let recorded = 0;
  for (const tactplanId of ids) {
    const [v, meta, emails] = await Promise.all([
      handoffs.fieldValues(prisma, tactplanId),
      prisma.campaignMeta.findUnique({ where: { tactplanId } }),
      handoffs.emailStates(prisma, tactplanId),
    ]);
    const met = handoffs.evaluate({ v, brandCode: meta && meta.brandCode, emails });
    for (const triggerId of met) {
      try {
        await prisma.triggerFiring.create({ data: { tactplanId, triggerId, doneAt: new Date(), doneBy: 'migration' } });
        recorded++;
      } catch (err) {
        if (err.code !== 'P2002') throw err;
      }
    }
  }
  console.log(`checked ${ids.length} campaigns, recorded ${recorded} handoffs as done`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
