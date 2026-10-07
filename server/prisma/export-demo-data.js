// Dev tool: snapshot the local dev.db into prisma/demo-data.json, which
// seed.js replays on a fresh deploy.
//
// Why this exists: Render's filesystem is ephemeral, so the deployed database
// is rebuilt from `migrate deploy` + `npm run seed` on every deploy. Without a
// fixture the seed only inserted brand rows, so the deployed app came up with
// no form, no sections and no fields — a blank shell.
//
// Re-run after changing the demo content:  node prisma/export-demo-data.js
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// Insertion order is dependency order — parents before children, so foreign
// keys resolve on replay. Ids are exported verbatim for the same reason.
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

const dbPath = process.argv[2] || path.join(__dirname, '..', 'dev.db');
const db = new Database(dbPath, { readonly: true });

const out = {};
let total = 0;
for (const table of TABLES) {
  try {
    const rows = db.prepare(`SELECT * FROM "${table}"`).all();
    out[table] = rows;
    total += rows.length;
    console.log(`${table.padEnd(22)} ${rows.length}`);
  } catch (err) {
    console.warn(`${table.padEnd(22)} skipped (${err.message})`);
    out[table] = [];
  }
}

const dest = path.join(__dirname, 'demo-data.json');
fs.writeFileSync(dest, JSON.stringify(out, null, 1));
console.log(`\nWrote ${total} rows to ${dest}`);
