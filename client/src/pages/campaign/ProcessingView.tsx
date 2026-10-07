import { useEffect, useRef, useState } from 'react';
import AccelerateHeader from '../../components/AccelerateHeader';
import AgentOrb from '../../components/AgentOrb';
import Signature from '../../components/Signature';
import { useCampaignStore } from '../../stores/useCampaignStore';
import { api } from '../../api';
import { applyMapped, mapLocally } from '../../studio/mapping';
import { definitions, planning, unresolved } from '../../studio/planningModel';
import { isMineFor, otherOwnerLabel } from '../../studio/ownership';

const stages = [
  { label: 'Uploading', title: 'Gathering your material', description: 'Bringing your selected documents and notes together for review.' },
  { label: 'Reviewing', title: 'Reviewing the material', description: 'NORA is identifying campaign information that can be used in the planning workspace.' },
  { label: 'Mapping', title: 'Connecting the campaign context', description: 'Organising the available information around the campaign details it relates to.' },
  { label: 'Preparing', title: 'Preparing for your review', description: 'Bringing the context together and highlighting what still needs your input.' },
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
  const heading = useRef<HTMLHeadingElement>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    document.title = 'Accelerate · Preparing campaign material';
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
      mutate(s => { s.material.note = text; s.material.facts = extra; s.material.summary = text.split('\n\n')[0]; });
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
  // Checkpoints sit at the centre of each stage's column; the head glides most of the
  // way to the next one while that stage runs, and holds there until the stage completes.
  const checkpoint = (i: number) => (i < 0 ? 0 : (i + 0.5) * (100 / stages.length));
  const position = reached ? 100 : checkpoint(current - 1) + 0.8 * (checkpoint(current) - checkpoint(current - 1));

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

  return (
    <>
      <AccelerateHeader />
      <main id="main" className="upload-main">
        <section className="upload-experience upload-processing" aria-labelledby="processing-heading" data-stage={complete ? 'complete' : stages[shown].label.toLowerCase()}>
          <AgentOrb id="upload-orb" size={185.64} state={complete ? 'idle' : 'thinking'} />
          <Signature />
          <div className="processing-copy" role="status" aria-live="polite" aria-atomic="true">
            <div key={complete ? 'done' : shown} className="processing-fade">
              <h1 id="processing-heading" ref={heading} tabIndex={-1}>{complete ? 'Material preparation complete' : stages[shown].title}</h1>
              <p className="processing-description">{complete ? 'Here’s what NORA found.' : stages[shown].description}</p>
            </div>
          </div>

          {!complete ? (
            <div className={`processing-progress ${reached ? 'is-done' : ''}`} aria-label="Material preparation progress">
              <div className="proc-rail" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(position)}>
                <div className="proc-fill" style={{ width: `${position}%` }}><b className="proc-streak" /></div>
                <span className="proc-head" style={{ left: `${position}%` }} />
                {stages.map((stage, i) => (
                  <span key={stage.label} className={`proc-check ${i < current ? 'is-reached' : ''}`} style={{ left: `${checkpoint(i)}%` }} />
                ))}
              </div>
              <ol className="proc-stages">
                {stages.map((stage, index) => (
                  <li key={stage.label} className={index < current ? 'is-complete' : index === current ? 'is-active' : ''} aria-current={index === current ? 'step' : undefined}>
                    {stage.label}<span className="sr-only">{index < current ? ' (complete)' : index === current ? ' (in progress)' : ' (pending)'}</span>
                  </li>
                ))}
              </ol>
            </div>
          ) : (
            <article className="processing-summary" aria-label="What NORA found">
              {(note || '').split(/\n{2,}/).filter(Boolean).map((paragraph, i) => <p key={i}>{paragraph}</p>)}
              {facts.length > 0 && <ul className="summary-facts">{facts.map(f => <li key={f}>{f}</li>)}</ul>}
            </article>
          )}

          <button type="button" className={`processing-cancel ${complete ? 'is-primary' : ''}`} onClick={cancel}>{complete ? 'Continue to review' : 'Cancel Upload'}</button>
          <p className="processing-demo">Files are parsed on the server and discarded; only the mapped campaign details are saved.</p>
        </section>
      </main>
    </>
  );
}
