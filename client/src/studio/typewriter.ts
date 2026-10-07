// @ts-nocheck — ported unchanged from the prototype's typewriter.js.
// Reusable, cancellable character reveal. Full text is already present for assistive technology.
// Character spans occupy their final positions from the start, so wrapping never changes.
export function typewriter(lines, { startDelay = 1000, sentencePause = 200, speed = 1, chunk = 1, onStart = () => {}, onComplete = () => {} } = {}) {
  let timer;
  let lineIndex = 0;
  let characterIndex = 0;
  let stopped = false;

  function tick() {
    if (stopped) return;
    const line = lines[lineIndex];
    const characters = line.querySelectorAll('[data-character]');
    if (characterIndex === 0) {
      line.classList.add('is-typing');
      onStart(line);
    }
    // chunk > 1 reveals several characters per tick (timers can't fire faster than ~4ms).
    let character;
    for (let n = 0; n < chunk && characterIndex < characters.length; n++) {
      character = characters[characterIndex];
      character.classList.add('is-revealed');
      characterIndex++;
    }
    if (characterIndex === characters.length) {
      line.classList.remove('is-typing');
      line.classList.add('is-typed');
      lineIndex++;
      characterIndex = 0;
      if (lineIndex === lines.length) {
        stopped = true;
        onComplete();
        return;
      }
      timer = setTimeout(tick, sentencePause);
    } else {
      // Deterministic natural cadence, 26–37ms, with a breath at punctuation.
      const pause = (/[,.!?]/.test(character.textContent) ? 110 : 26 + (characterIndex * 7 % 12)) / speed;
      timer = setTimeout(tick, pause);
    }
  }

  timer = setTimeout(tick, startDelay);
  return {
    finish() {
      clearTimeout(timer);
      stopped = true;
      lines.forEach(line => {
        line.classList.remove('is-typing');
        line.classList.add('is-typed');
        line.querySelectorAll('[data-character]').forEach(character => character.classList.add('is-revealed'));
      });
    },
    cancel() { clearTimeout(timer); stopped = true; },
  };
}

export interface Typewriter { finish(): void; cancel(): void }
