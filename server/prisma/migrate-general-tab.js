// CR-3: every General Campaign Details field (10-31) lives on the General
// (preplan) tab. 21-31 used to be plan phase, which put them on Journey.
// Idempotent. Also moves any saved answers so phase-filtered counts agree.
const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '..', 'dev.db'));
const KEYS = ['21', '22', '22.1', '22.2', '22.3', '23', '24', '24.1', '25', '26', '27', '28', '29', '30', '31'];
const ids = db.prepare(`SELECT id FROM FormField WHERE sectionId = 'generic' AND fieldKey IN (${KEYS.map(() => '?').join(',')})`).all(...KEYS).map((r) => r.id);
db.transaction(() => {
  const f = db.prepare(`UPDATE FormField SET phase = 'preplan' WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
  const e = db.prepare(`UPDATE FieldEntry SET phase = 'preplan' WHERE fieldId IN (${ids.map(() => '?').join(',')})`).run(...ids);
  console.log('fields moved:', f.changes, '· entries moved:', e.changes);
})();
