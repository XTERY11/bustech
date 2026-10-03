import test from 'node:test';
import assert from 'node:assert/strict';
import { SEATS, createSeatOccupancy, getCabinSnapshot } from '../src/data/cabinLayout';
import { createVehicleStore } from '../src/state/vehicleState';
import { connectTelemetry, normalizePassengerJourney, normalizeTelemetry } from '../src/adapters/telemetryAdapter';
import { MockBusSimulator } from '../src/simulation/mockBus';
import { buildPassengerPath, journeyStageTarget, samplePassengerPath } from '../src/simulation/passengerPath';

globalThis.window = globalThis as unknown as Window & typeof globalThis;

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
