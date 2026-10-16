import { useEffect, useRef, useState, type ReactNode } from 'react';
import AccelerateHeader from '../../components/AccelerateHeader';
import AgentOrb from '../../components/AgentOrb';
import Composer from '../../components/Composer';
import OptionPicker from '../../components/EmailPicker';
import { emailLibrary, ensureSegments, nextAsk, preheaderOptions, seedDemoEmails, subjectOptions, WAIT_OPTIONS, type Segment } from '../../studio/touchpointDemo';
import Signature from '../../components/Signature';
import { useCampaignStore } from '../../stores/useCampaignStore';
import { api } from '../../api';
import { applyMapped } from '../../studio/mapping';
import { brands } from '../../studio/demoData';
import { isMineFor, otherOwnerLabel } from '../../studio/ownership';
import { PERSONAS, usePersonaStore } from '../../stores/usePersonaStore';
import {
  planning, groups, definitions, label, target, value, choices, applicable, issue, required, unresolved,
  sectionStatus, addEmail, inherit, setField, evaluateGeneral, revise, resubmit, validate, mapMessage, provideCampaignCode,
} from '../../studio/planningModel';
import { inputsFromCampaign, generateFlow, chatEditFlow, patchToInputs } from '../../studio/flowPlanner';
import type { OrbState } from '../../components/agent-orb/agent-orb.js';

const SECTION_NAMES: Record<string, string> = { General: 'General Information', Contact: 'Project Team', Email: 'Email Information', Touchpoint: 'Touchpoint Details' };

// Shapes offered from a block's "+" on the Flow Canvas. Picking one drafts the
// instruction for Flow Planner; nothing changes until it is sent.
const SHAPES = [
  { key: 'decision', label: 'Decision', icon: '<path d="M12 3 21 12 12 21 3 12Z"/>' },
  { key: 'segment', label: 'Segment', icon: '<circle cx="9" cy="9" r="3"/><circle cx="16" cy="15" r="3"/><path d="M4 20c0-3 2.5-5 5-5M14 9h6"/>' },
  { key: 'email', label: 'Email', icon: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 6.5 8.5 6.5 8.5-6.5"/>' },
  { key: 'sms', label: 'SMS', icon: '<rect x="6" y="2.5" width="12" height="19" rx="2.5"/><path d="M10 18.5h4"/>' },
  { key: 'wait', label: 'Wait', icon: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>' },
  { key: 'database', label: 'Database', icon: '<ellipse cx="12" cy="5.5" rx="7.5" ry="2.5"/><path d="M4.5 5.5v13c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5v-13M4.5 12c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5"/>' },
  { key: 'exit', label: 'Exit', icon: '<rect x="4" y="4" width="16" height="16" rx="8"/><path d="M9.5 9.5l5 5M14.5 9.5l-5 5"/>' },
];

function Btn({ onClick, children, ...rest }: { onClick: () => void; children: ReactNode; [k: string]: any }) {
  return <button type="button" onClick={onClick} {...rest}>{children}</button>;
}

export default function PlanningView() {
  const { state, mutate, setStage, saving } = useCampaignStore();
  const p = planning(state);
  const flow = p.view === 'flow', sa = p.view === 'validation', s = p.section;
  const key = flow ? 'Flow' : s;
  const [flowBusy, setFlowBusy] = useState(false);
  const busy = flow && flowBusy;
  const [notice, setNotice] = useState('');
  const [preview, setPreview] = useState<number | null>(null);
  // The right-hand panel: Workspace (Campaign Memory) or Campaign Log; it can be closed.
  const [panelOpen, setPanelOpen] = useState(true);
  const [panelTab, setPanelTab] = useState<'workspace' | 'log'>('workspace');
  const openPanel = (tab: 'workspace' | 'log') => { setPanelTab(tab); setPanelOpen(true); };
  // Touchpoints are organised by segment: set the segments up the first time the section opens.
  useEffect(() => {
    if (['Email', 'Touchpoint'].includes(s) && !p.emails.length) update(st => { seedDemoEmails(st, addEmail, inherit); });
    // The Email section is a list of prepared emails to review, so it opens on the full field list.
    if (s === 'Email' && p.mode !== 'REVIEW ALL') update((_, pl) => { pl.mode = 'REVIEW ALL'; });
    if (s === 'Touchpoint' && !p.segments?.length) update(st => { ensureSegments(st); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s, state]);  // state: re-run when a freshly loaded copy of the campaign replaces this one
  // Flow canvas hover tools: the block under the pointer and whether its shape palette is open.
  const [blockTools, setBlockTools] = useState<{ code: string; left: number; top: number; open: boolean } | null>(null);
  const toolsTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hideToolsSoon = () => { clearTimeout(toolsTimer.current); toolsTimer.current = setTimeout(() => setBlockTools(null), 350); };
  const [historyOpen, setHistoryOpen] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [orbState, setOrbState] = useState<OrbState>('idle');
  const [editValue, setEditValue] = useState('');
  // Conversational questions: the one on screen, model-written wording per field, and skips.
  const current = useRef<{ key: string; id: string; section: string; index: number; found: string; master?: string; options: string[] } | null>(null);
  const [asked, setAsked] = useState<Record<string, string>>({});
  const [asking, setAsking] = useState('');
  const [skipped, setSkipped] = useState<string[]>([]);
  const failedQs = useRef(new Set<string>());
  // Section wrap-ups written by the model, keyed by section, object and campaign version.
  const statusReq = useRef<{ key: string; body: Parameters<typeof api.sectionStatus>[0] } | null>(null);
  const [statusNotes, setStatusNotes] = useState<Record<string, string>>({});
  const [statusAsking, setStatusAsking] = useState('');
  const failedStatus = useRef(new Set<string>());
  useEffect(() => {
    const r = statusReq.current;
    if (!r || statusNotes[r.key] || statusAsking === r.key || failedStatus.current.has(r.key)) return;
    setStatusAsking(r.key);
    api.sectionStatus(r.body)
      .then(res => { if (res.message) setStatusNotes(n => ({ ...n, [r.key]: res.message })); else failedStatus.current.add(r.key); })
      .catch(() => { failedStatus.current.add(r.key); })
      .finally(() => setStatusAsking(''));
  });
  const role = usePersonaStore(s => s.role);
  const heading = useRef<HTMLHeadingElement>(null);
  const thread = useRef<HTMLDivElement>(null);
  const attach = useRef<HTMLInputElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const notes = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const history = p.messages[key];
  useEffect(() => { setSkipped([]); }, [s, p.active, role]);
  const draft = p.drafts[key] || '';

  const update = (fn: (st: any, pl: any) => void) => mutate(st => fn(st, planning(st)));

  useEffect(() => {
    document.title = 'Campaign Accelerator · ' + (flow ? 'Flow Planner' : s);
    heading.current?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, [flow, s, sa]);


  useEffect(() => {
    if (busy || thinking) { setOrbState('thinking'); return; }
    if (history.at(-1)?.role === 'agent') {
      setOrbState('speaking');
      const t = setTimeout(() => setOrbState('idle'), 1500);
      return () => clearTimeout(t);
    }
    setOrbState('idle');
  }, [busy, thinking, history.length, history]);

  // Ease to the latest exchange (your last message, with the reply below it) rather than snapping to the end.
  const seen = useRef(0);
  useEffect(() => {
    const el = thread.current;
    if (!el) return;
    const grew = history.length > seen.current;
    seen.current = history.length;
    const users = el.querySelectorAll<HTMLElement>('.user-message');
    const target = users[users.length - 1];
    if (!grew || !target) return;
    const top = target.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 12;
    el.scrollTo({ top, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }, [history.length, key]);

  // Edits auto-persist as a draft; "Save … Details" is the explicit
  // checkpoint the design shows, so "Unsaved changes" means changes since
  // the last time the user saved this campaign.
  const dirty = !flow && p.version !== (p.savedVersion ?? -1);
  async function saveSection() {
    update((_, pl) => { pl.savedVersion = pl.version; });
    await useCampaignStore.getState().flush();
    setNotice(useCampaignStore.getState().saving === 'error' ? 'Could not reach the server. Your changes are kept in this session.' : `${s} Details saved.`);
  }

  const setDraft = (v: string) => update((_, pl) => { pl.drafts[key] = v; });
  const focusComposer = () => notes.current?.querySelector('textarea')?.focus();
  const navigateSection = (section: string) => update((_, pl) => { pl.section = section; pl.view = 'memory'; pl.editing = null; });
  const toWorkspace = () => setStage('review');

  // Flow Planner: generate/update regenerates from the latest Campaign
  // Memory; anything else is a plain-English edit through the server's
  // chat-edit tool, merged into planning.flow.edits, then regenerated.
  // ---- Flow lifecycle -------------------------------------------------------
  // Draft → Finalized → Sent for approval. Every generation, edit and restore is a
  // new version; the audit trail records who did what. Approval is simulated: nothing
  // leaves the app. Changing a finalized flow makes it a draft again.
  const actor = () => PERSONAS[role].role;
  const MAX_DIAGRAMS = 12;
  const approval = p.flow.approval as { status: string; revision: number } | undefined;
  const approvalSent = !!approval && approval.revision === p.flow.revision;
  const isFinal = !!p.flow.svg && p.flow.finalizedRevision === p.flow.revision;
  const stageLabel = approvalSent ? 'Sent for approval' : isFinal ? 'Finalized' : 'Draft';

  // Older campaigns have a diagram but no history yet: seed version 1 from it.
  function ensureHistory(pl: any) {
    pl.flow.versions ||= [];
    pl.flow.audit ||= [];
    if (pl.flow.svg && !pl.flow.versions.length) {
      pl.flow.versions.push({ revision: pl.flow.revision || 1, svg: pl.flow.svg, edits: JSON.parse(JSON.stringify(pl.flow.edits || {})), at: null, by: 'Flow Planner Agent', kind: 'initial', note: 'Initial draft' });
    }
  }
  function logAudit(pl: any, by: string, action: string) {
    pl.flow.audit ||= [];
    pl.flow.audit.push({ at: new Date().toISOString(), by, action, revision: pl.flow.revision });
  }
  // Call after pl.flow.svg / revision hold the NEW version (ensureHistory must run before they change).
  function recordVersion(pl: any, kind: string, note: string, by: string) {
    pl.flow.versions.push({ revision: pl.flow.revision, svg: pl.flow.svg, edits: JSON.parse(JSON.stringify(pl.flow.edits || {})), at: new Date().toISOString(), by, kind, note });
    const withDiagram = pl.flow.versions.filter((v: any) => v.svg);
    // Keep diagrams for the most recent versions only; older entries keep their history line.
    if (withDiagram.length > MAX_DIAGRAMS) withDiagram.slice(0, withDiagram.length - MAX_DIAGRAMS).forEach((v: any) => { v.svg = null; });
    logAudit(pl, by, note);
  }

  // When Flow Planner opens with no flow yet, the initial draft is generated automatically.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!flow || p.flow.svg || flowBusy || autoStarted.current) return;
    autoStarted.current = true;
    generateInitialDraft();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow]);

  async function generateInitialDraft() {
    setFlowBusy(true);
    try {
      const out = await generateFlow(inputsFromCampaign(useCampaignStore.getState().state));
      update((_, pl) => {
        ensureHistory(pl);
        pl.flow.edits ||= {};
        pl.flow.svg = out.svg; pl.flow.edits.codeAssignments = out.codeAssignments;
        pl.flow.version = pl.version; pl.flow.revision = (pl.flow.revision || 0) + 1; pl.flow.status = 'generated';
        recordVersion(pl, 'initial', 'Initial draft generated', 'Flow Planner Agent');
        pl.flow.noticeOpen = true;
        const first = 'Initial draft of the campaign flow has been generated.';
        const rest = 'Review it on the canvas and ask me for any changes. When it looks right, finalize the draft and it can go for approval.';
        pl.messages.Flow.push({ role: 'agent', text: `${first} ${rest}`, event: 'flow-draft' });
      });
      setNotice('Initial draft of the campaign flow has been generated.');
    } catch (e) {
      update((_, pl) => { pl.messages.Flow.push({ role: 'agent', text: `I couldn’t generate the initial draft: ${(e as Error).message}` }); });
    } finally { setFlowBusy(false); }
  }

  function finalizeDraft() {
    if (thinking || busy || !p.flow.svg || isFinal) return;
    update((_, pl) => { pl.messages.Flow.push({ role: 'user', text: 'Finalize this draft.' }); });
    setThinking(true);
    setTimeout(() => {
      update((_, pl) => {
        ensureHistory(pl);
        pl.flow.finalizedRevision = pl.flow.revision;
        logAudit(pl, actor(), 'Draft finalized');
        pl.messages.Flow.push({ role: 'agent', text: `Version ${pl.flow.revision} is finalized. You can now send it for approval.` });
      });
      setThinking(false);
    }, 750);
  }

  function sendForApproval() {
    if (thinking || busy || !p.flow.svg || !isFinal || approvalSent) return;
    update((_, pl) => { pl.messages.Flow.push({ role: 'user', text: 'Send this flow for approval.' }); });
    setThinking(true);
    setTimeout(() => {
      update((_, pl) => {
        ensureHistory(pl);
        pl.flow.approval = { status: 'sent', revision: pl.flow.revision, sentAt: new Date().toISOString() };
        logAudit(pl, actor(), 'Sent for approval');
        const first = `I’ve sent version ${pl.flow.revision} of the flow for approval.`;
        const rest = 'I’ll let you know here once it has been reviewed. If you change the flow, it becomes a draft again and I’ll ask you to finalize and resend it.';
        pl.messages.Flow.push({ role: 'agent', text: `${first} ${rest}` });
      });
      setThinking(false);
    }, 750);
  }

  function restoreVersion(rev: number) {
    const v = (p.flow.versions || []).find((x: any) => x.revision === rev);
    if (!v?.svg || busy || thinking) return;
    update((_, pl) => {
      ensureHistory(pl);
      pl.flow.svg = v.svg;
      pl.flow.edits = JSON.parse(JSON.stringify(v.edits || {}));
      pl.flow.revision = (pl.flow.revision || 0) + 1;
      pl.flow.version = pl.version;
      recordVersion(pl, 'restore', `Restored from version ${rev}`, actor());
      pl.messages.Flow.push({ role: 'agent', text: `I’ve restored version ${rev} as version ${pl.flow.revision}. It’s a draft again, so finalize it when you’re happy with it.` });
    });
    setPreview(null);
  }

  const fmtWhen = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'Before history was kept');

  async function runFlow(text: string) {
    const say = (t: string) => update((_, pl) => { pl.messages.Flow.push({ role: 'agent', text: t }); });
    update((_, pl) => { pl.messages.Flow.push({ role: 'user', text }); pl.drafts.Flow = ''; pl.flow.edits ||= {}; });
    setFlowBusy(true);
    try {
      const regenerate = /(?:generate|create|update|refresh|regenerate).*(?:flow|campaign details|diagram)/i.test(text);
      let summary = '';
      if (!regenerate) {
        if (!p.flow.svg) { say('The initial draft is still being prepared. Describe the change once it appears.'); return; }
        const res = await chatEditFlow(text, inputsFromCampaign(state));
        const real = patchToInputs(res.patch || {}, inputsFromCampaign(state));
        if (res.codeAssignments) real.codeAssignments = res.codeAssignments;
        summary = res.summary;
        if (!Object.keys(real).length) { say(summary); return; }
        update((_, pl) => { Object.assign(pl.flow.edits, real); });
      }
      const out = await generateFlow(inputsFromCampaign(state));
      update((_, pl) => {
        ensureHistory(pl);
        const wasFinal = pl.flow.svg && pl.flow.finalizedRevision === pl.flow.revision;
        pl.flow.svg = out.svg; pl.flow.edits.codeAssignments = out.codeAssignments;
        pl.flow.version = pl.version; pl.flow.revision = (pl.flow.revision || 0) + 1; pl.flow.status = 'generated';
        recordVersion(pl, regenerate ? 'refresh' : 'edit', regenerate ? 'Updated from latest campaign details' : `Edited: ${text.length > 60 ? text.slice(0, 57) + '…' : text}`, actor());
        pl.messages.Flow.push({ role: 'agent', text: (summary || 'Flow updated with the latest campaign details.') + ` This is version ${pl.flow.revision}${wasFinal ? ', back in draft until you finalize it again' : ''}.` });
      });
    } catch (e) {
      say(`Flow Planner could not complete that: ${(e as Error).message}`);
    } finally { setFlowBusy(false); }
  }

  // Ask the model to word the open question (once per field), keeping the chat fresh.
  useEffect(() => {
    const q = current.current;
    if (!q || asked[q.key] || asking === q.key || failedQs.current.has(q.key)) return;
    setAsking(q.key);
    const recent = (p.messages[q.section] || []).slice(-4).map((m: any) => `${m.role === 'user' ? 'User' : 'NORA'}: ${m.text}`);
    api.question({ field: definitions[q.id].field, section: q.section, brand: state.fields['14'], found: q.found || undefined, master: q.master, options: q.options, recent })
      .then(r => { if (r.question) setAsked(a => ({ ...a, [q.key]: r.question })); })
      .catch(() => { failedQs.current.add(q.key); })
      .finally(() => setAsking(''));
  });

  async function submit(text = draft) {
    if (!text.trim() || busy || thinking) return;
    if (flow) {
      runFlow(text);
      return;
    }
    const section = s;
    if (answerTouchpointCount(text)) { setDraft(''); return; }
    const q = current.current;
    // A short reply while a question is open answers that question directly.
    if (q && q.section === section && text.trim().length <= 120 && !/[.;]\s+\S/.test(text.trim())) {
      const t = text.trim();
      const pick = q.options.find(o => o.toLowerCase() === t.toLowerCase());
      const yes = /^(yes|yep|correct|confirm(ed)?|that'?s right|keep it)\b/i.test(t);
      answerQuestion(q.id, section, q.index, yes && q.found ? '__confirm__' : pick && pick === q.found ? '__confirm__' : pick || t, yes && q.found ? q.found : pick || t, asked[q.key] || '');
      return;
    }
    let turnStart = 0;
    update((_, pl) => { pl.messages[section].push({ role: 'user', text }); pl.drafts[section] = ''; turnStart = pl.messages[section].length; });
    setThinking(true);
    // Replies follow the design's voice: one lead line, then short notes.
    let lines: string[];
    const captured = () => {
      const st = useCampaignStore.getState().state;
      const pending = unresolved(st, section, planning(st).active).some((id: string) => target(st, section)?.meta[id]?.waiting);
      return [`Got it. I’ve added what you provided to the ${section} campaign context.`,
        ...(pending ? ['I’ve kept anything that isn’t available yet as a dependency instead of asking you to guess.'] : []),
        'I’ll continue to surface only what still needs your attention.'];
    };
    try {
      const res = await api.nora(text, section, p.emails.length);
      let count = 0;
      mutate(st => { count = applyMapped(st, res.values, 'Provided by you').length; });
      // The model writes the acknowledgement for this turn; the template is only a fallback.
      lines = res.reply ? [res.reply] : count ? captured() : ['I couldn’t find campaign details to record in that message.'];
    } catch {
      // No model configured or unreachable: deterministic local mapping.
      let result = { mapped: [] as unknown[], errors: [] as string[] };
      mutate(st => { result = mapMessage(st, text); });
      lines = result.mapped.length
        ? [...captured(), ...result.errors]
        : ['I couldn’t map that safely.', 'Use the field names in Campaign Canvas, followed by “is” or a colon, or edit an individual field.', ...result.errors];
    }
    update((_, pl) => {
      // An OMS notification raised while mapping belongs after NORA's reply.
      const thread = pl.messages[section], events = thread.slice(turnStart).filter((m: any) => m.event === 'oms');
      pl.messages[section] = thread.filter((m: any) => !events.includes(m));
      pl.messages[section].push({ role: 'agent', text: lines.join(' '), lines }, ...events);
    });
    setThinking(false);
  }

  function startEdit(id: string, section: string, index: number) {
    setEditValue(value(state, id, section, index));
    update((_, pl) => { pl.editing = `${section}:${index}:${id}`; });
    setTimeout(() => (document.querySelector('#memory-value') as HTMLElement | null)?.focus(), 0);
  }
  function saveEdit(id: string, section: string, index: number, file?: File) {
    update((st, pl) => {
      const v = file ? file.name : editValue;
      if (file) st.material.files.push(file);
      if (id === '19') provideCampaignCode(st, v); // only reachable from the OMS demo response
      else setField(st, id, v, section, index, 'Updated by you');
      evaluateGeneral(st);
      pl.editing = null;
    });
  }

  // --- Campaign Memory (design 6a–6c) -------------------------------------
  const statusDot = (kind: string, text: string) => <span className={`mem-dot ${kind}`}><i aria-hidden="true" />{text}</span>;
  const isRecent = (id: string, section: string, index: number) => p.recent.some((r: any) => r.id === id && r.section === section && r.index === index);

  function memCard(id: string, section: string, index: number) {
    const t = target(state, section, index), v = value(state, id, section, index), meta = t?.meta[id] || {}, problem = issue(state, id, section, index);
    const inherited = section === 'Touchpoint' && ['45', '46', '47'].includes(id);
    const active = p.editing === `${section}:${index}:${id}`;
    const opts = choices(state, id);
    const upload = /File upload/.test(definitions[id].control);
    return (
      <div key={id} className={`mem-card ${isRecent(id, section, index) ? 'recent' : ''} ${problem && v && !meta.waiting ? 'has-issue' : ''} ${v && !meta.waiting ? (/\byou\b|Selected|Entered|Confirmed|Kept/i.test(meta.source || '') ? 'src-you' : 'src-mapped') : 'src-none'}`}>
        <div className="mem-card-main">
          <span className="mem-label">{definitions[id].field}{meta.waiting && <em>{id === '19' ? ' | Waiting on OMS' : ' | Waiting / dependency'}</em>}{!isMine(id) && <b className="mem-field-owner">{ownerOf(id)}</b>}</span>
          {active ? (
            <form className="memory-edit" onSubmit={e => { e.preventDefault(); const input = (e.currentTarget.elements.namedItem('value') as HTMLInputElement); saveEdit(id, section, index, input?.type === 'file' ? input.files?.[0] : undefined); }}>
              <label className="sr-only" htmlFor="memory-value">{definitions[id].field}</label>
              {upload ? <input id="memory-value" type="file" name="value" />
                : opts ? <select id="memory-value" name="value" value={editValue} onChange={e => setEditValue(e.target.value)}><option value="">Needs input</option>{opts.map((o: string) => <option key={o}>{o}</option>)}</select>
                : <input id="memory-value" name="value" value={editValue} onChange={e => setEditValue(e.target.value)} />}
              <button type="submit">Save</button>
              <Btn onClick={() => update((_, pl) => { pl.editing = null; })}>Cancel</Btn>
            </form>
          ) : <span className={`mem-value ${v && !meta.waiting ? '' : 'empty'}`}>{meta.waiting || !v ? '--' : v}</span>}
          {id === '19' && !v && <small>{p.oms ? 'Requested from OMS. OMS provides this code; the Delivery Manager cannot enter it.' : 'Provided by OMS. NORA requests it automatically once the details above it are complete.'}</small>}
          {id === '11' && <small>Single-channel preview. HQE/SMS selection behavior remains a source conflict.</small>}
          {id === '49.1' && <small>Source options unresolved; entered condition is not a validated option.</small>}
          {meta.conflict && <small>Brand master lists {meta.conflict.master.join(' / ')}</small>}
          {problem && v && !meta.waiting && <small className="attention">{problem}</small>}
        </div>
        {!active && (
          <div className="mem-actions">
            {meta.source && <span className="mem-source" title={meta.source}>{meta.source}</span>}
            {meta.unconfirmed && <Btn onClick={() => update((st, pl) => { const tt = target(st, section, index); tt.meta[id] = { ...tt.meta[id], unconfirmed: false, conflict: undefined, source: tt.meta[id]?.conflict ? 'Kept over brand master' : 'Confirmed by you' }; pl.version++; evaluateGeneral(st); })}>{meta.conflict ? 'Keep mine' : 'Confirm'}</Btn>}
            {!inherited && id !== '19' && <Btn onClick={() => startEdit(id, section, index)}>{v ? 'Edit' : 'Add'}</Btn>}
            {id === '19' && p.oms?.status === 'requested' && <Btn title="Simulates OMS answering the notification" onClick={() => startEdit(id, section, index)}>Respond as OMS (demo)</Btn>}
          </div>
        )}
      </div>
    );
  }

  // One group: header (name · owner pill · status) then value cards, or a
  // "Waiting" placeholder while nothing in the group is known yet.
  // Who fills a field, from the schema's owner column. The signed-in persona
  // is the Delivery Manager; Campaign Code is OMS's even though the schema
  // lists DM, so it never counts as the DM's to fill.
  // Ownership follows the demo role chosen at the top right. "Mine" is what this role fills;
  // everything else is reported as being with whoever owns it.
  const ownerOf = (id: string) => otherOwnerLabel(role, id);
  const isMine = (id: string) => isMineFor(role, id);
  // Pending = still needs something: empty, unconfirmed, invalid or waiting.
  const isPending = (id: string, section: string, index: number) => !value(state, id, section, index) || !!issue(state, id, section, index);

  // Section-level LIVE tally: what is captured, what needs me, what is with others.
  function tally(section: string, index: number) {
    const req = target(state, section, index) ? required(state, section, index) : [];
    const pending = req.filter((id: string) => isPending(id, section, index));
    return { total: req.length, captured: req.length - pending.length, mine: pending.filter(isMine), others: pending.filter((id: string) => !isMine(id)) };
  }

  // LIVE shows only the required fields that still need *me*; REVIEW ALL
  // shows the whole field list, with an owner tag where it isn't mine.
  function memGroup([name, , ids]: [string, string, string[]], section: string, index: number, collapsed: boolean) {
    const t = target(state, section, index);
    const shown = ids.filter(id => applicable(state, id, section, index));
    if (!shown.length || !t) return null;
    const req = required(state, section, index);
    const live = p.mode === 'LIVE';
    const mineOpen = shown.filter(id => isMine(id) && req.includes(id) && isPending(id, section, index));
    const othersOpen = shown.filter(id => !isMine(id) && req.includes(id) && isPending(id, section, index));
    const filled = shown.filter(id => value(state, id, section, index));
    const cards = live ? mineOpen : shown;
    const othersLabel = [...new Set(othersOpen.map(ownerOf))].join(' · ');
    const status = mineOpen.length ? statusDot('needs', `${mineOpen.length} need${mineOpen.length === 1 ? 's' : ''} you`)
      : othersOpen.length ? statusDot('others', `With ${othersLabel}`)
      : !filled.length ? <span className="mem-waiting">Waiting</span>
      : statusDot('complete', 'Complete');
    const head = <><h3>{name}</h3>{status}</>;
    if (collapsed) return (
      <details key={name} className="mem-row"><summary>{head}</summary><div className="mem-cards">{shown.map(id => memCard(id, section, index))}</div></details>
    );
    // LIVE is a to-do list: a group with nothing left for me disappears.
    if (live && !cards.length) return null;
    return (
      <section key={`${name}-${index}`} className="mem-group">
        <header>{head}</header>
        <div className="mem-cards">{cards.map(id => memCard(id, section, index))}</div>
      </section>
    );
  }

  // Campaign Log: what has happened on this campaign, newest last, from NORA's notices,
  // the material upload and the flow's audit trail.
  function campaignLog() {
    const when = (iso?: string) => (iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).replace(',', ' ·') : 'Earlier');
    const entries: { title: string; text: string; at?: string }[] = [];
    if (state.material?.note) entries.push({ title: 'Campaign material processed', text: 'The uploaded material was read and its details were mapped into the campaign setup.', at: state.material.processedAt });
    for (const sec of ['General', 'Contact', 'Email', 'Touchpoint']) {
      for (const m of (p.messages[sec] || []) as any[]) {
        if (!m.event || m.event === 'question') continue;
        const text = (m.lines || [m.text]).join(' ');
        const title = m.event === 'oms' ? (/issued/i.test(text) ? 'Campaign Code received from OMS' : 'Notification sent to OMS') : m.event === 'aor' ? 'Brief passed to AoR' : 'Update';
        entries.push({ title, text, at: m.at });
      }
    }
    if (p.validation === 'validated') entries.push({ title: 'Campaign prerequisites completed', text: 'General campaign information has been gathered and reviewed. Required prerequisites are marked complete.' });
    for (const a of (p.flow.audit || []) as any[]) entries.push({ title: `Flow Planner · ${a.action}`, text: `${a.by} · version ${a.revision}`, at: a.at });
    return (
      <div className="campaign-log">
        <div className="memory-heading"><h2>Campaign Log</h2></div>
        <p className="memory-description">Everything that has happened on this campaign so far.</p>
        {!entries.length && <p className="mem-empty">Nothing has happened on this campaign yet.</p>}
        <ol>
          {entries.map((e, n) => (
            <li key={n}><h3>{e.title}</h3><p><time>{when(e.at)}</time>{e.text}</p></li>
          ))}
        </ol>
      </div>
    );
  }

  // First message in a section: what NORA took from the material, with the key values.
  function intro() {
    if (s === 'Touchpoint' || history.length || !state.material?.note || !target(state)) return null;
    const i = p.active;
    const found = [...new Set(groups[s].flatMap(g => g[2] as string[]))]
      .filter(id => applicable(state, id, s, i) && value(state, id, s, i) && !/\byou\b/i.test(target(state, s, i)?.meta[id]?.source || ''))
      .slice(0, 4);
    if (!found.length) return null;
    const brand = state.fields['14'];
    return (
      <div className="story-intro">
        <p>I’ve gone through your material{brand ? ` for the ${brand} campaign` : ''} and brought the details I found into the {SECTION_NAMES[s]} setup, so you won’t need to enter them again. Let’s review the information together.</p>
        {found.length > 0 && (
          <dl className="intro-table">
            {found.map(id => <div key={id}><dt>{definitions[id].field}</dt><dd>{value(state, id, s, i)}</dd></div>)}
          </dl>
        )}
      </div>
    );
  }

  function memory() {
    const i = p.active, t = target(state);
    const generalDone = s === 'General' && p.validation === 'validated';
    const pill = 'Complete · Ready for Flow Planner';
    return (
      <aside className={`campaign-memory panel-${panelTab}`} aria-label={panelTab === 'log' ? 'Campaign Log' : 'Campaign Memory'}>
        <nav className="panel-tabs" aria-label="Campaign panels">
          <button type="button" aria-current={panelTab === 'workspace' ? 'page' : undefined} onClick={() => setPanelTab('workspace')}>Workspace</button>
          <button type="button" aria-current={panelTab === 'log' ? 'page' : undefined} onClick={() => setPanelTab('log')}>Campaign Log</button>
        </nav>
        <button type="button" className="panel-close" aria-label="Close panel" onClick={() => setPanelOpen(false)}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11" stroke="#686868" strokeWidth="1.8" strokeLinecap="round" /></svg>
        </button>
        {panelTab === 'log' ? campaignLog() : <>
        <div className="memory-heading"><h2>Campaign Memory</h2></div>
        <p className="memory-description">Review the workspace information NORA has structured so far.</p>
        <div className="memory-sections" role="tablist" aria-label="Campaign sections">
          {(['General', 'Contact', 'Email', 'Touchpoint'] as const).map(x => <button key={x} type="button" role="tab" aria-selected={s === x} onClick={() => navigateSection(x)}>{x}</button>)}
        </div>
        {s !== 'Touchpoint' && <div className="memory-modes" role="group" aria-label="Memory view">{['LIVE', 'REVIEW ALL'].map(mode => <Btn key={mode} aria-pressed={p.mode === mode} onClick={() => update((_, pl) => { pl.mode = mode; })}>{mode}</Btn>)}</div>}
        {p.mode === 'LIVE' && t && s !== 'Touchpoint' && (() => {
          const c = tally(s, i);
          return (
            <div className="mem-tally" aria-label="Section progress">
              <div className="mem-tally-bar"><i style={{ width: `${c.total ? (c.captured / c.total) * 100 : 0}%` }} /></div>
              <span><b>{c.captured}</b> of {c.total} captured</span>
              <span className="needs"><b>{c.mine.length}</b> need you</span>
              <span className="others"><b>{c.others.length}</b> with others</span>
              <Btn className="mem-tally-link" onClick={() => update((_, pl) => { pl.mode = 'REVIEW ALL'; })}>View all →</Btn>
            </div>
          );
        })()}
        {generalDone && (
          <div className="mem-summary">
            <div className="mem-summary-top"><strong>General</strong><span className={`mem-summary-pill ${p.validation}`}><i aria-hidden="true" />{pill}</span></div>
            <ul>
              <li className="done">General Details completed</li>
              <li className="handoff">Campaign Code provided by OMS</li>
            </ul>
          </div>
        )}
        {s === 'Email' && (
          <>
            {/* Emails / touchpoints as a horizontal carousel of tiles, five per pane. */}
            <div className="object-list" aria-label={`${s} objects`}>
              {p.emails.map((_: unknown, n: number) => {
                const left = unresolved(state, s, n).filter((id: string) => !(s === 'Touchpoint' && ['45', '46', '47'].includes(id)));
                const mine = left.some(isMine);
                const tone = mine ? 'needs' : left.length ? 'others' : 'complete';
                const text = mine ? 'Needs you' : left.length ? `With ${[...new Set(left.map(ownerOf))].join(' · ')}` : 'Complete';
                return (
                  <Btn key={n} className={`object-tile${mine ? ' needs-you' : ''}`} aria-pressed={i === n} aria-label={`${label(s, n)}${s === 'Touchpoint' ? ` (linked to ${label('Email', n)})` : ''}: ${text}`} title={`${label(s, n)} · ${text}`}
                    onClick={() => update((_st, pl) => { pl.active = n; pl.editing = null; })}>
                    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                      {s === 'Email' ? <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3.5 6.5 8.5 6.5 8.5-6.5" /></> : <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>}
                    </svg>
                    <strong>{String(n + 1).padStart(2, '0')}</strong>
                    <i className={`tile-dot ${tone}`} aria-hidden="true" />
                  </Btn>
                );
              })}
              {s === 'Email' && <Btn className="object-tile add-object" aria-label="Add email" onClick={() => update((st, pl) => { pl.active = addEmail(st); pl.section = 'Email'; pl.view = 'memory'; pl.editing = null; })}><span aria-hidden="true" className="tile-plus">+</span></Btn>}
            </div>
            {!t && <p className="memory-description">No objects yet. Add an email to prepare linked Touchpoint context.</p>}
            {t && s === 'Touchpoint' && <p className="linked-email">Linked to: <Btn onClick={() => navigateSection('Email')}>{label('Email', i)} →</Btn></p>}
          </>
        )}
        {s === 'Touchpoint' ? touchpointCanvas() : t && (() => {
          const rendered = groups[s].map(g => memGroup(g, s, i, generalDone && p.mode === 'LIVE')).filter(Boolean);
          return rendered.length ? rendered : p.mode === 'LIVE' && <p className="mem-empty">Nothing here needs you right now. Switch to REVIEW ALL to see every detail.</p>;
        })()}
        <div className="memory-legend" aria-label="Legend"><span className="src-you"><i aria-hidden="true" />Provided by you</span><span className="src-mapped"><i aria-hidden="true" />Mapped from source</span></div>
        </>}
      </aside>
    );
  }

  // --- Conversation "ask" block (design 6a–6c) -----------------------------
  // What NORA still needs, in the design's voice: an intro on first visit,
  // "I'm still looking for:" afterwards, and a completion hand-off with
  // "Continue with:" pills once the section is done.
  // --- Touchpoints: per segment, ask how many touchpoints, then for each one the email
  // it sends (picked from the email library), the wait time and whether to resend.
  const segments: Segment[] = p.segments || [];
  const library = emailLibrary(p.emails || []);
  const subjects = subjectOptions(library);
  const subjectKey = (t: { email: string | null; subject?: string }) => subjects.find(o => o.email === t.email && o.text === t.subject)?.key || null;
  const preheaderKey = (t: { email: string | null; preheader?: string }) => preheaderOptions(library, t.email).find(o => o.text === t.preheader)?.key || null;

  function answerTouchpoint(question: string, shown: string, apply: (sg: Segment[]) => void) {
    update((_, pl) => {
      apply(pl.segments);
      pl.messages.Touchpoint.push({ role: 'agent', text: question, lines: [question], event: 'question' });
      pl.messages.Touchpoint.push({ role: 'user', text: shown });
      pl.version++;
    });
  }

  // A typed reply to "how many touchpoints": take the first number (digits or words).
  function answerTouchpointCount(text: string): boolean {
    const ask = nextAsk(segments);
    if (s !== 'Touchpoint' || ask?.kind !== 'count') return false;
    const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
    const m = text.toLowerCase().match(/\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\b/);
    const n = m ? Number(m[1]) || words[m[1]] : 0;
    const sg = segments[ask.seg];
    const question = `How many touchpoints should the ${sg.name} segment have?`;
    if (!n || n > 12) {
      update((_, pl) => { pl.messages.Touchpoint.push({ role: 'user', text }); pl.messages.Touchpoint.push({ role: 'agent', text: 'Please give the number of touchpoints as a number between 1 and 12.' }); pl.drafts.Touchpoint = ''; });
      return true;
    }
    answerTouchpoint(question, text.trim(), list => { list[ask.seg].count = n; list[ask.seg].touchpoints = Array.from({ length: n }, () => ({ email: null, subject: '', preheader: '', wait: '', resend: '' })); });
    update((_, pl) => { pl.drafts.Touchpoint = ''; });
    return true;
  }

  function touchpointStory() {
    if (!segments.length) return <div className="story-ask"><p className="story-note">Preparing the segments…</p></div>;
    const ask = nextAsk(segments);
    if (!ask) {
      const total = segments.reduce((n, sg) => n + sg.touchpoints.length, 0);
      return (
        <div className="story-ask">
          <p className="story-lead">All {total} touchpoint{total === 1 ? '' : 's'} across {segments.length} segments are set up.</p>
          <p className="story-note">You can change any email, wait time or resend choice on the Campaign Memory panel.</p>
          <div className="story-pills">
            <Btn onClick={() => update((_, pl) => { pl.view = 'flow'; })}>Open Flow Planner</Btn>
            <Btn onClick={toWorkspace}>Campaign workspace</Btn>
          </div>
        </div>
      );
    }
    const sg = segments[ask.seg];
    const tpLabel = ask.kind === 'count' ? '' : `touchpoint ${ask.tp + 1} of the ${sg.name} segment`;
    const question = ask.kind === 'count'
      ? `How many touchpoints should the ${sg.name} segment have?`
      : ask.kind === 'subject' ? `Which subject line should ${tpLabel} use?`
      : ask.kind === 'preheader' ? 'And which pre-header should go with it?'
      : ask.kind === 'wait' ? `How long should we wait after ${tpLabel} before the next send?`
      : `Should ${tpLabel} be resent to people who didn’t open it?`;
    const intro = ask.kind === 'count' && ask.seg === 0 && !history.length
      ? <p className="story-intro-line">This campaign has {segments.length} segments: {segments.map(x => x.name).join(' and ')}. Let’s set up the touchpoints for each one.</p>
      : null;
    return (
      <div className="story-ask">
        {intro}
        <div className="story-question">
          <p className="story-lead">{question}</p>
          {ask.kind === 'count' && <p className="story-hint">Type the number in the message box below.</p>}
          {ask.kind === 'subject' && (
            <OptionPicker options={subjects} label="Choose a subject line" onPick={key => { const o = subjects.find(x => x.key === key)!; answerTouchpoint(question, o.text, list => { Object.assign(list[ask.seg].touchpoints[ask.tp], { email: o.email, subject: o.text, preheader: '' }); }); }} />
          )}
          {ask.kind === 'preheader' && (() => {
            const t = sg.touchpoints[ask.tp], opts = preheaderOptions(library, t.email);
            return <>
              <p className="story-hint">Subject line “{t.subject}” · {library.find(e => e.key === t.email)?.name}</p>
              <OptionPicker options={opts} label="Choose a pre-header" onPick={key => { const o = opts.find(x => x.key === key)!; answerTouchpoint(question, o.text, list => { list[ask.seg].touchpoints[ask.tp].preheader = o.text; }); }} />
            </>;
          })()}
          {ask.kind === 'wait' && (
            <div className="story-chips">
              {WAIT_OPTIONS.map(w => <button key={w} type="button" onClick={() => answerTouchpoint(question, w, list => { list[ask.seg].touchpoints[ask.tp].wait = w; })}>{w}</button>)}
              {ask.tp === sg.touchpoints.length - 1 && <button type="button" onClick={() => answerTouchpoint(question, 'No wait (last touchpoint)', list => { list[ask.seg].touchpoints[ask.tp].wait = 'None (last)'; })}>No wait (last touchpoint)</button>}
            </div>
          )}
          {ask.kind === 'resend' && (
            <div className="story-chips">{['Yes', 'No'].map(v => <button key={v} type="button" onClick={() => answerTouchpoint(question, v, list => { list[ask.seg].touchpoints[ask.tp].resend = v; })}>{v}</button>)}</div>
          )}
          {library[0]?.key.startsWith('demo') && ask.kind === 'subject' && <p className="story-hint">Showing the Cosentyx sample emails, because no emails with subject lines have been captured yet.</p>}
        </div>
      </div>
    );
  }

  function touchpointCanvas() {
    if (!segments.length) return null;
    const setTp = (seg: number, tp: number, patch: object) => update((_, pl) => { Object.assign(pl.segments[seg].touchpoints[tp], patch); pl.version++; });
    return (
      <>
        {segments.map((sg, seg) => (
          <section key={sg.name} className="mem-group tp-segment">
            <header><h3>{sg.name}</h3><span className="tp-count">{sg.count == null ? 'Touchpoints not set' : `${sg.count} touchpoint${sg.count === 1 ? '' : 's'}`}</span></header>
            <div className="mem-cards">
              {sg.touchpoints.map((t, tp) => (
                <div key={tp} className={`mem-card tp-row ${t.email ? 'src-you' : 'src-none'}`}>
                  <span className="mem-label">Touchpoint {tp + 1}</span>
                  <div className="tp-detail">
                    <OptionPicker compact options={subjects} value={subjectKey(t)} label="Choose subject line" onPick={key => { const o = subjects.find(x => x.key === key)!; setTp(seg, tp, { email: o.email, subject: o.text, preheader: o.email === t.email ? t.preheader : '' }); }} />
                    {t.email && <OptionPicker compact options={preheaderOptions(library, t.email)} value={preheaderKey(t)} label="Choose pre-header" onPick={key => setTp(seg, tp, { preheader: preheaderOptions(library, t.email).find(x => x.key === key)!.text })} />}
                    <small>{t.email ? `${library.find(e => e.key === t.email)?.name} · ` : ''}{t.wait ? `Wait ${t.wait}` : 'Wait time not set'} · {t.resend ? `Resend: ${t.resend}` : 'Resend not set'}</small>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))}
      </>
    );
  }

  function story() {
    if (s === 'Touchpoint') return touchpointStory();
    const i = p.active;
    const inheritedIds = s === 'Touchpoint' ? ['45', '46', '47'] : [];
    const unresolvedAll = target(state) ? unresolved(state, s, i) : [];
    // Mine = owned by the Delivery Manager. Everything else is someone else's
    // to fill (AoR, OMS, …): NORA never asks the DM for it, it only reports it.
    const remaining = unresolvedAll.filter(isMine);
    const open = remaining.filter((id: string) => !target(state)?.meta[id]?.waiting && !inheritedIds.includes(id));
    const waiting = remaining.filter((id: string) => target(state)?.meta[id]?.waiting);
    const withOthers = unresolvedAll.filter((id: string) => !isMine(id) && !inheritedIds.includes(id));
    const othersByOwner = [...new Set(withOthers.map(ownerOf))].map(o => ({ owner: o, fields: withOthers.filter((id: string) => ownerOf(id) === o) }));
    const done = s === 'General' ? p.validation === 'validated' : sectionStatus(state, s) === 'Complete';
    const othersPending = !done && withOthers.length > 0;
    const others = ['General', 'Contact', 'Email', 'Touchpoint'].filter(x => x !== s && sectionStatus(state, x) !== 'Complete' && !(x === 'General' && p.validation === 'validated'));
    // Several emails: when this one is done, NORA moves on to the next email that still
    // needs the Delivery Manager instead of declaring the whole section finished.
    const multi = ['Email', 'Touchpoint'].includes(s) && p.emails.length > 1;
    const emailOpen = (j: number) => unresolved(state, s, j).filter((id: string) => isMine(id) && !inheritedIds.includes(id) && !target(state, s, j)?.meta[id]?.waiting).length;
    const nextEmail = multi ? p.emails.findIndex((_: unknown, j: number) => j !== i && emailOpen(j) > 0) : -1;
    const toEmail = (j: number) => update((_, pl) => { pl.active = j; pl.editing = null; });
    const pills = (
      <div className="story-pills">
        {nextEmail >= 0 && <Btn className="plan-primary" onClick={() => toEmail(nextEmail)}>Continue to {label(s, nextEmail)}</Btn>}
        {s === 'Email' && <Btn onClick={() => update((st, pl) => { pl.active = addEmail(st); pl.editing = null; })}>+ Add email</Btn>}
        {others.map(x => <Btn key={x} onClick={() => navigateSection(x)}>{x === 'Touchpoint' ? 'Touchpoints' : x}</Btn>)}
        <Btn onClick={() => update((_, pl) => { pl.view = 'flow'; })}>Open Flow Planner</Btn>
        <Btn onClick={toWorkspace}>Campaign workspace</Btn>
      </div>
    );

    if (role === 'SA') return (
      <div className="story-ask">
        <p className="story-lead">Flow Planner is your area.</p>
        <p>There are no campaign details waiting on the Solution Architect. You can build the flow from whatever has been captured so far.</p>
        <div className="story-pills">
          <Btn onClick={() => update((_, pl) => { pl.view = 'flow'; })}>Open Flow Planner</Btn>
          <Btn onClick={toWorkspace}>Campaign workspace</Btn>
        </div>
      </div>
    );
    if (s === 'General' && p.validation === 'revision_requested') return (
      <div className="story-ask">
        <p className="story-lead">General Details need revision.</p>
        <p>{p.revision || 'Review and correct the General context.'} Your Email and Touchpoint progress is preserved.</p>
        <div className="story-pills"><Btn onClick={() => { let ok = false; update(st => { ok = resubmit(st); }); if (!ok) setNotice('Correct the requested General details and resolve required inputs before resubmitting.'); }}>Resubmit General for validation</Btn></div>
      </div>
    );
    if (['Email', 'Touchpoint'].includes(s) && !p.emails.length) return (
      <div className="story-ask">
        <p className="story-lead">No emails have been added yet.</p>
        <p>Add an email to start planning; each email has one linked Touchpoint.</p>
        <div className="story-pills"><Btn onClick={() => update((st, pl) => { pl.active = addEmail(st); pl.section = 'Email'; pl.editing = null; })}>+ Add email</Btn></div>
      </div>
    );
    if (done || !open.length) {
      // NORA's wrap-up is written by the model from what was actually captured (and from
      // where), and what other teams still owe. The plain lines are only a fallback.
      const statusKey = `${s}:${i}:${p.version}`;
      const t = target(state);
      const ids = [...new Set(groups[s].flatMap(g => g[2] as string[]))].filter(id => applicable(state, id, s, i) && value(state, id, s, i));
      statusReq.current = nextEmail >= 0 || !t ? null : {
        key: statusKey,
        body: {
          section: s, object: ['Email', 'Touchpoint'].includes(s) ? label(s, i) : undefined, brand: state.fields['14'],
          captured: ids.map(id => ({ field: definitions[id].field, value: String(value(state, id, s, i)).slice(0, 80), source: t?.meta[id]?.source })),
          withOthers: withOthers.map((id: string) => ({ field: definitions[id].field, owner: ownerOf(id), notified: ownerOf(id) === 'OMS' ? !!p.oms : ownerOf(id) === 'AoR' ? !!p.aor : false })),
          recent: (p.messages[s] || []).slice(-4).map((m: any) => `${m.role === 'user' ? 'User' : 'NORA'}: ${m.text}`),
        },
      };
      const aiStatus = statusNotes[statusKey];
      const loading = !aiStatus && statusAsking === statusKey;
      return (
      <div className="story-ask">
        {loading ? <div className="story-thinking" role="status"><span className="dots" aria-hidden="true"><i /><i /><i /></span>NORA is thinking</div>
          : aiStatus ? <p className="story-lead">{aiStatus}</p>
          : <p className="story-lead">{nextEmail >= 0 ? `${label(s, i)} is done. ${label(s, nextEmail)} still needs a few details from you.` : othersPending ? `That’s everything on your side of ${s}.` : `${s} Details are complete.`}</p>}
        {s === 'Email' && <p className="story-note">The subject line and pre-header are optional. Tell me in the message box if you’d like to add them.</p>}

        {othersPending && !aiStatus && !loading && <p className="story-note">{(() => {
          const names = othersByOwner.map(o => o.owner);
          const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
          const sent = names.every(n => (n === 'OMS' ? p.oms : n === 'AoR' ? p.aor : true));
          return sent
            ? `${list} ${names.length > 1 ? 'have both' : 'has'} been notified and will take it from here. In the meantime you’re free to move on to the rest of the campaign.`
            : `The rest belongs to ${list}. I’ll notify them as soon as their inputs are unblocked.`;
        })()}</p>}
        {waiting.length > 0 && <p className="story-note">Still waiting on: {waiting.map((id: string) => definitions[id].field).join(' · ')}</p>}
        <p className="story-note">Where would you like to go next?</p>
        {pills}
      </div>
      );
    }
    statusReq.current = null;

    // The ask is conversational: NORA asks ONE question at a time in the chat, worded by
    // the model. Quick replies answer it in one click; anything typed in the message box
    // answers it too. Conflicts with the brand master come first, then confirmations,
    // then choices, then typed details.
    const clarify = open.filter((id: string) => value(state, id, s, i)).sort((a: string, b: string) => Number(!!target(state)?.meta[b]?.conflict) - Number(!!target(state)?.meta[a]?.conflict));
    const missing = open.filter((id: string) => !value(state, id, s, i));
    const pickable = missing.filter((id: string) => suggestions(id).length);
    const typed = missing.filter((id: string) => !pickable.includes(id));
    const queue = [...clarify, ...pickable, ...typed].filter((id: string) => !skipped.includes(`${s}:${i}:${id}`));
    const qid: string | undefined = queue[0];
    if (!qid) { current.current = null; return (
      <div className="story-ask">
        <p className="story-note">I’ve set the remaining questions aside. Answer them any time in the message box, or edit them on the canvas.</p>
        <div className="story-pills"><Btn onClick={() => setSkipped([])}>Go through them again</Btn></div>
      </div>
    ); }

    const v = value(state, qid, s, i), problem = issue(state, qid, s, i);
    const clashMeta = target(state)?.meta[qid]?.conflict as { master: string[] } | undefined;
    const confirming = clarify.includes(qid) && !clashMeta;
    const options = clashMeta ? [] : suggestions(qid).filter(o => o.toLowerCase() !== v.toLowerCase()).slice(0, 6);
    const key = `${s}:${i}:${qid}`;
    current.current = { key, id: qid, section: s, index: i, found: v, master: clashMeta?.master.join(' / '), options: clashMeta ? [...clashMeta.master, v] : confirming ? [v, ...options] : options };
    const question = asked[key] || (asking === key ? '' : fallbackQuestion(qid, v, clashMeta?.master.join(' / '), problem));
    const reply = (answer: string, shown: string) => answerQuestion(qid, s, i, answer, shown, question);

    return (
      <div className="story-ask">
        {!asked[key] && asking === key ? (
          <div className="story-thinking" role="status"><span className="dots" aria-hidden="true"><i /><i /><i /></span>NORA is thinking</div>
        ) : (
          <div className="story-question">
            <p className="story-lead">{question}</p>
            <div className="story-chips" role="group" aria-label={definitions[qid].field}>
              {clashMeta ? <>
                {clashMeta.master.map(m => <button key={m} type="button" onClick={() => reply(m, m)}>{m}</button>)}
                <button type="button" onClick={() => reply('__confirm__', v)}>{v}</button>
              </> : <>
                {confirming && <button type="button" onClick={() => reply('__confirm__', v)}>Yes, {v}</button>}
                {options.map(o => <button key={o} type="button" onClick={() => reply(o, o)}>{o}</button>)}
              </>}
              <button type="button" className="chip-quiet" onClick={() => setSkipped(x => [...x, key])}>Skip for now</button>
            </div>
            {!options.length && !clashMeta && <p className="story-hint">{confirming ? 'Or type a different value below.' : 'Type your answer in the message box below.'}</p>}
            <small className="story-count">{multi ? `${label(s, i)} of ${p.emails.length} · ` : ''}{queue.length > 1 ? `${queue.length - 1} more after this` : multi && nextEmail >= 0 ? `Last one for this email, then ${label(s, nextEmail)}` : 'Last one on your side'}</small>
          </div>
        )}
        {waiting.length > 0 && <p className="story-note">Waiting on: {waiting.map((id: string) => definitions[id].field).join(' · ')}</p>}
        {s === 'Email' && <div className="story-pills"><Btn onClick={() => update((st, pl) => { pl.active = addEmail(st); pl.editing = null; })}>+ Add email</Btn></div>}
      </div>
    );
  }

  // Plain wording used until (or if) the model's question arrives.
  function fallbackQuestion(id: string, found: string, master: string | undefined, problem: string) {
    const f = definitions[id].field;
    if (master) return `Your material lists the ${f.toLowerCase()} as ${found}, while the brand master records ${master} for ${state.fields['14']}. Which should be used?`;
    if (found) return problem && problem !== 'Needs confirmation' ? `The ${f.toLowerCase()} came through as ${found}, which looks incorrect (${problem.toLowerCase()}). What should it be?` : `Can you confirm the ${f.toLowerCase()} is ${found}?`;
    return `What is the ${f.toLowerCase()}?`;
  }

  // Record one answer: the question and the answer join the conversation, then the next
  // question follows straight after.
  function answerQuestion(id: string, section: string, index: number, answer: string, shown: string, question: string) {
    if (thinking) return;
    update((st, pl) => {
      if (answer === '__confirm__') {
        const t = target(st, section, index);
        t.meta[id] = { ...t.meta[id], unconfirmed: false, conflict: undefined, source: t.meta[id]?.conflict ? 'Kept over brand master' : 'Confirmed by you' };
        pl.version++;
      } else {
        setField(st, id, answer, section, index, suggestions(id).includes(answer) ? 'Selected by you' : 'Entered by you');
        const t = target(st, section, index);
        if (t?.meta[id]) t.meta[id].unconfirmed = false;
      }
      pl.messages[section].push({ role: 'agent', text: question, lines: [question], event: 'question' });
      pl.messages[section].push({ role: 'user', text: shown });
      pl.drafts[section] = '';
      evaluateGeneral(st);
    });
  }

  // Suggested answers for a field: its defined option set, or — for
  // Indication / Therapeutic Area — what the brand master knows.
  function suggestions(id: string): string[] {
    if (id === '15') return [...new Set(brands.filter(b => b.name === state.fields['14']).map(b => b.indication))];
    if (id === '16') return [...new Set((brands.some(b => b.name === state.fields['14']) ? brands.filter(b => b.name === state.fields['14']) : brands).map(b => b.therapeuticArea).filter(Boolean))];
    if (id === '14') return [];
    return (choices(state, id) || []) as string[];
  }

  const agentMessage = (m: any, key: number) => {
    const lines: string[] = m.lines || [m.text];
    return (
      <div key={key} className="agent-row">
        <AgentOrb className="agent-avatar" size={35} quality="low" />
        <div className="story-reply">
          <p className="story-lead">{lines[0]}</p>
          {lines.slice(1).map((l, n) => <p key={n}>{l}</p>)}
        </div>
      </div>
    );
  };


  function flowCanvas() {
    const f = p.flow;
    const stale = f.svg && f.version !== p.version;
    const versions: any[] = f.versions?.length ? f.versions : f.svg ? [{ revision: f.revision, svg: f.svg, note: 'Initial draft', by: 'Flow Planner Agent', at: null }] : [];
    const viewing = preview != null ? versions.find(v => v.revision === preview && v.svg) : null;
    return (
      <aside className="flow-canvas" aria-label="Flow Canvas">
        <div className="canvas-top"><h2>Flow Canvas</h2><span>{busy ? 'Generating flow…' : f.svg ? <><b className={`flow-stage stage-${stageLabel.split(' ')[0].toLowerCase()}`}>{stageLabel}</b> Version {f.revision}</> : 'Preparing initial draft'}</span>
          <div className="canvas-controls">
            <Btn aria-label="Zoom out" onClick={() => update((_, pl) => { pl.flow.zoom = Math.max(0.2, pl.flow.zoom - 0.1); })}>−</Btn>
            <output>{Math.round(f.zoom * 100)}%</output>
            <Btn aria-label="Zoom in" onClick={() => update((_, pl) => { pl.flow.zoom = Math.min(2, pl.flow.zoom + 0.1); })}>+</Btn>
            <Btn onClick={() => { const view = viewport.current, svg = view?.querySelector('svg'); const w = svg?.viewBox?.baseVal?.width || svg?.getBoundingClientRect().width; update((_, pl) => { pl.flow.zoom = view && w ? Math.min(1, (view.clientWidth - 40) / w) : 1; }); }}>Fit</Btn>
            <Btn aria-label="Pan canvas" aria-pressed={!!f.pan} onClick={() => update((_, pl) => { pl.flow.pan = !pl.flow.pan; })}>✥</Btn>
          </div>
        </div>
        {f.svg && (
          <div className="version-bar">
            <label htmlFor="flow-version">Version</label>
            <select id="flow-version" value={preview ?? f.revision} onChange={e => { const r = Number(e.target.value); setPreview(r === f.revision ? null : r); }}>
              {[...versions].reverse().map((v: any) => <option key={v.revision} value={v.revision} disabled={!v.svg && v.revision !== f.revision}>v{v.revision} · {v.note}{v.revision === f.revision ? ' (current)' : ''}</option>)}
            </select>
            {viewing && <><span className="version-viewing">Viewing v{viewing.revision}</span><Btn disabled={busy || thinking} onClick={() => restoreVersion(viewing.revision)}>Restore this version</Btn><Btn onClick={() => setPreview(null)}>Back to current</Btn></>}
            <Btn className="history-toggle" aria-expanded={historyOpen} onClick={() => setHistoryOpen(o => !o)}>{historyOpen ? 'Hide history' : 'Version history'}</Btn>
          </div>
        )}
        {historyOpen && f.svg && (
          <div className="version-panel">
            <section><h3>Version history</h3><ol>
              {[...versions].reverse().map((v: any) => (
                <li key={v.revision} className={v.revision === f.revision ? 'current' : ''}>
                  <div><strong>v{v.revision}</strong> {v.note}{v.revision === f.finalizedRevision && ' · Finalized'}{(f.approval as any)?.revision === v.revision && ' · Sent for approval'}<small>{v.by} · {fmtWhen(v.at)}</small></div>
                  {v.revision === f.revision ? <em>Current</em> : v.svg ? <Btn onClick={() => setPreview(v.revision)}>View</Btn> : <em>Archived</em>}
                </li>))}
            </ol></section>
          </div>
        )}
        {stale && <p className="flow-update">Campaign details have changed. The current flow is unchanged until you ask Flow Planner to update it.</p>}
        <div ref={viewport} className={`canvas-viewport ${f.pan ? 'panning' : ''}`} tabIndex={0} aria-label="Scrollable flow diagram"
          onPointerDown={e => { if (!f.pan) return; const v = viewport.current!; drag.current = { x: e.clientX, y: e.clientY, left: v.scrollLeft, top: v.scrollTop }; v.setPointerCapture(e.pointerId); }}
          onPointerMove={e => {
            const d = drag.current, v = viewport.current;
            if (d && v) { v.scrollLeft = d.left - e.clientX + d.x; v.scrollTop = d.top - e.clientY + d.y; return; }
            // Hovering a block shows a "+" on its right edge; the shape palette opens from it.
            if (!v || f.pan || viewing || busy || (e.target as Element).closest('.fp-tools')) return;
            const g = (e.target as Element).closest('g.fp-node') as SVGGElement | null;
            const code = g?.getAttribute('data-code');
            if (!g || !code) { if (!blockTools?.open) hideToolsSoon(); return; }
            const r = g.getBoundingClientRect(), vr = v.getBoundingClientRect();
            clearTimeout(toolsTimer.current);
            if (blockTools?.code !== code) setBlockTools({ code, left: r.right - vr.left + v.scrollLeft, top: r.top - vr.top + v.scrollTop + r.height / 2, open: false });
          }}
          onPointerLeave={() => hideToolsSoon()}
          onPointerUp={() => { drag.current = null; }}>
          <div className="canvas-content" style={{ zoom: f.zoom }}>
            {busy && !f.svg ? (
              <div className="flow-generating" role="status"><h3>Generating flow…</h3><p>Building the segmentation flow from the validated campaign context.</p>
                <div className="flow-nodes" aria-hidden="true">{[0, 1, 2, 3].map(i => <span key={i} style={{ display: 'contents' }}>{i > 0 && <span className="flow-connector">→</span>}<div className="flow-skeleton"><i /><i /></div></span>)}</div>
              </div>
            ) : !f.svg ? (
              <div className="flow-empty"><AgentOrb size={54} quality="low" /><h3>Preparing the initial draft</h3><p>Flow Planner generates the first draft from the campaign details captured so far.</p></div>
            ) : (
              <div className="flow-svg" style={{ opacity: busy ? 0.45 : 1, transition: 'opacity 200ms' }} dangerouslySetInnerHTML={{ __html: viewing ? viewing.svg : f.svg }} />
            )}
          </div>
          {blockTools && !viewing && !busy && (
            <div className="fp-tools" style={{ left: blockTools.left, top: blockTools.top }}
              onPointerEnter={() => clearTimeout(toolsTimer.current)} onPointerLeave={() => hideToolsSoon()}>
              <button type="button" className="fp-add" aria-label={`Add a block after ${blockTools.code}`} aria-expanded={blockTools.open}
                onPointerEnter={() => setBlockTools(t => t && { ...t, open: true })} onClick={() => setBlockTools(t => t && { ...t, open: !t.open })}>+</button>
              {blockTools.open && (
                <div className="fp-palette" role="menu" aria-label={`Add after ${blockTools.code}`}>
                  <span className="fp-palette-title">Add after {blockTools.code}</span>
                  {SHAPES.map(sh => (
                    <button key={sh.key} type="button" role="menuitem" title={sh.label}
                      onClick={() => { setDraft(`Add a ${sh.label.toLowerCase()} block after ${blockTools.code} `); focusComposer(); setBlockTools(null); }}>
                      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" dangerouslySetInnerHTML={{ __html: sh.icon }} />
                      <span>{sh.label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        <footer><span>Generated by the Campaign Accelerator segmentation engine · block codes (B1, B2 …) stay stable across edits.</span><span>{busy ? 'Working…' : viewing ? `Previewing v${viewing.revision} · read only` : 'Awaiting instruction'}</span></footer>
      </aside>
    );
  }

  // The heading follows what is actually left for the Delivery Manager in this section.
  const mineLeft = target(state) ? unresolved(state, s, p.active).filter((id: string) => isMine(id) && !['45', '46', '47'].includes(id)) : [];
  const headingText = flow ? 'Flow Planner'
    : !target(state) ? 'Add an email to get started'
    : mineLeft.some((id: string) => target(state)?.meta[id]?.conflict) ? 'Your material and our records disagree'
    : mineLeft.length ? 'Some details still need your Input & Review'
    : role === 'SA' ? 'Flow Planner is your area'
    : s === 'General' && unresolved(state, s, 0).length ? 'Everything on your side is complete'
    : `${s} Details are complete`;

  return (
    <>
      <AccelerateHeader onNotice={setNotice} />
      <div className="planning-context">
        <Btn onClick={toWorkspace}>← Campaign workspace</Btn>
        <span className="context-divider" /><span>{state.fields['14'] || 'New Campaign'} · {({ 'New Brand Launch': 'New Brand', 'New Indication Launch': 'New Indication' } as Record<string, string>)[state.fields['12']] || 'Existing Brand'}</span><span>/</span><strong>{flow ? 'Flow Planner' : SECTION_NAMES[s]}</strong>
        <div className="planning-context-end">
          {flow ? <small>Built from the details captured so far</small> : dirty ? <small className="save-state dirty"><i aria-hidden="true" />Unsaved changes</small> : <small className="save-state">{saving === 'saving' ? 'Saving…' : saving === 'error' ? 'Not saved — check the server' : 'All changes saved'}</small>}
          {flow && <Btn onClick={() => update((_, pl) => { pl.section = 'General'; pl.mode = 'REVIEW ALL'; pl.view = 'memory'; })}>Campaign details</Btn>}
          {!flow && <Btn className="save-section" onClick={saveSection}>Save {s} Details</Btn>}
        </div>
      </div>
      <main id="main" className={`planning-shell ${flow ? 'flow-shell' : ''} ${p.mode === 'REVIEW ALL' && !flow ? 'audit-shell' : ''} ${!flow && !panelOpen ? 'panel-closed' : ''}`}>
        <section className="planning-conversation" aria-label={`${flow ? 'Flow Planner' : 'NORA'} conversation`}>
          <div className={`planning-identity${flow ? '' : ' sr-only'}`}>
            <AgentOrb size={54} state={orbState} quality={flow ? 'low' : 'high'} />
            <div><Signature agent={flow ? 'Flow Planner Agent' : 'Requirement Collection Agent'} /><h1 ref={heading} tabIndex={-1} className={flow ? 'sr-only' : undefined}>{headingText}</h1></div>
          </div>
          <div className="conversation-thread" ref={thread} tabIndex={0} aria-label="Conversation history">
            {flow && !history.length && <><h2>Preparing the initial draft of the campaign flow.</h2><p>I’m using the campaign details captured so far; anything still pending is simply left out.</p></>}
            {history.map((m: any, i: number) => m.role === 'user' ? <div key={i} className="conversation-message user-message">{m.text}</div> : sa ? <div key={i} className="conversation-message agent-message">{m.text}</div> : agentMessage(m, i))}
            {(thinking || busy) && <div className="story-thinking" role="status"><span className="dots" aria-hidden="true"><i /><i /><i /></span>{flow ? 'Flow Planner is working on it' : 'NORA is thinking'}</div>}
            {thinking ? null : sa ? <>
              <p>I’ve organised the General campaign context so you can review what is available before making your validation decision.</p>
              <p>You can review the latest updates first or inspect the full General Details.</p>
              <div className="suggestions"><Btn onClick={() => update((_, pl) => { pl.mode = 'LIVE'; })}>Review latest updates</Btn><Btn onClick={() => update((_, pl) => { pl.mode = 'REVIEW ALL'; })}>Review all General Details</Btn></div>
              {p.validation === 'awaiting'
                ? <div className="validation-actions">
                    <Btn className="plan-primary" onClick={() => update((st, pl) => { if (validate(st)) { pl.view = 'memory'; pl.messages.General.push({ role: 'agent', text: 'General Details are validated. Flow Planner is available. No flow has been generated.' }); } })}>Validate General Details</Btn>
                    <Btn onClick={() => update((_, pl) => { pl.requestRevision = true; })}>Request revision</Btn>
                  </div>
                : <p>{sectionStatus(state, 'General')}</p>}
              {p.requestRevision && (
                <form className="revision-form" onSubmit={e => { e.preventDefault(); const fb = (e.currentTarget.elements.namedItem('feedback') as HTMLTextAreaElement).value; update((st, pl) => { revise(st, fb); pl.requestRevision = false; }); }}>
                  <label htmlFor="revision-feedback">What needs revision?</label><textarea id="revision-feedback" name="feedback" /><button type="submit">Request revision</button>
                </form>
              )}
            </> : flow ? (
              <div className="suggestions">
                {p.flow.svg && <>
                  <Btn disabled={busy} onClick={() => submit('Update the flow using the latest campaign details')}>Update the flow using the latest campaign details</Btn>
                  <Btn onClick={() => { setDraft('Add a decision block after B3 asking '); focusComposer(); setNotice('Name a block by the code printed on the diagram (B1, B2, …).'); }}>Add a step after a block</Btn>
                  <Btn onClick={() => { setDraft('Delete block '); focusComposer(); }}>Remove a block</Btn>
                  {!isFinal
                    ? <Btn className="plan-primary" disabled={busy || thinking} onClick={finalizeDraft}>Finalize draft</Btn>
                    : <Btn className={approvalSent ? 'done' : 'plan-primary'} disabled={busy || approvalSent} onClick={sendForApproval}>{approvalSent ? 'Sent for approval ✓' : approval ? 'Send updated flow for approval' : 'Send for approval'}</Btn>}
                </>}
              </div>
            ) : <div className="agent-row"><AgentOrb className="agent-avatar" size={35} quality="low" state={orbState} /><div className="agent-body">{intro()}{story()}</div></div>}
          </div>
          <div className="planning-compose" ref={notes}>
            <small className="working-with"><i aria-hidden="true" />Working with {flow ? 'Flow Planner' : SECTION_NAMES[s] + (p.emails.length && ['Email', 'Touchpoint'].includes(s) ? ` · ${label(s, p.active)}` : '')}</small>
            <Composer value={draft} onChange={setDraft} onSend={() => submit()} disabled={busy || thinking} onAttach={() => attach.current?.click()}
              placeholder={flow ? 'Tell Flow Planner what you want to create or change…' : 'Tell me what you’re working on, or share whatever you have so far…'} onMic={() => setNotice('Voice input is outside this demo.')} />
            <input ref={attach} type="file" className="sr-only" multiple tabIndex={-1} aria-label="Add supporting material"
              onChange={e => { const files = [...(e.target.files || [])]; e.target.value = ''; if (files.length) { update(st => { st.material.files = files; st.material.notes = ''; st.material.processing = { startedAt: Date.now(), complete: false }; }); setStage('processing'); } }} />
            <p className="home-disclaimer">{flow ? 'Flow Planner acts only on your instruction.' : 'NORA is AI-powered and may make mistakes. Please review and validate outputs before finalizing.'}</p>
            <div className="planning-notice" role="status">{notice}</div>
          </div>
        </section>
        {flow ? flowCanvas() : panelOpen ? memory() : null}
        {!flow && !panelOpen && (
          <nav className="home-side-tabs" aria-label="Campaign panels">
            <button type="button" onClick={() => openPanel('workspace')}>Workspace</button>
            <button type="button" onClick={() => openPanel('log')}>Campaign Log</button>
          </nav>
        )}
      </main>
    </>
  );
}
