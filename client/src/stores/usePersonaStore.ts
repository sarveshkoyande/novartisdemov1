import { create } from 'zustand';
import type { RoleKey } from '../studio/ownership';

// Demo role switch. The signed-in person is a fixture (not authentication): clicking
// the profile at the top right cycles Delivery Manager → AoR → Solution Architect,
// and every campaign screen then shows what that role needs to do.
export const PERSONAS: Record<RoleKey, { name: string; initials: string; role: string }> = {
  DM: { name: 'Anna Meier', initials: 'AM', role: 'Delivery Manager' },
  AoR: { name: 'Demo Agency', initials: 'AG', role: 'Agency of Record' },
  SA: { name: 'Demo Architect', initials: 'SA', role: 'Solution Architect' },
};
const ORDER: RoleKey[] = ['DM', 'AoR', 'SA'];
const KEY = 'campaign-studio.role';

function initial(): RoleKey {
  try { const v = localStorage.getItem(KEY) as RoleKey | null; if (v && ORDER.includes(v)) return v; } catch { /* storage unavailable */ }
  return 'DM';
}

interface PersonaStore { role: RoleKey; cycle: () => RoleKey }
export const usePersonaStore = create<PersonaStore>((set, get) => ({
  role: initial(),
  cycle() {
    const next = ORDER[(ORDER.indexOf(get().role) + 1) % ORDER.length];
    try { localStorage.setItem(KEY, next); } catch { /* storage unavailable */ }
    set({ role: next });
    return next;
  },
}));
