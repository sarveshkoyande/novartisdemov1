import type { ElementType } from 'react';

// Stable word wrapping for the typewriter reveal: every character is
// pre-laid-out (invisible), and screen readers get one complete copy.
export default function TypedLine({ as: Tag = 'p', className = '', text, id, wordClass = 'nora-word' }: { as?: ElementType; className?: string; text: string; id?: string; wordClass?: string }) {
  const words = text.split(' ');
  return (
    <Tag className={`nora-line ${className}`} id={id}>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">
        {words.map((word, w) => (
          <span key={w}>
            {w > 0 && <span data-character> </span>}
            <span className={wordClass}>{Array.from(word).map((c, i) => <span key={i} data-character>{c}</span>)}</span>
          </span>
        ))}
      </span>
    </Tag>
  );
}
