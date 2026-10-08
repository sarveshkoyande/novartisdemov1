import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import AccelerateHeader from '../components/AccelerateHeader';
import AgentOrb from '../components/AgentOrb';
import TypedLine from '../components/TypedLine';
import Composer from '../components/Composer';
import { setPendingIntake, takePendingIntake } from '../studio/pendingIntake';
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
  existing: '<rect x="5" y="5" width="16" height="16" rx="3"/><path d="M10 10h11v11M5 15h10v6"/>',
  brand: '<path d="M13 4v18M4 13h18"/><path d="M6 4H4v2m16-2h2v2M4 20v2h2m14 0h2v-2"/>',
  indication: '<path d="M4 17 11 10l5 5 7-9"/><path d="M17 6h6v6"/><circle cx="5" cy="20" r="2"/>',
  update: '<path d="M21 13a8 8 0 1 1-2.6-5.9"/><path d="M21 4v5h-5"/>',
};
const cards: [string, string, string][] = [
  ['existing', 'Existing Brand', 'Create a new campaign for an existing brand.'],
  ['brand', 'New Brand', 'Create a campaign for a brand that has not yet been set up.'],
  ['indication', 'New Indication', 'Create a campaign for a new indication under an existing brand.'],
];

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

  // Home composer: whatever is shared here is carried into the new campaign
  // and read by NORA together with the upload step (Existing Brand journey).
  function send() {
    if (!notes.trim() && !files.length) return;
    setPendingIntake({ notes, files });
    select('existing');
  }

  // Each card opens a campaign straight on the upload step. The card decides
  // the Request Type; the brand is captured later from the material or NORA.
  const requestType: Record<string, string> = { existing: 'Update Existing Campaign', brand: 'New Brand Launch', indication: 'New Indication Launch' };
  const cardName: Record<string, string> = { existing: 'Existing Brand', brand: 'New Brand', indication: 'New Indication' };

  async function select(key: string) {
    if (proceeding.current) return;
    finishIntroduction();
    setSelected(key);
    setAgentState('acknowledgement');
    setOrbState('speaking');
    if (key === 'update') {
      setResponse('Update Existing Campaign. Let’s find the one you want to change.');
      proceeding.current = true;
      timers.current.push(setTimeout(() => navigate('/campaigns'), reduced ? 0 : 320));
      return;
    }
    setResponse(`${cardName[key]}. Let’s start with what you already have.`);
    proceeding.current = true;
    const state = initialState();
    state.step = 1;
    const p = planning(state);
    state.fields['12'] = requestType[key];
    state.fields['13'] = key === 'brand' ? 'Yes' : 'No';
    p.meta['12'] = { source: `Inherited · ${cardName[key]} journey` };
    p.meta['13'] = { source: 'Inherited · Request Type' };
    const intake = takePendingIntake();
    if (intake) { state.material.notes = intake.notes; state.material.files = intake.files; }
    try {
      const [campaign] = await Promise.all([api.create(cardName[key], state), new Promise(r => setTimeout(r, reduced ? 0 : 320))]);
      adopt(campaign.id, state, 'upload');
      navigate(`/campaigns/${campaign.id}`);
    } catch (e) {
      proceeding.current = false;
      setResponse(`Could not start the campaign: ${(e as Error).message}`);
      setAgentState('waiting'); setOrbState('idle');
    }
  }

  return (
    <div className="is-welcome is-home">
      <AccelerateHeader />
      <main id="main">
        <section ref={root} className={`nora-welcome ${[...classes].join(' ')}`} data-agent-state={agentState} aria-label="NORA welcomes you">
          <div className="nora-presence">
            <AgentOrb className="nora-object" size="100%" state={orbState} />
            <div className="nora-signature" aria-hidden="true"><span />NORA <span className="nora-signature-divider">/</span> Requirement Collection Agent</div>
          </div>
          <TypedLine as="h1" className="nora-greeting" text={`Welcome, ${dashboardDemo.user.firstName}.`} />
          <TypedLine className="nora-name" text="I’m NORA, your campaign agent." />
          <TypedLine className="nora-purpose" text="I’ll bring the right campaign context, people and details together as we go." />
          <TypedLine as="h2" className="nora-invitation" text="What would you like to create today?" id="choose-heading" />
          <div className="nora-choices" role="group" aria-labelledby="choose-heading">
            {cards.map(([key, title, description]) => (
              <button key={key} type="button" className={`nora-choice ${selected === key ? 'is-selected' : ''}`} aria-label={title} onClick={() => select(key)}>
                <span className="nora-card-top"><svg viewBox="0 0 26 26" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" dangerouslySetInnerHTML={{ __html: icons[key] }} /><span aria-hidden="true">↗</span></span>
                <span className="nora-card-title">{title}</span>
                <span className="nora-card-description">{description}</span>
              </button>
            ))}
          </div>
          <p className="nora-response" role="status" aria-live="polite">{response}</p>
          <div className="home-composer">
            <Composer value={notes} onChange={setNotes} onSend={send} onAttach={() => attachInput.current?.click()} />
            <input ref={attachInput} type="file" multiple className="sr-only" tabIndex={-1} aria-label="Attach supporting material" accept=".pdf,.docx,.doc,.pptx,.xlsx,.xls,.csv,.txt,.md"
              onChange={e => { const picked = [...(e.target.files || [])]; e.target.value = ''; if (picked.length) { setFiles(f => [...f, ...picked]); setResponse(`${files.length + picked.length} file(s) attached. Send, then choose the brand.`); } }} />
            {files.length > 0 && <p className="upload-caption">Attached: {files.map(f => f.name).join(', ')}</p>}
            <p className="upload-caption">NORA will organise what you share into Campaign Canvas.</p>
          </div>
        </section>
      </main>
    </div>
  );
}
