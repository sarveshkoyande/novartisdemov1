// Demo Contact Details defaults for every brand in the fixed brand list
// (seed-brand-list.js). Adds a few demo people so brands don't all share the
// same team. Idempotent: users matched by name; defaults upserted per slot.
// Anything here can be changed later in Admin -> Brands -> Default contacts,
// or per campaign by CDM in Orchestration.
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const db = new Database(path.join(__dirname, '..', 'dev.db'));

const EXTRA_USERS = [
  ['Sofia Martins', 'xm', 'Novartis'],
  ['Daniel Kim', 'xm', 'Novartis'],
  ['Grace Liu', 'cdm', 'Novartis'],
  ['Omar Haddad', 'cdm', 'Novartis'],
  ['Hannah Weiss', 'ops', 'Novartis'],
  ['Arjun Patel', 'ops', 'Novartis'],
  ['Chloe Dubois', 'solutionArchitect', 'Novartis'],
  ['Ben Carter', 'mds', 'Novartis'],
  ['Isabel Romero', 'cep', 'Novartis'],
  ['Kenji Sato', 'dca', 'Novartis'],
  ['Laura Rossi', 'aor', 'VML'],
  ['Mei Wong', 'aor', 'McCann Health'],
];

const now = new Date().toISOString();
const findUser = db.prepare('SELECT id FROM AppUser WHERE name = ?');
const addUser = db.prepare('INSERT INTO AppUser (id, name, email, roleType, brand, createdAt, organization) VALUES (?, ?, NULL, ?, NULL, ?, ?)');
const id = (name) => {
  const row = findUser.get(name);
  if (!row) throw new Error(`No AppUser named ${name}`);
  return row.id;
};

// slot order: contentOwner, agency, deliveryManager, deliveryCoordinator,
// solutionArchitect, mds, cep, tagging, proofRecipients
const TEAMS = {
  Leqvio:               ['Emily Chen',    'Ogilvy',        'Lena Park',   'Hannah Weiss', 'Jordan Blake',  'Anita Rao', 'Tomás Okafor',  'Sam Wright', ['Marco Diaz', 'Emily Chen']],
  Entresto:             ['Emily Chen',    'Ogilvy',        'Lena Park',   'Hannah Weiss', 'Jordan Blake',  'Anita Rao', 'Tomás Okafor',  'Sam Wright', ['Priya Sharma', 'Emily Chen']],
  Kisqali:              ['Sofia Martins', 'Havas',         'Naveen Iyer', 'Arjun Patel',  'Chloe Dubois',  'Ben Carter', 'Isabel Romero', 'Kenji Sato', ['Marco Diaz', 'Sofia Martins']],
  Pluvicto:             ['Sofia Martins', 'Havas',         'Naveen Iyer', 'Arjun Patel',  'Chloe Dubois',  'Ben Carter', 'Isabel Romero', 'Kenji Sato', ['Marco Diaz', 'Sofia Martins']],
  Scemblix:             ['Sofia Martins', 'McCann Health', 'Grace Liu',   'Arjun Patel',  'Chloe Dubois',  'Ben Carter', 'Isabel Romero', 'Kenji Sato', ['Mei Wong', 'Sofia Martins']],
  'Tafinlar + Mekinist':['Sofia Martins', 'McCann Health', 'Grace Liu',   'Arjun Patel',  'Chloe Dubois',  'Ben Carter', 'Isabel Romero', 'Kenji Sato', ['Mei Wong', 'Sofia Martins']],
  Lutathera:            ['Sofia Martins', 'Havas',         'Grace Liu',   'Arjun Patel',  'Chloe Dubois',  'Ben Carter', 'Isabel Romero', 'Kenji Sato', ['Marco Diaz', 'Sofia Martins']],
  Cosentyx:             ['Daniel Kim',    'VML',           'Omar Haddad', 'Hannah Weiss', 'Jordan Blake',  'Anita Rao', 'Isabel Romero', 'Sam Wright', ['Laura Rossi', 'Daniel Kim']],
  Xolair:               ['Daniel Kim',    'VML',           'Omar Haddad', 'Hannah Weiss', 'Jordan Blake',  'Anita Rao', 'Isabel Romero', 'Sam Wright', ['Laura Rossi', 'Daniel Kim']],
  Fabhalta:             ['Daniel Kim',    'McCann Health', 'Grace Liu',   'Hannah Weiss', 'Chloe Dubois',  'Ben Carter', 'Tomás Okafor',  'Kenji Sato', ['Mei Wong', 'Daniel Kim']],
  Kesimpta:             ['Emily Chen',    'Ogilvy',        'Omar Haddad', 'Arjun Patel',  'Jordan Blake',  'Ben Carter', 'Tomás Okafor',  'Sam Wright', ['Priya Sharma', 'Emily Chen']],
  Zolgensma:            ['Emily Chen',    'VML',           'Omar Haddad', 'Arjun Patel',  'Chloe Dubois',  'Anita Rao', 'Tomás Okafor',  'Kenji Sato', ['Laura Rossi', 'Emily Chen']],
};
const SLOTS = ['contentOwner', 'agency', 'deliveryManager', 'deliveryCoordinator', 'solutionArchitect', 'mds', 'cep', 'tagging', 'proofRecipients'];

const upsert = db.prepare(`INSERT INTO BrandContact (brand, slot, value) VALUES (?, ?, ?)
  ON CONFLICT(brand, slot) DO UPDATE SET value = excluded.value`);

db.transaction(() => {
  for (const [name, role, org] of EXTRA_USERS) {
    if (!findUser.get(name)) addUser.run('demo_' + crypto.randomBytes(8).toString('hex'), name, role, now, org);
  }
  for (const [brand, team] of Object.entries(TEAMS)) {
    team.forEach((v, i) => {
      const slot = SLOTS[i];
      const value = slot === 'agency' ? v : Array.isArray(v) ? JSON.stringify(v.map(id)) : id(v);
      upsert.run(brand, slot, value);
    });
  }
})();

console.log('AppUsers:', db.prepare('SELECT COUNT(*) n FROM AppUser').get().n, '· BrandContact rows:', db.prepare('SELECT COUNT(*) n FROM BrandContact').get().n);
