import { useEffect, useRef, useState } from 'react';
import type { LibraryEmail } from '../studio/touchpointDemo';

// A dropdown of the campaign's emails. Each option shows the email name, then its
// subject-line variations, then its pre-header variations, so emails can be told apart.
export default function EmailPicker({ emails, value, onPick, label = 'Choose an email' }: {
  emails: LibraryEmail[]; value?: string | null; onPick: (key: string) => void; label?: string;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const chosen = emails.find(e => e.key === value);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <div className="email-picker" ref={box}>
      <button type="button" className="email-picker-trigger" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <span>{chosen ? chosen.name : label}</span>
        <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
      </button>
      {open && (
        <ul className="email-picker-list" role="listbox" aria-label={label}>
          {emails.map(e => (
            <li key={e.key} role="option" aria-selected={e.key === value}>
              <button type="button" onClick={() => { onPick(e.key); setOpen(false); }}>
                <strong>{e.name}</strong>{e.fuse && <small className="email-picker-fuse">{e.fuse}</small>}
                <span className="email-picker-label">Subject lines</span>
                <ol>{e.subjects.map(x => <li key={x}>{x}</li>)}</ol>
                <span className="email-picker-label">Pre-headers</span>
                <ol>{e.preheaders.map(x => <li key={x}>{x}</li>)}</ol>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
