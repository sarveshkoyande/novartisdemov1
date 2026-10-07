// Reorganises the form into the client's structure: General Campaign Details
// (10-31), Email Details (42-44.3 here; 32-41 live in the email rail) and
// Journey Details (50-51 here; 45-49 live in the journey builder). The older
// sections (Journey, OMS, MCI, Data Cloud, BU Setup, CMA, Email/SMS/MDS/
// Automatrix tactics) and the legacy General fields are removed, along with
// any answers saved against them. Idempotent.
const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '..', 'dev.db'));

const KEEP = ['generic', 'emaildetails', 'journeydetails'];
const GENERAL = ['10', '11', '12', '13', '14', '15', '16', '17', '18', '19', '20', '20.1', '20.2', '21', '22', '22.1', '22.2', '22.3', '23', '24', '24.1', '25', '26', '27', '28', '29', '30', '31'];
const EMAIL = ['42', '43', '43.1', '43.2', '43.3', '43.4', '44', '44.1', '44.2', '44.3'];
const JOURNEY = ['50', '51'];
const NAMES = { generic: ['2', 'General Campaign Details'], emaildetails: ['3', 'Email Details'], journeydetails: ['4', 'Journey Details'] };

db.transaction(() => {
  const ph = (n) => Array(n).fill('?').join(',');
  const oldSections = db.prepare(`SELECT id FROM FormSection WHERE id NOT IN (${ph(KEEP.length)})`).all(...KEEP).map((r) => r.id);
  const legacy = db.prepare(`SELECT id FROM FormField WHERE sectionId = 'generic' AND fieldKey NOT IN (${ph(GENERAL.length)})`).all(...GENERAL).map((r) => r.id);
  const legacyIds = [...legacy, ...db.prepare(`SELECT id FROM FormField WHERE sectionId IN (${ph(oldSections.length)})`).all(...oldSections).map((r) => r.id)];

  const e1 = db.prepare(`DELETE FROM FieldEntry WHERE sectionId IN (${ph(oldSections.length)})`).run(...oldSections).changes;
  const e2 = legacy.length ? db.prepare(`DELETE FROM FieldEntry WHERE fieldId IN (${ph(legacy.length)})`).run(...legacy).changes : 0;
  db.prepare(`DELETE FROM SectionState WHERE sectionId IN (${ph(oldSections.length)})`).run(...oldSections);
  if (legacy.length) db.prepare(`DELETE FROM FormField WHERE id IN (${ph(legacy.length)})`).run(...legacy);
  db.prepare(`DELETE FROM FormSection WHERE id IN (${ph(oldSections.length)})`).run(...oldSections);
  const t = db.prepare('DELETE FROM TacticFieldTemplate').run().changes;

  const order = db.prepare('UPDATE FormField SET "order" = ?, phase = ? WHERE sectionId = ? AND fieldKey = ?');
  GENERAL.forEach((k, i) => order.run(i, 'preplan', 'generic', k));
  EMAIL.forEach((k, i) => order.run(i, 'plan', 'emaildetails', k));
  JOURNEY.forEach((k, i) => order.run(i, 'plan', 'journeydetails', k));
  db.prepare(`UPDATE FieldEntry SET phase = 'preplan' WHERE sectionId = 'generic'`).run();
  db.prepare(`UPDATE FieldEntry SET phase = 'plan' WHERE sectionId IN ('emaildetails','journeydetails')`).run();
  db.prepare(`UPDATE FormField SET label = 'From Name/From Friendly (Sender profile)' WHERE sectionId = 'generic' AND fieldKey = '26'`).run();

  const sec = db.prepare('UPDATE FormSection SET num = ?, name = ?, "order" = ? WHERE id = ?');
  KEEP.forEach((id, i) => sec.run(NAMES[id][0], NAMES[id][1], i, id));

  console.log(`removed sections: ${oldSections.join(', ')}`);
  console.log(`removed ${legacyIds.length} fields (${legacy.length} legacy General), ${e1 + e2} saved answers, ${t} tactic templates`);
})();

const left = db.prepare(`SELECT s.id, COUNT(f.id) n FROM FormSection s LEFT JOIN FormField f ON f.sectionId = s.id GROUP BY s.id ORDER BY s."order"`).all();
console.log('sections now:', left.map((r) => `${r.id}=${r.n}`).join(', '));
