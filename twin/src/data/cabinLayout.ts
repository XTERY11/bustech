/** Photo-based approximation, fitted to the existing 7.6 m exterior.
 * Source: https://landtransportguru.net/byd-b70a02-autonomous-bus/
 * -X front, +X rear, +Y up, +Z kerb. Coordinates are metres in body space.
 * 16 fixed seats: 9 low-entry (5 priority) + 7 raised; F01 is additional.
 */
export interface SeatDefinition {
  id: string;
  zone: 'low-floor' | 'rear-platform' | 'wheelchair-bay';
  kind: 'standard' | 'priority' | 'foldable';
  position: [number, number, number];
  /** Rotation about Y; zero faces the front (-X). */
  rotation: number;
}

export const CABIN = {
  floorY: 0.36,
  rearFloorY: 0.99,
  rearStartX: 1.96,
  steps: [1.12, 1.40, 1.68],
  seatHeight: 0.45,
  wheelchairBay: { x: -1.55, z: -0.54, length: 1.25, width: 0.94 },
} as const;

export const SEATS: readonly SeatDefinition[] = [
  ...[-0.66, 0.04, 0.74].flatMap((x, row) => [-0.77, -0.29, 0.77].map((z, col): SeatDefinition => ({
    id: `S${String(row * 3 + col + 1).padStart(2, '0')}`,
    zone: 'low-floor',
    kind: row === 0 || col === 2 ? 'priority' : 'standard',
    position: [x, CABIN.floorY, z], rotation: 0,
  }))),
  ...[-0.78, -0.30, 0.30, 0.78].map((z, i): SeatDefinition => ({
    id: `S${i + 10}`, zone: 'rear-platform', kind: 'standard',
    position: [2.19, CABIN.rearFloorY, z], rotation: 0,
  })),
  ...[-0.67, 0, 0.67].map((z, i): SeatDefinition => ({
    id: `S${i + 14}`, zone: 'rear-platform', kind: 'standard',
    position: [3.19, CABIN.rearFloorY, z], rotation: 0,
  })),
  { id: 'F01', zone: 'wheelchair-bay', kind: 'foldable', position: [-1.98, CABIN.floorY, -0.64], rotation: Math.PI },
];

export type SeatOccupancy = Readonly<Record<string, boolean>>;
export type OccupancyPreset = 'mixed' | 'empty' | 'full';
const MIXED = new Set(['S01', 'S04', 'S06', 'S08', 'S10', 'S13', 'S15']);

export function createSeatOccupancy(preset: OccupancyPreset = 'mixed'): SeatOccupancy {
  return Object.fromEntries(SEATS.map((s) => [s.id, preset === 'full' || (preset === 'mixed' && MIXED.has(s.id))]));
}

/** Drop malformed values and unknown IDs. Missing IDs preserve their old state. */
export function normalizeSeatOccupancy(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  return Object.fromEntries(SEATS.filter((s) => typeof raw[s.id] === 'boolean').map((s) => [s.id, raw[s.id] as boolean]));
}

/** Serializable read boundary for a future host/backend, independent of Three.js. */
export function getCabinSnapshot(state: { vehicleId?: string; updatedAt?: number; seatOccupancy?: SeatOccupancy }) {
  const seats = SEATS.map((s) => ({ ...s, position: [...s.position], occupied: state.seatOccupancy?.[s.id] ?? false }));
  const fixed = seats.filter((s) => s.kind !== 'foldable');
  return {
    schemaVersion: 1, vehicleId: state.vehicleId, updatedAt: state.updatedAt,
    layoutId: 'byd-b70a02-photo-v1', source: 'simulation', units: 'metres',
    coordinateFrame: { front: '-X', up: '+Y', kerb: '+Z', origin: 'vehicle body centre at ground level' },
    fixedSeatCount: fixed.length, occupiedFixedSeats: fixed.filter((s) => s.occupied).length,
    availableFixedSeats: fixed.filter((s) => !s.occupied).length,
    occupiedTotal: seats.filter((s) => s.occupied).length,
    wheelchairBay: { ...CABIN.wheelchairBay, foldableSeatId: 'F01', wheelchairOccupancy: 'not-simulated' },
    seats,
  };
}
