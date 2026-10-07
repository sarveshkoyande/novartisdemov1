// Notes/files shared on the Home composer before a campaign exists. Held in
// memory only and consumed once by the campaign created next.
let pending: { notes: string; files: File[] } | null = null;
export function setPendingIntake(value: { notes: string; files: File[] }) { pending = value; }
export function takePendingIntake() { const v = pending; pending = null; return v; }
