import { useLocation, useNavigate } from 'react-router';
import { PERSONAS, usePersonaStore } from '../stores/usePersonaStore';

export interface HeaderUser { name: string; initials: string; role: string }

// Shared presentation; the identity is a demo fixture, not authentication. The profile
// at the top right is a button that switches the demo role (Delivery Manager → AoR →
// Solution Architect) without leaving the page or the campaign.
export default function AccelerateHeader({ onNotice }: { user?: HeaderUser; onNotice?: (message: string) => void }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const role = usePersonaStore(s => s.role);
  const cycle = usePersonaStore(s => s.cycle);
  const user = PERSONAS[role];
  const current = pathname.startsWith('/campaigns') && pathname !== '/campaigns' ? 'Home' : pathname === '/campaigns' ? 'Campaigns' : pathname === '/calendar' ? 'Calendar' : 'Home';
  const links: [string, string][] = [['Home', '/'], ['Campaigns', '/campaigns'], ['Calendar', '/calendar']];
  return (
    <header className="accelerate-header">
      <div className="accelerate-brand"><img src="/assets/novartis-logo.svg" alt="Novartis" width={84} height={13} /><i aria-hidden="true" /><strong>Campaign Accelerator</strong></div>
      <nav aria-label="Main navigation">
        {links.map(([label, to]) => (
          <button key={label} type="button" aria-current={current === label ? 'page' : undefined} onClick={() => navigate(to)}>{label}</button>
        ))}
      </nav>
      <div className="accelerate-tools">
        <button type="button" className="header-icon" aria-label="Help" title="Help" onClick={() => onNotice?.('Help is outside this demo.')}>
          <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M9.2 9.3a2.9 2.9 0 0 1 5.6 1c0 1.9-2.8 2.4-2.8 4.2" /><circle cx="12" cy="17.6" r=".6" fill="currentColor" /></svg>
        </button>
        <button type="button" className="header-icon" aria-label="Notifications" title="Notifications" onClick={() => onNotice?.('No new notifications.')}>
          <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M7 15.5V11a5 5 0 0 1 10 0v4.5l1.3 1.5H5.7Z" /><path d="M10.5 19a1.6 1.6 0 0 0 3 0" /></svg>
        </button>
      </div>
      <div className="accelerate-profile">
        <button type="button" className="role-switch" title="Demo: switch role" aria-label={`Viewing as ${user.role}. Switch demo role.`}
          onClick={() => { const next = cycle(); onNotice?.(`Now viewing as ${PERSONAS[next].role}.`); }}>
          <span className="accelerate-avatar">{user.initials}</span>
          <span className="role-text"><strong>{user.name}</strong><span>{user.role}</span></span>
          <span className="role-swap" aria-hidden="true">⇄</span>
        </button>
      </div>
    </header>
  );
}
