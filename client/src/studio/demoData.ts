// @ts-nocheck — fixtures ported from the prototype's demo-data.js.
// Business definitions stay in docs/campaign-schema.json. These values are NOT master data.
export const brand = {
  demoPlaceholder: true,
  name: 'Demo Brand A',
  indication: 'Demo indication A',
  therapeuticArea: 'Demo therapeutic area A',
  branded: 'Branded',
  team: {
    '1': 'Demo Content Owner',
    '2': 'Demo Agency',
    '3': 'Demo Delivery Manager',
    '4': 'Demo Delivery Coordinator',
    '5': 'Demo Solution Architect',
    '6': 'Demo MDS Contributor',
    '7': 'Demo CEP Contributor',
    '8': 'Demo Tagging Contributor',
  },
};

// Exact option sets explicitly provided in CAMPAIGN_SCHEMA.md.
export const options = {
  sourceBacked: true,
  '12': ['New Brand Launch', 'New Indication Launch', 'Update Existing Campaign'],
  '17': ['Branded', 'Unbranded'],
  '20': ['No', 'Yes'],
  '22': ['Ad Hoc', 'Cadenced', 'Real-time', 'Real-time & Cadenced', 'Model based'],
  '22.1': ['No', 'Yes'],
  '22.2': ['No', 'Yes'],
};

export const fixtureMasters = {
  demoPlaceholder: true,
  '18': ['Demo audience A', 'DTC'], // DTC is source-defined; other label is explicitly a fixture.
  '26': ['Demo Sender Profile A'],
};

export const steps = ['Create campaign', 'Upload material', 'Prepare context', 'Review package', 'Campaign setup', 'Campaign workspace', 'AoR contribution'];
export const scanSteps = ['Checking brand mapping', 'Finding indication', 'Mapping therapeutic area', 'Looking for campaign team'];

export function initialState(): any {
  return {
    step: 0, persona: 'DM', brandSelected: false, initiated: false, aorSaved: false,
    // No inferred Request Type, campaign code, TACTPlan ID or campaign-specific content.
    fields: { '20': 'No', '22.1': 'No' },
    provenance: {},
    channel: '', // UX-only single-channel demo scenario, never a permanent schema decision.
    surveyFile: '',
    // UX-only intake draft. Files are local File objects, never uploaded or parsed.
    material: { files: [], notes: '', submitted: false, skipped: false, message: '' },
  };
}

// User-specified discovery fixtures, matching Figma 56:1442. Not official master data.
export const brands: Brand[] = [
  { name: 'Cosentyx', indication: 'Plaque psoriasis', therapeuticArea: 'Rheumatology' },
  { name: 'Entresto', indication: 'Heart failure', therapeuticArea: 'Cardiovascular' },
  { name: 'Kisqali', indication: 'HR+/HER2− breast cancer', therapeuticArea: 'Oncology' },
  { name: 'Leqvio', indication: 'Hypercholesterolaemia', therapeuticArea: 'Cardiovascular' },
  { name: 'Pluvicto', indication: 'Metastatic prostate cancer', therapeuticArea: 'Oncology' },
  { name: 'Kesimpta', indication: 'Relapsing multiple sclerosis', therapeuticArea: 'Neuroscience' },
].map(value => ({ ...value, demoPlaceholder: true }));

// Screen 01 presentation fixtures transcribed from Figma 98:6392.
// These statuses do not validate campaigns or drive any production workflow.
export const dashboardDemo = {
  demoPlaceholder: true,
  user: { name: 'Anna Meier', firstName: 'Anna', initials: 'AM', role: 'Delivery Manager' },
  greeting: 'Good morning',
  campaigns: [
    { id: 'demo-cosentyx', brandName: 'Cosentyx', subtitle: 'Planning', category: 'needs', tone: 'needs', sections: ['complete','complete','needs','pending'], next: 'Email details need completion', action: 'Complete Email Details', attention: 'Email Details need completion', badge: 'Needs input', activity: '—' },
    { id: 'demo-kesimpta', brandName: 'Kesimpta', subtitle: 'Planning', category: 'needs', tone: 'needs', sections: ['needs','complete','progress','pending'], next: 'General details need completion', action: 'Complete General Details', attention: 'General Details need completion', badge: 'Needs input', activity: '—' },
    { id: 'demo-pluvicto', brandName: 'Pluvicto', subtitle: 'Planning', category: 'needs', tone: 'needs', sections: ['complete','needs','pending','pending'], next: 'Contact details need completion', action: 'Complete Contact Details', attention: 'Contact Details need completion', badge: 'Needs input', activity: '—' },
    { id: 'demo-kisqali', brandName: 'Kisqali', subtitle: 'Planning', category: 'waiting', tone: 'waiting', sections: ['waiting','unset','progress','pending'], next: 'Waiting for OMS · Campaign Code', action: 'Continue Email Details', activity: '—', waiting: { badge: 'Awaiting OMS', description: 'OMS has been notified to provide the Campaign Code.', paused: 'General — Campaign Code with OMS', parallel: 'Email work can continue' } },
    { id: 'demo-leqvio', brandName: 'Leqvio', subtitle: 'Flow Planner', category: 'progress', tone: 'updated', sections: ['validated','complete','updated','updated'], next: 'Flow update available', action: 'Review changes', activity: '—', flowUpdate: { badge: 'Initial flow generated', description: 'Campaign details have changed since the current flow diagram was generated.', changes: ['Email updated','Touchpoint updated'] } },
    { id: 'demo-entresto', brandName: 'Entresto', subtitle: 'HCP Q4 · 72% ready', category: 'progress', tone: 'progress', sections: ['complete','complete','progress','pending'], next: 'In progress', action: 'Continue campaign setup', activity: '18 min ago' },
  ].map(campaign => ({ ...campaign, brand: brands.find(brand => brand.name === campaign.brandName), demoPlaceholder: true })),
  activity: [
    { campaign: 'Entresto HCP Q4', text: 'Campaign details updated', time: '18 min ago', tone: 'progress' },
    { campaign: 'Leqvio', text: 'Initial flow generated', time: 'Earlier', tone: 'updated' },
    { campaign: 'Kesimpta', text: 'General Details need completion', time: 'Earlier', tone: 'needs' },
    { campaign: 'Kisqali', text: 'Campaign Code requested from OMS', time: 'Earlier', tone: 'waiting' },
    { campaign: 'Pluvicto', text: 'General Details completed', time: 'Earlier', tone: 'complete' },
  ],
};

export interface Brand { name: string; indication: string; therapeuticArea: string; branded?: string; demoPlaceholder?: boolean }

// Brand discovery reads the server's BrandIndication master; the planning
// model's brand choices and mappings follow whatever was loaded last.
export function setBrands(next: Brand[]) {
  if (!next.length) return;
  brands.splice(0, brands.length, ...next.map(b => ({ ...b, demoPlaceholder: false })));
}
