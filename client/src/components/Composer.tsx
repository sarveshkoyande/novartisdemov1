// The NORA message composer shared by Upload, Review and Planning.
export default function Composer({ value, onChange, onSend, onAttach, disabled, placeholder = 'Tell NORA what you know, paste notes, or add supporting material…' }: {
  value: string; onChange: (v: string) => void; onSend: () => void; onAttach?: () => void; disabled?: boolean; placeholder?: string;
}) {
  return (
    <div className="upload-composer">
      <label htmlFor="upload-notes" className="sr-only">Notes for NORA</label>
      <textarea id="upload-notes" placeholder={placeholder} value={value} onChange={e => onChange(e.target.value)}
        onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); if (!disabled) onSend(); } }} />
      <div className="upload-composer-actions">
        <button type="button" className="upload-attach" onClick={onAttach}><img src="/assets/upload/attachment.svg" alt="" />Attach</button>
        <button type="button" className="upload-send" disabled={disabled || !value.trim()} onClick={onSend}>Send</button>
      </div>
    </div>
  );
}
