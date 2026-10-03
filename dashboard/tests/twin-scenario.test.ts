import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildScenario, boardingScenario, cabinSeatOccupancy, frameAtElapsed, playScenario, strollerPathMilestones, ARRIVAL_MS, DOCK_MS, BOARDING_MS, STROLLER_BOARDING_MS } from '../app/lib/twinScenario.ts';
import type { Context, Journey, Result } from '../app/live-types.ts';
import { CABIN, SEATS } from '../../twin/src/data/cabinLayout.ts';
import { BUS, DOOR_CENTER_X } from '../../twin/src/components/BusDigitalTwin/dimensions.ts';

const context = (need = 'CANE'): Context => ({ request_id: 'test', request: { active: true, intent: 'BOARDING', accessibility_need: need },
  vehicle_context: { single_entrance_state: 'OPEN', cabin: { layout_id: 'byd-b70a02-photo-v1', occupied_seat_ids: ['S01', 'S04', 'S03'], wheelchair_bay_occupied: false } } });
const result = (wheelchair = false): Result => ({ request_id: 'run-1', plan_status: 'READY', simulated: true, execution_authorized: false,
  boarding_target: wheelchair ? { type: 'WHEELCHAIR_BAY', id: 'WHEELCHAIR_BAY' } : { type: 'SEAT', id: 'S03' },
  decision_summary: ['Plan prepared.'], safety_flags: [],
  action_plan: (wheelchair ? ['PREPARE_WHEELCHAIR_AREA', 'OPEN_SINGLE_ENTRANCE', 'DEPLOY_AUTOMATIC_SHORT_RAMP', 'GUIDE_PASSENGER_TO_ASSIGNED_PLACE', 'WAIT_FOR_SEATED_AND_BELTED_CONFIRMATION']
    : ['OPEN_SINGLE_ENTRANCE', 'KEEP_RAMPS_STOWED', 'GUIDE_PASSENGER_TO_ASSIGNED_PLACE', 'WAIT_FOR_SEATED_AND_BELTED_CONFIRMATION']).map((action, index) => ({ step: index + 1, action, parameters: {} })),
  passenger_communication: { channel: 'DISPLAY', language: 'en-SG', audio_text: null, display_text: 'Please wait for the operator.' },
  meta: { mode: 'rules', source: 'rules', api_calls: 0, model: null, latency_ms: 0, validation_passed: true, usage: {} } });
const journey = (stage: Journey['stage'], wheelchair = false): Journey => ({ journey_id: 'booking-1', stage, matched: true, need: wheelchair ? 'WHEELCHAIR' : 'CANE',
  boarding_target: result(wheelchair).boarding_target, seat: wheelchair ? 'WHEELCHAIR_BAY' : 'S03',
  animation: stage === 'AT_STOP' || stage === 'ON_BOARD' ? { id: 'animation-1', phase: stage === 'AT_STOP' ? 'arrival' : 'boarding', aid: wheelchair ? 'wheelchair' : 'cane',
    started_at: 1000, duration_ms: stage === 'AT_STOP' ? ARRIVAL_MS : BOARDING_MS, target: result(wheelchair).boarding_target! } : null,
  guidance: { title: 'Passenger guidance', display_text: 'Please wait.', audio_text: 'Please wait.' } });
const actuates = (steps: ReturnType<typeof buildScenario>) => steps.some(step => step.frame.arrival || step.frame.kneeling === true ||
  ['opening', 'open'].includes(step.frame.door ?? '') || ['extending', 'extended'].includes(step.frame.ramp ?? ''));
const strollerResult = (seat = 'S03'): Result => ({ ...result(), boarding_target: { type: 'SEAT', id: seat },
  equipment_target: { type: 'WHEELCHAIR_BAY', id: 'WHEELCHAIR_BAY' } });
const strollerJourney = (stage: 'AT_STOP' | 'ON_BOARD', seat = 'S03'): Journey => ({ ...journey(stage), need: 'STROLLER',
  boarding_target: strollerResult(seat).boarding_target, equipment_target: strollerResult(seat).equipment_target, seat,
  animation: { ...journey(stage).animation!, aid: 'stroller', target: strollerResult(seat).boarding_target!,
    equipment_target: strollerResult(seat).equipment_target, duration_ms: stage === 'AT_STOP' ? ARRIVAL_MS : STROLLER_BOARDING_MS } });

test('live animation requires an active booking, matching arrival and READY plan', () => {
  const ready = result();
  const c = context();
  for (const j of [journey('BOOKED'), journey('IDLE'), { ...journey('AT_STOP'), matched: false }, { ...journey('AT_STOP'), animation: null }]) {
    assert.equal(actuates(buildScenario(ready, c, false, j)), false);
  }
  assert.equal(actuates(buildScenario(ready, { ...c, request: { ...c.request, active: false } }, false, journey('AT_STOP'))), false);
  assert.equal(actuates(buildScenario({ ...ready, plan_status: 'NEEDS_CONFIRMATION' }, c, false, journey('AT_STOP'))), false);
  assert.equal(actuates(buildScenario(ready, c, true, journey('AT_STOP'))), false);
  assert.equal(actuates(buildScenario(ready, c, false, journey('AT_STOP'))), true);
});

test('YOLO-only detections show the highest-confidence aid waiting without vehicle actuation', () => {
  const c = { ...context(), request: { active: false }, perception: { yolo_detections: [
    { label: 'WHEELCHAIR', confidence: 0.6 }, { label: 'STROLLER', confidence: 0.85 }, { label: 'CANE', confidence: 0.95 },
  ] } };
  const j = { ...journey('IDLE'), need: null };
  const steps = buildScenario(result(), c, false, j);
  assert.equal(steps[0].frame.passengerJourney?.aid, 'cane');
  assert.equal(steps[0].frame.passengerJourney?.stage, 'waiting');
  assert.equal(steps[0].frame.passengerJourney?.progress, 0);
  assert.equal(actuates(steps), false);
});

test('the bus approaches before any door, kneeling or ramp action; boarding readiness is at ten seconds', () => {
  const steps = buildScenario(result(true), context('WHEELCHAIR'), false, journey('AT_STOP', true));
  assert.deepEqual(steps[0].frame.arrival, { id: 'animation-1', progress: 0 });
  assert.equal(steps[1].at, 50);
  assert.equal(steps[1].frame.arrival?.progress, 1);
  for (const step of steps.filter(item => item.at < DOCK_MS)) {
    assert.notEqual(step.frame.kneeling, true);
    assert.notEqual(step.frame.door, 'opening');
    assert.notEqual(step.frame.ramp, 'extending');
  }
  assert.equal(steps.find(step => step.frame.boardingStatus === 'ready')?.at, ARRIVAL_MS);
  assert.equal(steps[0].frame.passengerJourney?.stage, 'waiting');
  assert.equal(steps[0].frame.passengerJourney?.progress, 0);
});

test('seat preview traverses the path before adding the assigned occupant and stops for operator confirmation', () => {
  const steps = boardingScenario(result(), context(), journey('ON_BOARD'));
  assert.equal(cabinSeatOccupancy(context(), result().boarding_target)?.S03, false);
  assert.equal(steps[0].frame.seatOccupancy?.S03, false);
  assert.deepEqual(steps.filter(step => step.frame.passengerJourney).map(step => [step.at, step.frame.passengerJourney!.stage, step.frame.passengerJourney!.progress]),
    [[0, 'boarding', 0], [50, 'boarding', 0.36], [4500, 'navigating', 0.70], [8500, 'navigating', 1], [12000, 'seated', 1]]);
  assert.equal(steps.find(step => step.frame.seatOccupancy?.S03)?.at, 12000);
  assert.equal(steps.at(-1)?.at, BOARDING_MS);
  assert.equal(steps.at(-1)?.frame.boardingStatus, 'boarding');
  assert.ok(steps.every(step => !['closing', 'closed'].includes(step.frame.door ?? '') && !['retracting'].includes(step.frame.ramp ?? '')));
  assert.ok(steps.every(step => step.frame.boardingStatus !== 'complete'));
});

test('wheelchair preview targets the bay, keeps its actor visible and never declares securement', () => {
  const steps = boardingScenario(result(true), context('WHEELCHAIR'), journey('ON_BOARD', true));
  const parked = steps.find(step => step.at === 12000)!;
  assert.equal(parked.frame.passengerJourney?.stage, 'seated');
  assert.deepEqual(parked.frame.passengerJourney?.destination, { type: 'WHEELCHAIR_BAY', id: 'WHEELCHAIR_BAY' });
  assert.equal(parked.frame.seatOccupancy, undefined);
  assert.ok(!steps.some(step => step.frame.passengerJourney?.stage === 'secured'));
  assert.ok(steps.every(step => !/ready to depart|securement is confirmed|wheelchair secured/i.test(step.frame.passengerInfo?.message ?? '')));
  assert.equal(steps[0].frame.ramp, 'extended');
  assert.ok(steps.filter(step => step.frame.passengerJourney).every(step => step.frame.passengerJourney?.equipmentDestination === null));
});

test('stroller milestones match all supported twin seat geometries, including the separate handle parking point', () => {
  const source = readFileSync(new URL('../../twin/src/simulation/passengerPath.ts', import.meta.url), 'utf8');
  const aisle = Number(source.match(/const AISLE_Z\s*=\s*([\d.]+)\s*;/)?.[1]);
  const offset = Number(source.match(/STROLLER_FORWARD_OFFSET\s*=\s*([\d.]+)\s*;/)?.[1]);
  assert.ok(Number.isFinite(aisle) && Number.isFinite(offset));
  const length = (path: number[][]) => path.slice(1).reduce((sum, point, index) =>
    sum + Math.hypot(...point.map((value, axis) => value - path[index][axis])), 0);
  for (const id of ['S02', 'S03', 'S05', 'S06', 'S08', 'S09']) {
    const seat = SEATS.find(item => item.id === id)!;
    const approach = [
      [DOOR_CENTER_X, 0.025, BUS.sideZ + BUS.ramp.length + 0.66], [DOOR_CENTER_X, 0.04, BUS.sideZ + BUS.ramp.length + 0.04],
      [DOOR_CENTER_X, CABIN.floorY, BUS.sideZ - 0.03], [DOOR_CENTER_X, CABIN.floorY, aisle],
      [CABIN.wheelchairBay.x, CABIN.floorY, aisle], [CABIN.wheelchairBay.x, CABIN.floorY, CABIN.wheelchairBay.z + offset],
    ];
    const full = [...approach, [CABIN.wheelchairBay.x, CABIN.floorY, aisle], [seat.position[0], CABIN.floorY, aisle], seat.position];
    const milestones = strollerPathMilestones({ type: 'SEAT', id })!;
    assert.ok(Math.abs(milestones.parkingProgress - length(approach) / length(full)) < 1e-12);
    assert.ok(Math.abs(milestones.entranceProgress - length(approach.slice(0, 3)) / length(full)) < 1e-12);
  }
  assert.ok(strollerPathMilestones({ type: 'SEAT', id: 'S03' })!.parkingProgress > strollerPathMilestones({ type: 'SEAT', id: 'S06' })!.parkingProgress);
  assert.ok(strollerPathMilestones({ type: 'SEAT', id: 'S06' })!.parkingProgress > strollerPathMilestones({ type: 'SEAT', id: 'S09' })!.parkingProgress);
  for (const id of ['S01', 'S04', 'S07', 'S10', 'S16', 'F01', 'S17', 'toString']) assert.equal(strollerPathMilestones({ type: 'SEAT', id }), null);
  assert.equal(strollerPathMilestones({ type: 'WHEELCHAIR_BAY', id: 'WHEELCHAIR_BAY' }), null);
});

test('stroller preview parks equipment, pauses visibly, then walks to its validated low-floor seat before seat hand-off', () => {
  for (const id of ['S02', 'S03', 'S05', 'S06', 'S08', 'S09']) {
    const prepared = strollerResult(id), j = strollerJourney('ON_BOARD', id), c = context('STROLLER');
    const steps = boardingScenario(prepared, c, j);
    const progress = strollerPathMilestones(prepared.boarding_target!)!;
    assert.deepEqual(steps.filter(step => step.frame.passengerJourney).map(step => [step.at, step.frame.passengerJourney!.stage, step.frame.passengerJourney!.progress]),
      [[0, 'boarding', 0], [50, 'boarding', progress.entranceProgress], [4500, 'navigating', progress.parkingProgress],
        [8000, 'navigating', progress.parkingProgress], [11000, 'navigating', 1], [19000, 'seated', 1]]);
    for (const step of steps.filter(step => step.frame.passengerJourney)) {
      assert.deepEqual(step.frame.passengerJourney!.destination, prepared.boarding_target);
      assert.deepEqual(step.frame.passengerJourney!.equipmentDestination, prepared.equipment_target);
    }
    for (const elapsed of [8000, 10000]) {
      const restored = frameAtElapsed(steps, elapsed)!;
      assert.equal(restored.frame.passengerJourney!.progress, progress.parkingProgress);
      assert.equal(restored.frame.passengerJourney!.stage, 'navigating');
      assert.equal(restored.frame.seatOccupancy?.[id], false);
      assert.equal(restored.targets.passengerJourney, undefined);
    }
    const walking = frameAtElapsed(steps, 12000)!;
    assert.ok(walking.frame.passengerJourney!.progress! > progress.parkingProgress && walking.frame.passengerJourney!.progress! < 1);
    assert.equal(walking.frame.seatOccupancy?.[id], false);
    const seated = frameAtElapsed(steps, 20000)!;
    assert.equal(seated.frame.passengerJourney?.stage, 'seated');
    assert.equal(seated.frame.seatOccupancy?.[id], true);
    assert.deepEqual(seated.frame.passengerJourney?.equipmentDestination, prepared.equipment_target);
    assert.equal(steps.find(step => step.frame.seatOccupancy?.[id] === true)?.at, 19000);
    assert.equal(steps.at(-1)?.at, STROLLER_BOARDING_MS);
    // The rearward 'interior' camera cannot see the front bay: parking and seating stay in one cutaway shot.
    assert.deepEqual(steps.filter(step => step.camera).map(step => [step.at, step.camera]), [[0, 'entrance'], [4500, 'cutaway']]);
    assert.equal(steps[0].frame.ramp, 'retracted');
    assert.ok(steps.every(step => step.frame.boardingStatus !== 'complete' && step.frame.passengerJourney?.stage !== 'secured'));
    assert.ok(steps.every(step => !['closing', 'closed'].includes(step.frame.door ?? '') && !['retracting'].includes(step.frame.ramp ?? '')));
    assert.equal(actuates(buildScenario(prepared, c, false, strollerJourney('AT_STOP', id))), true);
    const messages = steps.map(step => `${step.label} ${step.frame.passengerInfo?.title ?? ''} ${step.frame.passengerInfo?.message ?? ''}`).join(' ');
    if (!['S02', 'S03'].includes(id)) assert.doesNotMatch(messages, /nearby|close to|short highlighted/i);
    else assert.match(messages, /nearby/i);
  }
});

test('a stroller without a validated bay and supported seat remains stationary, including old READY results', () => {
  const invalid = [
    { ...strollerResult(), equipment_target: null }, { ...strollerResult(), equipment_target: undefined },
    ...['S01', 'S04', 'S07', 'S10', 'S16', 'F01', 'S17', 'toString'].map(id => strollerResult(id)), { ...strollerResult(), boarding_target: null },
    { ...strollerResult(), equipment_target: { type: 'SEAT', id: 'S02' } },
    { ...strollerResult(), equipment_target: { type: 'WHEELCHAIR_BAY', id: 'OTHER' } },
  ] as Result[];
  for (const prepared of invalid) {
    const c = context('STROLLER');
    const steps = buildScenario(prepared, c, false, null);
    assert.equal(actuates(steps), false);
    assert.ok(steps.every(step => !['boarding', 'navigating', 'seated'].includes(step.frame.passengerJourney?.stage ?? '')));
    const j: Journey = { ...strollerJourney('AT_STOP'), boarding_target: prepared.boarding_target, equipment_target: prepared.equipment_target,
      animation: { ...strollerJourney('AT_STOP').animation!, target: prepared.boarding_target ?? null, equipment_target: prepared.equipment_target } };
    assert.equal(actuates(buildScenario(prepared, c, false, j)), false);
  }
});

test('presets run the complete preview without CV; missing validated targets never invent a seat', () => {
  const steps = buildScenario(result(), context(), false, null);
  assert.equal(steps.find(step => step.frame.passengerJourney?.stage === 'boarding')?.at, ARRIVAL_MS);
  assert.equal(steps.find(step => step.frame.passengerJourney?.stage === 'seated')?.at, ARRIVAL_MS + 12000);
  const missing = boardingScenario({ ...result(), boarding_target: null }, context());
  assert.equal(missing.some(step => step.frame.passengerJourney?.stage === 'boarding'), false);
  assert.equal(missing.some(step => step.frame.seatOccupancy?.S03), false);
});

test('manual "Preview boarding" (TwinPanel) plays the booked boarding guidance before any camera exit', () => {
  // TwinPanel passes the live journey without its hub animation; nothing here touches hub state.
  const booked = { ...journey('BOOKED', true), animation: null };
  assert.equal(actuates(buildScenario(result(true), context('WHEELCHAIR'), false, booked)), false, 'automatic path still waits');
  const steps = boardingScenario(result(true), context('WHEELCHAIR'), booked);
  assert.equal(steps[0].frame.passengerJourney?.aid, 'wheelchair');
  assert.deepEqual(steps.find(step => step.at === 12000)?.frame.passengerJourney?.destination, { type: 'WHEELCHAIR_BAY', id: 'WHEELCHAIR_BAY' });
  assert.equal(steps[0].frame.passengerJourney?.journeyId, 'run-1:boarding');
});

test('elapsed restoration restores partial motion, cumulative cabin state and the latest camera', () => {
  const steps = buildScenario(result(true), context('WHEELCHAIR'), false, journey('AT_STOP', true));
  const arriving = frameAtElapsed(steps, 2150)!;
  assert.ok(Math.abs(arriving.frame.arrival!.progress - 0.5) < 1e-9);
  assert.equal(arriving.targets.arrival?.progress, 1);
  assert.equal(arriving.step.camera, 'overview');
  const boarding = boardingScenario(result(), context(), journey('ON_BOARD'));
  const walking = frameAtElapsed(boarding, 2050)!;
  assert.ok(Math.abs(walking.frame.passengerJourney!.progress! - 0.24) < 1e-9);
  assert.equal(walking.frame.passengerJourney?.stage, 'navigating');
  assert.equal(walking.step.camera, 'entrance');
  const seated = frameAtElapsed(boarding, 15000)!;
  assert.equal(seated.frame.passengerJourney?.stage, 'seated');
  assert.equal(seated.frame.seatOccupancy?.S03, true);
  assert.equal(seated.frame.door, 'open');
  assert.equal(seated.step.camera, 'cutaway');
});

test('playback resumes remaining steps and cancellation clears all queued work; Replay starts at zero', () => {
  let nextId = 0;
  const timers = new Map<number, { run: () => void; delay: number }>();
  globalThis.window = { setTimeout: (run: () => void, delay: number) => { const id = ++nextId; timers.set(id, { run, delay }); return id; },
    clearTimeout: (id: number) => { timers.delete(id); } } as unknown as Window & typeof globalThis;
  const steps = boardingScenario(result(), context(), journey('ON_BOARD'));
  const sent: { frame: Parameters<Parameters<typeof playScenario>[1]>[0]; step: typeof steps[number] }[] = [];
  const stop = playScenario(steps, (frame, step) => sent.push({ frame, step }), 5000);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].step.at, 4500);
  assert.ok([...timers.values()].some(timer => timer.delay === 3500));
  assert.ok(![...timers.values()].some(timer => timer.delay === 4500));
  stop();
  assert.equal(timers.size, 0);
  const replay = playScenario(steps, (frame, step) => sent.push({ frame, step }), 0);
  assert.ok([...timers.values()].some(timer => timer.delay === 0));
  [...timers.values()].find(timer => timer.delay === 0)!.run();
  assert.equal(sent.at(-1)?.frame.passengerJourney?.progress, 0);
  replay();
  assert.equal(timers.size, 0);
});

test('stroller reconnect preserves the parked cart; cancellation stops late seating and Replay restores both actors', () => {
  let nextId = 0;
  const timers = new Map<number, { run: () => void; delay: number }>();
  globalThis.window = { setTimeout: (run: () => void, delay: number) => { const id = ++nextId; timers.set(id, { run, delay }); return id; },
    clearTimeout: (id: number) => { timers.delete(id); } } as unknown as Window & typeof globalThis;
  const prepared = strollerResult(), steps = boardingScenario(prepared, context('STROLLER'), strollerJourney('ON_BOARD'));
  const sent: { frame: Parameters<Parameters<typeof playScenario>[1]>[0]; step: typeof steps[number] }[] = [];
  const stop = playScenario(steps, (frame, step) => sent.push({ frame, step }), 10000);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].frame.passengerJourney?.progress, strollerPathMilestones(prepared.boarding_target!)!.parkingProgress);
  assert.deepEqual(sent[0].frame.passengerJourney?.equipmentDestination, prepared.equipment_target);
  assert.equal(sent[0].frame.seatOccupancy?.S03, false);
  assert.deepEqual([...timers.values()].map(item => item.delay), [1000, 5000, 9000, 12000]);
  stop();
  assert.equal(timers.size, 0);
  const replay = playScenario(steps, (frame, step) => sent.push({ frame, step }), 0);
  [...timers.values()].find(timer => timer.delay === 0)!.run();
  assert.equal(sent.at(-1)?.frame.passengerJourney?.progress, 0);
  assert.equal(sent.at(-1)?.frame.seatOccupancy?.S03, false);
  assert.deepEqual(sent.at(-1)?.frame.passengerJourney?.equipmentDestination, prepared.equipment_target);
  replay();
  assert.equal(timers.size, 0);
});

test('a later passenger of the same bus (hub arrival of 3000 ms) starts docked: no drive-in, entrance first', () => {
  const docked = (wheelchair: boolean, duration_ms: number): Journey => {
    const j = journey('AT_STOP', wheelchair);
    return { ...j, animation: { ...j.animation!, duration_ms } };
  };
  const at = (steps: ReturnType<typeof buildScenario>, pick: (frame: (typeof steps)[number]['frame']) => boolean) => steps.find(step => pick(step.frame))?.at;
  let steps = buildScenario(result(true), context('WHEELCHAIR'), false, docked(true, 3000));
  assert.equal(steps[0].at, 0);
  assert.deepEqual(steps[0].frame.arrival, { id: 'animation-1', progress: 1 });
  assert.ok(steps.every(step => !step.frame.arrival || step.frame.arrival.progress === 1), 'the bus never drives in');
  // The docked bus keeps its entrance open: the door never closes and reopens between passengers.
  assert.equal(steps[0].frame.door, 'open');
  assert.ok(steps.every(step => !['closed', 'closing', 'opening'].includes(step.frame.door ?? 'open')));
  assert.equal(at(steps, frame => frame.ramp === 'extended'), 4100);
  assert.equal(at(steps, frame => frame.boardingStatus === 'ready'), 4100, 'never ready before the ramp');
  steps = buildScenario(result(false), context('CANE'), false, docked(false, 3000));
  assert.equal(at(steps, frame => frame.boardingStatus === 'ready'), 3000);
  // A stroller on the docked bus: the waiting actor already carries its parking bay; ready after the 3 s.
  const strollerDocked = strollerJourney('AT_STOP');
  steps = buildScenario(strollerResult(), context('STROLLER'), false, { ...strollerDocked, animation: { ...strollerDocked.animation!, duration_ms: 3000, docked: true } });
  assert.deepEqual(steps[0].frame.passengerJourney?.equipmentDestination, strollerResult().equipment_target);
  assert.equal(steps[0].frame.door, 'open');
  assert.equal(at(steps, frame => frame.boardingStatus === 'ready'), 3000);
  // The first passenger of a bus keeps the full drive-in.
  steps = buildScenario(result(true), context('WHEELCHAIR'), false, docked(true, ARRIVAL_MS));
  assert.equal(steps[0].frame.arrival?.progress, 0);
  assert.equal(at(steps, frame => frame.boardingStatus === 'ready'), ARRIVAL_MS);
});
