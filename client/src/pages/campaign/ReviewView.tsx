import { useEffect, useRef, useState } from 'react';
import AccelerateHeader from '../../components/AccelerateHeader';
import AgentOrb, { useSpeakingPulse } from '../../components/AgentOrb';
import Composer from '../../components/Composer';
import Signature from '../../components/Signature';
import { useCampaignStore } from '../../stores/useCampaignStore';
import { planning, required, unresolved } from '../../studio/planningModel';
import { roleSection } from '../../studio/roleStatus';
import { usePersonaStore } from '../../stores/usePersonaStore';
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
  const role = usePersonaStore(st => st.role);
  const heading = useRef<HTMLHeadingElement>(null);
  const [feedback, setFeedback] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [pulse, setPulse] = useState(1);
  const orbState = useSpeakingPulse(pulse, 1800);

  useEffect(() => { document.title = 'Campaign Accelerator · Campaign review'; heading.current?.focus({ preventScroll: true }); }, []);

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
              const rs = roleSection(state, section.domain, role);
              const status = rs.tone === 'needs' ? 'Needs input' : rs.tone === 'waiting' ? `With ${rs.owners.join(' and ')}` : rs.tone === 'pending' ? 'Not started' : 'Complete';
              const req = required(state, section.domain);
              return (
                <button key={section.domain} type="button" className={`review-card${rs.tone === 'needs' ? ' needs-review' : ''}`} onClick={() => openSection(section.domain)}>
                  <span className="review-card-top"><span className="review-icon"><img src={`/assets/review/${section.icon}.svg`} alt="" /></span><span className={`review-status ${rs.tone === 'needs' ? 'needs-input' : rs.tone === 'waiting' || rs.tone === 'pending' ? 'with-others' : ''}`}>{status}</span></span>
                  <span className="review-count">{['Email', 'Touchpoint'].includes(section.domain) ? `${planning(state).emails.length} linked objects` : `${req.length - unresolved(state, section.domain, undefined).length}/${req.length} captured`}</span>
                  <strong>{section.label}</strong>
                  <span className="review-card-copy">Review what NORA prepared and fill the gaps.</span>
                  <span className="review-arrow"><img src="/assets/review/arrow.svg" alt="" /></span>
                </button>
              );
            })}
            {(() => {
              // For the Solution Architect, a draft that hasn't been finalized is flagged on the card itself.
              const f = planning(state).flow;
              const awaiting = role === 'SA' && !(f.svg && f.finalizedRevision === f.revision); // from the start: opening it generates the draft
              return (
                <button type="button" className={`review-card${awaiting ? ' needs-review' : ''}`} onClick={openFlow}>
                  <span className="review-card-top"><span className="review-icon"><img src="/assets/review/branch.svg" alt="" /></span><span className={`review-status${awaiting ? ' needs-input' : ''}`}>{awaiting ? 'Awaiting your review' : f.svg ? 'Generated' : 'Ready'}</span></span>
                  <span className="review-count">{awaiting ? (f.svg ? `Version ${f.revision} generated` : 'Initial draft ready') : f.svg ? 'Flow diagram saved' : 'No diagram yet'}</span>
                  <strong>Flow Design</strong>
                  <span className="review-card-copy">{awaiting ? 'The campaign flow has been generated and is waiting for your review.' : 'Generate and refine the campaign flow with Flow Planner.'}</span>
                  <span className="review-arrow"><img src="/assets/review/arrow.svg" alt="" /></span>
                </button>
              );
            })()}
          </div>
          <p className="review-start">Click a section to get started with adding your campaign details.</p>
          <Composer value={state.material.reviewNotes || ''} onChange={v => mutate(s => { s.material.reviewNotes = v; })} onSend={submit} disabled={busy} onAttach={() => setStage('upload')} />
          <p className="upload-caption">NORA will organise what you share into Campaign Canvas.</p>
          <p className="upload-feedback" role="status" aria-live="polite">{busy ? 'NORA is mapping your notes…' : feedback}</p>
        </section>
      </main>
    </>
  );
}
