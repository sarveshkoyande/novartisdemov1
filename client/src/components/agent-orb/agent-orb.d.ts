export type OrbState = 'idle' | 'thinking' | 'speaking';
export interface AgentOrbHandle {
  setState(state: OrbState, immediate?: boolean): void;
  setLevel(value: number): void;
  destroy(): void;
}
export interface AgentOrbOptions {
  size?: number | string | null;
  state?: OrbState;
  quality?: 'low' | 'high';
  label?: string;
}
export function createAgentOrb(container: HTMLElement, options?: AgentOrbOptions): AgentOrbHandle;
export default createAgentOrb;
