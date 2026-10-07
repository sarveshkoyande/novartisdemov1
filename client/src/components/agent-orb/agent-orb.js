/**
 * Campaign agent orb — standalone SVG + CSS + vanilla JS component.
 * Transparent background, no dependencies. Works with Vite out of the box.
 *
 *   import { createAgentOrb } from './components/agent-orb/agent-orb.js';
 *   const orb = createAgentOrb(document.querySelector('#agent'), { size: 160 });
 *   orb.setState('thinking');   // 'idle' | 'thinking' | 'speaking'
 *   orb.setLevel(0.6);          // optional audio level 0..1 while speaking
 *   orb.destroy();
 *
 * Styles are self-contained: no CSS import needed.
 */

/* Styles are injected once at runtime so the component needs no CSS import,
   no bundler plugin and no extra file. It works in Vite, plain servers and
   static previews alike. */
const STYLE_ID = 'agent-orb-styles';
const CSS = `/* Campaign agent orb — transparent, drop-in component styles */

.agent-orb {
  --ao-size: 160px;
  --ao-iris-duration: 16s;
  position: relative;
  display: inline-block;
  width: var(--ao-size);
  aspect-ratio: 1 / 1;
  background: transparent;
  line-height: 0;
  contain: layout paint;
  -webkit-tap-highlight-color: transparent;
}

.agent-orb--fluid {
  --ao-size: 100%;
  display: block;
}

.agent-orb__stage {
  position: absolute;
  inset: 0;
  transform-origin: 50% 50%;
  will-change: transform;
}

.agent-orb__svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
  background: transparent;
}

/* Iridescent rim: a rotating conic gradient masked to a thin soft ring.
   Kept in CSS because SVG has no native conic gradient. */
.agent-orb__iris {
  position: absolute;
  inset: 4%; /* matches the r=92 circle in a 200 viewBox */
  border-radius: 50%;
  pointer-events: none;
  background: conic-gradient(
    from 0deg,
    #ffd0bc,
    #ff7a40,
    #dadada,
    #fff0ea,
    #ffd0bc,
    #ff4e00,
    #ffd0bc
  );
  -webkit-mask: radial-gradient(closest-side, transparent 78%, #000 92%, #000 97%, transparent 100%);
          mask: radial-gradient(closest-side, transparent 78%, #000 92%, #000 97%, transparent 100%);
  opacity: 0.45;
  animation: agent-orb-spin var(--ao-iris-duration) linear infinite;
}

.agent-orb__streaks {
  mix-blend-mode: screen;
}

@keyframes agent-orb-spin {
  to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
  .agent-orb__iris { animation: none; }
  .agent-orb__stage { will-change: auto; }
}
`;

function injectStyles() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const TAU = Math.PI * 2;
const LOOP_SECONDS = 12.5; // length of one full cycle, matches the reference

export const DEFAULT_PALETTE = {
  // Novartis system: Space Orange #FF4E00 and its tints, with warm-black depth.
  coral: '#ff4e00',
  rose: '#ff7a40',
  blush: '#ffd0bc',
  peach: '#fff0ea',
  accent: '#d64100',
  accentDeep: '#161616',
  streak: '#fff0ea',
};

const STATE_PRESETS = {
  idle: { speed: 1, swirl: 1, streaks: 1, iris: 16 },
  thinking: { speed: 2.4, swirl: 1.45, streaks: 1.35, iris: 7 },
  speaking: { speed: 1.5, swirl: 1.15, streaks: 1.1, iris: 11 },
};

const DEFAULTS = {
  size: 160, // number (px), CSS length string, or null to fill the container
  state: 'idle',
  palette: DEFAULT_PALETTE,
  label: 'Campaign agent',
  quality: 'high', // 'high' | 'low' (low skips the silk distortion filter)
  shadow: true, // soft contact shadow; set false for dark or busy backgrounds
  maxFps: 60,
};

let instanceCount = 0;

/* ---------- small helpers ---------- */

function svgEl(tag, attrs, parent) {
  const node = document.createElementNS(SVG_NS, tag);
  if (attrs) for (const key in attrs) node.setAttribute(key, attrs[key]);
  if (parent) parent.appendChild(node);
  return node;
}

function stop(gradient, offset, color, opacity = 1) {
  svgEl('stop', { offset, 'stop-color': color, 'stop-opacity': opacity }, gradient);
}

const fmt = (p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`;

/** Catmull-Rom spline through points, emitted as cubic Béziers. */
function spline(points, startWithMove) {
  let d = (startWithMove ? 'M' : 'L') + fmt(points[0]);
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] || points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] || p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${fmt(c1)} ${fmt(c2)} ${fmt(p2)}`;
  }
  return d;
}

// Seeded random so every instance draws the same streak pattern.
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const smoothBump = (phase, center, width) => {
  // 0..1 bump on a looping 0..1 phase
  let d = Math.abs(phase - center);
  d = Math.min(d, 1 - d);
  if (d >= width) return 0;
  const x = 1 - d / width;
  return x * x * (3 - 2 * x);
};

/* ---------- ribbon definitions (the swirling silk inside the glass) ---------- */

function ribbonSpecs(p) {
  return [
    // back layer: wide, soft, warm wash
    { key: 'wash', layer: 'back', from: p.peach, to: p.blush, angle: -28, offset: 26, width: 92, amp: 16, freq: 0.9, speed: 0.35, phase: 0.0, twist: 0.9, drift: 6, opacity: 0.9 },
    { key: 'blush', layer: 'back', from: p.blush, to: p.rose, angle: -40, offset: -38, width: 60, amp: 14, freq: 1.1, speed: 0.42, phase: 2.1, twist: 1.3, drift: 8, opacity: 0.75 },
    // main silk folds
    { key: 'coral', layer: 'silk', from: p.coral, to: p.rose, angle: -34, offset: -14, width: 54, amp: 18, freq: 1.25, speed: 0.55, phase: 0.6, twist: 1.8, drift: 10, opacity: 0.95, crease: true },
    { key: 'rose', layer: 'silk', from: p.rose, to: p.blush, angle: -22, offset: 32, width: 40, amp: 15, freq: 1.4, speed: 0.48, phase: 3.4, twist: 1.5, drift: 7, opacity: 0.8, crease: true },
    // iridescent accent that drifts in and out
    { key: 'accent', layer: 'accent', from: p.accent, to: p.accentDeep, angle: -30, offset: 8, width: 18, amp: 13, freq: 1.3, speed: 0.6, phase: 1.2, twist: 1.1, drift: 9, opacity: 0.7 },
  ];
}

/* ---------- component ---------- */

export class AgentOrb {
  constructor(container, options = {}) {
    if (!container) throw new Error('AgentOrb: a container element is required.');
    this.options = { ...DEFAULTS, ...options, palette: { ...DEFAULT_PALETTE, ...(options.palette || {}) } };
    this.container = container;
    injectStyles();
    this.id = `agent-orb-${++instanceCount}`;

    this.clock = LOOP_SECONDS * 0.15;
    this.lastTime = 0;
    this.lastFrame = 0;
    this.rafId = 0;
    this.visible = true;
    this.pageVisible = !document.hidden;
    this.destroyed = false;

    this.preset = { ...STATE_PRESETS.idle };
    this.target = { ...STATE_PRESETS.idle };
    this.level = 0;
    this.levelTarget = 0;
    this.lastLevelAt = -Infinity;

    this._build();
    this.setState(this.options.state, true);
    this._bindEnvironment();
    this._renderFrame(0);
    this._start();
  }

  /* ----- public API ----- */

  setState(state, immediate = false) {
    const preset = STATE_PRESETS[state];
    if (!preset) {
      console.warn(`AgentOrb: unknown state "${state}". Use idle, thinking or speaking.`);
      return;
    }
    this.state = state;
    this.target = { ...preset };
    if (immediate) this.preset = { ...preset };
    this.root.dataset.state = state;
    this.root.style.setProperty('--ao-iris-duration', `${preset.iris}s`);
    this.root.setAttribute('aria-label', `${this.options.label}, ${state}`);
    if (this.reducedMotion) this._renderFrame(0);
  }

  /** Feed a live audio level (0..1) while speaking. Optional. */
  setLevel(value) {
    this.levelTarget = Math.max(0, Math.min(1, Number(value) || 0));
    this.lastLevelAt = performance.now();
  }

  setPalette(palette) {
    this.options.palette = { ...this.options.palette, ...palette };
    const p = this.options.palette;
    this.ribbons.forEach((r) => {
      const spec = ribbonSpecs(p).find((s) => s.key === r.spec.key);
      r.stopA.setAttribute('stop-color', spec.to);
      r.stopB.setAttribute('stop-color', spec.from);
      r.stopC.setAttribute('stop-color', spec.to);
    });
    this.streakLines.forEach((line, i) => i % 4 === 0 && line.setAttribute('stroke', p.streak));
  }

  pause() {
    this.paused = true;
    this._stop();
  }

  resume() {
    this.paused = false;
    this._start();
  }

  destroy() {
    this.destroyed = true;
    this._stop();
    this.io?.disconnect();
    document.removeEventListener('visibilitychange', this._onVisibility);
    this.motionQuery?.removeEventListener?.('change', this._onMotion);
    this.root.remove();
  }

  /* ----- DOM construction ----- */

  _build() {
    const { size, palette: p, label, quality, shadow } = this.options;
    const id = this.id;

    const root = document.createElement('div');
    root.className = 'agent-orb';
    root.setAttribute('role', 'img');
    root.setAttribute('aria-label', label);
    if (size == null) root.classList.add('agent-orb--fluid');
    else root.style.setProperty('--ao-size', typeof size === 'number' ? `${size}px` : size);

    const stage = document.createElement('div');
    stage.className = 'agent-orb__stage';
    root.appendChild(stage);

    const svg = svgEl('svg', { class: 'agent-orb__svg', viewBox: '0 0 200 200', 'aria-hidden': 'true', focusable: 'false' });
    stage.appendChild(svg);

    const iris = document.createElement('div');
    iris.className = 'agent-orb__iris';
    stage.appendChild(iris);

    const defs = svgEl('defs', null, svg);

    // clip to the sphere
    const clip = svgEl('clipPath', { id: `${id}-clip` }, defs);
    svgEl('circle', { cx: 100, cy: 100, r: 92 }, clip);

    // frosted glass body — semi-opaque white so the orb reads on any background
    const body = svgEl('radialGradient', { id: `${id}-body`, cx: '46%', cy: '40%', r: '62%' }, defs);
    stop(body, '0%', '#ffffff', 0.9);
    stop(body, '70%', '#fcfcfc', 0.94);
    stop(body, '100%', '#f2f2f2', 0.97);

    // fresnel edge brightening
    const fresnel = svgEl('radialGradient', { id: `${id}-fresnel`, cx: '50%', cy: '50%', r: '50%' }, defs);
    stop(fresnel, '0%', '#ffffff', 0);
    stop(fresnel, '74%', '#ffffff', 0);
    stop(fresnel, '92%', '#ffffff', 0.45);
    stop(fresnel, '100%', '#ffffff', 0.85);

    // glass thickness: slightly cooler, denser bottom
    const depth = svgEl('linearGradient', { id: `${id}-depth`, x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
    stop(depth, '0%', '#ffffff', 0);
    stop(depth, '72%', '#ffffff', 0);
    stop(depth, '100%', '#dadada', 0.35);

    // specular highlight
    const spec = svgEl('radialGradient', { id: `${id}-spec`, cx: '50%', cy: '50%', r: '50%' }, defs);
    stop(spec, '0%', '#ffffff', 0.95);
    stop(spec, '100%', '#ffffff', 0);

    // contact shadow
    const shadowGrad = svgEl('radialGradient', { id: `${id}-shadow`, cx: '50%', cy: '50%', r: '50%' }, defs);
    stop(shadowGrad, '0%', '#161616', 0.22);
    stop(shadowGrad, '100%', '#161616', 0);

    // streak mask: fades lines out with distance from their origin
    const streakFade = svgEl('radialGradient', { id: `${id}-streak-fade`, gradientUnits: 'userSpaceOnUse', cx: 52, cy: 168, r: 120 }, defs);
    stop(streakFade, '0%', '#ffffff', 1);
    stop(streakFade, '45%', '#ffffff', 0.55);
    stop(streakFade, '100%', '#ffffff', 0);
    const streakMask = svgEl('mask', { id: `${id}-streak-mask`, maskUnits: 'userSpaceOnUse', x: 0, y: 0, width: 200, height: 200 }, defs);
    svgEl('rect', { x: 0, y: 0, width: 200, height: 200, fill: `url(#${id}-streak-fade)` }, streakMask);

    // filters
    const filterBox = { x: '-25%', y: '-25%', width: '150%', height: '150%', 'color-interpolation-filters': 'sRGB' };
    const soft = svgEl('filter', { id: `${id}-soft`, ...filterBox }, defs);
    svgEl('feGaussianBlur', { stdDeviation: 7 }, soft);

    const silk = svgEl('filter', { id: `${id}-silk`, ...filterBox }, defs);
    if (quality === 'high') {
      svgEl('feTurbulence', { type: 'fractalNoise', baseFrequency: '0.010 0.016', numOctaves: 2, seed: 7, result: 'noise' }, silk);
      svgEl('feDisplacementMap', { in: 'SourceGraphic', in2: 'noise', scale: 22, xChannelSelector: 'R', yChannelSelector: 'G', result: 'warped' }, silk);
      svgEl('feGaussianBlur', { in: 'warped', stdDeviation: 3.6 }, silk);
    } else {
      svgEl('feGaussianBlur', { stdDeviation: 4 }, silk);
    }

    const crease = svgEl('filter', { id: `${id}-crease`, ...filterBox }, defs);
    svgEl('feGaussianBlur', { stdDeviation: 0.9 }, crease);

    const streakBlur = svgEl('filter', { id: `${id}-streak-blur`, ...filterBox }, defs);
    svgEl('feGaussianBlur', { stdDeviation: 0.75 }, streakBlur);

    const shadowBlur = svgEl('filter', { id: `${id}-shadow-blur`, x: '-50%', y: '-200%', width: '200%', height: '500%' }, defs);
    svgEl('feGaussianBlur', { stdDeviation: 2 }, shadowBlur);

    // ----- scene -----
    if (shadow) {
      svgEl('ellipse', { cx: 100, cy: 194, rx: 58, ry: 4.5, fill: `url(#${id}-shadow)`, filter: `url(#${id}-shadow-blur)` }, svg);
    }

    const sphere = svgEl('g', { 'clip-path': `url(#${id}-clip)` }, svg);
    svgEl('circle', { cx: 100, cy: 100, r: 92, fill: `url(#${id}-body)` }, sphere);

    const layers = {
      back: svgEl('g', { filter: `url(#${id}-soft)` }, sphere),
      silk: svgEl('g', { filter: `url(#${id}-silk)` }, sphere),
      accent: svgEl('g', { filter: `url(#${id}-silk)` }, sphere),
    };
    const creaseLayer = svgEl('g', { filter: `url(#${id}-crease)`, fill: 'none', stroke: '#ffffff', 'stroke-linecap': 'round' }, sphere);

    this.ribbons = ribbonSpecs(p).map((spec) => {
      // gradient runs across the band: light edge, deep core, soft edge — reads as a fold
      const grad = svgEl('linearGradient', { id: `${id}-r-${spec.key}`, x1: 0, y1: 0, x2: 0.15, y2: 1 }, defs);
      const stopA = svgEl('stop', { offset: '0%', 'stop-color': spec.to, 'stop-opacity': 0.55 }, grad);
      const stopB = svgEl('stop', { offset: '55%', 'stop-color': spec.from }, grad);
      const stopC = svgEl('stop', { offset: '100%', 'stop-color': spec.to, 'stop-opacity': 0.8 }, grad);
      const group = svgEl('g', null, layers[spec.layer]);
      const path = svgEl('path', { fill: `url(#${id}-r-${spec.key})`, opacity: spec.opacity }, group);
      let creasePath = null;
      if (spec.crease) {
        const cg = svgEl('g', null, creaseLayer);
        creasePath = svgEl('path', { 'stroke-width': 1.3, opacity: 0.55 }, cg);
        creasePath._group = cg;
      }
      return { spec, group, path, creasePath, stopA, stopB, stopC };
    });
    this.accentLayer = layers.accent;

    // light streaks fanning out from the lower left
    const streaks = svgEl('g', { class: 'agent-orb__streaks', mask: `url(#${id}-streak-mask)`, filter: `url(#${id}-streak-blur)` }, sphere);
    const rand = seeded(42);
    this.streakLines = [];
    const tints = [p.streak, '#ffd0bc', '#dadada', '#ffe0d4'];
    for (let i = 0; i < 72; i++) {
      const angle = (-100 + rand() * 95) * (Math.PI / 180);
      const len = 50 + rand() * 90;
      const start = 6 + rand() * 14;
      const ox = 52, oy = 168;
      const line = svgEl('line', {
        x1: (ox + Math.cos(angle) * start).toFixed(1),
        y1: (oy + Math.sin(angle) * start).toFixed(1),
        x2: (ox + Math.cos(angle) * len).toFixed(1),
        y2: (oy + Math.sin(angle) * len).toFixed(1),
        stroke: tints[i % tints.length],
        'stroke-width': (0.3 + rand() * 0.7).toFixed(2),
        'stroke-linecap': 'round',
        opacity: (0.3 + rand() * 0.55).toFixed(2),
      }, streaks);
      this.streakLines.push(line);
    }
    this.streaks = streaks;

    // glass overlays
    svgEl('circle', { cx: 100, cy: 100, r: 92, fill: `url(#${id}-depth)` }, sphere);
    svgEl('circle', { cx: 100, cy: 100, r: 92, fill: `url(#${id}-fresnel)` }, sphere);
    this.specular = svgEl('ellipse', { cx: 66, cy: 46, rx: 30, ry: 15, fill: `url(#${id}-spec)`, opacity: 0.75, transform: 'rotate(-32 66 46)' }, sphere);

    // crisp outer edge
    svgEl('circle', { cx: 100, cy: 100, r: 91.5, fill: 'none', stroke: '#ffffff', 'stroke-opacity': 0.9, 'stroke-width': 1 }, svg);

    this.root = root;
    this.stage = stage;
    this.iris = iris;
    this.container.appendChild(root);
  }

  /* ----- environment: visibility, reduced motion ----- */

  _bindEnvironment() {
    this.motionQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    this.reducedMotion = !!this.motionQuery?.matches;
    this._onMotion = (e) => {
      this.reducedMotion = e.matches;
      if (this.reducedMotion) {
        this._stop();
        this._renderFrame(0);
      } else {
        this._start();
      }
    };
    this.motionQuery?.addEventListener?.('change', this._onMotion);

    this._onVisibility = () => {
      this.pageVisible = !document.hidden;
      this.pageVisible ? this._start() : this._stop();
    };
    document.addEventListener('visibilitychange', this._onVisibility);

    if ('IntersectionObserver' in window) {
      this.io = new IntersectionObserver(([entry]) => {
        this.visible = entry.isIntersecting;
        this.visible ? this._start() : this._stop();
      });
      this.io.observe(this.root);
    }
  }

  /* ----- loop ----- */

  _start() {
    if (this.rafId || this.destroyed || this.paused || this.reducedMotion || !this.visible || !this.pageVisible) return;
    this.lastTime = 0;
    const tick = (now) => {
      this.rafId = requestAnimationFrame(tick);
      const minDelta = 1000 / this.options.maxFps;
      if (this.lastFrame && now - this.lastFrame < minDelta - 1) return;
      this.lastFrame = now;
      const dt = this.lastTime ? Math.min(0.1, (now - this.lastTime) / 1000) : 0;
      this.lastTime = now;
      this._renderFrame(dt, now);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  _stop() {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    this.lastFrame = 0;
  }

  _renderFrame(dt, now = performance.now()) {
    // ease state parameters so state changes never jump
    const ease = 1 - Math.exp(-dt * 2.5);
    for (const k of ['speed', 'swirl', 'streaks']) {
      this.preset[k] += (this.target[k] - this.preset[k]) * ease;
    }
    const { speed, swirl, streaks } = this.preset;

    if (this.reducedMotion) this.clock = LOOP_SECONDS * 0.62;
    else this.clock += dt * speed;

    const t = this.clock;
    const phase = (t % LOOP_SECONDS) / LOOP_SECONDS;

    // ribbons
    for (const r of this.ribbons) {
      const s = r.spec;
      const ph = t * s.speed + s.phase;
      const top = [];
      const bottom = [];
      for (let x = -50; x <= 250; x += 12) {
        const u = x / 200;
        const base = 100 + s.offset + Math.sin(ph * 0.6 + s.phase) * 6;
        const w1 = Math.sin(u * s.freq * TAU + ph) * s.amp * swirl + Math.sin(u * s.freq * 0.5 * TAU - ph * 0.7) * s.amp * 0.45;
        const w2 = Math.sin(u * s.freq * TAU + ph + s.twist) * s.amp * swirl + Math.sin(u * s.freq * 0.5 * TAU - ph * 0.7 + 0.6) * s.amp * 0.45;
        const thick = s.width * (0.55 + 0.45 * Math.sin(u * TAU * 0.8 + ph * 0.5));
        top.push([x, base + w1 - thick / 2]);
        bottom.push([x, base + w2 + thick / 2]);
      }
      const d = spline(top, true) + spline(bottom.reverse(), false) + 'Z';
      r.path.setAttribute('d', d);

      const angle = s.angle + Math.sin(t * 0.25 + s.phase) * s.drift * swirl;
      const transform = `rotate(${angle.toFixed(2)} 100 100)`;
      r.group.setAttribute('transform', transform);

      if (r.creasePath) {
        r.creasePath.setAttribute('d', spline(top, true));
        r.creasePath._group.setAttribute('transform', transform);
      }
    }

    // timed moments across the loop
    const accentOpacity = 0.1 + 0.9 * smoothBump(phase, 0.45, 0.22);
    this.accentLayer.setAttribute('opacity', accentOpacity.toFixed(3));

    const streakOpacity = Math.min(1, smoothBump(phase, 0.76, 0.24) * 0.9 * streaks);
    this.streaks.setAttribute('opacity', streakOpacity.toFixed(3));
    this.streaks.setAttribute('transform', `rotate(${(Math.sin(t * 0.4) * 6).toFixed(2)} 52 168)`);

    this.iris.style.opacity = (0.3 + 0.45 * smoothBump(phase, 0.62, 0.4)).toFixed(3);
    this.specular.setAttribute('opacity', (0.6 + 0.2 * Math.sin(t * 0.5)).toFixed(3));

    // speaking pulse: live level if provided, otherwise a gentle synthetic one
    let levelGoal = 0;
    if (this.state === 'speaking') {
      const live = now - this.lastLevelAt < 400;
      levelGoal = live
        ? this.levelTarget
        : 0.35 + 0.35 * Math.sin(t * 7.3) * Math.sin(t * 2.1) + 0.15 * Math.sin(t * 13.7);
    }
    this.level += (Math.max(0, levelGoal) - this.level) * (1 - Math.exp(-dt * 12));
    const scale = 1 + this.level * 0.045;
    this.stage.style.transform = scale === 1 ? '' : `scale(${scale.toFixed(4)})`;
  }
}

export function createAgentOrb(container, options) {
  return new AgentOrb(container, options);
}

export default createAgentOrb;
