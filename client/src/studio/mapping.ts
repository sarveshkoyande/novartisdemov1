import type { MappedValue } from '../api';
import { addEmail, evaluateGeneral, mapMessage, planning, setField } from './planningModel';

// Applies server (Claude) field values through the planning model's own
// setField, so validation, inheritance and provenance behave exactly as for
// typed input. Emails referenced beyond the current count are created.
export function applyMapped(state: any, values: MappedValue[], source: string) {
  const p = planning(state);
  const mapped: MappedValue[] = [];
  // Email count first, so per-email values land on existing objects.
  const ordered = [...values].sort((a, b) => (a.id === '24' ? -1 : b.id === '24' ? 1 : 0));
  for (const v of ordered) {
    const repeating = v.section === 'Email' || v.section === 'Touchpoint';
    if (repeating) while (p.emails.length <= v.index && p.emails.length < 100) addEmail(state);
    setField(state, v.id, v.value, v.section, repeating ? v.index : 0, source);
    mapped.push(v);
  }
  evaluateGeneral(state);
  return mapped;
}

// Local deterministic fallback when no model is configured.
export function mapLocally(state: any, text: string) {
  return mapMessage(state, text);
}
