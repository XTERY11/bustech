import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CABIN_ROUTE_GEOMETRY, cabinRouteFor } from '../backend/planner/cabinRoute.mjs';
import { CABIN, SEATS } from '../../twin/src/data/cabinLayout.ts';
import { BUS, DOOR_CENTER_X } from '../../twin/src/components/BusDigitalTwin/dimensions.ts';

const safeIds = ['S02', 'S03', 'S05', 'S06', 'S08', 'S09'];
const close = (actual: number, expected: number, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);

test('route map stays aligned with the twin interior entrance, aisle, safe seats and wheelchair bay', () => {
  close(CABIN_ROUTE_GEOMETRY.entrance[0], DOOR_CENTER_X);
  close(CABIN_ROUTE_GEOMETRY.entrance[1], BUS.sideZ - 0.03);
  close(CABIN_ROUTE_GEOMETRY.wheelchair_bay[0], CABIN.wheelchairBay.x);
  close(CABIN_ROUTE_GEOMETRY.wheelchair_bay[1], CABIN.wheelchairBay.z);
  assert.deepEqual(Object.keys(CABIN_ROUTE_GEOMETRY.seats).sort(), safeIds);
  for (const id of safeIds) {
    const seat = SEATS.find(candidate => candidate.id === id)!;
    assert.equal(seat.zone, 'low-floor');
    close(CABIN_ROUTE_GEOMETRY.seats[id][0], seat.position[0]);
    close(CABIN_ROUTE_GEOMETRY.seats[id][1], seat.position[2]);
  }
  // passengerPath's imports intentionally target the browser bundler. Read the
  // single aisle constant rather than rewriting those production import paths.
  const passengerPath = readFileSync(new URL('../../twin/src/simulation/passengerPath.ts', import.meta.url), 'utf8');
  const aisle = passengerPath.match(/const AISLE_Z\s*=\s*([\d.]+)\s*;/);
  assert.ok(aisle, 'the twin must expose a recognisable aisle centreline');
  close(CABIN_ROUTE_GEOMETRY.aisle_z, Number(aisle[1]));
});

test('S03 guidance starts inside the entrance and follows the right-turn path, without adding the outside ramp', () => {
  const route = cabinRouteFor({ type: 'SEAT', id: 'S03' })!;
  assert.deepEqual(route.origin, { type: 'ENTRANCE', id: 'SINGLE_ENTRANCE', facing: 'INTO_BUS' });
  assert.equal(route.layout_id, 'byd-b70a02-photo-v1');
  assert.deepEqual(route.steps.map(({ maneuver, distance_m }) => [maneuver, distance_m]),
    [['START', null], ['STRAIGHT', 0.9], ['TURN_RIGHT', null], ['STRAIGHT', 0.7], ['TURN_RIGHT', null], ['STRAIGHT', 0.5], ['ARRIVE', null]]);
  close(route.steps[1].distance_m, Math.round((BUS.sideZ - 0.03 - CABIN_ROUTE_GEOMETRY.aisle_z) * 10) / 10);
});

test('seat-side turns mirror each other and wheelchair-bay guidance uses the opposite aisle direction', () => {
  for (const [leftSeat, rightSeat] of [['S02', 'S03'], ['S05', 'S06'], ['S08', 'S09']]) {
    const left = cabinRouteFor({ type: 'SEAT', id: leftSeat })!;
    const right = cabinRouteFor({ type: 'SEAT', id: rightSeat })!;
    assert.deepEqual(left.steps.filter(step => step.maneuver.startsWith('TURN')).map(step => step.maneuver), ['TURN_RIGHT', 'TURN_LEFT']);
    assert.deepEqual(right.steps.filter(step => step.maneuver.startsWith('TURN')).map(step => step.maneuver), ['TURN_RIGHT', 'TURN_RIGHT']);
    assert.equal(left.steps[3].distance_m, right.steps[3].distance_m);
  }
  const bay = cabinRouteFor({ type: 'WHEELCHAIR_BAY', id: 'WHEELCHAIR_BAY' })!;
  assert.deepEqual(bay.steps.map(({ maneuver, distance_m }) => [maneuver, distance_m]),
    [['START', null], ['STRAIGHT', 0.9], ['TURN_LEFT', null], ['STRAIGHT', 0.2], ['TURN_RIGHT', null], ['STRAIGHT', 0.8], ['ARRIVE', null]]);
});

test('every supported route has sequential turns and reaches the geometry target within its rounded-distance precision', () => {
  const targets = [...safeIds.map(id => ({ type: 'SEAT', id })), { type: 'WHEELCHAIR_BAY', id: 'WHEELCHAIR_BAY' }];
  for (const target of targets) {
    const route = cabinRouteFor(target)!;
    assert.ok(route);
    assert.deepEqual(route.steps.map(step => step.step), route.steps.map((_, index) => index + 1));
    assert.equal(route.steps[0].maneuver, 'START');
    assert.equal(route.steps.at(-1)?.maneuver, 'ARRIVE');
    let position = [...CABIN_ROUTE_GEOMETRY.entrance], heading = [0, -1];
    for (let index = 0; index < route.steps.length; index++) {
      const step = route.steps[index];
      if (step.maneuver === 'TURN_LEFT' || step.maneuver === 'TURN_RIGHT') {
        assert.equal(step.distance_m, null);
        assert.equal(route.steps[index - 1].maneuver, 'STRAIGHT');
        assert.equal(route.steps[index + 1].maneuver, 'STRAIGHT');
        heading = step.maneuver === 'TURN_RIGHT' ? [-heading[1], heading[0]] : [heading[1], -heading[0]];
      } else if (step.maneuver === 'STRAIGHT') {
        assert.ok(step.distance_m > 0);
        close(step.distance_m * 10, Math.round(step.distance_m * 10));
        position = position.map((value, axis) => value + heading[axis] * step.distance_m);
      } else assert.equal(step.distance_m, null);
    }
    const point = target.type === 'SEAT' ? CABIN_ROUTE_GEOMETRY.seats[target.id] : CABIN_ROUTE_GEOMETRY.wheelchair_bay;
    close(position[0], point[0], 0.051);
    close(position[1], point[1], 0.101);
  }
});

test('unsupported, rear, foldable and malformed targets fail closed; results never share mutable target objects', () => {
  for (const target of [null, undefined, [], 'S03', {}, { type: 'SEAT', id: 'S01' }, { type: 'SEAT', id: 'S04' },
    { type: 'SEAT', id: 'S07' }, { type: 'SEAT', id: 'S10' }, { type: 'SEAT', id: 'S16' }, { type: 'SEAT', id: 'F01' },
    { type: 'SEAT', id: 'WHEELCHAIR_BAY' }, { type: 'WHEELCHAIR_BAY', id: 'S03' }, { type: 'SEAT', id: 'toString' },
    { type: 'SEAT', id: ['S03'] }, { type: ['SEAT'], id: 'S03' }, { type: 'SEAT', id: 3 }]) {
    assert.equal(cabinRouteFor(target), null);
  }
  const target = { type: 'SEAT', id: 'S03' };
  const first = cabinRouteFor(target)!;
  first.target.id = 'S99';
  first.steps[1].distance_m = 999;
  assert.equal(target.id, 'S03');
  assert.equal(cabinRouteFor(target)?.target.id, 'S03');
  assert.equal(cabinRouteFor(target)?.steps[1].distance_m, 0.9);
});

test('stroller routes visit the handle parking point before turning around and walking alone to any verified low-floor seat', () => {
  const equipment = { type: 'WHEELCHAIR_BAY', id: 'WHEELCHAIR_BAY' };
  for (const id of safeIds) {
    const route = cabinRouteFor({ type: 'SEAT', id }, equipment)!;
    assert.equal(route.steps.length, 15);
    assert.deepEqual(route.equipment_target, equipment);
    assert.deepEqual(route.steps.map(step => step.step), Array.from({ length: 15 }, (_, index) => index + 1));
    assert.deepEqual(route.steps.map(({ maneuver, distance_m }) => [maneuver, distance_m]), [
      ['START', null], ['STRAIGHT', 0.9], ['TURN_LEFT', null], ['STRAIGHT', 0.2], ['TURN_RIGHT', null], ['STRAIGHT', 0.2],
      ['PARK_STROLLER', null], ['TURN_RIGHT', null], ['TURN_RIGHT', null], ['STRAIGHT', 0.2], ['TURN_LEFT', null],
      ['STRAIGHT', Math.round((CABIN_ROUTE_GEOMETRY.seats[id][0] - CABIN_ROUTE_GEOMETRY.stroller_passenger_stop[0]) * 10) / 10],
      [CABIN_ROUTE_GEOMETRY.seats[id][1] < CABIN_ROUTE_GEOMETRY.aisle_z ? 'TURN_LEFT' : 'TURN_RIGHT', null], ['STRAIGHT', 0.5], ['ARRIVE', null],
    ]);
    let position = [...CABIN_ROUTE_GEOMETRY.entrance], heading = [0, -1], parked = false;
    for (const step of route.steps) {
      if (step.maneuver === 'TURN_LEFT' || step.maneuver === 'TURN_RIGHT') {
        heading = step.maneuver === 'TURN_RIGHT' ? [-heading[1], heading[0]] : [heading[1], -heading[0]];
      } else if (step.maneuver === 'STRAIGHT') {
        position = position.map((value, axis) => value + heading[axis] * step.distance_m);
      } else if (step.maneuver === 'PARK_STROLLER') {
        parked = true;
        assert.deepEqual(heading.map(value => value || 0), [0, -1]);
        close(position[0], CABIN_ROUTE_GEOMETRY.stroller_passenger_stop[0], 0.051);
        close(position[1], CABIN_ROUTE_GEOMETRY.stroller_passenger_stop[1], 0.101);
        const strollerCenter = position.map((value, axis) => value + heading[axis] * CABIN_ROUTE_GEOMETRY.stroller_ahead_offset);
        close(strollerCenter[0], CABIN_ROUTE_GEOMETRY.wheelchair_bay[0], 0.051);
        close(strollerCenter[1], CABIN_ROUTE_GEOMETRY.wheelchair_bay[1], 0.101);
      }
    }
    assert.equal(parked, true);
    close(position[0], CABIN_ROUTE_GEOMETRY.seats[id][0], 0.051);
    close(position[1], CABIN_ROUTE_GEOMETRY.seats[id][1], 0.101);
  }
});

test('stroller handle stop and forward equipment offset exactly place the aid at the wheelchair-bay centre', () => {
  close(CABIN_ROUTE_GEOMETRY.stroller_passenger_stop[0], CABIN_ROUTE_GEOMETRY.wheelchair_bay[0]);
  close(CABIN_ROUTE_GEOMETRY.stroller_passenger_stop[1] - CABIN_ROUTE_GEOMETRY.stroller_ahead_offset, CABIN_ROUTE_GEOMETRY.wheelchair_bay[1]);
  const source = readFileSync(new URL('../../twin/src/simulation/passengerPath.ts', import.meta.url), 'utf8');
  const offset = source.match(/STROLLER_FORWARD_OFFSET\s*=\s*([\d.]+)\s*;/);
  assert.ok(offset, 'the twin must expose its stroller model offset');
  close(CABIN_ROUTE_GEOMETRY.stroller_ahead_offset, Number(offset[1]));
});

test('a separate parking target permits all six mapped clear-approach low-floor seats, but not window or raised seats, and is cloned defensively', () => {
  const bay = { type: 'WHEELCHAIR_BAY', id: 'WHEELCHAIR_BAY' };
  for (const equipment of [undefined, null]) assert.ok(!cabinRouteFor({ type: 'SEAT', id: 'S03' }, equipment)?.steps.some(step => step.maneuver === 'PARK_STROLLER'));
  for (const equipment of [[], 'WHEELCHAIR_BAY', {}, { type: 'SEAT', id: 'S02' }, { type: 'WHEELCHAIR_BAY', id: 'S03' }]) {
    assert.equal(cabinRouteFor({ type: 'SEAT', id: 'S03' }, equipment), null);
  }
  for (const target of [{ type: 'SEAT', id: 'S01' }, { type: 'SEAT', id: 'S04' }, { type: 'SEAT', id: 'S07' }, { type: 'SEAT', id: 'S10' }, { type: 'SEAT', id: 'F01' }, bay]) assert.equal(cabinRouteFor(target, bay), null);
  for (const id of safeIds) assert.equal(cabinRouteFor({ type: 'SEAT', id }, bay)?.steps[6].maneuver, 'PARK_STROLLER');
  const target = { type: 'SEAT', id: 'S03' }, route = cabinRouteFor(target, bay)!;
  route.equipment_target!.id = 'OTHER_BAY';
  route.steps[6].maneuver = 'ARRIVE';
  assert.equal(bay.id, 'WHEELCHAIR_BAY');
  assert.deepEqual(cabinRouteFor(target, bay)?.equipment_target, bay);
  assert.equal(cabinRouteFor(target, bay)?.steps[6].maneuver, 'PARK_STROLLER');
});
