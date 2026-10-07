import { create } from 'zustand';
import { api, type Stage } from '../api';
import { planning } from '../studio/planningModel';

// The planning model (studio/planningModel.ts) mutates one plain state object
// in place, exactly as the prototype did. The store holds that object plus a
// revision counter: mutate() runs the change, bumps `rev` so React re-renders,
// and schedules a debounced save of the whole document to the server.
// Files are browser File objects — kept in memory only, never serialised.

interface CampaignStore {
  id: string | null;
  state: any;
  stage: Stage;
  rev: number;
  saving: 'idle' | 'saving' | 'saved' | 'error';
  files: File[];
  load: (id: string) => Promise<void>;
  adopt: (id: string, state: any, stage: Stage) => void;
  mutate: (fn: (state: any) => void) => void;
  setStage: (stage: Stage) => void;
  flush: () => Promise<void>;
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;

function serialisable(state: any) {
  const { material, ...rest } = state;
  return { ...rest, material: material ? { ...material, files: (material.files || []).map((f: File | { name: string; size: number }) => ({ name: f.name, size: f.size })) } : material };
}

export const useCampaignStore = create<CampaignStore>((set, get) => ({
  id: null, state: null, stage: 'upload', rev: 0, saving: 'idle', files: [],
  async load(id) {
    if (get().id === id && get().state) return;
    const campaign = await api.campaign(id);
    const state = campaign.state;
    state.material = { ...state.material, files: [] };
    set({ id, state, stage: campaign.stage, rev: get().rev + 1, saving: 'saved', files: [] });
  },
  adopt(id, state, stage) { set({ id, state, stage, rev: get().rev + 1, saving: 'saved', files: [] }); },
  mutate(fn) {
    const { state } = get();
    if (!state) return;
    fn(state);
    set({ rev: get().rev + 1 });
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { get().flush(); }, 600);
  },
  setStage(stage) { set({ stage }); clearTimeout(saveTimer); get().flush(); },
  async flush() {
    const { id, state, stage } = get();
    if (!id || !state) return;
    set({ saving: 'saving' });
    try {
      planning(state);
      await api.save(id, { state: serialisable(state), stage, title: state.fields?.['21'] || '', brand: state.fields?.['14'] || undefined });
      set({ saving: 'saved' });
    } catch { set({ saving: 'error' }); }
  },
}));
