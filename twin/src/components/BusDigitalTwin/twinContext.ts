import { createContext, useContext } from 'react';
import type { AnimationController } from '../../state/animationController';
import type { Presentation } from '../../state/presentation';
import type { TwinAction, VehicleState } from '../../types/vehicle';

/**
 * Per-frame data shared with the 3D parts WITHOUT React re-renders.
 * Parts read `ctx.anim.values` inside `useFrame` and write transforms
 * directly — React only re-renders when semantic state changes.
 */
export interface TwinFrameContext {
  anim: AnimationController;
  /** Latest semantic state and derived presentation (refs, mutated in place). */
  state: { current: VehicleState };
  presentation: { current: Presentation };
  /** Seconds since mount, for subtle pulses. */
  time: { current: number };
  /** performance.now() of the last destination change, for the display flash. */
  destinationChangedAt: { current: number };
  /** Send an event back to the host (component clicks etc.). */
  emit: (a: TwinAction) => void;
}

export const TwinContext = createContext<TwinFrameContext | null>(null);

export function useTwin(): TwinFrameContext {
  const ctx = useContext(TwinContext);
  if (!ctx) throw new Error('useTwin must be used inside <BusDigitalTwin>');
  return ctx;
}

export const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
export const smoothstep = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
/** 0..1 gentle breathing pulse. */
export const pulse = (t: number, hz = 0.8) => 0.5 + 0.5 * Math.sin(t * Math.PI * 2 * hz);
