import { useEffect, useRef, useState } from 'react';
import { createAgentOrb, type AgentOrbHandle, type AgentOrbOptions, type OrbState } from './agent-orb/agent-orb.js';

// React host for the supplied immutable orb component. The orb owns its own
// DOM and injected styles; this wrapper only mounts, re-states and destroys it.
export default function AgentOrb({ state = 'idle', size, quality, label = 'NORA, Requirement Collection Agent', className, id }: {
  state?: OrbState; size?: AgentOrbOptions['size']; quality?: AgentOrbOptions['quality']; label?: string; className?: string; id?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const orb = useRef<AgentOrbHandle | null>(null);
  useEffect(() => {
    orb.current = createAgentOrb(host.current!, { size, quality, label, state });
    return () => { orb.current?.destroy(); orb.current = null; };
    // Size/quality/label are mount-time options of the component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { orb.current?.setState(state); }, [state]);
  return <div ref={host} className={className} id={id} />;
}

// Speaks briefly whenever `trigger` changes, then settles back to idle.
export function useSpeakingPulse(trigger: unknown, ms = 1600): OrbState {
  const [state, setState] = useState<OrbState>('idle');
  useEffect(() => {
    if (trigger === undefined || trigger === '' || trigger === 0) return;
    setState('speaking');
    const t = setTimeout(() => setState('idle'), ms);
    return () => clearTimeout(t);
  }, [trigger, ms, setState]);
  return state;
}
