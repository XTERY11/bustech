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
export const STROLLER_FORWARD_OFFSET = 0.62;

export interface StrollerJourneyPath {
  path: readonly Point3[];
  parkingProgress: number;
  parkingPoint: Point3;
  equipmentPosition: Point3;
}

function pathLength(path: readonly Point3[]): number {
  return path.slice(1).reduce((total, point, index) => total + Math.hypot(
    point[0] - path[index][0], point[1] - path[index][1], point[2] - path[index][2],
  ), 0);
}

/** Push a stroller to its bay, leave it there, then walk to a supported aisle-side seat. */
export function buildStrollerJourneyPath(destination: PassengerDestination, equipmentDestination?: PassengerDestination | null): StrollerJourneyPath | null {
  if (equipmentDestination?.type !== 'WHEELCHAIR_BAY' || equipmentDestination.id !== 'WHEELCHAIR_BAY'
    || destination.type !== 'SEAT' || !['S02', 'S03', 'S05', 'S06', 'S08', 'S09'].includes(destination.id)) return null;
  const seat = SEATS.find(candidate => candidate.id === destination.id)!;
  const bayPath = buildPassengerPath(equipmentDestination)!;
  const parkingPoint: Point3 = [CABIN.wheelchairBay.x, CABIN.floorY, CABIN.wheelchairBay.z + STROLLER_FORWARD_OFFSET];
  const approach = [...bayPath.slice(0, -1), parkingPoint];
  const path: readonly Point3[] = [...approach,
    [CABIN.wheelchairBay.x, CABIN.floorY, AISLE_Z],
    [seat.position[0], CABIN.floorY, AISLE_Z], seat.position];
  return { path, parkingProgress: pathLength(approach) / pathLength(path), parkingPoint,
    equipmentPosition: [CABIN.wheelchairBay.x, CABIN.floorY, CABIN.wheelchairBay.z] };
}

/** Equipment is a separate stable sample after parking, including seat hand-off. */
export function sampleStrollerJourney(plan: StrollerJourneyPath, rawProgress: number): { passenger: PathSample; equipment: PathSample; equipmentParked: boolean } {
  let passenger = samplePassengerPath(plan.path, rawProgress);
  if (Math.abs(rawProgress - plan.parkingProgress) <= EPSILON) passenger = { position: plan.parkingPoint, tangent: [0, 0, -1] };
  const equipmentParked = rawProgress >= plan.parkingProgress - EPSILON;
  if (equipmentParked) return { passenger, equipment: { position: plan.equipmentPosition, tangent: [0, 0, -1] }, equipmentParked };
  const yaw = Math.atan2(passenger.tangent[0], passenger.tangent[2]);
  return { passenger, equipment: { position: [passenger.position[0] + Math.sin(yaw) * STROLLER_FORWARD_OFFSET,
    passenger.position[1], passenger.position[2] + Math.cos(yaw) * STROLLER_FORWARD_OFFSET], tangent: passenger.tangent }, equipmentParked };
}

/** A seated person hands off to cabin occupancy; parked equipment does not. */
export function journeyVisibility(stage: PassengerJourneyStage, destination: PassengerDestination, separateEquipment: boolean): { passenger: boolean; equipment: boolean } {
  const active = stage !== 'hidden';
  const seatHandoff = destination.type === 'SEAT' && (stage === 'seated' || stage === 'secured');
  return { passenger: active && !seatHandoff, equipment: active && separateEquipment };
}

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
