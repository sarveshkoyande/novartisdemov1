import { useEffect, useRef, useState } from 'react';
import AccelerateHeader from '../../components/AccelerateHeader';
import AgentOrb, { useSpeakingPulse } from '../../components/AgentOrb';
import Composer from '../../components/Composer';
import Signature from '../../components/Signature';
import { useCampaignStore } from '../../stores/useCampaignStore';
import { planning, required, sectionStatus, unresolved } from '../../studio/planningModel';
import { api } from '../../api';
import { applyMapped, mapLocally } from '../../studio/mapping';

const sections = [
  { domain: 'General', label: 'General Information', icon: 'sparkles' },
  { domain: 'Contact', label: 'Project Team', icon: 'branch' },
  { domain: 'Email', label: 'Email Information', icon: 'sparkles' },
  { domain: 'Touchpoint', label: 'Touchpoint Details', icon: 'branch' },
];

// The fifth block: opens Flow Planner, available once General is complete.

export default function ReviewView() {
  const { state, mutate, setStage } = useCampaignStore();
  const heading = useRef<HTMLHeadingElement>(null);
  const [feedback, setFeedback] = useState<string>(state.material.summary || '');
  const [busy, setBusy] = useState(false);
  const [pulse, setPulse] = useState(1);
  const orbState = useSpeakingPulse(pulse, 1800);

  useEffect(() => { document.title = 'Accelerate · Campaign review'; heading.current?.focus({ preventScroll: true }); }, []);

  function respond(text: string) { setFeedback(text); setPulse(p => p + 1); }

  function openFlow() {
    mutate(s => { const p = planning(s); p.section = 'General'; p.view = 'flow'; });
    setStage('planning');
  }

  function openSection(section: string) {
    mutate(s => { const p = planning(s); p.section = section; p.view = 'memory'; });
    setStage('planning');
  }

  // Additional notes go through the same mapping as the planning chat.
  async function submit() {
    const text = (state.material.reviewNotes || '').trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      const res = await api.nora(text, 'General', planning(state).emails.length);
      let count = 0;
      mutate(s => { count = applyMapped(s, res.values, 'Provided by you · NORA').length; s.material.reviewNotes = ''; });
      respond(res.reply || `Added ${count} details to Campaign Canvas.`);
    } catch {
      let count = 0;
      mutate(s => { count = mapLocally(s, text).mapped.length; s.material.reviewNotes = ''; });
      respond(count ? `Added ${count} details to Campaign Canvas.` : 'I couldn’t map that safely. Use the field names shown in Campaign Canvas, e.g. “TACTPlan ID is ABC123”.');
    } finally { setBusy(false); }
  }

  return (
    <>
      <AccelerateHeader onNotice={respond} />
      <main id="main" className="upload-main review-main">
        <section className="upload-experience review-experience" aria-labelledby="review-heading">
          <button type="button" className="review-upload" onClick={() => { mutate(s => { s.material.reviewOpen = false; s.material.processing = null; }); setStage('upload'); }}>Upload New Document</button>
          <AgentOrb id="upload-orb" size={185.64} state={orbState} />
          <Signature />
          <h1 id="review-heading" ref={heading} tabIndex={-1}>Your campaign workspace is ready to review.</h1>
          <p className="review-intro">I’ve mapped the information I could find. Review what’s prepared and complete anything that’s still missing.</p>
          <div className="review-sections">
            {sections.map(section => {
              const status = sectionStatus(state, section.domain);
              const req = required(state, section.domain);
              return (
                <button key={section.domain} type="button" className="review-card" onClick={() => openSection(section.domain)}>
                  <span className="review-card-top"><span className="review-icon"><img src={`/assets/review/${section.icon}.svg`} alt="" /></span><span className={`review-status ${status === 'Complete' ? '' : 'needs-input'}`}>{status}</span></span>
                  <span className="review-count">{['Email', 'Touchpoint'].includes(section.domain) ? `${planning(state).emails.length} linked objects` : `${req.length - unresolved(state, section.domain, undefined).length}/${req.length} required captured`}</span>
                  <strong>{section.label}</strong>
                  <span className="review-card-copy">Review what NORA prepared and fill the gaps.</span>
                  <span className="review-arrow"><img src="/assets/review/arrow.svg" alt="" /></span>
                </button>
              );
            })}
            <button type="button" className="review-card" onClick={openFlow}>
              <span className="review-card-top"><span className="review-icon"><img src="/assets/review/branch.svg" alt="" /></span><span className="review-status">{planning(state).flow.svg ? 'Generated' : 'Ready'}</span></span>
              <span className="review-count">{planning(state).flow.svg ? 'Flow diagram saved' : 'No diagram yet'}</span>
              <strong>Flow Design</strong>
              <span className="review-card-copy">Generate and refine the campaign flow with Flow Planner.</span>
              <span className="review-arrow"><img src="/assets/review/arrow.svg" alt="" /></span>
            </button>
          </div>
          <Composer value={state.material.reviewNotes || ''} onChange={v => mutate(s => { s.material.reviewNotes = v; })} onSend={submit} disabled={busy} onAttach={() => setStage('upload')} />
          <p className="upload-caption">NORA will organise what you share into Campaign Canvas.</p>
          <p className="upload-demo-note">Status reflects the saved campaign. Source conflicts stay flagged for confirmation.</p>
          <p className="upload-feedback" role="status" aria-live="polite">{busy ? 'NORA is mapping your notes…' : feedback}</p>
        </section>
      </main>
    </>
  );
}
