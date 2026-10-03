import { CABIN, SEATS } from '../data/cabinLayout';
import type { PassengerDestination, PassengerJourneyStage } from '../types/vehicle';
import { BUS, DOOR_CENTER_X } from '../components/BusDigitalTwin/dimensions';

export type Point3 = readonly [number, number, number];

export interface PathSample {
  position: Point3;
  tangent: Point3;
}

const AISLE_Z = 0.24;
const EPSILON = 1e-6;

/**
 * Build a collision-avoiding centre line in the bus body coordinate frame.
 * Low-floor destinations turn from the doorway into the central aisle. Rear
 * destinations add the three shallow step landings already modelled in Cabin.
 */
export function buildPassengerPath(destination: PassengerDestination): readonly Point3[] | null {
  const common: Point3[] = [
    [DOOR_CENTER_X, 0.025, BUS.sideZ + BUS.ramp.length + 0.66],
    [DOOR_CENTER_X, 0.04, BUS.sideZ + BUS.ramp.length + 0.04],
    [DOOR_CENTER_X, CABIN.floorY, BUS.sideZ - 0.03],
    [DOOR_CENTER_X, CABIN.floorY, AISLE_Z],
  ];

  if (destination.type === 'WHEELCHAIR_BAY') {
    return [
      ...common,
      [CABIN.wheelchairBay.x, CABIN.floorY, AISLE_Z],
      [CABIN.wheelchairBay.x, CABIN.floorY, CABIN.wheelchairBay.z],
    ];
  }

  const seat = SEATS.find((candidate) => candidate.id === destination.id && candidate.kind !== 'foldable');
  if (!seat) return null;

  if (seat.zone === 'rear-platform') {
    return [
      ...common,
      [0.96, CABIN.floorY, AISLE_Z],
      [CABIN.steps[0] + 0.14, CABIN.floorY + 0.21, AISLE_Z],
      [CABIN.steps[1] + 0.14, CABIN.floorY + 0.42, AISLE_Z],
      [CABIN.steps[2] + 0.14, CABIN.rearFloorY, AISLE_Z],
      [seat.position[0], CABIN.rearFloorY, AISLE_Z],
      [seat.position[0], seat.position[1], seat.position[2]],
    ];
  }

  return [
    ...common,
    [seat.position[0], CABIN.floorY, AISLE_Z],
    [seat.position[0], seat.position[1], seat.position[2]],
  ];
}

/** Sample a polyline by travelled distance rather than by point index. */
export function samplePassengerPath(path: readonly Point3[], rawProgress: number): PathSample {
  if (!path.length) return { position: [0, 0, 0], tangent: [0, 0, 1] };
  if (path.length === 1) return { position: path[0], tangent: [0, 0, 1] };
  if (rawProgress <= 0) {
    const a = path[0], b = path[1];
    const length = Math.max(EPSILON, Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
    return { position: a, tangent: [(b[0] - a[0]) / length, (b[1] - a[1]) / length, (b[2] - a[2]) / length] };
  }
  if (rawProgress >= 1) {
    const a = path[path.length - 2], b = path[path.length - 1];
    const length = Math.max(EPSILON, Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
    return { position: b, tangent: [(b[0] - a[0]) / length, (b[1] - a[1]) / length, (b[2] - a[2]) / length] };
  }

  const lengths: number[] = [];
  let total = 0;
  for (let index = 1; index < path.length; index++) {
    const a = path[index - 1], b = path[index];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    lengths.push(length);
    total += length;
  }
  if (total <= EPSILON) return { position: path[0], tangent: [0, 0, 1] };

  let remaining = Math.min(1, Math.max(0, rawProgress)) * total;
  for (let index = 0; index < lengths.length; index++) {
    const length = lengths[index];
    const a = path[index], b = path[index + 1];
    if (remaining <= length || index === lengths.length - 1) {
      const amount = length <= EPSILON ? 0 : Math.min(1, remaining / length);
      const tangentLength = Math.max(EPSILON, length);
      return {
        position: [
          a[0] + (b[0] - a[0]) * amount,
          a[1] + (b[1] - a[1]) * amount,
          a[2] + (b[2] - a[2]) * amount,
        ],
        tangent: [
          (b[0] - a[0]) / tangentLength,
          (b[1] - a[1]) / tangentLength,
          (b[2] - a[2]) / tangentLength,
        ],
      };
    }
    remaining -= length;
  }

  return { position: path[path.length - 1], tangent: [0, 0, 1] };
}

/** Default stage targets keep useful motion when the host sends no progress. */
export function journeyStageTarget(stage: PassengerJourneyStage): number {
  switch (stage) {
    case 'hidden': return 0;
    case 'waiting': return 0;
    case 'boarding': return 0.36;
    case 'navigating': return 0.94;
    case 'seated':
    case 'secured': return 1;
  }
}
