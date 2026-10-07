import { planning, unresolved } from './planningModel';
import { isMineFor, otherOwnerLabel, type RoleKey } from './ownership';

// What a section needs from the person viewing it. Their own open fields make it
// "needs"; if only other people's are open it is "waiting" (with those owners);
// nothing open means "complete". Email and Touchpoint with no emails are "pending".
export type SectionTone = 'pending' | 'needs' | 'waiting' | 'complete';
export function roleSection(state: any, section: string, role: RoleKey): { tone: SectionTone; owners: string[]; mine: number; others: number } {
  const p = planning(state);
  const perEmail = section === 'Email' || section === 'Touchpoint';
  if (perEmail && !p.emails.length) return { tone: 'pending', owners: [], mine: 0, others: 0 };
  const ids: string[] = [];
  for (let i = 0; i < (perEmail ? p.emails.length : 1); i++) ids.push(...unresolved(state, section, i).filter((id: string) => !['45', '46', '47'].includes(id)));
  const mine = ids.filter(id => isMineFor(role, id));
  const others = ids.filter(id => !isMineFor(role, id));
  return { tone: mine.length ? 'needs' : others.length ? 'waiting' : 'complete', owners: [...new Set(others.map(id => otherOwnerLabel(role, id)))], mine: mine.length, others: others.length };
}
