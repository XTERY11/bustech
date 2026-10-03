/** The host supplies a target; the renderer eases the bus over 4.2 seconds. */
export const ARRIVAL_SECONDS = 4.2;
// The model's front is -X, so a forward approach travels from +X to the stop.
export const ARRIVAL_START_X = 7;

export function advanceArrivalProgress(current: number, target: number, delta: number): number {
  const distance = target - current;
  return current + Math.sign(distance) * Math.min(Math.abs(distance), Math.max(0, Math.min(delta, 0.1)) / ARRIVAL_SECONDS);
}

export function arrivalPosition(progress: number): number {
  const p = Math.max(0, Math.min(1, progress));
  if (p === 1) return 0;
  const eased = p * p * (3 - 2 * p);
  return ARRIVAL_START_X * (1 - eased);
}

/** Signed X travel and +Z axle rotation satisfy rolling contact at ground level. */
export function wheelRotationForTravel(travel: number, radius: number): number {
  return travel === 0 ? 0 : -travel / radius;
}
