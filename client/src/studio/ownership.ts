import { definitions } from './planningModel';

// Who fills which field. The schema's owner column is the base; two rules sit on top:
//  - the Campaign Code is issued by OMS, whatever the schema says;
//  - Theme and Behavior Chain belong to the AoR, not the Delivery Manager.
export type RoleKey = 'DM' | 'AoR' | 'SA';
export type OwnerKey = RoleKey | 'OMS';

export const ROLE_LABEL: Record<OwnerKey, string> = { DM: 'Delivery Manager', AoR: 'AoR', SA: 'Solution Architect', OMS: 'OMS' };

const OVERRIDE: Record<string, OwnerKey[]> = { '19': ['OMS'], '41': ['AoR'], '42': ['AoR'] };

export function ownerKeys(id: string): OwnerKey[] {
  if (OVERRIDE[id]) return OVERRIDE[id];
  const owner = definitions[id]?.owner || '';
  const keys: OwnerKey[] = [];
  if (/\bDM\b/.test(owner)) keys.push('DM');
  if (/\bAoR\b/.test(owner)) keys.push('AoR');
  if (/\bSA\b/.test(owner)) keys.push('SA');
  return keys.length ? keys : ['DM'];
}

export const isMineFor = (role: RoleKey, id: string) => ownerKeys(id).includes(role);

// A readable owner for a field that is NOT yours: the first party that is not you.
export const otherOwnerLabel = (role: RoleKey, id: string) => {
  const keys = ownerKeys(id).filter(k => k !== role);
  return ROLE_LABEL[keys[0] || 'DM'];
};
