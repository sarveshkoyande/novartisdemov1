import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import AccelerateHeader from '../components/AccelerateHeader';
import AgentOrb from '../components/AgentOrb';
import TypedLine from '../components/TypedLine';
import Composer from '../components/Composer';
import { takePendingIntake } from '../studio/pendingIntake';
import { initialState } from '../studio/demoData';
import { planning } from '../studio/planningModel';
import { api } from '../api';
import { useCampaignStore } from '../stores/useCampaignStore';
import { typewriter, type Typewriter } from '../studio/typewriter';
import { dashboardDemo } from '../studio/demoData';
import type { OrbState } from '../components/agent-orb/agent-orb.js';
import '../styles/welcome.css';
import '../styles/upload.css';

// uxPackaging: true — NORA is the existing Requirement Collection Agent's display name.
const icons: Record<string, string> = {
  create: '<path d="M13 4v18M4 13h18"/><path d="M6 4H4v2m16-2h2v2M4 20v2h2m14 0h2v-2"/>',
  update: '<path d="M21 13a8 8 0 1 1-2.6-5.9"/><path d="M21 4v5h-5"/>',
  reuse: '<rect x="8" y="8" width="13" height="13" rx="2.5"/><path d="M5 17.5H4.5A1.5 1.5 0 0 1 3 16V4.5A1.5 1.5 0 0 1 4.5 3H16a1.5 1.5 0 0 1 1.5 1.5V5"/>',
};
type Intent = 'create' | 'update' | 'reuse';
const cards: [Intent, string, string][] = [
  ['create', 'Create New', 'Create a new campaign for an existing brand.'],
  ['update', 'Continue Campaign', 'Resume an existing campaign and pick up where you left off.'],
  ['reuse', 'Re-use & Create', 'Use an existing campaign to create a new one.'],
];
interface Msg { role: 'user' | 'agent'; text: string }
interface Pick { id: string; name: string; brand: string; updatedAt: string }

export default function WelcomePage() {
  const navigate = useNavigate();
  const adopt = useCampaignStore(s => s.adopt);
  const root = useRef<HTMLElement>(null);
  const writer = useRef<Typewriter | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const proceeding = useRef(false);
  const [agentState, setAgentState] = useState('arrival');
  const [orbState, setOrbState] = useState<OrbState>('idle');
  const [classes, setClasses] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState('');
  // The Home conversation: once the user types or picks, the cards give way to a thread.
  const [thread, setThread] = useState<Msg[]>([]);
  const [mode, setMode] = useState<'' | 'chat' | 'update' | 'reuse' | 'reuse-details'>('');
  const [thinking, setThinking] = useState(false);
  const [catalogue, setCatalogue] = useState<Pick[] | null>(null);
  const [matches, setMatches] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [source, setSource] = useState<Pick | null>(null);
  const threadEnd = useRef<HTMLDivElement>(null);
  useEffect(() => { threadEnd.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [thread, mode, thinking]);
  const [response, setResponse] = useState('');
  const [notes, setNotes] = useState('');
  const attachInput = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const addClass = (...names: string[]) => setClasses(prev => new Set([...prev, ...names]));

  const finishIntroduction = () => {
    if (!writer.current || classes.has('instant-intro')) return;
    timers.current.forEach(clearTimeout);
    writer.current.finish();
    addClass('instant-intro', 'has-arrived', 'is-ready');
    setAgentState('waiting');
    setOrbState('idle');
  };
  const finishRef = useRef(finishIntroduction);
  finishRef.current = finishIntroduction;

  useEffect(() => {
    document.title = 'Campaign Accelerator · Home';
    const lines = [...root.current!.querySelectorAll<HTMLElement>('.nora-line')];
    writer.current = typewriter(lines, {
      startDelay: 100, sentencePause: 20, speed: 7, chunk: 4,
      onStart: () => { setAgentState('speaking'); setOrbState('speaking'); },
      onComplete: () => { setAgentState('waiting'); setOrbState('idle'); timers.current.push(setTimeout(() => addClass('is-ready'), 200)); },
    });
    if (reduced) finishRef.current();
    else timers.current.push(setTimeout(() => addClass('has-arrived'), 80));
    // Any early interaction skips the intro; there is no overlay or lock.
    const early = (event: Event) => {
      if (event instanceof KeyboardEvent && ['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return;
      if (proceeding.current) return;
      finishRef.current();
    };
    document.addEventListener('pointerdown', early, true);
    document.addEventListener('keydown', early, true);
    const pending = timers.current;
    return () => {
      writer.current?.cancel();
      pending.forEach(clearTimeout);
      document.removeEventListener('pointerdown', early, true);
      document.removeEventListener('keydown', early, true);
    };
  }, [reduced]);

  const say = (role: Msg['role'], text: string) => setThread(t => [...t, { role, text }]);

  async function campaigns(): Promise<Pick[]> {
    if (catalogue) return catalogue;
    const list = await api.campaigns().catch(() => []);
    const picks = list.map(c => ({ id: c.id, name: c.title || c.state?.fields?.['21'] || `${c.brand} campaign`, brand: c.state?.fields?.['14'] || c.brand, updatedAt: c.updatedAt }));
    setCatalogue(picks);
    return picks;
  }

  // Plain fallback when the model is unavailable.
  function guess(text: string): { intent: 'create' | 'update' | 'reuse' | 'chat'; hasDetails: boolean } {
    if (/\b(reuse|re-use|clone|copy|duplicate|based on|like last)\b/i.test(text)) return { intent: 'reuse', hasDetails: false };
    if (/\b(update|edit|change|continue|open|existing)\b/i.test(text)) return { intent: 'update', hasDetails: false };
    if (text.trim().split(/\s+/).length > 12) return { intent: 'create', hasDetails: true };
    if (/\b(new|create|start|launch)\b/i.test(text)) return { intent: 'create', hasDetails: false };
    return { intent: 'chat', hasDetails: false };
  }

  // Home composer: NORA reads the first message and routes it. Campaign details or files
  // go straight to processing; update/reuse open a picker in the conversation.
  async function send() {
    const text = notes.trim();
    if ((!text && !files.length) || thinking || proceeding.current) return;
    finishIntroduction();
    if (mode === 'reuse-details' && source) { if (text) say('user', text); return startReuse(source, text, files); }
    if (text) say('user', text);
    else say('user', `Attached ${files.map(f => f.name).join(', ')}`);
    setNotes('');
    setThinking(true); setOrbState('thinking');
    const picks = await campaigns();
    let routed: { intent: 'create' | 'update' | 'reuse' | 'chat'; hasDetails: boolean; matches: string[]; reply: string };
    // Obvious cases are routed instantly; the model is only asked when the message is
    // ambiguous (it is slow enough that waiting on it for every message feels broken).
    const quick = guess(text);
    const words = text.toLowerCase();
    const named = picks.filter(c => [c.brand, c.name].some(n => n && n.length > 2 && words.includes(n.toLowerCase().replace(/ campaign$/, '')))).map(c => c.id);
    if (quick.intent === 'update' || quick.intent === 'reuse' || (quick.intent === 'create' && quick.hasDetails) || files.length) {
      routed = { ...quick, intent: files.length && quick.intent === 'chat' ? 'create' : quick.intent, hasDetails: quick.hasDetails || files.length > 0, matches: named, reply: '' };
    } else try {
      routed = await api.homeIntent({ text: text || '(files attached)', campaigns: picks.map(p => ({ id: p.id, name: p.name, brand: p.brand })), recent: thread.map(m => `${m.role === 'user' ? 'User' : 'NORA'}: ${m.text}`) });
    } catch {
      routed = { ...guess(text), matches: [], reply: '' };
    }
    setThinking(false); setOrbState('idle');
    const attached = files.length > 0;
    if (routed.intent === 'create' || (routed.intent === 'chat' && attached)) {
      say('agent', routed.reply || 'I’ll prepare a new campaign from what you shared.');
      return startCreate(routed.hasDetails || attached ? { notes: text, files } : null);
    }
    if (routed.intent === 'update' || routed.intent === 'reuse') {
      setMatches(routed.matches.filter(id => picks.some(p => p.id === id)));
      setQuery('');
      setMode(routed.intent);
      const found = routed.matches.filter(id => picks.some(p => p.id === id)).length;
      const verb = routed.intent === 'update' ? 'update' : 'base the new campaign on';
      say('agent', routed.reply || (found > 5 ? `I found ${found} matching campaigns; the most recent are below. Pick the one to ${verb}, or search to narrow it down.` : found ? `I found ${found} matching campaign${found === 1 ? '' : 's'}; ${found === 1 ? 'it is' : 'they are'} at the top. Pick the one to ${verb}.` : `Which campaign would you like to ${verb}? Pick it below or search by name or brand.`));
      return;
    }
    setMode('chat');
    say('agent', routed.reply || 'I can create a new campaign, update an existing one, or start a new one from a past campaign. What would you like to do?');
  }

  // Cards: Create goes to the upload step (or straight to processing when something
  // was already shared); Update and Reuse open the picker in the conversation.
  async function select(key: Intent) {
    if (proceeding.current) return;
    finishIntroduction();
    setSelected(key);
    if (key === 'create') {
      const shared = notes.trim() || files.length ? { notes: notes.trim(), files } : null;
      say('user', 'Create a new campaign');
      say('agent', shared ? 'I’ll prepare the campaign from what you shared.' : 'Let’s start with what you already have.');
      return startCreate(shared);
    }
    say('user', key === 'update' ? 'Update a campaign' : 'Reuse a campaign');
    say('agent', key === 'update' ? 'Which campaign would you like to update?' : 'Which campaign should the new one be based on?');
    setMatches([]); setQuery(''); setMode(key);
    campaigns();
  }

  async function startCreate(material: { notes: string; files: File[] } | null) {
    proceeding.current = true;
    setOrbState('speaking');
    const state = initialState();
    state.step = 1;
    planning(state);
    const intake = takePendingIntake();
    if (intake) { state.material.notes = intake.notes; state.material.files = intake.files; }
    if (material) Object.assign(state.material, { notes: material.notes, files: material.files, submitted: true, processing: { startedAt: Date.now(), complete: false } });
    try {
      const [campaign] = await Promise.all([api.create('New campaign', state), new Promise(r => setTimeout(r, reduced ? 0 : 450))]);
      adopt(campaign.id, state, material ? 'processing' : 'upload');
      navigate(`/campaigns/${campaign.id}`);
    } catch (e) {
      proceeding.current = false;
      say('agent', `I couldn’t start the campaign: ${(e as Error).message}`);
      setOrbState('idle');
    }
  }

  function choose(pick: Pick) {
    say('user', pick.name);
    if (mode === 'update') {
      say('agent', `Opening ${pick.name}.`);
      proceeding.current = true;
      timers.current.push(setTimeout(() => navigate(`/campaigns/${pick.id}`), reduced ? 0 : 450));
      return;
    }
    setSource(pick);
    setMode('reuse-details');
    say('agent', `I’ll start a new campaign from ${pick.name}. What is different this time? Describe it or attach material, or continue with the details as they are.`);
  }

  // Reuse: copy the source campaign's General and Contact details into a new campaign;
  // identifiers, emails, touchpoints and the flow start fresh. Anything shared now is
  // processed on top.
  async function startReuse(pick: Pick, text: string, attached: File[]) {
    proceeding.current = true;
    setNotes('');
    setOrbState('speaking');
    try {
      const from = await api.campaign(pick.id);
      const state = initialState();
      state.step = 1;
      const fields = { ...(from.state?.fields || {}) };
      for (const id of ['10', '19', '21', '25']) delete fields[id];
      state.fields = { ...state.fields, ...fields };
      state.channel = from.state?.channel || '';
      const p = planning(state);
      for (const id of Object.keys(fields)) p.meta[id] = { source: `Reused from ${pick.name}` };
      if (text || attached.length) Object.assign(state.material, { notes: text, files: attached, submitted: true, processing: { startedAt: Date.now(), complete: false } });
      const campaign = await api.create(pick.brand || 'Reused campaign', state);
      adopt(campaign.id, state, text || attached.length ? 'processing' : 'review');
      navigate(`/campaigns/${campaign.id}`);
    } catch (e) {
      proceeding.current = false;
      say('agent', `I couldn’t copy that campaign: ${(e as Error).message}`);
      setOrbState('idle');
    }
  }

  function startOver() {
    setThread([]); setMode(''); setSource(null); setMatches([]); setQuery(''); setSelected(''); setFiles([]); setNotes('');
  }

  const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  const pickerList = (() => {
    if (!catalogue) return null;
    const q = query.trim().toLowerCase();
    const hits = q ? catalogue.filter(c => `${c.name} ${c.brand}`.toLowerCase().includes(q)) : catalogue;
    const top = matches.length && !q ? [...catalogue.filter(c => matches.includes(c.id)), ...hits.filter(c => !matches.includes(c.id))] : hits;
    return top.slice(0, 5);
  })();
  const chatting = thread.length > 0;

  return (
    <div className="is-welcome is-home">
      <AccelerateHeader />
      <main id="main">
        <section ref={root} className={`nora-welcome ${[...classes].join(' ')}${chatting ? ' is-chatting' : ''}`} data-agent-state={agentState} aria-label="NORA welcomes you">
          <div className="nora-presence">
            <AgentOrb className="nora-object" size="100%" state={orbState} />
            <div className="nora-signature" aria-hidden="true"><span />NORA <span className="nora-signature-divider">/</span> Requirement Collection Agent</div>
          </div>
          <TypedLine as="h1" className="nora-greeting" text={`Welcome, ${dashboardDemo.user.firstName}.`} />
          <TypedLine className="nora-name" text="I’m NORA, your campaign partner." />
          <TypedLine className="nora-purpose" text="I can help you kick off a new campaign, pick up where you left off, or see which campaigns need your attention. Just tell me what’s on your mind in the chat below, or pick one of the quick options to get started." />
          <TypedLine as="h2" className="nora-invitation sr-only" text="What would you like to do today?" id="choose-heading" />
          <div className="nora-choices" role="group" aria-labelledby="choose-heading" hidden={chatting}>
            {cards.map(([key, title, description]) => (
              <button key={key} type="button" className={`nora-choice ${selected === key ? 'is-selected' : ''}`} aria-label={title} onClick={() => select(key)}>
                <span className="nora-card-top"><svg viewBox="0 0 26 26" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" dangerouslySetInnerHTML={{ __html: icons[key] }} /><span aria-hidden="true">↗</span></span>
                <span className="nora-card-title">{title}</span>
                <span className="nora-card-description">{description}</span>
              </button>
            ))}
          </div>
          {chatting && (
            <div className="home-thread" aria-live="polite">
              {/* NORA's messages carry her orb as an avatar; the big orb above collapses away. */}
              {thread.map((m, n) => m.role === 'agent'
                ? <div key={n} className="home-row"><AgentOrb className="home-avatar" size={30} quality="low" /><p className="home-msg agent">{m.text}</p></div>
                : <p key={n} className="home-msg user">{m.text}</p>)}
              {thinking && <div className="home-row"><AgentOrb className="home-avatar" size={30} quality="low" state="thinking" /><p className="home-msg agent thinking"><span className="dots" aria-hidden="true"><i /><i /><i /></span>NORA is thinking</p></div>}
              {(mode === 'update' || mode === 'reuse') && !thinking && (
                <div className="home-picker" role="group" aria-label="Choose a campaign">
                  <input className="home-search" type="search" placeholder="Search campaigns by name or brand" value={query} onChange={e => setQuery(e.target.value)} aria-label="Search campaigns" />
                  {!pickerList ? <p className="home-picker-empty">Loading campaigns…</p>
                    : !pickerList.length ? <p className="home-picker-empty">No campaigns match that search.</p>
                    : pickerList.map(c => (
                      <button key={c.id} type="button" className={`home-pick${matches.includes(c.id) ? ' is-match' : ''}`} onClick={() => choose(c)}>
                        <strong>{c.name}</strong><span>{c.brand} · updated {fmtDate(c.updatedAt)}</span>
                      </button>
                    ))}
                  <button type="button" className="home-browse" onClick={() => navigate('/campaigns')}>Browse all campaigns →</button>
                </div>
              )}
              {mode === 'reuse-details' && source && !proceeding.current && (
                <div className="home-chips"><button type="button" onClick={() => startReuse(source, '', [])}>Continue with the details as they are</button></div>
              )}
              {mode === 'chat' && !thinking && (
                <div className="home-chips">{cards.map(([key, title]) => <button key={key} type="button" onClick={() => select(key)}>{title}</button>)}</div>
              )}
              {!thinking && !proceeding.current && mode !== 'chat' && <div className="home-chips"><button type="button" className="quiet" onClick={startOver}>Start over</button></div>}
              <div ref={threadEnd} />
            </div>
          )}
          <p className="nora-response" role="status" aria-live="polite">{response}</p>
          <div className="home-composer">
            <Composer value={notes} onChange={setNotes} onSend={send} onAttach={() => attachInput.current?.click()} placeholder="Tell me what you’re working on, or share whatever you have so far…" onMic={() => setResponse('Voice input is outside this demo.')} />
            <input ref={attachInput} type="file" multiple className="sr-only" tabIndex={-1} aria-label="Attach supporting material" accept=".pdf,.docx,.doc,.pptx,.xlsx,.xls,.csv,.txt,.md"
              onChange={e => { const picked = [...(e.target.files || [])]; e.target.value = ''; if (picked.length) { setFiles(f => [...f, ...picked]); setResponse(`${files.length + picked.length} file(s) attached. Send them, or add a note first.`); } }} />
            {files.length > 0 && <p className="upload-caption">Attached: {files.map(f => f.name).join(', ')}</p>}
            <p className="home-disclaimer">NORA is AI-powered and may make mistakes. Please review and validate outputs before finalizing.</p>
          </div>
        </section>
        {/* Side tabs: Workspace (this screen) and the Campaign Log. */}
        <nav className="home-side-tabs" aria-label="Workspace views">
          <button type="button" aria-current="page">Workspace</button>
          <button type="button" onClick={() => navigate('/campaigns')}>Campaign Log</button>
        </nav>
      </main>
    </div>
  );
}
