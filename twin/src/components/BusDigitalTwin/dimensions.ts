/**
 * Geometric layout of the procedural bus, in metres.
 *
 * Coordinate frame (matches the reference photo):
 *   -X = front, +X = rear, +Y = up, +Z = kerb / passenger-door side (left-hand traffic).
 *
 * Every other module reads positions from here. A future .glb model would
 * provide the same anchors (door hinge line, ramp pivot, display quads) as
 * named empties, and only this file plus the mesh components would change.
 */
export const BUS = {
  length: 7.6,
  width: 2.3,
  bottom: 0.26,
  top: 2.86,
  cornerRadius: 0.16,

  get frontX() { return -this.length / 2; },
  get rearX() { return this.length / 2; },
  get sideZ() { return this.width / 2; },
  get height() { return this.top - this.bottom; },

  /** Bands along the side, y ranges. */
  stripe: { y0: 1.2, y1: 1.27 },
  band: { y0: 1.27, y1: 2.52 },
  windows: { y0: 1.35, y1: 2.44 },

  floorY: 0.36,

  wheel: { radius: 0.46, width: 0.28, frontX: -2.62, rearX: 1.5, trackZ: 0.93, wellRadius: 0.6 },

  door: { x0: -1.92, x1: -0.72, y0: 0.37, y1: 2.3, pocketDepth: 0.55 },

  ramp: { width: 0.94, length: 1.06, thickness: 0.04, topY: 0.345 },

  roofPod: { x: 0.35, length: 6.1, width: 1.92, height: 0.26 },

  /** Kneeling: body drops and rolls toward the kerb (+Z). */
  kneel: { drop: 0.055, roll: 0.032 },
} as const;

export const DOOR_CENTER_X = (BUS.door.x0 + BUS.door.x1) / 2;
export const DOOR_WIDTH = BUS.door.x1 - BUS.door.x0;

/** Anchor points (body space) used by callouts & camera presets. */
export const ANCHORS = {
  door: [DOOR_CENTER_X + 0.42, BUS.door.y1 + 0.13, BUS.sideZ + 0.12] as const,
  ramp: [DOOR_CENTER_X + BUS.ramp.width / 2 + 0.12, 0.2, BUS.sideZ + BUS.ramp.length * 0.7] as const,
  display: [BUS.frontX - 0.05, 2.9, 0.4] as const,
  speaker: [DOOR_CENTER_X - 0.9, BUS.top + 0.45, BUS.sideZ - 0.1] as const,
};
