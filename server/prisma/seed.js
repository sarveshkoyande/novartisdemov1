// Rebuilds the demo dataset on a fresh database.
//
// Render's filesystem is ephemeral: every deploy and every restart starts from
// an empty disk, so the database is recreated by `prisma migrate deploy` and
// then filled by this script. It used to insert only the brand/indication
// rows, which meant a deployed instance came up with no form, no sections and
// no fields — the app loaded blank. It now replays prisma/demo-data.json, a
// snapshot of the working local database (regenerate with
// `node prisma/export-demo-data.js`).
//
// Idempotent per table: a table that already has rows is left completely
// alone, so this is safe to run against a database someone has been using —
// it will not overwrite real edits or duplicate demo content.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// Parents before children so foreign keys resolve.
const TABLES = [
  'Form',
  'FormSection',
  'FormField',
  'BrandIndication',
  'TacticFieldTemplate',
  'NudgeRule',
  'PlanMilestone',
  'FieldEntry',
  'Comment',
  'AgentSkill',
  'AppUser',
  'BrandContact',
  'CampaignMeta',
  'CampaignContact',
  'TriggerFiring',
  'CampaignEmail',
  'JourneyTouchpoint',
];

// DATABASE_URL is a Prisma URL ("file:./dev.db"); better-sqlite3 wants a path.
function resolveDbPath() {
  const url = process.env.DATABASE_URL || 'file:./dev.db';
  const raw = url.startsWith('file:') ? url.slice(5) : url;
  return path.isAbsolute(raw) ? raw : path.resolve(__dirname, '..', raw);
}

function main() {
  const fixturePath = path.join(__dirname, 'demo-data.json');
  if (!fs.existsSync(fixturePath)) {
    console.warn('[seed] prisma/demo-data.json missing — nothing to seed.');
    return;
  }
  const data = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const db = new Database(resolveDbPath());

  let inserted = 0, skipped = 0;
  for (const table of TABLES) {
    const rows = data[table] || [];
    if (!rows.length) continue;
    let existing;
    try {
      existing = db.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get().c;
    } catch (err) {
      console.warn(`[seed] ${table}: no such table, skipping (${err.message})`);
      continue;
    }
    if (existing > 0) {
      console.log(`[seed] ${table.padEnd(22)} already has ${existing} row(s) — left as is`);
      skipped += rows.length;
      continue;
    }
    const cols = Object.keys(rows[0]);
    const stmt = db.prepare(
      `INSERT INTO "${table}" (${cols.map(c => `"${c}"`).join(',')}) VALUES (${cols.map(() => '?').join(',')})`
    );
    // One transaction per table: a partial insert would leave the demo in a
    // state that looks populated to the count check above and would then never
    // be repaired on a later run.
    db.transaction(() => { for (const r of rows) stmt.run(cols.map(c => r[c])); })();
    inserted += rows.length;
    console.log(`[seed] ${table.padEnd(22)} inserted ${rows.length} row(s)`);
  }

  db.close();
  console.log(`[seed] done — ${inserted} row(s) inserted, ${skipped} skipped (table not empty).`);
}

main();
