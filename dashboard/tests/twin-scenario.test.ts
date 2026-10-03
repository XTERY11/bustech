import test from 'node:test';
import assert from 'node:assert/strict';
import { buildScenario, boardingScenario, cabinSeatOccupancy, frameAtElapsed, playScenario, ARRIVAL_MS, DOCK_MS, BOARDING_MS } from '../app/lib/twinScenario.ts';
import type { Context, Journey, Result } from '../app/live-types.ts';

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
