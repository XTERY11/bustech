// Simulated cabin-map directions from the interior entrance threshold, not GPS
// navigation or live passenger localisation. Keep these points aligned with the
// twin's dimensions, cabinLayout and passengerPath; the geometry test checks them.
export const CABIN_ROUTE_GEOMETRY = Object.freeze({
  entrance: Object.freeze([-1.32, 1.12]),
  aisle_z: 0.24,
  seats: Object.freeze({
    S02: Object.freeze([-0.66, -0.29]), S03: Object.freeze([-0.66, 0.77]),
    S05: Object.freeze([0.04, -0.29]), S06: Object.freeze([0.04, 0.77]),
    S08: Object.freeze([0.74, -0.29]), S09: Object.freeze([0.74, 0.77]),
  }),
  wheelchair_bay: Object.freeze([-1.55, -0.54]),
  stroller_passenger_stop: Object.freeze([-1.55, 0.08]),
  stroller_ahead_offset: 0.62,
});

const EPSILON = 1e-9;

/** Produce deterministic manoeuvres for an already validated boarding target. */
export function cabinRouteFor(target, equipmentTarget = null) {
  if (!target || typeof target !== 'object' || Array.isArray(target)
    || typeof target.type !== 'string' || typeof target.id !== 'string') return null;
  const destination = target.type === 'SEAT' ? CABIN_ROUTE_GEOMETRY.seats[target.id]
    : target.type === 'WHEELCHAIR_BAY' && target.id === 'WHEELCHAIR_BAY' ? CABIN_ROUTE_GEOMETRY.wheelchair_bay : null;
  if (!Array.isArray(destination)) return null;
  if (equipmentTarget !== null && (!equipmentTarget || typeof equipmentTarget !== 'object' || Array.isArray(equipmentTarget)
    || equipmentTarget.type !== 'WHEELCHAIR_BAY' || equipmentTarget.id !== 'WHEELCHAIR_BAY'
    || target.type !== 'SEAT')) return null;
  const [entranceX, entranceZ] = CABIN_ROUTE_GEOMETRY.entrance;
  const [destinationX, destinationZ] = destination;
  const steps = [{ step: 1, maneuver: 'START', distance_m: null }];
  let heading = [0, -1]; // The passenger begins facing from the kerb into the bus.
  const add = (maneuver, distance_m = null) => steps.push({ step: steps.length + 1, maneuver, distance_m });

  const walk = points => {
    for (let index = 1; index < points.length; index++) {
      const delta = [points[index][0] - points[index - 1][0], points[index][1] - points[index - 1][1]];
      const distance = Math.hypot(...delta);
      if (distance <= EPSILON) continue;
      const direction = delta.map(value => value / distance);
      // +X is rearward, +Z is the kerb. Viewed facing -Z, a positive X/Z cross
      // product is a right turn; reversing that sign gives a left turn.
      const cross = heading[0] * direction[1] - heading[1] * direction[0];
      if (Math.abs(cross) > EPSILON) add(cross > 0 ? 'TURN_RIGHT' : 'TURN_LEFT');
      else if (heading[0] * direction[0] + heading[1] * direction[1] < 0) { add('TURN_RIGHT'); add('TURN_RIGHT'); }
      add('STRAIGHT', Math.round(distance * 10) / 10);
      heading = direction;
    }
  };
  if (equipmentTarget) {
    const [parkingX, parkingZ] = CABIN_ROUTE_GEOMETRY.stroller_passenger_stop;
    walk([[entranceX, entranceZ], [entranceX, CABIN_ROUTE_GEOMETRY.aisle_z],
      [parkingX, CABIN_ROUTE_GEOMETRY.aisle_z], [parkingX, parkingZ]]);
    add('PARK_STROLLER');
    // The stroller stays in the bay. The passenger reverses orientation, returns
    // to the aisle and then walks alone to their validated low-floor seat.
    walk([[parkingX, parkingZ], [parkingX, CABIN_ROUTE_GEOMETRY.aisle_z],
      [destinationX, CABIN_ROUTE_GEOMETRY.aisle_z], [destinationX, destinationZ]]);
  } else {
    walk([[entranceX, entranceZ], [entranceX, CABIN_ROUTE_GEOMETRY.aisle_z],
      [destinationX, CABIN_ROUTE_GEOMETRY.aisle_z], [destinationX, destinationZ]]);
  }
  add('ARRIVE');
  return {
    layout_id: 'byd-b70a02-photo-v1',
    origin: { type: 'ENTRANCE', id: 'SINGLE_ENTRANCE', facing: 'INTO_BUS' },
    target: { type: target.type, id: target.id },
    ...(equipmentTarget ? { equipment_target: { type: equipmentTarget.type, id: equipmentTarget.id } } : {}),
    steps,
  };
}
