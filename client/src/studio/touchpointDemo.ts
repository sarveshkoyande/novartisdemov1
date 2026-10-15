// Mock-up data for the segment → touchpoint journey (Cosentyx demo).
// Segments come from the campaign's Segment Name field when it lists two or more;
// otherwise these Cosentyx segments are used. The email library is built from the
// emails captured in the Email section when they have names and subject lines;
// otherwise the Cosentyx sample emails below are offered.

export interface LibraryEmail { key: string; name: string; fuse?: string; subjects: string[]; preheaders: string[] }
export interface Touchpoint { email: string | null; wait: string; resend: string }
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
  | { kind: 'email' | 'wait' | 'resend'; seg: number; tp: number }
  | null;
export function nextAsk(segments: Segment[]): TouchpointAsk {
  for (let seg = 0; seg < segments.length; seg++) {
    const sg = segments[seg];
    if (sg.count == null) return { kind: 'count', seg };
    for (let tp = 0; tp < sg.touchpoints.length; tp++) {
      const t = sg.touchpoints[tp];
      if (!t.email) return { kind: 'email', seg, tp };
      if (!t.wait) return { kind: 'wait', seg, tp };
      if (!t.resend) return { kind: 'resend', seg, tp };
    }
  }
  return null;
}
