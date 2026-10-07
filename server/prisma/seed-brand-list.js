// Fixed Brand -> Indication -> Therapeutic Area list. Existing brands (field
// 13 = No) pick from this list in the New Request modal; new brands type
// freely. Idempotent: upserts by (brand, indication).
require('dotenv').config();
const Database = require('better-sqlite3');
const path = require('path');

const LIST = [
  ['Kisqali', 'HR+/HER2− early breast cancer', 'Oncology'],
  ['Kisqali', 'HR+/HER2− metastatic breast cancer', 'Oncology'],
  ['Pluvicto', 'PSMA-positive metastatic castration-resistant prostate cancer', 'Oncology'],
  ['Scemblix', 'Chronic myeloid leukemia (CML)', 'Oncology'],
  ['Tafinlar + Mekinist', 'BRAF V600E/K melanoma', 'Oncology'],
  ['Lutathera', 'Gastroenteropancreatic neuroendocrine tumors (GEP-NETs)', 'Oncology'],
  ['Cosentyx', 'Plaque psoriasis', 'Immunology'],
  ['Cosentyx', 'Psoriatic arthritis', 'Immunology'],
  ['Cosentyx', 'Hidradenitis suppurativa', 'Immunology'],
  ['Cosentyx', 'Ankylosing spondylitis', 'Immunology'],
  ['Xolair', 'Chronic spontaneous urticaria', 'Immunology'],
  ['Fabhalta', 'Paroxysmal nocturnal hemoglobinuria (PNH)', 'Renal / Hematology'],
  ['Fabhalta', 'IgA nephropathy', 'Renal / Hematology'],
  ['Entresto', 'Heart failure with reduced ejection fraction (HFrEF)', 'Cardiovascular'],
  ['Entresto', 'Heart failure with preserved ejection fraction (HFpEF)', 'Cardiovascular'],
  ['Leqvio', 'Hyperlipidemia / LDL-C reduction', 'Cardiovascular'],
  ['Kesimpta', 'Relapsing multiple sclerosis', 'Neuroscience'],
  ['Zolgensma', 'Spinal muscular atrophy (SMA)', 'Neuroscience'],
];

const db = new Database(path.join(__dirname, '..', 'dev.db'));
const up = db.prepare(`INSERT INTO BrandIndication (brand, indication, brandedUnbranded, therapeuticArea)
  VALUES (?, ?, 'Branded', ?) ON CONFLICT(brand, indication) DO UPDATE SET therapeuticArea = excluded.therapeuticArea`);
db.transaction(() => LIST.forEach(([b, i, ta]) => up.run(b, i, ta)))();
console.log('BrandIndication rows:', db.prepare('SELECT COUNT(*) n FROM BrandIndication').get().n);
