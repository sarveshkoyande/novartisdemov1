import { useLocation, useNavigate } from 'react-router';
import { dashboardDemo } from '../studio/demoData';

export interface HeaderUser { name: string; initials: string; role: string }

// Shared presentation; the identity is a local demo fixture, not authentication.
export default function AccelerateHeader({ user = dashboardDemo.user, onNotice }: { user?: HeaderUser; onNotice?: (message: string) => void }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const nav = (label: string) => {
    if (label === 'Campaigns') navigate('/campaigns');
    else onNotice?.(label === 'Help' ? 'Filter campaigns by status, open a campaign, or choose New Campaign to start the NORA intake journey.' : `${label} is outside this demo.`);
  };
  return (
    <header className="accelerate-header">
      <div className="accelerate-brand"><img src="/assets/novartis-logo.svg" alt="Novartis" width={84} height={13} /><strong>Accelerate</strong></div>
      <nav aria-label="Main navigation">
        <button type="button" aria-current={!['/campaigns', '/schedule', '/admin'].includes(pathname) ? 'page' : undefined} onClick={() => navigate('/')}>Home</button>
        <button type="button" aria-current={pathname === '/campaigns' ? 'page' : undefined} onClick={() => nav('Campaigns')}>Campaigns</button>
        <button type="button" aria-current={pathname === '/schedule' ? 'page' : undefined} onClick={() => navigate('/schedule')}>Schedule</button>
        <button type="button" aria-current={pathname === '/admin' ? 'page' : undefined} onClick={() => navigate('/admin')}>Admin</button>
      </nav>
      <div className="accelerate-profile">
        <button type="button" onClick={() => nav('Help')}>Help</button>
        <span className="accelerate-avatar">{user.initials}</span>
        <div><strong>{user.name}</strong><span>{user.role}</span></div>
      </div>
    </header>
  );
}
