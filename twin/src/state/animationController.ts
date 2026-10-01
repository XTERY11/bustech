import type { AnimationValues, VehicleState } from '../types/vehicle';

/**
 * Animation controller
 * --------------------
 *   VehicleState ──► targets (0 | 1) ──► AnimatedChannel (time-based) ──► AnimationValues
 *
 * Each channel owns a *linear* progress `p` that moves toward its target at a
 * fixed rate (1 / duration). The value the scene sees is `ease(p)`. Because
 * the linear progress simply reverses when the target flips, transitions are
 * interruptible and reversible with no jumps — exactly what live telemetry
 * needs (e.g. a door that re-opens because of an obstacle).
 */

export const ANIMATION_DURATIONS = {
  doorOpenAmount: 1.2, // seconds, full travel
  rampDeployAmount: 2.0,
  kneelAmount: 1.6,
} as const satisfies Record<keyof AnimationValues, number>;

export const easeInOutCubic = (t: number) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

export const easeInOutSine = (t: number) => -(Math.cos(Math.PI * t) - 1) / 2;

export class AnimatedChannel {
  progress: number;
  target: number;

  constructor(
    public readonly duration: number,
    initial = 0,
    private readonly ease: (t: number) => number = easeInOutCubic,
  ) {
    this.progress = initial;
    this.target = initial;
  }

  get value() {
    return this.ease(this.progress);
  }

  get moving() {
    return this.progress !== this.target;
  }

  /** Advance by dt seconds. Returns true if the channel just settled. */
  step(dt: number): boolean {
    if (!this.moving) return false;
    const rate = 1 / this.duration;
    const delta = this.target - this.progress;
    const stepAmount = Math.sign(delta) * Math.min(Math.abs(delta), rate * dt);
    this.progress += stepAmount;
    if (Math.abs(this.target - this.progress) < 1e-6) {
      this.progress = this.target;
      return true;
    }
    return false;
  }

  /** Jump without animating (e.g. first frame, or telemetry resync). */
  snap(value: number) {
    this.progress = this.target = value;
  }
}

/** Map semantic state to numeric animation targets. Pure function. */
export function targetsFromState(state: VehicleState): AnimationValues {
  return {
    doorOpenAmount: state.door === 'opening' || state.door === 'open' ? 1 : 0,
    rampDeployAmount: state.ramp === 'extending' || state.ramp === 'extended' ? 1 : 0,
    kneelAmount: state.kneeling ? 1 : 0,
  };
}

export type ChannelName = keyof AnimationValues;

export class AnimationController {
  readonly channels: Record<ChannelName, AnimatedChannel>;

  constructor(initial: VehicleState) {
    const t = targetsFromState(initial);
    this.channels = {
      doorOpenAmount: new AnimatedChannel(ANIMATION_DURATIONS.doorOpenAmount, t.doorOpenAmount),
      // Ramp phases are shaped inside the ramp component, so keep this linear.
      rampDeployAmount: new AnimatedChannel(ANIMATION_DURATIONS.rampDeployAmount, t.rampDeployAmount, (x) => x),
      kneelAmount: new AnimatedChannel(ANIMATION_DURATIONS.kneelAmount, t.kneelAmount, easeInOutSine),
    };
  }

  setTargets(state: VehicleState) {
    const t = targetsFromState(state);
    (Object.keys(t) as ChannelName[]).forEach((k) => (this.channels[k].target = t[k]));
  }

  /** Advance all channels; returns names of channels that settled this frame. */
  step(dt: number): ChannelName[] {
    const settled: ChannelName[] = [];
    // Clamp dt so a long stall (background tab) can't skip a whole motion,
    // while slow devices still keep pace with real-time telemetry.
    const safeDt = Math.min(dt, 0.25);
    (Object.keys(this.channels) as ChannelName[]).forEach((k) => {
      if (this.channels[k].step(safeDt)) settled.push(k);
    });
    return settled;
  }

  get isAnimating() {
    return Object.values(this.channels).some((c) => c.moving);
  }

  get values(): AnimationValues {
    return {
      doorOpenAmount: this.channels.doorOpenAmount.value,
      rampDeployAmount: this.channels.rampDeployAmount.value,
      kneelAmount: this.channels.kneelAmount.value,
    };
  }
}
