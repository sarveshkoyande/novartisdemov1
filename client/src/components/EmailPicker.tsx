import { useEffect, useRef, useState } from 'react';

export interface PickOption { key: string; primary: string; secondary?: string }

// A scrollable dropdown. Touchpoints use it twice: first to pick a subject line from every
// email (each option names the email it belongs to), then a pre-header from that email.
export default function OptionPicker({ options, value, onPick, label, compact }: {
  options: PickOption[]; value?: string | null; onPick: (key: string) => void; label: string; compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const chosen = options.find(o => o.key === value);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <div className={`email-picker${compact ? ' is-compact' : ''}`} ref={box}>
      <button type="button" className="email-picker-trigger" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <span>{chosen ? chosen.primary : label}</span>
        <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
      </button>
      {open && (
        <ul className="email-picker-list" role="listbox" aria-label={label}>
          {options.map(o => (
            <li key={o.key} role="option" aria-selected={o.key === value}>
              <button type="button" onClick={() => { onPick(o.key); setOpen(false); }}>
                <strong>{o.primary}</strong>
                {o.secondary && <small>{o.secondary}</small>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
