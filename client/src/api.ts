// Thin client for the Campaign Studio routes (server/studio-routes.js).
import type { Brand } from './studio/demoData';

export interface StudioCampaign { id: string; brand: string; title: string; stage: Stage; state: any; createdAt: string; updatedAt: string }
export type Stage = 'upload' | 'processing' | 'review' | 'planning';
export interface MappedValue { section: string; index: number; id: string; value: string }

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  return res.json();
}
const send = (method: string, body: unknown) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export const api = {
  brands: () => fetch('/api/studio/brands').then(r => json<{ brands: Brand[] }>(r)).then(r => r.brands),
  campaigns: () => fetch('/api/studio/campaigns').then(r => json<{ campaigns: StudioCampaign[] }>(r)).then(r => r.campaigns),
  campaign: (id: string) => fetch(`/api/studio/campaigns/${id}`).then(r => json<{ campaign: StudioCampaign }>(r)).then(r => r.campaign),
  create: (brand: string, state: any) => fetch('/api/studio/campaigns', send('POST', { brand, state })).then(r => json<{ campaign: StudioCampaign }>(r)).then(r => r.campaign),
  save: (id: string, body: { state: any; stage?: Stage; title?: string; brand?: string }) => fetch(`/api/studio/campaigns/${id}`, send('PUT', body)).then(r => json<{ campaign: StudioCampaign }>(r)),
  remove: (id: string) => fetch(`/api/studio/campaigns/${id}`, { method: 'DELETE' }),
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
