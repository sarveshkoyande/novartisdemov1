// One-time: seeds NudgeRule with the triggers that were previously
// hardcoded branches in runReactCheckpoint() (hqe-requirement-studio-mock_2.html)
// — CPF-submitted -> Visio nudge, Asset Scope -> BU Setup nudge, Channel
// Type / Enrollment change messages — so behavior after the cutover to
// evaluateNudgeRules() is identical, just sourced from rows instead of code.
//
// CMA-Metadata-Sheet-remaining reminder is now migrated too, as a
// "fields_remaining" trigger (see schema.prisma NudgeRule + evaluateNudgeRules()
// in the client) — it fires while metasheetFieldRemaining('cma','1.4.6') > 0,
// gated by the same compound condition the old hardcoded branch checked
// (enrollment=Yes AND metadataSource=New metadata), now expressed via
// conditionsJson instead of an inline if().
//
// Also seeds one phase_complete rule (triggerPhase="preplan") as the
// concrete, admin-editable answer to "how is CPF completion defined" —
// previously not defined anywhere as data at all.
'use strict';
const path = require('path');
const { PrismaClient } = require('../generated/prisma');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');

const RULES = [
  {
    trigger: 'section_submitted', triggerSectionId: 'generic',
    message: 'CPF journey initiated — the Visio diagram can now be updated in parallel.',
    nudgeMessage: 'A nudge has been sent to <b>Campaign Operations</b> to confirm the Visio build. Note: the diagram itself is generated automatically.',
    nudgeToOwner: 'ops',
  },
  {
    trigger: 'field_value_equals', triggerFieldDrives: 'assetScope', triggerValue: 'newbrand',
    message: 'Great — <b>Asset Scope: New Brand Launch</b> is set. A <b>BU Setup</b> block now runs in parallel with CPF.',
    nudgeMessage: 'A Business Unit setup task has been assigned to the <b>SFMC Product Owner (CEP)</b> and <b>MDS/Data Cloud</b>.',
    nudgeToOwner: 'cep',
  },
  {
    trigger: 'field_value_equals', triggerFieldDrives: 'assetScope', triggerValue: 'newind',
    message: 'Great — <b>Asset Scope: New Indication Launch</b> is set. A <b>BU Setup</b> block now runs in parallel with CPF, just as it does for a new brand.',
    nudgeMessage: 'A Business Unit setup task has been assigned to the <b>SFMC Product Owner (CEP)</b> and <b>MDS/Data Cloud</b>.',
    nudgeToOwner: 'cep',
  },
  {
    trigger: 'field_value_equals', triggerFieldDrives: 'assetScope', triggerValue: 'update',
    message: 'Great — <b>Asset Scope: Update Existing Campaign</b> is set. No new Business Unit needed. <br><b>Next:</b> set Channel Type and move on to CPF details.',
  },
  {
    trigger: 'field_value_equals', triggerFieldDrives: 'channels', triggerValue: 'Email + SMS',
    message: 'Nice — Channel Type set to <b>Email + SMS</b>. Both the Email and SMS build sections are now in scope. <br><b>Next:</b> Automatrix will unlock once Email produces a FUSE ID.',
  },
  {
    trigger: 'field_value_equals', triggerFieldDrives: 'channels', triggerValue: 'Email only',
    message: 'Nice — Channel Type set to <b>Email only</b>. The Email build section is in scope; SMS stays hidden — none of its fields will be asked.',
  },
  {
    trigger: 'field_value_equals', triggerFieldDrives: 'channels', triggerValue: 'SMS only',
    message: 'Nice — Channel Type set to <b>SMS only</b>. The SMS build section is in scope; Email stays hidden — none of its fields will be asked.',
  },
  {
    trigger: 'field_value_equals', triggerFieldDrives: 'enrollment', triggerValue: 'Yes',
    message: 'Great — Enrollment Sign-Up set to <b>Yes</b>. This doesn\'t change the Source/Program/Survey fields — those already show or hide purely on Asset Scope. What it does unlock: Campaign Source Code and the Metadata Sheet, which need <b>both</b> Asset Scope = New Brand/New Indication <b>and</b> this set to Yes. <br><b>Next:</b> if Metadata Source = New metadata, the CMA sheet grouped fields open up for the AOR to fill directly; the Data Enablement (DE) team picks it up from there.',
  },
  {
    trigger: 'field_value_equals', triggerFieldDrives: 'enrollment', triggerValue: 'No',
    message: 'Got it — Enrollment Sign-Up set to <b>No</b>. Campaign Source Code and the Metadata Sheet get disabled — the DE team\'s workflow won\'t trigger. Everything else in OMS (Source Type, Franchise, Program, Survey, etc.) is unaffected — those only depend on Asset Scope.',
  },
  {
    trigger: 'phase_complete', triggerPhase: 'preplan',
    message: 'CPF details are fully complete — every preplanning field is filled across all owners.',
    nudgeMessage: 'Ready to move to <b>CRF & Tactic Build</b> — Campaign Operations can advance the phase when ready.',
    nudgeToOwner: 'ops',
  },
  {
    trigger: 'fields_remaining', triggerSectionId: 'cma', triggerFieldKey: '1.4.6',
    conditionsJson: JSON.stringify({ logic: 'and', rules: [
      { key: 'enrollment', value: 'Yes' }, { key: 'metadataSource', value: 'New metadata' },
    ] }),
    message: 'CMA Metadata Sheet still needs <b>{{remaining}} of {{total}}</b> fields filled.',
    nudgeMessage: 'A reminder has been sent to the <b>AOR</b> to complete the remaining CMA Metadata Sheet fields; Data Enablement is waiting on it.',
    nudgeToOwner: 'aor',
  },
];

async function main() {
  const dbPath = path.join(__dirname, '..', 'dev.db');
  const adapter = new PrismaBetterSqlite3({ url: process.env.DATABASE_URL || `file:${dbPath}` });
  const prisma = new PrismaClient({ adapter });

  await prisma.nudgeRule.deleteMany({});
  for (let i = 0; i < RULES.length; i++) {
    await prisma.nudgeRule.create({ data: { ...RULES[i], order: i, active: false } });
  }
  console.log(`Seeded ${RULES.length} NudgeRule rows.`);
  await prisma.$disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
