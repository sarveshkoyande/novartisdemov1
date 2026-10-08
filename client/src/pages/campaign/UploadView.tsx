import { useEffect, useRef, useState } from 'react';
import AccelerateHeader from '../../components/AccelerateHeader';
import AgentOrb, { useSpeakingPulse } from '../../components/AgentOrb';
import Composer from '../../components/Composer';
import Signature from '../../components/Signature';
import { useCampaignStore } from '../../stores/useCampaignStore';

const size = (n: number) => (n < 1024 ? `${n} B` : `${Math.ceil(n / 1024)} KB`);

export default function UploadView() {
  const { state, mutate, setStage } = useCampaignStore();
  const draft = state.material;
  const input = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const [dragging, setDragging] = useState(false);
  const [message, setMessage] = useState<string>(draft.message || '');
  const [pulse, setPulse] = useState(0);
  const orbState = useSpeakingPulse(pulse, 1500);
  const dragDepth = useRef(0);
  const hasContent = draft.files.length > 0 || draft.notes.trim().length > 0;

  useEffect(() => {
    document.title = 'Campaign Accelerator · Upload campaign material';
    heading.current?.focus({ preventScroll: true });
    // Keep drops outside the target from navigating away and losing the draft.
    const prevent = (e: DragEvent) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault(); };
    window.addEventListener('dragover', prevent);
    window.addEventListener('drop', prevent);
    return () => { window.removeEventListener('dragover', prevent); window.removeEventListener('drop', prevent); };
  }, []);

  function respond(text: string) {
    mutate(s => { s.material.message = text; });
    setMessage(text);
    setPulse(p => p + 1);
  }
  function addFiles(files: File[]) {
    mutate(s => {
      for (const file of files) {
        if (!s.material.files.some((f: File) => f.name === file.name && f.size === file.size && f.lastModified === file.lastModified)) s.material.files.push(file);
      }
      s.material.submitted = false; s.material.skipped = false;
    });
    respond(`${state.material.files.length} file${state.material.files.length === 1 ? '' : 's'} attached. Ready when you are.`);
  }
  function submit() {
    if (!hasContent) return;
    mutate(s => { Object.assign(s.material, { submitted: true, skipped: false, message: '', processing: { startedAt: Date.now(), complete: false } }); });
    setStage('processing');
  }

  return (
    <>
      <AccelerateHeader onNotice={respond} />
      <main id="main" className="upload-main">
        <section className="upload-experience" aria-labelledby="upload-heading">
          <AgentOrb id="upload-orb" size={185.64} state={orbState} />
          <Signature />
          <h1 id="upload-heading" ref={heading} tabIndex={-1}>Upload kick-off meeting notes, a TACTPlan export or other documents to kick-start campaign planning.</h1>
          <p className="upload-intro">I can use what you already have to prepare the campaign details for review.</p>
          <div className="upload-files-area">
            <div className={`upload-drop ${dragging ? 'is-dragging' : ''}`} id="upload-drop"
              onDragEnter={e => { e.preventDefault(); dragDepth.current++; setDragging(true); }}
              onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
              onDragLeave={e => { e.preventDefault(); if (--dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false); } }}
              onDrop={e => { e.preventDefault(); dragDepth.current = 0; setDragging(false); const files = [...e.dataTransfer.files]; if (files.length) addFiles(files); else respond('Drop a file here, or paste text into the notes area.'); }}>
              <img className="upload-cloud" src="/assets/upload/upload.svg" alt="" />
              <p>Drag &amp; drop files or <button type="button" className="upload-browse" onClick={() => input.current?.click()}>Browse</button></p>
              <small>Supported formats: PDF, Word, PowerPoint (.pptx), Excel, CSV, TXT</small>
            </div>
            <input ref={input} id="upload-files" type="file" multiple accept=".pdf,.docx,.doc,.pptx,.xlsx,.xls,.csv,.txt,.md" className="sr-only" tabIndex={-1} aria-label="Choose supporting files" aria-describedby="upload-limit"
              onChange={e => { addFiles([...(e.target.files || [])]); e.target.value = ''; }} />
            <ul className="upload-file-list" aria-label="Selected files" hidden={!draft.files.length}>
              {draft.files.map((file: File, index: number) => (
                <li key={`${file.name}-${index}`}>
                  <span><strong>{file.name}</strong><small>{size(file.size)} · {file instanceof File ? 'Ready to read' : 'From an earlier session — attach again to re-read'}</small></span>
                  <button type="button" aria-label={`Remove ${file.name}`} onClick={() => { mutate(s => { s.material.files.splice(index, 1); }); respond('Attachment removed.'); }}>×</button>
                </li>
              ))}
            </ul>
            <div className="upload-actions">
              <button type="button" className="upload-skip" onClick={() => { mutate(s => { s.material.skipped = true; }); setStage('review'); }}>Not now</button>
              <button type="button" className="upload-submit" disabled={!hasContent} onClick={submit}><span aria-hidden="true">↑</span> Upload document or notes</button>
            </div>
          </div>
          <Composer value={draft.notes} onChange={v => mutate(s => { s.material.notes = v; s.material.submitted = false; })} onSend={submit} onAttach={() => input.current?.click()} />
          <p className="upload-caption">NORA will organise what you share into Campaign Canvas.</p>
          <p id="upload-limit" className="upload-demo-note">Files are parsed to text for mapping and discarded. Your campaign draft is saved automatically.</p>
          <p className="upload-feedback" role="status" aria-live="polite">{message}</p>
        </section>
      </main>
    </>
  );
}
