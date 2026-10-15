// The NORA message composer shared by Upload, Review and Planning.
export default function Composer({ value, onChange, onSend, onAttach, onMic, disabled, placeholder = 'Tell NORA what you know, paste notes, or add supporting material…' }: {
  value: string; onChange: (v: string) => void; onSend: () => void; onAttach?: () => void; onMic?: () => void; disabled?: boolean; placeholder?: string;
}) {
  return (
    <div className="upload-composer">
      <label htmlFor="upload-notes" className="sr-only">Notes for NORA</label>
      <textarea id="upload-notes" placeholder={placeholder} value={value} onChange={e => onChange(e.target.value)}
        onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); if (!disabled) onSend(); } }} />
      <div className="upload-composer-actions">
        <button type="button" className="upload-attach" onClick={onAttach}><img src="/assets/upload/attachment.svg" alt="" />Attach</button>
        {onMic && (
          <button type="button" className="upload-mic" aria-label="Voice input" title="Voice input" onClick={onMic}>
            <svg viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><rect x="7" y="2" width="6" height="10" rx="3" /><path d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v3" /></svg>
          </button>
        )}
        <button type="button" className="upload-send" disabled={disabled || !value.trim()} onClick={onSend}>Send</button>
      </div>
    </div>
  );
}
