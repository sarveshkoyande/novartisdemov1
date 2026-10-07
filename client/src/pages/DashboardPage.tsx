import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import AccelerateHeader from '../components/AccelerateHeader';
import { api, type StudioCampaign } from '../api';
import { dashboardDemo } from '../studio/demoData';
import { sections as planSections } from '../studio/planningModel';
import { roleSection } from '../studio/roleStatus';
import type { RoleKey } from '../studio/ownership';
import { PERSONAS, usePersonaStore } from '../stores/usePersonaStore';
import '../styles/dashboard.css';

type Tone = 'complete' | 'progress' | 'needs' | 'waiting' | 'revision' | 'pending' | 'unset' | 'validated' | 'updated';
const statuses: Record<Tone, [string, string]> = {
  complete: ['✓', 'Complete'], progress: ['●', 'In progress'], needs: ['!', 'Needs input'],
  waiting: ['◔', 'With others'], revision: ['↺', 'Revision required'], pending: ['', 'Pending'],
  unset: ['–', '—'], validated: ['✓', 'Complete'], updated: ['↑', 'Updated after flow'],
};
const filters: [string, string, Tone][] = [['all', 'All', 'pending'], ['needs', 'Needs me', 'needs'], ['progress', 'In progress', 'progress'], ['waiting', 'Waiting', 'waiting'], ['updates', 'Flow updates', 'updated']];

interface Row {
  id: string; brand: { name: string }; subtitle: string; category: string; tone: Tone; sections: Tone[];
  next: string; action: string; activity: string; attention?: string; badge?: string; live?: boolean;
  waiting?: { badge: string; description: string; paused: string; parallel: string };
  flowUpdate?: { badge: string; description: string; changes: string[] };
}

function ago(iso: string) {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  return min < 1 ? 'just now' : min < 60 ? `${min} min ago` : min < 1440 ? `${Math.round(min / 60)} h ago` : new Date(iso).toLocaleDateString();
}

const sectionTone = (state: any, section: string, role: RoleKey) => { const r = roleSection(state, section, role); return { tone: r.tone as Tone, owners: r.owners }; };

// A persisted studio campaign, summarised from the viewer's role.
function liveRow(c: StudioCampaign, role: RoleKey): Row {
  const preparing = c.stage === 'upload' || c.stage === 'processing';
  const per = planSections.map(sec => (preparing ? { tone: 'pending' as Tone, owners: [] as string[] } : sectionTone(c.state, sec, role)));
  const sections = per.map(x => x.tone);
  const firstIndex = sections.findIndex(t => t === 'needs');
  const first = planSections[firstIndex];
  const waiting = sections.includes('waiting');
  const category = preparing ? 'progress' : first ? 'needs' : waiting ? 'waiting' : 'progress';
  const tone: Tone = preparing ? 'progress' : first ? 'needs' : waiting ? 'waiting' : 'progress';
  const owners = [...new Set(per.flatMap(x => x.owners))];
  const withText = owners.length ? `With ${owners.join(' and ')}` : 'In progress';
  return {
    id: c.id, live: true, brand: { name: c.brand }, subtitle: c.title || (preparing ? 'Material preparation' : 'Planning'),
    category, tone, sections,
    next: preparing ? 'Upload material or continue to review' : first ? `${first} details need your input` : waiting ? withText : 'In progress',
    action: preparing ? 'Continue intake' : first ? `Complete ${first} Details` : 'Open campaign',
    attention: first ? `${first} Details need your input` : undefined,
    badge: first ? 'Needs input' : undefined,
    activity: ago(c.updatedAt),
    waiting: waiting && !first ? { badge: withText, description: `${withText} to continue.`, paused: owners.length ? `Waiting on ${owners.join(' and ')}` : 'Waiting', parallel: 'You can keep working on other sections' } : undefined,
  };
}

// The sample rows are the Delivery Manager's. For any other role nothing in them is theirs to do.
function demoRows(role: RoleKey): Row[] {
  const rows = dashboardDemo.campaigns as Row[];
  if (role === 'DM') return rows;
  return rows.map(r => ({
    ...r, category: r.category === 'needs' ? 'progress' : r.category, tone: r.tone === 'needs' || r.tone === 'revision' ? 'progress' : r.tone,
    sections: r.sections.map(t => (t === 'needs' || t === 'revision' ? 'waiting' : t)) as Tone[],
    attention: undefined, badge: undefined, next: r.category === 'needs' ? 'With the Delivery Manager' : r.next, action: 'Open campaign',
  }));
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const role = usePersonaStore(st => st.role);
  const [live, setLive] = useState<StudioCampaign[]>([]);
  const [activeFilter, setActiveFilter] = useState('all');
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [page, setPage] = useState(0);
  const [notice, setNotice] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const heading = useRef<HTMLHeadingElement>(null);

  function notify(message: string) {
    clearTimeout(timer.current);
    setNotice(message);
    timer.current = setTimeout(() => setNotice(''), 6500);
  }

  useEffect(() => {
    document.title = 'Accelerate · Campaigns';
    heading.current?.focus({ preventScroll: true });
    api.campaigns().then(setLive).catch(() => notify('Could not reach the campaign server. Showing demo fixtures only.'));
    return () => clearTimeout(timer.current);
  }, []);

  const campaigns: Row[] = useMemo(() => [...live.map(c => liveRow(c, role)), ...demoRows(role)], [live, role]);
  const matches = (c: Row, filter: string) => filter === 'all' || (filter === 'updates' ? !!c.flowUpdate : c.category === filter);
  const needs = campaigns.filter(c => c.category === 'needs');
  const updates = campaigns.filter(c => c.flowUpdate);
  const visible = campaigns.filter(c => matches(c, activeFilter));
  const selected = selectedId ?? campaigns[0]?.id;
  const PAGE_SIZE = 6;
  const pages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  const pageRows = visible.slice(current * PAGE_SIZE, current * PAGE_SIZE + PAGE_SIZE);

  const open = (c: Row) => (c.live
    ? navigate(`/campaigns/${c.id}`)
    : notify(`${c.brand.name} — ${c.action}. This is an illustrative demo row with no workspace. Start a New Campaign to create a live one.`));
  const status = (key: Tone) => <span className={`dash-status tone-${key}`}><span className="dash-status-icon" aria-hidden="true">{statuses[key][0]}</span><span>{statuses[key][1]}</span></span>;
  const action = (c: Row, kind = '') => <button type="button" className={`dash-action ${kind}`} onClick={() => open(c)}>{c.action} <span aria-hidden="true">→</span></button>;

  return (
    <div className="is-dashboard">
      <AccelerateHeader onNotice={notify} />
      <main id="main" className="dashboard-main">
        <section className="dash-greeting">
          <div>
            <div className="dash-greeting-line"><h1 ref={heading} tabIndex={-1}>{dashboardDemo.greeting}, {role === 'DM' ? dashboardDemo.user.firstName : PERSONAS[role].role}</h1><p>Here’s what needs your attention today.</p></div>
            <p className="dash-nora"><span className="dash-nora-label">◆ NORA</span><span><strong>{needs.length} campaigns need your input</strong><span className="dash-separator"> · </span>{updates.length} campaign{updates.length === 1 ? ' has' : 's have'} newer details than its current flow.</span></p>
          </div>
          <button className="dash-new" type="button" onClick={() => navigate('/')}><span aria-hidden="true">＋</span> New Campaign</button>
        </section>
        <nav className="dash-filters" aria-label="Campaign status filters">
          {filters.map(([id, label, tone]) => <button key={id} type="button" aria-pressed={activeFilter === id} onClick={() => { setActiveFilter(id); setPage(0); }}><span className={`dash-dot tone-${tone}`} aria-hidden="true" />{label}<span className="dash-count">{campaigns.filter(c => matches(c, id)).length}</span></button>)}
        </nav>
        <div className="dash-grid">
          <div className="dash-primary">
            <section className="dash-panel dash-campaigns" aria-labelledby="active-campaigns">
              <div className="dash-panel-heading"><h2 id="active-campaigns">Active campaigns</h2><span role="status">{visible.length} shown</span><span className="dash-order">Ordered by what needs you first</span></div>
              <div className="dash-table-scroll" tabIndex={0} role="region" aria-label="Active campaigns table">
                <table>
                  <colgroup><col className="col-campaign" /><col span={3} className="col-section" /><col className="col-touchpoint" /><col className="col-next" /><col className="col-activity" /></colgroup>
                  <thead><tr>{['Campaign', 'General', 'Contact', 'Email', 'Touchpoint', 'Next action', 'Activity'].map(t => <th key={t} scope="col">{t}</th>)}</tr></thead>
                  <tbody>{pageRows.map(c => (
                    <tr key={c.id} className={c.id === selected ? 'is-selected' : ''}>
                      <td><button className="dash-campaign-name" aria-pressed={c.id === selected} onClick={() => setSelectedId(c.id)}><span className={`dash-dot tone-${c.tone}`} aria-hidden="true" />{c.brand.name}</button><span className="dash-subtitle">{c.subtitle}{c.live ? '' : ' · Demo'}</span></td>
                      {c.sections.map((s, i) => <td key={i}>{status(s)}</td>)}
                      <td><div className={`dash-next tone-${c.tone}`}>{c.next}</div>{action(c, c.category === 'needs' ? 'dark' : '')}</td>
                      <td className="dash-time">{c.activity}</td>
                    </tr>))}
                  </tbody>
                </table>
              </div>
              {pages > 1 && (
                <nav className="dash-pagination" aria-label="Campaign pages">
                  <span>{current * PAGE_SIZE + 1}–{Math.min(visible.length, (current + 1) * PAGE_SIZE)} of {visible.length}</span>
                  <button type="button" disabled={current === 0} onClick={() => setPage(current - 1)} aria-label="Previous page">‹</button>
                  {Array.from({ length: pages }, (_, n) => <button key={n} type="button" aria-current={n === current ? 'page' : undefined} onClick={() => setPage(n)}>{n + 1}</button>)}
                  <button type="button" disabled={current === pages - 1} onClick={() => setPage(current + 1)} aria-label="Next page">›</button>
                </nav>
              )}
              <div className="dash-legend">{(['complete', 'progress', 'needs', 'waiting', 'pending'] as Tone[]).map(key => <span key={key}><span aria-hidden="true">{statuses[key][0] || '○'}</span> {key === 'waiting' ? 'With others' : statuses[key][1]}</span>)}</div>
            </section>
            <div className="dash-support">
              <section className="dash-panel">
                <div className="dash-panel-heading"><h2>Waiting on others</h2><span className="dash-order">Not yours to act on</span></div>
                {campaigns.filter(c => c.waiting).map(c => <article key={c.id} className="dash-support-item waiting"><div className="dash-item-title"><strong>{c.brand.name}</strong><span className="dash-badge tone-waiting">{c.waiting!.badge}</span></div><p>{c.waiting!.description}</p><div className="dash-parallel">{status('waiting')}<span>{c.waiting!.paused}</span></div><div className="dash-parallel">{status('progress')}<strong>{c.waiting!.parallel}</strong></div>{action(c)}</article>)}
              </section>
              <section className="dash-panel">
                <div className="dash-panel-heading"><h2>Flow update available</h2><span className="dash-order">Updates only on your instruction</span></div>
                {updates.map(c => <article key={c.id} className="dash-support-item updated"><div className="dash-item-title"><strong>{c.brand.name}</strong><span className="dash-badge tone-updated">{c.flowUpdate!.badge}</span></div><p>{c.flowUpdate!.description}</p><div className="dash-changes">{c.flowUpdate!.changes.map(change => <span key={change}><span aria-hidden="true">●</span> {change}</span>)}</div>{action(c, 'teal')}</article>)}
              </section>
            </div>
          </div>
          <aside className="dash-aside">
            <section className="dash-panel">
              <div className="dash-panel-heading"><h2>Needs your attention</h2><span className="dash-attention-count">{needs.length}</span></div>
              {needs.map(c => <article key={c.id} className="dash-attention-item"><div className="dash-item-title"><strong>{c.brand.name}</strong><span className={`dash-badge tone-${c.tone}`}>{c.badge}</span></div><p>{c.attention}</p>{action(c, 'link')}</article>)}
            </section>
            <section className="dash-panel dash-activity">
              <div className="dash-panel-heading"><h2>Recent activity</h2></div>
              <ol>
                {live.slice(0, 3).map(c => <li key={c.id}><span className="dash-dot tone-progress" aria-hidden="true" /><p><strong>{c.title || c.brand}</strong> — Campaign updated</p><span className="dash-time">{ago(c.updatedAt)}</span></li>)}
                {dashboardDemo.activity.map((a: any) => <li key={a.campaign + a.text}><span className={`dash-dot tone-${a.tone}`} aria-hidden="true" /><p><strong>{a.campaign}</strong> — {a.text}</p><span className="dash-time">{a.time}</span></li>)}
              </ol>
            </section>
          </aside>
        </div>
        <p className="dash-demo-note">Campaigns you create are saved to the server. Rows marked “Demo” are illustrative fixtures.</p>
      </main>
      <div className="dash-notice" role="status" hidden={!notice}>{notice}</div>
    </div>
  );
}
