import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CABIN, SEATS, createSeatOccupancy, getCabinSnapshot } from '../src/data/cabinLayout';
import { createVehicleStore } from '../src/state/vehicleState';
import { connectTelemetry, normalizeArrival, normalizePassengerJourney, normalizeTelemetry } from '../src/adapters/telemetryAdapter';
import { MockBusSimulator } from '../src/simulation/mockBus';
import { buildPassengerPath, buildStrollerJourneyPath, journeyStageTarget, journeyVisibility, samplePassengerPath, sampleStrollerJourney, STROLLER_FORWARD_OFFSET } from '../src/simulation/passengerPath';
import { advanceArrivalProgress, arrivalPosition, ARRIVAL_SECONDS, wheelRotationForTravel } from '../src/simulation/arrival';
import { BUS } from '../src/components/BusDigitalTwin/dimensions';
import { TwinHud } from '../src/components/BusDigitalTwin/TwinHud';
import { DEFAULT_VEHICLE_STATE } from '../src/types/vehicle';
import { derivePresentation } from '../src/state/presentation';

globalThis.window = globalThis as unknown as Window & typeof globalThis;

test('dashboard HUD hides only sequence and duplicate display; standalone and accessible feedback remain', () => {
  const state = { ...DEFAULT_VEHICLE_STATE, boardingStatus: 'ready' as const,
    passengerInfo: { title: 'Passenger guidance', message: 'Please wait at the entrance.' },
    announcement: { active: true, text: 'Route 400 is ready.' } };
  const props = { state, presentation: derivePresentation(state) };
  const normal = renderToStaticMarkup(createElement(TwinHud, props));
  assert.match(normal, /aria-label="Boarding sequence"/);
  assert.match(normal, /twin-bar--display/);
  const compact = renderToStaticMarkup(createElement(TwinHud, { ...props, compact: true }));
  assert.doesNotMatch(compact, /aria-label="Boarding sequence"|twin-bar--display/);
  for (const kept of ['Door', 'Ramp', 'Suspension', 'twin-bar--announcement', 'aria-live="polite"', 'Please wait at the entrance.']) {
    assert.ok(compact.includes(kept), `${kept} must remain in the dashboard HUD`);
  }
});

test('photo layout has 16 fixed seats, seven raised, five low-entry priority, and one extra fold-up seat', () => {
  assert.equal(new Set(SEATS.map((s) => s.id)).size, 17);
  assert.equal(SEATS.filter((s) => s.kind !== 'foldable').length, 16);
  assert.equal(SEATS.filter((s) => s.zone === 'rear-platform').length, 7);
  assert.equal(SEATS.filter((s) => s.kind === 'priority' && s.zone === 'low-floor').length, 5);
  // Keep every seat shell inside the body and out of the entry door's swept region.
  for (const seat of SEATS) {
    assert.ok(Math.abs(seat.position[2]) + 0.22 < 1.04);
    assert.ok(seat.position[0] + 0.27 < 3.68);
    assert.ok(!(seat.position[0] < -0.72 && seat.position[0] > -1.92 && seat.position[2] > 0.4));
  }
});

test('presets are complete independent maps; folding seat is counted separately', () => {
  for (const [preset, fixed, total] of [['mixed', 7, 7], ['empty', 0, 0], ['full', 16, 17]] as const) {
    const s = getCabinSnapshot({ seatOccupancy: createSeatOccupancy(preset) });
    assert.equal(s.occupiedFixedSeats, fixed);
    assert.equal(s.occupiedTotal, total);
    assert.equal(s.availableFixedSeats + s.occupiedFixedSeats, 16);
    assert.equal(s.seats.length, 17);
  }
  assert.notEqual(createSeatOccupancy(), createSeatOccupancy());
});

test('mock command → telemetry → store → serializable snapshot stays consistent through door updates and reset', () => {
  const store = createVehicleStore();
  const bus = new MockBusSimulator();
  const stop = connectTelemetry(store, bus, 'bus-01');
  try {
    bus.setSeatOccupied('S02', true);
    bus.setSeatOccupied('S01', false);
    bus.setSeatOccupied('F01', true);
    bus.openDoor();
    const snapshot = getCabinSnapshot(store.getState());
    assert.equal(store.getState().door, 'opening');
    assert.equal(snapshot.seats.find((s) => s.id === 'S02')?.occupied, true);
    assert.equal(snapshot.seats.find((s) => s.id === 'S01')?.occupied, false);
    assert.equal(snapshot.occupiedFixedSeats, 7);
    assert.equal(snapshot.occupiedTotal, 8);
    assert.deepEqual(JSON.parse(JSON.stringify(snapshot)).seats, snapshot.seats);
    bus.reset();
    assert.equal(getCabinSnapshot(store.getState()).occupiedTotal, 7);
    assert.equal(store.getState().seatOccupancy?.F01, false);
  } finally { stop(); }
});

test('partial host telemetry preserves all other seats, rejects unknown IDs and non-booleans', () => {
  const store = createVehicleStore();
  const before = store.getState().seatOccupancy;
  store.setVehicleState(normalizeTelemetry({ seatOccupancy: { S02: true, S01: 'false', S99: true, F01: 1 } }));
  assert.equal(store.getState().seatOccupancy?.S02, true);
  assert.equal(store.getState().seatOccupancy?.S01, before?.S01);
  assert.equal(store.getState().seatOccupancy?.F01, false);
  assert.equal(store.getState().seatOccupancy?.S99, undefined);
  for (const raw of [null, 'occupied', [], 3]) {
    store.setVehicleState(normalizeTelemetry({ seatOccupancy: raw }));
    assert.equal(getCabinSnapshot(store.getState()).occupiedTotal, 8);
  }
  store.setVehicleState(normalizeTelemetry({ door: 'open' }));
  assert.equal(getCabinSnapshot(store.getState()).occupiedTotal, 8);
});

test('read snapshots cannot mutate layout positions and occupancy commands isolate simulator instances', () => {
  const a = new MockBusSimulator(), b = new MockBusSimulator();
  a.setSeatOccupied('S01', false);
  assert.equal(b.snapshot.seatOccupancy.S01, true);
  const snapshot = getCabinSnapshot({ seatOccupancy: a.snapshot.seatOccupancy });
  snapshot.seats[0].position[0] = 999;
  snapshot.seats[0].occupied = true;
  assert.notEqual(SEATS[0].position[0], 999);
  assert.equal(a.snapshot.seatOccupancy.S01, false);
  const before = a.snapshot;
  a.setSeatOccupied('not-a-seat', true);
  assert.equal(a.snapshot, before);
});

test('passenger journey telemetry validates known seats, remains optional, and null clears it', () => {
  const valid = {
    journeyId: 'run-42:passenger-1', aid: 'cane', stage: 'navigating', progress: 0.55,
    destination: { type: 'SEAT', id: 'S03' },
  };
  assert.deepEqual(normalizePassengerJourney(valid), valid);
  assert.equal(normalizePassengerJourney({ ...valid, journeyId: 'j'.repeat(200) })?.journeyId.length, 200);
  assert.deepEqual(normalizePassengerJourney({
    ...valid, aid: 'wheelchair', stage: 'secured',
    destination: { type: 'WHEELCHAIR_BAY', id: 'WHEELCHAIR_BAY' },
  }), {
    ...valid, aid: 'wheelchair', stage: 'secured',
    destination: { type: 'WHEELCHAIR_BAY', id: 'WHEELCHAIR_BAY' },
  });
  assert.equal(normalizePassengerJourney(null), null);

  const store = createVehicleStore();
  store.setVehicleState(normalizeTelemetry({ passengerJourney: valid }));
  assert.deepEqual(store.getState().passengerJourney, valid);
  store.setVehicleState(normalizeTelemetry({ door: 'open' }));
  assert.deepEqual(store.getState().passengerJourney, valid, 'an old frame without the optional field must preserve it');
  store.setVehicleState(normalizeTelemetry({ passengerJourney: null }));
  assert.equal(store.getState().passengerJourney, null);
});

test('malformed passenger journeys are ignored instead of replacing valid state', () => {
  const invalid = [
    {},
    { journeyId: 'bad id', aid: 'cane', stage: 'boarding', destination: { type: 'SEAT', id: 'S03' } },
    { journeyId: 'j1', aid: 'jetpack', stage: 'boarding', destination: { type: 'SEAT', id: 'S03' } },
    { journeyId: 'j1', aid: 'cane', stage: 'flying', destination: { type: 'SEAT', id: 'S03' } },
    { journeyId: 'j1', aid: 'cane', stage: 'boarding', destination: { type: 'SEAT', id: 'F01' } },
    { journeyId: 'j1', aid: 'cane', stage: 'boarding', destination: { type: 'SEAT', id: 'S99' } },
    { journeyId: 'j1', aid: 'wheelchair', stage: 'boarding', destination: { type: 'WHEELCHAIR_BAY', id: 'wheelchair-bay' } },
    { journeyId: 'j1', aid: 'cane', stage: 'boarding', destination: { type: 'SEAT', id: 'S03' }, progress: 1.2 },
    { journeyId: 'j'.repeat(201), aid: 'cane', stage: 'boarding', destination: { type: 'SEAT', id: 'S03' } },
  ];
  for (const value of invalid) {
    assert.equal(normalizePassengerJourney(value), undefined);
    assert.equal('passengerJourney' in normalizeTelemetry({ passengerJourney: value }), false);
  }
});

test('arrival telemetry accepts bounded progress, preserves old frames, and explicitly resets on null', () => {
  const arrival = { id: 'arrival-1', progress: 0.6 };
  assert.deepEqual(normalizeArrival(arrival), arrival);
  assert.deepEqual(normalizeArrival({ id: 'a', progress: 0 }), { id: 'a', progress: 0 });
  assert.deepEqual(normalizeArrival({ id: 'a', progress: 1 }), { id: 'a', progress: 1 });
  const store = createVehicleStore();
  store.setVehicleState(normalizeTelemetry({ arrival }));
  arrival.progress = 0;
  assert.equal(store.getState().arrival?.progress, 0.6, 'the store owns a copy');
  store.setVehicleState(normalizeTelemetry({ door: 'open' }));
  assert.equal(store.getState().arrival?.id, 'arrival-1');
  for (const value of [undefined, {}, [], 'arriving', { id: '', progress: 0 }, { id: 'bad id', progress: 0 },
    { id: 'a', progress: -0.01 }, { id: 'a', progress: 1.01 }, { id: 'a', progress: NaN }, { id: 'a', progress: Infinity }, { id: 'a', progress: '1' }]) {
    assert.equal(normalizeArrival(value), undefined);
    assert.equal('arrival' in normalizeTelemetry({ arrival: value }), false);
  }
  store.setVehicleState(normalizeTelemetry({ arrival: null }));
  assert.equal(store.getState().arrival, null);
});

test('arrival drives toward the model front from the approach road to the stop without overshooting and can restart', () => {
  assert.equal(arrivalPosition(0), 7);
  assert.equal(arrivalPosition(1), 0);
  assert.equal(arrivalPosition(-1), 7);
  assert.equal(arrivalPosition(2), 0);
  const forwardX = Math.sign(BUS.frontX - BUS.rearX);
  assert.equal(forwardX, -1, 'the bus geometry defines its front along -X');
  assert.ok((arrivalPosition(1) - arrivalPosition(0)) * forwardX > 0, 'arrival must move toward the bus front, not reverse');
  let progress = 0, lastX = 7;
  for (let frame = 0; frame < Math.round(ARRIVAL_SECONDS * 60); frame++) {
    progress = advanceArrivalProgress(progress, 1, 1 / 60);
    const x = arrivalPosition(progress);
    assert.ok(x <= lastX && x >= 0);
    lastX = x;
  }
  assert.ok(Math.abs(progress - 1) < 1e-9);
  assert.equal(advanceArrivalProgress(1, 1, 1), 1);
  assert.equal(advanceArrivalProgress(0, 1, -1), 0);
  assert.ok(advanceArrivalProgress(1, 0, 0.1) < 1);
});

test('arrival wheels roll forward with signed X travel rather than spinning in reverse', () => {
  const travel = arrivalPosition(1) - arrivalPosition(0);
  const rotation = wheelRotationForTravel(travel, BUS.wheel.radius);
  assert.ok(travel < 0);
  assert.ok(rotation > 0, 'negative X travel needs positive rotation about the +Z axle');
  assert.ok(Math.abs(travel + rotation * BUS.wheel.radius) < 1e-9, 'the tyre contact point must not slip');
  assert.equal(wheelRotationForTravel(0, BUS.wheel.radius), 0);
  assert.ok(wheelRotationForTravel(-travel, BUS.wheel.radius) < 0, 'resetting travel reverses the wheel sign consistently');
});

test('waiting passengers remain at the marked point; supported low-floor paths end at the assigned seat', () => {
  assert.equal(journeyStageTarget('waiting'), 0);
  const waiting = normalizePassengerJourney({ journeyId: 'waiting-1', aid: 'cane', stage: 'waiting', destination: { type: 'SEAT', id: 'S03' }, progress: 0 });
  assert.equal(waiting?.stage, 'waiting');
  for (const id of ['S03', 'S02', 'S09', 'S06', 'S05', 'S08'] as const) {
    const seat = SEATS.find(candidate => candidate.id === id)!;
    const path = buildPassengerPath({ type: 'SEAT', id });
    assert.ok(path);
    assert.ok(path.every(point => point.every(Number.isFinite)));
    assert.equal(path[0][0], path[1][0]);
    assert.ok(path[0][2] > 2.3);
    assert.deepEqual(samplePassengerPath(path, 1).position, seat.position);
    assert.equal(seat.zone, 'low-floor');
    assert.ok(path.slice(2).every(point => point[1] === seat.position[1]));
  }
});

test('passenger paths begin outside, pass the doorway, and terminate at their validated destination', () => {
  const seatPath = buildPassengerPath({ type: 'SEAT', id: 'S03' });
  assert.ok(seatPath);
  assert.ok(seatPath[0][2] > 2.3, 'the passenger begins outside the kerb-side door');
  assert.deepEqual(samplePassengerPath(seatPath, 0).position, seatPath[0]);
  assert.deepEqual(samplePassengerPath(seatPath, 1).position, [-0.66, 0.36, 0.77]);

  const bayPath = buildPassengerPath({ type: 'WHEELCHAIR_BAY', id: 'WHEELCHAIR_BAY' });
  assert.ok(bayPath);
  assert.deepEqual(samplePassengerPath(bayPath, 1).position, [-1.55, 0.36, -0.54]);
  assert.equal(buildPassengerPath({ type: 'SEAT', id: 'F01' }), null);
  assert.ok(journeyStageTarget('boarding') < journeyStageTarget('navigating'));
  assert.equal(journeyStageTarget('secured'), 1);
});

test('equipment telemetry accepts stroller parking before every supported aisle-side seat, with old frames unchanged', () => {
  const base = { journeyId: 'stroller-1', aid: 'stroller', stage: 'navigating', progress: 0.5,
    destination: { type: 'SEAT', id: 'S02' } };
  const equipmentDestination = { type: 'WHEELCHAIR_BAY', id: 'WHEELCHAIR_BAY' };
  const valid = { ...base, equipmentDestination };
  assert.deepEqual(normalizePassengerJourney(valid), valid);
  for (const id of ['S02', 'S03', 'S05', 'S06', 'S08', 'S09']) {
    assert.deepEqual(normalizePassengerJourney({ ...valid, destination: { type: 'SEAT', id } }),
      { ...valid, destination: { type: 'SEAT', id } });
  }
  assert.deepEqual(normalizePassengerJourney(base), base, 'old frames must not invent equipment parking');
  assert.deepEqual(normalizePassengerJourney({ ...base, equipmentDestination: null }), { ...base, equipmentDestination: null });
  for (const invalid of [
    { ...valid, aid: 'wheelchair' }, { ...valid, aid: 'cane' },
    ...['S01', 'S04', 'S07', 'S10', 'S16', 'F01', 'S99'].map(id => ({ ...valid, destination: { type: 'SEAT', id } })),
    { ...valid, destination: { type: 'WHEELCHAIR_BAY', id: 'WHEELCHAIR_BAY' } },
    { ...base, equipmentDestination: { type: 'SEAT', id: 'S03' } },
    { ...base, equipmentDestination: { type: 'WHEELCHAIR_BAY', id: 'S03' } },
    { ...base, equipmentDestination: [] }, { ...base, equipmentDestination: 'WHEELCHAIR_BAY' },
  ]) assert.equal(normalizePassengerJourney(invalid), undefined);
  const store = createVehicleStore();
  store.setVehicleState(normalizeTelemetry({ passengerJourney: valid }));
  equipmentDestination.id = 'mutated';
  assert.equal(store.getState().passengerJourney?.equipmentDestination?.id, 'WHEELCHAIR_BAY');
  store.setVehicleState(normalizeTelemetry({ door: 'open' }));
  assert.equal(store.getState().passengerJourney?.equipmentDestination?.id, 'WHEELCHAIR_BAY');
  store.setVehicleState(normalizeTelemetry({ passengerJourney: { ...base, equipmentDestination: null } }));
  assert.equal(store.getState().passengerJourney?.equipmentDestination, null);
});

test('stroller via-bay paths park at the true centre before the person continues to any supported near or farther seat', () => {
  const equipment = { type: 'WHEELCHAIR_BAY', id: 'WHEELCHAIR_BAY' } as const;
  const expectedParkingProgress = { S02: 0.6598212848252332, S03: 0.6598212848252332,
    S05: 0.573402583610456, S06: 0.573402583610456, S08: 0.5069994057108516, S09: 0.5069994057108516 };
  for (const id of ['S02', 'S03', 'S05', 'S06', 'S08', 'S09'] as const) {
    const plan = buildStrollerJourneyPath({ type: 'SEAT', id }, equipment)!;
    assert.ok(plan);
    assert.equal(plan.path.length, 9);
    assert.ok(plan.parkingProgress > 0.5 && plan.parkingProgress < 0.67);
    assert.ok(Math.abs(plan.parkingProgress - expectedParkingProgress[id]) < 1e-9);
    const seat = SEATS.find(candidate => candidate.id === id)!;
    assert.equal(seat.zone, 'low-floor');
    assert.deepEqual(plan.path[plan.path.length - 2], [seat.position[0], CABIN.floorY, 0.24]);
    assert.deepEqual(plan.parkingPoint.slice(0, 2), [CABIN.wheelchairBay.x, CABIN.floorY]);
    assert.ok(Math.abs(plan.parkingPoint[2] - 0.08) < 1e-9);
    assert.equal(plan.parkingPoint[2] - STROLLER_FORWARD_OFFSET, CABIN.wheelchairBay.z);
    const before = sampleStrollerJourney(plan, plan.parkingProgress - 0.00001);
    assert.equal(before.equipmentParked, false);
    assert.ok(Math.abs(Math.hypot(before.equipment.position[0] - before.passenger.position[0],
      before.equipment.position[2] - before.passenger.position[2]) - STROLLER_FORWARD_OFFSET) < 1e-9);
    const parked = sampleStrollerJourney(plan, plan.parkingProgress);
    assert.equal(parked.equipmentParked, true);
    assert.deepEqual(parked.passenger.position, plan.parkingPoint);
    assert.deepEqual(parked.passenger.tangent, [0, 0, -1]);
    assert.deepEqual(parked.equipment, { position: [CABIN.wheelchairBay.x, CABIN.floorY, CABIN.wheelchairBay.z], tangent: [0, 0, -1] });
    assert.ok(Math.hypot(...before.equipment.position.map((value, axis) => value - parked.equipment.position[axis])) < 0.001);
    const final = sampleStrollerJourney(plan, 1);
    assert.deepEqual(final.passenger.position, seat.position);
    assert.deepEqual(final.equipment, parked.equipment, 'the stroller must not follow the passenger to the seat');
    const after = sampleStrollerJourney(plan, plan.parkingProgress + 0.01);
    assert.ok(after.passenger.position[2] > plan.parkingPoint[2], 'the passenger returns toward the aisle after releasing the stroller');
    assert.deepEqual(after.equipment, parked.equipment);
  }
  assert.equal(buildStrollerJourneyPath({ type: 'SEAT', id: 'S03' }), null);
  assert.equal(buildStrollerJourneyPath({ type: 'SEAT', id: 'S03' }, null), null);
  for (const id of ['S01', 'S04', 'S07', 'S10', 'S16'] as const) assert.equal(buildStrollerJourneyPath({ type: 'SEAT', id }, equipment), null);
  assert.equal(buildStrollerJourneyPath(equipment, equipment), null);
});

test('seat hand-off hides only the person, keeps separately parked equipment, and never splits a wheelchair passenger', () => {
  const seat = { type: 'SEAT', id: 'S03' } as const;
  const bay = { type: 'WHEELCHAIR_BAY', id: 'WHEELCHAIR_BAY' } as const;
  assert.deepEqual(journeyVisibility('navigating', seat, true), { passenger: true, equipment: true });
  assert.deepEqual(journeyVisibility('seated', seat, true), { passenger: false, equipment: true });
  assert.deepEqual(journeyVisibility('hidden', seat, true), { passenger: false, equipment: false });
  assert.deepEqual(journeyVisibility('seated', seat, false), { passenger: false, equipment: false });
  assert.deepEqual(journeyVisibility('seated', bay, false), { passenger: true, equipment: false });
  assert.deepEqual(samplePassengerPath(buildPassengerPath(bay)!, 1).position,
    [CABIN.wheelchairBay.x, CABIN.floorY, CABIN.wheelchairBay.z]);
});
