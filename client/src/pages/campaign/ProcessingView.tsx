import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import AccelerateHeader from '../../components/AccelerateHeader';
import AgentOrb from '../../components/AgentOrb';
import Composer from '../../components/Composer';
import { useCampaignStore } from '../../stores/useCampaignStore';
import { api } from '../../api';
import { applyMapped, mapLocally } from '../../studio/mapping';
import { definitions, planning, unresolved } from '../../studio/planningModel';
import { isMineFor, otherOwnerLabel } from '../../studio/ownership';

const stages = [
  { label: 'Uploading', title: 'Getting everything together…', description: 'Let me gather your documents and campaign details so we have everything in one place.' },
  { label: 'Reviewing', title: 'Getting familiar with your campaign…', description: 'I’m going through what you’ve shared to understand the campaign and what you’re looking to achieve.' },
  { label: 'Mapping', title: 'Putting the pieces together…', description: 'I’ve found the key details. Now I’m organizing them into your campaign plan.' },
  { label: 'Preparing', title: 'Just a few finishing touches…', description: 'I’m getting everything ready for you to review. Almost there!' },
];
const stageDuration = 1800;

// Ownership, as on the Campaign Canvas (the Delivery Manager's view).
const isMine = (id: string) => isMineFor('DM', id);
const ownerOf = (id: string) => otherOwnerLabel('DM', id);
const list = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}` : xs[0] || '');

// Strip anything that reads like internal bookkeeping: "(field 11)", "(21)", "fields 22, 23".
const clean = (t: string) => t.replace(/\s*\((?:fields?\s*)?[\d.,\s]+\)/gi, '').replace(/\bfields?\s+\d+(?:\.\d+)?(?:\s*(?:,|and)\s*\d+(?:\.\d+)?)*/gi, 'details').replace(/ {2,}/g, ' ').trim();

// Plain-language fallback when the model's note is unavailable.
function compose(state: any, count: number): string {
  const p = planning(state);
  const open: string[] = [...unresolved(state, 'General', 0), ...unresolved(state, 'Contact', 0)];
  p.emails.forEach((_: unknown, i: number) => open.push(...unresolved(state, 'Email', i)));
  const unique = [...new Set(open)].filter(id => !['45', '46', '47'].includes(id));
  const mine = unique.filter(isMine).map(id => definitions[id].field);
  const others = new Map<string, string[]>();
  for (const id of unique.filter(id => !isMine(id))) others.set(ownerOf(id), [...(others.get(ownerOf(id)) || []), definitions[id].field]);
  const parts = [count ? `I found ${count} details in your material and added them to the campaign.` : 'I couldn’t find campaign details I could use in this material.'];
  if (mine.length) parts.push(`Still to confirm on your side: ${list(mine.slice(0, 6))}${mine.length > 6 ? ` and ${mine.length - 6} more` : ''}.`);
  for (const [owner, fields] of others) parts.push(`${owner} will provide: ${list(fields.slice(0, 5))}${fields.length > 5 ? ` and ${fields.length - 5} more` : ''}.`);
  return parts.join('\n\n');
}

// The staged presentation runs while the server really parses and maps the
// material. "Complete" needs both: the last stage reached AND the result.
export default function ProcessingView() {
  const { state, mutate, setStage } = useCampaignStore();
  const startedAt = state.material.processing?.startedAt ?? Date.now();
  const [elapsedStage, setElapsedStage] = useState(0);
  const [note, setNote] = useState<string | null>(state.material.note ?? null);
  const [facts, setFacts] = useState<string[]>(state.material.facts ?? []);
  const [settled, setSettled] = useState(false);
  const [followUp, setFollowUp] = useState('');
  const navigate = useNavigate();
  const heading = useRef<HTMLHeadingElement>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    document.title = 'Campaign Accelerator · Preparing campaign material';
    heading.current?.focus({ preventScroll: true });
    const tick = setInterval(() => setElapsedStage(Math.max(0, Math.floor((Date.now() - startedAt) / stageDuration))), 200);
    const controller = new AbortController();
    abort.current = controller;
    const files = (state.material.files as File[]).filter(f => f instanceof File);
    api.extract(files, state.material.notes, planning(state).emails.length, controller.signal).then(res => {
      const extra: string[] = [];
      let count = 0;
      if (res.ai && res.values.length) mutate(s => { count = applyMapped(s, res.values, 'Mapped from your material').length; });
      else if (res.text.trim()) {
        mutate(s => { count = mapLocally(s, res.text).mapped.length; });
        extra.push('Mapped with simple field matching because no model is configured.');
      }
      if (res.failed.length) extra.push(`Could not read: ${res.failed.map(f => f.name).join(', ')}.`);
      const text = res.ai && res.reply ? clean(res.reply) : compose(useCampaignStore.getState().state, count);
      mutate(s => { s.material.note = text; s.material.facts = extra; s.material.summary = text.split('\n\n')[0]; s.material.processedAt = new Date().toISOString(); });
      setNote(text);
      setFacts(extra);
    }).catch(err => {
      if (controller.signal.aborted) return;
      const text = 'I couldn’t process this material. You can still continue and enter the details in the workspace.';
      const extra = [(err as Error).message];
      mutate(s => { s.material.note = text; s.material.facts = extra; });
      setNote(text);
      setFacts(extra);
    });
    return () => { clearInterval(tick); controller.abort(); };
    // Runs once per processing session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const current = Math.min(note === null ? stages.length - 1 : stages.length, elapsedStage);
  const reached = current === stages.length; // every checkpoint passed and the result is in
  // A short closing beat at 100% before the summary replaces the loader.
  useEffect(() => {
    if (!reached) return;
    const t = setTimeout(() => setSettled(true), matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 1000);
    return () => clearTimeout(t);
  }, [reached]);
  const complete = reached && settled;
  const shown = Math.min(current, stages.length - 1);

  function cancel() {
    if (complete) {
      mutate(s => { s.material.processing = null; s.material.reviewOpen = true; });
      setStage('review');
      return;
    }
    abort.current?.abort();
    mutate(s => { s.material.message = 'Preparation cancelled. Your selected files and notes have been kept.'; s.material.processing = null; s.material.submitted = false; });
    setStage('upload');
  }

  const paragraphs = (note || '').split(/\n{2,}/)
    // Drop caveat sentences only, never a whole paragraph.
    .map(para => (para.match(/[^.!?]+[.!?]+["”’)]*\s*|[^.!?]+$/g) || [para]).filter(sn => !/worth flagging|source conflict|may need confirming/i.test(sn)).join('').trim())
    .filter(Boolean);

  function uploadNew() {
    mutate(s => { s.material.processing = null; s.material.reviewOpen = false; s.material.submitted = false; });
    setStage('upload');
  }

  return (
    <>
      <AccelerateHeader />
      <main id="main" className="upload-main">
        {/* NORA reports progress as a chat message: one line per stage, then her summary. */}
        <section className="upload-experience processing-chat" aria-labelledby="processing-heading" data-stage={complete ? 'complete' : stages[shown].label.toLowerCase()}>
          <div className="processing-message" role="status" aria-live="polite" aria-atomic="true">
            <AgentOrb className="processing-avatar" size={36} quality="low" state={complete ? 'idle' : 'thinking'} />
            <div key={complete ? 'done' : shown} className="processing-fade">
              {complete ? <>
                <h1 id="processing-heading" ref={heading} tabIndex={-1}>All set!</h1>
                {paragraphs.map((paragraph, i) => <p key={i}>{paragraph}</p>)}
                {facts.length > 0 && <ul className="summary-facts">{facts.map(f => <li key={f}>{f}</li>)}</ul>}
              </> : <>
                <h1 id="processing-heading" ref={heading} tabIndex={-1}>{stages[shown].title}</h1>
                <p>{stages[shown].description}</p>
              </>}
              <div className="processing-actions">
                {complete ? <>
                  <button type="button" className="processing-secondary" onClick={uploadNew}>Upload New Document</button>
                  <button type="button" className="processing-primary" onClick={cancel}>Continue to Workspace</button>
                </> : <button type="button" className="processing-primary" onClick={cancel}>Cancel Process</button>}
              </div>
            </div>
          </div>
          <div className={`processing-composer ${complete ? '' : 'is-waiting'}`}>
            <Composer value={followUp} onChange={setFollowUp} disabled={!complete} placeholder="Tell me what you’re working on, or share whatever you have so far…"
              onSend={() => { mutate(s => { s.material.reviewNotes = followUp; }); setFollowUp(''); cancel(); }} onAttach={complete ? uploadNew : undefined} onMic={() => {}} />
            <p className="home-disclaimer">NORA is AI-powered and may make mistakes. Please review and validate outputs before finalizing.</p>
          </div>
        </section>
        {complete && (
          <nav className="home-side-tabs" aria-label="Workspace views">
            <button type="button" onClick={cancel}>Workspace</button>
            <button type="button" onClick={() => navigate('/campaigns')}>Campaign Log</button>
          </nav>
        )}
      </main>
    </>
  );
}
