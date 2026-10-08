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
  const nav = (label: string) => {
    if (label === 'Campaigns') navigate('/campaigns');
    else onNotice?.(`${label} is outside this demo.`);
  };
  return (
    <header className="accelerate-header">
      <div className="accelerate-brand"><img src="/assets/novartis-logo.svg" alt="Novartis" width={84} height={13} /><strong>Campaign Accelerator</strong></div>
      <nav aria-label="Main navigation">
        <button type="button" aria-current={!['/campaigns', '/schedule', '/admin'].includes(pathname) ? 'page' : undefined} onClick={() => navigate('/')}>Home</button>
        <button type="button" aria-current={pathname === '/campaigns' ? 'page' : undefined} onClick={() => nav('Campaigns')}>Campaigns</button>
        <button type="button" aria-current={pathname === '/schedule' ? 'page' : undefined} onClick={() => navigate('/schedule')}>Schedule</button>
        <button type="button" aria-current={pathname === '/admin' ? 'page' : undefined} onClick={() => navigate('/admin')}>Admin</button>
      </nav>
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
