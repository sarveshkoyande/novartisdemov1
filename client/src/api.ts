// Client for the Campaign Studio routes (server/studio-routes.js).
//
// Two storage modes, chosen at build time:
//  - server (default): campaigns and brands come from the Express server's database.
//  - local (VITE_STORAGE=local, the Vercel build): campaigns are kept in this browser's
//    localStorage and brands ship with the site. Document reading, NORA and the Flow
//    Planner still call /api (a Vercel function), which stores nothing.
import type { Brand } from './studio/demoData';
import brandList from './studio/brands.json';

export interface StudioCampaign { id: string; brand: string; title: string; stage: Stage; state: any; createdAt: string; updatedAt: string }
export type Stage = 'upload' | 'processing' | 'review' | 'planning';
export interface MappedValue { section: string; index: number; id: string; value: string }

const LOCAL = import.meta.env.VITE_STORAGE === 'local';

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  return res.json();
}
const send = (method: string, body: unknown) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

// --- browser storage ------------------------------------------------------
const KEY = 'campaign-studio.campaigns.v1';
function readAll(): StudioCampaign[] {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; }
}
function writeAll(list: StudioCampaign[]) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); }
  catch { throw new Error('This browser’s storage is full or blocked, so the campaign could not be saved.'); }
}
// File objects can't be stored; keep just their names and sizes.
function plain(state: any) {
  const m = state?.material;
  if (!m) return state;
  return { ...state, material: { ...m, files: (m.files || []).map((f: { name: string; size: number }) => ({ name: f.name, size: f.size })) } };
}
const byNewest = (a: StudioCampaign, b: StudioCampaign) => b.updatedAt.localeCompare(a.updatedAt);

const local = {
  brands: async () => brandList as Brand[],
  campaigns: async () => readAll().sort(byNewest),
  campaign: async (id: string) => {
    const found = readAll().find(c => c.id === id);
    if (!found) throw new Error('Campaign not found in this browser. Campaigns are saved per browser.');
    return found;
  },
  create: async (brand: string, state: any) => {
    const now = new Date().toISOString();
    const campaign: StudioCampaign = { id: crypto.randomUUID(), brand, title: '', stage: 'upload', state: plain(state), createdAt: now, updatedAt: now };
    writeAll([campaign, ...readAll()]);
    return campaign;
  },
  save: async (id: string, body: { state: any; stage?: Stage; title?: string; brand?: string }) => {
    const all = readAll();
    const at = all.findIndex(c => c.id === id);
    if (at < 0) throw new Error('Campaign not found in this browser.');
    const next = { ...all[at], state: plain(body.state), updatedAt: new Date().toISOString(),
      ...(body.stage ? { stage: body.stage } : {}), ...(body.title !== undefined ? { title: body.title } : {}), ...(body.brand ? { brand: body.brand } : {}) };
    all[at] = next;
    writeAll(all);
    return { campaign: next };
  },
  remove: async (id: string) => { writeAll(readAll().filter(c => c.id !== id)); },
};

// --- server ---------------------------------------------------------------
const remote = {
  brands: () => fetch('/api/studio/brands').then(r => json<{ brands: Brand[] }>(r)).then(r => r.brands),
  campaigns: () => fetch('/api/studio/campaigns').then(r => json<{ campaigns: StudioCampaign[] }>(r)).then(r => r.campaigns),
  campaign: (id: string) => fetch(`/api/studio/campaigns/${id}`).then(r => json<{ campaign: StudioCampaign }>(r)).then(r => r.campaign),
  create: (brand: string, state: any) => fetch('/api/studio/campaigns', send('POST', { brand, state })).then(r => json<{ campaign: StudioCampaign }>(r)).then(r => r.campaign),
  save: (id: string, body: { state: any; stage?: Stage; title?: string; brand?: string }) => fetch(`/api/studio/campaigns/${id}`, send('PUT', body)).then(r => json<{ campaign: StudioCampaign }>(r)),
  remove: async (id: string) => { await fetch(`/api/studio/campaigns/${id}`, { method: 'DELETE' }); },
};

const storage = LOCAL ? local : remote;

export const api = {
  ...storage,
  extract: (files: File[], notes: string, emailCount: number, signal?: AbortSignal) => {
    const form = new FormData();
    files.forEach(f => form.append('files', f));
    form.append('notes', notes);
    form.append('emailCount', String(emailCount));
    return fetch('/api/studio/extract', { method: 'POST', body: form, signal })
      .then(r => json<{ text: string; failed: { name: string; error: string }[]; values: MappedValue[]; reply: string; ai: boolean }>(r));
  },
  nora: (text: string, section: string, emailCount: number) =>
    fetch('/api/studio/nora', send('POST', { text, section, emailCount })).then(r => json<{ values: MappedValue[]; reply: string }>(r)),
};
