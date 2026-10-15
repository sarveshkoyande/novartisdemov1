// Mock-up data for the segment → touchpoint journey (Cosentyx demo).
// Segments come from the campaign's Segment Name field when it lists two or more;
// otherwise these Cosentyx segments are used. The email library is built from the
// emails captured in the Email section when they have names and subject lines;
// otherwise the Cosentyx sample emails below are offered.

export interface LibraryEmail { key: string; name: string; fuse?: string; subjects: string[]; preheaders: string[] }
export interface Touchpoint { email: string | null; subject?: string; preheader?: string; wait: string; resend: string }
export interface Segment { name: string; count: number | null; touchpoints: Touchpoint[] }

export const DEMO_SEGMENTS = ['PsO · New-to-Brand Dermatologists', 'PsA · Lapsed Rheumatology Prescribers'];

export const DEMO_EMAILS: LibraryEmail[] = [
  {
    key: 'demo-1', name: 'Email 01 · Clear Skin, Lasting Results', fuse: 'FU-24-1101',
    subjects: ['Help more of your patients reach clear skin', 'Lasting skin clearance with Cosentyx: the 5-year data'],
    preheaders: ['See the long-term PASI 90/100 outcomes in moderate-to-severe plaque psoriasis.', 'Review durable response data for your plaque psoriasis patients.'],
  },
  {
    key: 'demo-2', name: 'Email 02 · Starting Patients on Cosentyx', fuse: 'FU-24-1102',
    subjects: ['Starting Cosentyx: a simple guide for your practice', 'Dosing, onboarding and support in one place'],
    preheaders: ['Loading doses, maintenance schedule and patient support resources.', 'Everything your team needs to start patients with confidence.'],
  },
  {
    key: 'demo-3', name: 'Email 03 · Joint and Skin Together (PsA)', fuse: 'FU-24-1103',
    subjects: ['Treat joint and skin symptoms of PsA together', 'One treatment for psoriatic arthritis and its skin symptoms'],
    preheaders: ['See ACR and PASI outcomes from the psoriatic arthritis trials.', 'Data on joint symptoms, skin clearance and radiographic progression.'],
  },
  {
    key: 'demo-4', name: 'Email 04 · Patient Support Programme', fuse: 'FU-24-1104',
    subjects: ['Support for your patients from day one', 'Your patients are not on their own'],
    preheaders: ['Nurse support, injection training and access help for Cosentyx patients.', 'How the Cosentyx support programme helps patients stay on therapy.'],
  },
];

export const WAIT_OPTIONS = ['3 days', '7 days', '14 days', '21 days'];

// Emails from the Email section when they carry a name and subject lines, else the demo set.
export function emailLibrary(emails: { fields: Record<string, string> }[]): LibraryEmail[] {
  const split = (v?: string) => String(v || '').split(/\n|\s\|\s/).map(x => x.trim()).filter(Boolean);
  const real = emails
    .map((e, i) => ({ key: `email-${i}`, name: e.fields['36'] ? `Email ${String(i + 1).padStart(2, '0')} · ${e.fields['36']}` : '', fuse: e.fields['32'], subjects: split(e.fields['39']), preheaders: split(e.fields['40']) }))
    .filter(e => e.name && e.subjects.length);
  return real.length ? real : DEMO_EMAILS;
}

// Segments for the campaign: from field 27 when it names two or more, else the demo pair.
export function ensureSegments(state: any): Segment[] {
  const p = state.planning;
  if (p.segments?.length) return p.segments;
  const named = String(state.fields?.['27'] || '').split(/[;,\n]/).map((x: string) => x.trim()).filter(Boolean);
  p.segments = (named.length >= 2 ? named : DEMO_SEGMENTS).map((name: string) => ({ name, count: null, touchpoints: [] }));
  return p.segments;
}

// The next thing to ask, in order: segment touchpoint counts, then each touchpoint's email,
// wait time and resend choice.
export type TouchpointAsk =
  | { kind: 'count'; seg: number }
  | { kind: 'subject' | 'preheader' | 'wait' | 'resend'; seg: number; tp: number }
  | null;
export function nextAsk(segments: Segment[]): TouchpointAsk {
  for (let seg = 0; seg < segments.length; seg++) {
    const sg = segments[seg];
    if (sg.count == null) return { kind: 'count', seg };
    for (let tp = 0; tp < sg.touchpoints.length; tp++) {
      const t = sg.touchpoints[tp];
      if (!t.email || !t.subject) return { kind: 'subject', seg, tp };
      if (!t.preheader) return { kind: 'preheader', seg, tp };
      if (!t.wait) return { kind: 'wait', seg, tp };
      if (!t.resend) return { kind: 'resend', seg, tp };
    }
  }
  return null;
}

// Mock-up default: a campaign with no emails starts with the Cosentyx sample emails, fully
// filled in, so the Email section, the workspace and the touchpoint picker all show them.
// Theme and Behavior Chain are left for AoR, as in a real campaign.
export function seedDemoEmails(state: any, addEmail: (st: any) => number, inherit: (st: any) => void): boolean {
  const p = state.planning;
  if (!p || p.emails.length) return false;
  const deploy = ['2026-11-03', '2026-11-10', '2026-11-17', '2026-11-24'];
  DEMO_EMAILS.forEach((e, n) => {
    const at = addEmail(state);
    const email = p.emails[at];
    const values: Record<string, string> = {
      '32': e.fuse || '', '33': '2027-10-31', '34': '2026-09-30', '35': '2027-12-31',
      '36': e.name.replace(/^Email \d+ · /, ''), '37': deploy[n] || '', '38': 'No',
      '39': e.subjects.join('\n'), '40': e.preheaders.join('\n'), '43': 'No', '44': 'No',
    };
    for (const [id, v] of Object.entries(values)) { email.fields[id] = v; email.meta[id] = { source: 'Cosentyx sample (demo)' }; }
  });
  if (!state.fields['24']) { state.fields['24'] = String(DEMO_EMAILS.length); p.meta['24'] = { source: 'Cosentyx sample (demo)' }; }
  p.active = 0;
  p.version++;
  inherit(state);
  return true;
}

// Every subject line across the library, each naming the email it belongs to.
export function subjectOptions(library: LibraryEmail[]) {
  return library.flatMap(e => e.subjects.map((text, i) => ({ key: `${e.key}::s${i}`, primary: text, secondary: `${e.name}${e.fuse ? ' · ' + e.fuse : ''}`, email: e.key, text })));
}
// The pre-headers of one email.
export function preheaderOptions(library: LibraryEmail[], emailKey: string | null) {
  const e = library.find(x => x.key === emailKey);
  return e ? e.preheaders.map((text, i) => ({ key: `${e.key}::p${i}`, primary: text, secondary: e.name, text })) : [];
}
