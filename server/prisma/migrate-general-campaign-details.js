// Restructures Generic/Overview into the client's General Campaign Details,
// fields 10-31 (sections 1-2 plan, U2). Existing rows are updated in place,
// never deleted and recreated: FieldEntry and `ref` conditions point at
// FormField.id, so keeping the id keeps every saved answer.
//
// fieldKey changes to the client's number. Anything that still points at an
// old key (derivesFrom, cascadeFromField, NudgeRule.triggerFieldKey, and
// legacy FieldEntry rows keyed by fieldKey) is rewritten in the same run.
//
// Idempotent: each target is looked up by its old OR new key, so a second
// run finds the already-migrated row and changes nothing.
//
//   node prisma/migrate-general-campaign-details.js [--dry]

require('dotenv').config();
const { PrismaClient } = require('../generated/prisma');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');

const SECTION = 'generic';
const DRY = process.argv.includes('--dry');

// [new key, label, owner, phase, from: [sectionId, oldKey] | null, extra]
// `from: null` means the field is genuinely new. `cond` values name another
// row by NEW key and are resolved to that row's id below (strict ref rule).
const FIELDS = [
  ['10', 'TactPlan ID', 'cdm', 'preplan', ['generic', '1.1.1']],
  ['11', 'Channels Type', 'cdm', 'preplan', ['generic', '1.1.6b']],
  ['12', 'Request Type (Asset Scope)', 'cdm', 'preplan', ['generic', '1.1.7']],
  ['13', 'New Brand?', 'cdm', 'preplan', null, { type: 'sel', opts: ['Yes', 'No'] }],
  ['14', 'Brand', 'cdm', 'preplan', ['generic', '1.1.3']],
  ['15', 'Indication', 'cdm', 'preplan', ['generic', '1.1.4']],
  ['16', 'Therapeutic Area', 'cdm', 'preplan', ['generic', '1.1.15']],
  ['17', 'Branded/Unbranded', 'cdm', 'preplan', ['generic', '1.1.5']],
  ['18', 'Audience Type', 'cdm', 'preplan', ['generic', '1.1.6']],
  ['19', 'Campaign code', 'oms', 'preplan', ['generic', '1.1.10']],
  ['20', 'Send Time Optimization', 'cdm', 'preplan', ['generic', '1.2.1']],
  ['20.1', 'Sending Time Window', 'cdm', 'preplan', ['generic', '1.2.2'], { cond: { ref: '20', value: 'Yes' } }],
  ['20.2', 'STO Random', 'cdm', 'preplan', ['generic', '1.2.3'], { cond: { ref: '20', value: 'Yes' } }],
  ['21', 'Campaign Name', 'aor', 'plan', ['generic', '1.1.8']],
  ['22', 'Campaign Type', 'aor', 'plan', ['generic', '1.1.12']],
  ['22.1', 'Has Enrolment Form?', 'aor', 'plan', ['oms', '1.4.1']],
  ['22.2', 'Is Survey Sheet Available?', 'aor', 'plan', null, { type: 'sel', opts: ['Yes', 'No'], cond: { ref: '22.1', value: 'Yes' } }],
  ['22.3', 'Attach Survey Sheet', 'aor', 'plan', null, { type: 'file', cond: { ref: '22.2', value: 'Yes' } }],
  ['23', 'Campaign Goal', 'aor', 'plan', ['generic', '1.1.9']],
  ['24', 'Number of Emails', 'aor', 'plan', ['email', '1.6.1']],
  ['24.1', 'Number of SMS', 'aor', 'plan', ['sms', '1.10.1']],
  ['25', 'Desired campaign GO LIVE date', 'aor', 'plan', ['generic', '1.1.19']],
  ['26', 'From Name/From Friendly', 'aor', 'plan', ['generic', '1.1.16']],
  ['27', 'Segment Name', 'aor', 'plan', ['generic', '1.1.13']],
  ['28', 'Segment Rules', 'cdm', 'plan', ['dc', '1.8.1'], { type: 'ta' }],
  ['29', 'Specialty Inclusion', 'cdm', 'plan', ['dc', '1.8.6']],
  ['30', 'Specialty Exclusion', 'cdm', 'plan', ['dc', '1.8.7']],
  ['31', 'User Exit Criteria for Campaign Journey', 'cdm', 'plan', null, { type: 'ta' }],
];

async function main() {
  const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: process.env.DATABASE_URL || 'file:./dev.db' }) });
  const log = [];
  const rename = {}; // old fieldKey -> new fieldKey, for references elsewhere
  const idByKey = {};

  const find = async (newKey, from) => {
    const byNew = await prisma.formField.findFirst({ where: { sectionId: SECTION, fieldKey: newKey } });
    if (byNew || !from) return byNew;
    return prisma.formField.findFirst({ where: { sectionId: from[0], fieldKey: from[1] } });
  };

  // Pass 1: create or update every target row (conds resolved in pass 2,
  // once every id is known).
  for (let i = 0; i < FIELDS.length; i++) {
    const [key, label, owner, phase, from, extra = {}] = FIELDS[i];
    const order = i;
    const existing = await find(key, from);
    if (existing) {
      if (existing.fieldKey !== key) rename[existing.fieldKey] = key;
      const data = { sectionId: SECTION, fieldKey: key, label, owner, phase, order };
      if (extra.type) data.type = extra.type;
      if (extra.opts) data.optionsJson = JSON.stringify(extra.opts);
      const changed = Object.entries(data).some(([k, v]) => existing[k] !== v);
      if (changed) {
        log.push(`update ${existing.sectionId}:${existing.fieldKey} -> ${key} ${label}`);
        if (!DRY) await prisma.formField.update({ where: { id: existing.id }, data });
      }
      idByKey[key] = existing.id;
    } else {
      log.push(`create ${key} ${label}`);
      if (!DRY) {
        const row = await prisma.formField.create({
          data: {
            sectionId: SECTION, fieldKey: key, label, owner, phase, order,
            type: extra.type || 'text',
            optionsJson: extra.opts ? JSON.stringify(extra.opts) : null,
          },
        });
        idByKey[key] = row.id;
      } else {
        idByKey[key] = `(new ${key})`;
      }
    }
  }

  // Pass 2: strict `ref` visibility rules.
  for (const [key, , , , , extra = {}] of FIELDS) {
    if (!extra.cond) continue;
    const condJson = JSON.stringify({ ref: idByKey[extra.cond.ref], value: extra.cond.value });
    const row = DRY ? null : await prisma.formField.findUnique({ where: { id: idByKey[key] } });
    if (DRY || row.condJson !== condJson) {
      log.push(`cond ${key} <- ${extra.cond.ref} = ${extra.cond.value}`);
      if (!DRY) await prisma.formField.update({ where: { id: idByKey[key] }, data: { condJson } });
    }
  }

  // Pass 3: anything still pointing at an old key. Old generic keys can
  // collide with nothing else ("1.1.x"/"1.2.x"/"1.4.1"/...), so a plain
  // key-for-key rewrite is safe.
  for (const [oldKey, newKey] of Object.entries(rename)) {
    const n = { derives: 0, cascade: 0, tmpl: 0, nudge: 0, entries: 0 };
    if (!DRY) {
      n.derives = (await prisma.formField.updateMany({ where: { derivesFrom: oldKey }, data: { derivesFrom: newKey } })).count;
      n.cascade = (await prisma.formField.updateMany({ where: { cascadeFromField: oldKey }, data: { cascadeFromField: newKey } })).count;
      n.tmpl = (await prisma.tacticFieldTemplate.updateMany({ where: { cascadeFromField: oldKey }, data: { cascadeFromField: newKey } })).count;
      n.nudge = (await prisma.nudgeRule.updateMany({ where: { triggerFieldKey: oldKey }, data: { triggerFieldKey: newKey } })).count;
      // Legacy entries keyed by fieldKey: move them to the new section/key.
      // Skip any that would collide with an entry already at the new key.
      const legacy = await prisma.fieldEntry.findMany({ where: { fieldId: oldKey } });
      for (const e of legacy) {
        const clash = await prisma.fieldEntry.findFirst({ where: { tactplanId: e.tactplanId, sectionId: SECTION, fieldId: newKey } });
        if (clash) continue;
        await prisma.fieldEntry.update({ where: { id: e.id }, data: { fieldId: newKey, sectionId: SECTION } });
        n.entries++;
      }
    }
    log.push(`refs ${oldKey} -> ${newKey}: ${JSON.stringify(n)}`);
  }

  // Entries saved by FormField.id under a moved field's OLD section still
  // carry that section id; move them so section-scoped reads find them.
  if (!DRY) {
    const ids = Object.values(idByKey);
    const moved = await prisma.fieldEntry.updateMany({ where: { fieldId: { in: ids }, NOT: { sectionId: SECTION } }, data: { sectionId: SECTION } });
    if (moved.count) log.push(`moved ${moved.count} id-keyed entries into ${SECTION}`);
  }

  // The section itself: client's name, and every role that now owns a field.
  const needsJson = JSON.stringify({ preplan: ['cdm', 'oms'], plan: ['aor', 'cdm'], exec: ['aor'] });
  const section = await prisma.formSection.findUnique({ where: { id: SECTION } });
  if (section && (section.name !== 'General Campaign Details' || section.needsJson !== needsJson)) {
    log.push('section renamed to General Campaign Details, needs updated');
    if (!DRY) await prisma.formSection.update({ where: { id: SECTION }, data: { name: 'General Campaign Details', needsJson } });
  }

  // Report generic fields with no new number. They stay, after field 31.
  const leftovers = await prisma.formField.findMany({
    where: { sectionId: SECTION, NOT: { fieldKey: { in: FIELDS.map((f) => f[0]) } } },
    orderBy: { order: 'asc' },
  });
  for (let i = 0; i < leftovers.length; i++) {
    const f = leftovers[i];
    if (!DRY && f.order !== 100 + i) await prisma.formField.update({ where: { id: f.id }, data: { order: 100 + i } });
  }
  log.push(`unmapped (kept, after 31): ${leftovers.map((f) => `${f.fieldKey} ${f.label}`).join('; ') || 'none'}`);

  console.log((DRY ? '[dry run]\n' : '') + (log.join('\n') || 'nothing to change'));
  await prisma.$disconnect();
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { FIELDS };
