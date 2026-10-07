import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import AccelerateHeader from '../components/AccelerateHeader';
import AgentOrb from '../components/AgentOrb';
import TypedLine from '../components/TypedLine';
import { typewriter, type Typewriter } from '../studio/typewriter';
import { brands as fixtureBrands, initialState, setBrands, type Brand } from '../studio/demoData';
import { planning } from '../studio/planningModel';
import { takePendingIntake } from '../studio/pendingIntake';
import { api } from '../api';
import { useCampaignStore } from '../stores/useCampaignStore';
import type { OrbState } from '../components/agent-orb/agent-orb.js';
import '../styles/discovery.css';

const skeleton = (index: number) => (
  <div className="discovery-skeleton discovery-grid" aria-hidden="true">
    <i style={{ width: `${55 + (index % 6) * 5}%` }} /><i style={{ width: `${[64, 48, 87, 78, 81, 94][index % 6]}%` }} /><i style={{ width: `${[60, 83, 54, 83, 54, 72][index % 6]}%` }} /><i className="skeleton-radio" />
  </div>
);

// Existing Brand discovery, backed by the server's BrandIndication master.
// The staged reveal is UX packaging; "ready" waits for the real fetch.
export default function DiscoveryPage() {
  const navigate = useNavigate();
  const adopt = useCampaignStore(s => s.adopt);
  const [rows, setRows] = useState<Brand[]>(fixtureBrands.slice());
  const [phase, setPhase] = useState<'retrieving' | 'resolving' | 'ready'>('retrieving');
  const [shown, setShown] = useState({ search: false, table: false });
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<number | null>(null);
  const [orbState, setOrbState] = useState<OrbState>('thinking');
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const section = useRef<HTMLElement>(null);
  const writer = useRef<Typewriter | null>(null);
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const ready = phase === 'ready';

  const type = () => {
    writer.current?.cancel();
    const heading = section.current?.querySelector<HTMLElement>('.discovery-copy h1');
    if (!heading) return;
    writer.current = typewriter([heading], { startDelay: 100 });
    if (reduced) writer.current.finish();
  };

  useEffect(() => {
    document.title = 'Accelerate · Existing Brand';
    type();
    const timers = [setTimeout(() => setShown(s => ({ ...s, search: true })), 600), setTimeout(() => setShown({ search: true, table: true }), 1100)];
    const minimum = new Promise(r => setTimeout(r, reduced ? 0 : 2400));
    let cancelled = false;
    Promise.all([api.brands().catch(() => [] as Brand[]), minimum]).then(([list]) => {
      if (cancelled) return;
      if (list.length) { setBrands(list); setRows(list); } else setError('Brand master unavailable — showing local demo brands.');
      setPhase('resolving');
      timers.push(setTimeout(() => { setPhase('ready'); setOrbState('idle'); }, reduced ? 0 : 700));
    });
    return () => { cancelled = true; timers.forEach(clearTimeout); writer.current?.cancel(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { if (ready) type(); /* retype the new question */ // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  useEffect(() => {
    if (selected === null) return;
    setOrbState('speaking');
    const t = setTimeout(() => setOrbState('idle'), 850);
    return () => clearTimeout(t);
  }, [selected]);

  const visible = rows.map((b, i) => ({ b, i })).filter(({ b }) => b.name.toLowerCase().includes(query.trim().toLowerCase()));

  async function proceed() {
    if (!ready || selected === null || creating) return;
    const brand = rows[selected];
    const state = initialState();
    state.step = 1;
    state.brandSelected = true;
    planning(state);
    Object.assign(state.fields, { '14': brand.name, '15': brand.indication, '16': brand.therapeuticArea, '12': 'Update Existing Campaign', '13': 'No' });
    if (brand.branded) state.fields['17'] = brand.branded;
    const source = { source: 'Mapped from Brand master' };
    for (const id of ['14', '15', '16', ...(brand.branded ? ['17'] : [])]) state.planning.meta[id] = { ...source };
    state.planning.meta['12'] = { source: 'Inherited · Existing Brand journey' };
    state.planning.meta['13'] = { source: 'Inherited · Request Type' };
    const intake = takePendingIntake();
    if (intake) { state.material.notes = intake.notes; state.material.files = intake.files; }
    setCreating(true);
    try {
      const campaign = await api.create(brand.name, state);
      adopt(campaign.id, state, 'upload');
      navigate(`/campaigns/${campaign.id}`);
    } catch (e) {
      setCreating(false);
      setError(`Could not create the campaign: ${(e as Error).message}`);
    }
  }

  const cls = ['brand-discovery', shown.search && 'show-search', shown.table && 'show-table', phase !== 'retrieving' && 'settling', phase !== 'retrieving' && 'resolving', ready && 'ready'].filter(Boolean).join(' ');
  return (
    <div className="is-discovery">
      <AccelerateHeader />
      <main id="main">
        <section ref={section} className={cls} aria-label="Existing Brand" data-phase={phase}>
          <button className="discovery-back" type="button" onClick={() => navigate('/')}>← Campaign type</button>
          <div className="discovery-agent">
            <AgentOrb id="discovery-orb" size={matchMedia('(max-width:600px)').matches ? 80 : 112} state={orbState} label="NORA — Requirement Collection Agent" />
            <div className="discovery-copy">
              <div className="eyebrow">NORA <span> / Existing Brand</span></div>
              <p id="discovery-status">{selected !== null ? `${rows[selected].name} selected.` : ready ? 'The available brands are ready.' : 'Retrieving available brands'}</p>
              <TypedLine key={ready ? 'ask' : 'retrieve'} as="h1" text={ready ? 'Which brand is this campaign for?' : 'I’m retrieving the available brands.'} wordClass="discovery-word" />
              <p id="discovery-guidance">{ready ? 'Select a brand and I’ll prepare the campaign information already available for it.' : 'Give me a moment while I prepare the available brand context.'}</p>
            </div>
          </div>
          <div className="sr-only" role="status">{ready ? 'Brand list ready.' : 'Retrieving available brands.'}</div>
          <div className="discovery-search">
            <label htmlFor="discovery-search">Brand</label>
            <div className="discovery-search-box"><span aria-hidden="true">⌕</span><input id="discovery-search" type="search" placeholder="Search by brand name" autoComplete="off" disabled={!ready} value={query} onChange={e => setQuery(e.target.value)} /><div className="discovery-skeleton" aria-hidden="true"><i /></div></div>
          </div>
          <div className="discovery-table" aria-busy={!ready}>
            <div className="discovery-grid discovery-table-head" aria-hidden="true"><span>Brand</span><span>Indication</span><span>Therapeutic Area</span><span /></div>
            <fieldset disabled={!ready} aria-hidden={!ready}>
              <legend className="sr-only">Select a brand</legend>
              {visible.map(({ b, i }) => (
                <div key={`${b.name}-${b.indication}`} className="discovery-row" style={{ ['--row' as string]: i }}>
                  {skeleton(i)}
                  <label className="discovery-grid discovery-brand"><strong>{b.name}</strong><span>{b.indication}</span><span>{b.therapeuticArea || '—'}</span><input type="radio" name="discovery-brand" checked={selected === i} onChange={() => { writer.current?.finish(); setSelected(i); }} aria-label={`${b.name}, ${b.indication}`} /></label>
                </div>
              ))}
            </fieldset>
            <p className="discovery-empty" hidden={visible.length > 0}>No matching brands. Try another brand name.</p>
          </div>
          <p className="discovery-fixture">{error || 'Brand context from the Accelerate brand master (seeded demo data).'}</p>
          <div className="discovery-actions">
            <button type="button" className="button secondary" onClick={() => navigate('/campaigns')}>Cancel</button>
            <button type="button" className="button primary" disabled={!ready || selected === null || creating} onClick={proceed}>{creating ? 'Creating…' : 'Continue'} <span aria-hidden="true">→</span></button>
          </div>
        </section>
      </main>
    </div>
  );
}
