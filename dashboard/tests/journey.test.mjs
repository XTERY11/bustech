import test from 'node:test';
import assert from 'node:assert/strict';
import { advance, reconcile, matches, ARRIVAL_MS, STROLLER_BOARDING_MS } from '../backend/journey.mjs';
import { SignalHub, PRESENCE_MS, PRESENCE_LOST_MS, BOOKING_TTL_MS } from '../backend/hub.mjs';
import { plan } from '../backend/planner/agent.mjs';

const booking = (need = 'WHEELCHAIR') => ({ active: true, intent: 'BOARDING', route_id: 'DEMO_ROUTE', stop_id: 'DEMO_STOP', accessibility_need: need,
  ramp_preference: need === 'WHEELCHAIR' ? 'REQUESTED' : 'UNSPECIFIED', assistance_requested: need === 'WHEELCHAIR' ? ['WHEELCHAIR_RAMP'] : ['ADDITIONAL_BOARDING_TIME'], preferred_interaction: 'BOTH', language: 'en-SG' });
const enter = (label = 'WHEELCHAIR', visit = 'visit-1') => ({ yolo_detections: [{ label, confidence: 0.95 }], target_match_confirmed: true, zone: { triggered: true, roi_id: 'stop', event: 'enter', ...(visit ? { visit_id: visit } : {}) } });
const exit = (label = 'WHEELCHAIR', visit = 'visit-1') => ({ yolo_detections: [], target_match_confirmed: false, zone: { triggered: false, roi_id: 'stop', event: 'exit', left: [label], ...(visit ? { visit_id: visit } : {}) } });
const present = (label = 'WHEELCHAIR', visit = 'visit-1') => ({ ...enter(label, visit), zone: { ...enter(label, visit).zone, event: 'present' } });
const ready = { plan_status: 'READY', boarding_target: { type: 'WHEELCHAIR_BAY', id: 'WHEELCHAIR_BAY' } };

function harness(t, customPlanner) {
  let clock = Date.parse('2026-10-03T10:00:00Z'), sequence = 0, calls = 0;
  const modes = [], events = [];
  const hub = new SignalHub({ autoRun: false, now: () => clock, planner: async (c, o) => {
    calls++; modes.push(o.mode); return customPlanner ? customPlanner(c, o) : plan(c, { ...o, mode: 'rules' });
  } });
  t.after(() => hub.close()); hub.on('event', e => events.push(e));
  return { hub, modes, events, calls: () => calls, add: ms => { clock += ms; hub.tick(); },
    send: (channel, payload, eventId = `e-${++sequence}`) => hub.receive(channel, { event_id: eventId, observed_at: new Date(clock).toISOString(), payload }) };
}

test('exit is held until a validated target and bus arrival preparation are complete', () => {
  let j = advance({ stage: 'IDLE' }, 'booking', booking(), null, { eventId: 'b-1', now: 0 });
  j = advance(j, 'perception', enter(), null); j = advance(j, 'perception', exit(), null);
  assert.equal(j.pending_exit, true); assert.equal(j.stage, 'AT_STOP');
  j = reconcile(j, ready, 100);
  assert.equal(j.animation.phase, 'arrival');
  assert.equal(reconcile(j, ready, 100 + ARRIVAL_MS - 1).stage, 'AT_STOP');
  j = reconcile(j, ready, 100 + ARRIVAL_MS);
  assert.deepEqual([j.stage, j.seat, j.completed, j.animation.phase], ['ON_BOARD', 'WHEELCHAIR_BAY', true, 'boarding']);
  assert.equal(advance(j, 'perception', enter()), j, 'consumed booking cannot board again');
});

test('wrong category, low confidence, unconfirmed signal, wrong visit/ROI and non-exit do not board', () => {
  const b = advance({ stage: 'IDLE' }, 'booking', booking(), null, { eventId: 'b' });
  const wrong = advance(b, 'perception', enter('STROLLER'));
  assert.equal(wrong.matched, false); assert.equal(reconcile(wrong, ready).animation, null);
  for (const bad of [{ ...enter(), target_match_confirmed: false }, { ...enter(), yolo_detections: [{ label: 'WHEELCHAIR', confidence: 0.1 }] }]) {
    assert.equal(advance(b, 'perception', bad).matched, false);
  }
  const j = advance(b, 'perception', enter());
  assert.equal(advance(j, 'perception', exit('WHEELCHAIR', 'other')), j);
  assert.equal(advance(j, 'perception', { ...exit(), zone: { ...exit().zone, roi_id: 'other' } }), j);
  assert.equal(advance(j, 'perception', { yolo_detections: [], zone: { triggered: false } }).pending_exit, false);
  assert.equal(matches('HEARING_ASSISTANCE', []), false);
});

test('legacy enter/exit without a visit ID works, but cannot exit a visit-bound journey', () => {
  const b = advance({ stage: 'IDLE' }, 'booking', booking(), null, { eventId: 'b' });
  const legacy = advance(b, 'perception', enter('WHEELCHAIR', null));
  assert.equal(advance(legacy, 'perception', exit('WHEELCHAIR', null)).pending_exit, true);
  const bound = advance(b, 'perception', enter());
  assert.equal(advance(bound, 'perception', exit('WHEELCHAIR', null)), bound);
});

test('boarding intent: an exit judged not towards the bus waits for the passenger again', () => {
  const b = advance({ stage: 'IDLE' }, 'booking', booking(), null, { eventId: 'b' });
  const atStop = advance(b, 'perception', enter());
  const walkedOff = advance(atStop, 'perception', { ...exit(), zone: { ...exit().zone, boarding: false, dwell_seconds: 0.8 } });
  assert.deepEqual([walkedOff.stage, walkedOff.pending_exit, walkedOff.matched, walkedOff.visit_id, walkedOff.reason], ['BOOKED', false, false, null, 'not_boarding']);
  for (const boarding of [true, undefined]) {
    const zone = { ...exit().zone, dwell_seconds: 6.2, ...(boarding === undefined ? {} : { boarding }) };
    assert.equal(advance(atStop, 'perception', { ...exit(), zone }).pending_exit, true);
  }
  // After walking off, the same passenger can come back (a new visit) and board.
  const back = advance(walkedOff, 'perception', enter('WHEELCHAIR', 'visit-2'));
  assert.equal(advance(back, 'perception', { ...exit('WHEELCHAIR', 'visit-2'), zone: { ...exit('WHEELCHAIR', 'visit-2').zone, boarding: true } }).pending_exit, true);
});

test('boarding intent fields pass the hub schema; boarding:false returns to BOOKED, an invalid type is rejected', async t => {
  const h = harness(t); h.send('booking', booking()); await h.hub.run();
  h.send('perception', enter());
  h.send('perception', { ...exit(), zone: { ...exit().zone, boarding: false, dwell_seconds: 0.8 } });
  assert.equal(h.hub.snapshot().journey.stage, 'BOOKED');
  assert.equal(h.hub.snapshot().navigation.phase, 'TO_STOP');
  assert.throws(() => h.send('perception', { ...exit(), zone: { ...exit().zone, boarding: 'no' } }));
  h.send('perception', enter('WHEELCHAIR', 'visit-2'));
  h.send('perception', { ...exit('WHEELCHAIR', 'visit-2'), zone: { ...exit('WHEELCHAIR', 'visit-2').zone, boarding: true, dwell_seconds: 7 } });
  h.add(ARRIVAL_MS);
  assert.equal(h.hub.snapshot().journey.stage, 'ON_BOARD');
});

test('unmatched aid only waits; after boarding, other people at the stop do not touch the journey', async t => {
  const h = harness(t); h.send('booking', booking()); await h.hub.run();
  h.send('perception', enter('STROLLER'));
  let s = h.hub.snapshot();
  assert.deepEqual([s.journey.stage, s.journey.matched, s.journey.animation, s.navigation.phase], ['AT_STOP', false, null, 'WAIT_AT_STOP']);
  assert.match(s.journey.guidance.display_text, /does not match the booking/);
  h.send('perception', exit('STROLLER')); h.add(ARRIVAL_MS);
  assert.equal(h.hub.snapshot().journey.stage, 'BOOKED');
  h.send('perception', enter('WHEELCHAIR', 'visit-2')); h.send('perception', exit('WHEELCHAIR', 'visit-2')); h.add(ARRIVAL_MS);
  s = h.hub.snapshot(); assert.equal(s.journey.stage, 'ON_BOARD');
  const animation = s.journey.animation;
  h.send('perception', enter('CANE', 'visit-3')); h.send('perception', exit('CANE', 'visit-3')); h.add(1000);
  assert.deepEqual([h.hub.snapshot().journey.stage, h.hub.snapshot().journey.animation], ['ON_BOARD', animation]);
  h.send('booking', booking('CANE'), 'b-next');
  assert.deepEqual([h.hub.snapshot().journey.stage, h.hub.snapshot().journey.journey_id], ['BOOKED', 'b-next']);
});

test('live camera: a booking takes over the visit already in the region, even when its exit comes before a heartbeat', async t => {
  const present = (label, visit) => ({ ...enter(label, visit), zone: { ...enter(label, visit).zone, event: 'present' } });
  const h = harness(t);
  h.send('perception', enter()); h.add(2000); h.send('perception', present('WHEELCHAIR', 'visit-1'));
  assert.equal(h.hub.snapshot().journey.stage, 'IDLE', 'no booking yet: the camera report is only kept');
  h.add(1500); h.send('booking', booking()); await h.hub.run();
  let s = h.hub.snapshot();
  assert.deepEqual([s.journey.stage, s.journey.matched, s.journey.visit_id, s.navigation.phase], ['AT_STOP', true, 'visit-1', 'WAIT_AT_STOP']);
  h.send('perception', exit());
  assert.equal(h.hub.snapshot().journey.pending_exit, true);
  h.add(ARRIVAL_MS); assert.equal(h.hub.snapshot().journey.stage, 'ON_BOARD');
  // An unmatched occupant is taken over as unmatched; a report older than PRESENCE_MS or an exit is not taken over.
  h.send('perception', enter('STROLLER', 'visit-2')); h.send('booking', booking(), 'b-2');
  assert.deepEqual([h.hub.snapshot().journey.stage, h.hub.snapshot().journey.matched], ['AT_STOP', false]);
  h.add(PRESENCE_MS + 1); h.send('booking', booking(), 'b-3');
  assert.equal(h.hub.snapshot().journey.stage, 'BOOKED');
  h.send('perception', exit('STROLLER', 'visit-2')); h.send('booking', booking(), 'b-4');
  assert.equal(h.hub.snapshot().journey.stage, 'BOOKED');
});

test('model completion immediately pushes TO_STOP navigation and an atomic result snapshot', async t => {
  const h = harness(t); h.send('booking', booking()); await h.hub.run();
  assert.equal(h.hub.snapshot().navigation.phase, 'TO_STOP');
  const resultEvent = h.events.find(e => e.type === 'result');
  assert.equal(resultEvent.data.snapshot.journey.boarding_target.id, 'WHEELCHAIR_BAY');
  assert.equal(resultEvent.data.snapshot.navigation.phase, 'TO_STOP');
  assert.ok(h.events.some(e => e.type === 'navigation' && e.data.navigation?.phase === 'TO_STOP'));
});

test('one model call, two CV signals, delayed boarding and no heartbeat replay', async t => {
  const h = harness(t); h.send('booking', booking()); await h.hub.run();
  h.send('perception', enter());
  const animation = h.hub.snapshot().journey.animation;
  assert.equal(h.hub.snapshot().navigation.phase, 'WAIT_AT_STOP');
  h.send('perception', { ...enter(), zone: { ...enter().zone, event: 'present' } });
  assert.deepEqual(h.hub.snapshot().journey.animation, animation);
  h.send('perception', exit());
  assert.equal(h.hub.snapshot().journey.pending_exit, true);
  h.add(ARRIVAL_MS); const s = h.hub.snapshot();
  assert.equal(s.journey.stage, 'ON_BOARD'); assert.equal(s.navigation.phase, 'TO_WHEELCHAIR_BAY');
  const revision = s.journey.revision, start = s.journey.animation.started_at;
  h.send('perception', enter()); await h.hub.run();
  assert.equal(h.calls(), 1); assert.equal(h.hub.snapshot().journey.revision, revision);
  assert.equal(h.hub.snapshot().journey.animation.started_at, start);
  assert.equal(h.hub.cabin.wheelchair_bay_occupied, true);
  const target = h.hub.result.boarding_target;
  assert.equal((await h.hub.run({ force: true })).skipped, true);
  h.add(300000);
  assert.equal(h.hub.snapshot().journey.stage, 'ON_BOARD');
  assert.deepEqual(h.hub.result.boarding_target, target);
  h.hub.setMode('two_turn');
  assert.deepEqual(h.hub.result.boarding_target, target, 'future mode preference does not erase a consumed journey');
});

test('early CV enter+exit do not cancel or replace the initial in-flight LLM request', async t => {
  let release; const h = harness(t, async c => {
    await new Promise(resolve => { release = resolve; }); return plan(c, { mode: 'rules' });
  });
  h.send('booking', booking('CANE')); const pending = h.hub.run();
  h.send('perception', enter('CANE')); h.send('perception', exit('CANE'));
  assert.ok(h.hub.active); assert.equal(h.hub.snapshot().journey.pending_exit, true);
  release(); await pending;
  assert.equal(h.calls(), 1); assert.deepEqual(h.modes, ['single']);
  assert.equal(h.hub.snapshot().journey.animation.phase, 'arrival');
  h.add(ARRIVAL_MS);
  assert.equal(h.hub.snapshot().navigation.phase, 'TO_SEAT');
  assert.ok(h.hub.cabin.occupied_seat_ids.includes(h.hub.snapshot().journey.seat));
});

test('confidence drop holds the bus; recovery uses a new animation ID for independent App deduplication', async t => {
  const h = harness(t); h.send('booking', booking()); await h.hub.run(); h.send('perception', enter());
  const first = h.hub.snapshot().journey.animation.id;
  h.send('perception', { ...enter(), yolo_detections: [{ label: 'WHEELCHAIR', confidence: 0.5 }], zone: { ...enter().zone, event: 'present' } });
  assert.equal(h.hub.snapshot().journey.animation, null);
  assert.match(h.hub.snapshot().journey.guidance.display_text, /confirming your assistance/, 'below the gate is not a mismatch');
  h.send('perception', { ...enter(), zone: { ...enter().zone, event: 'present' } });
  assert.notEqual(h.hub.snapshot().journey.animation.id, first);
  assert.equal(h.calls(), 1);
});

test('cancel at the stop clears navigation and prevents pending boarding', async t => {
  const h = harness(t); h.send('booking', booking()); await h.hub.run();
  h.send('perception', enter()); h.send('perception', exit());
  h.send('booking', { active: false }); h.add(ARRIVAL_MS);
  assert.equal(h.hub.snapshot().journey.stage, 'IDLE'); assert.equal(h.hub.snapshot().navigation, null);
});

test('TTL is real, including a booking expiring while the model is responding', async t => {
  let release; const h = harness(t, async c => { await new Promise(r => { release = r; }); return plan(c, { mode: 'rules' }); });
  h.send('booking', booking()); const pending = h.hub.run();
  h.add(300000); release(); assert.equal((await pending).discarded, true);
  assert.equal(h.hub.result, null); assert.equal(h.hub.snapshot().journey.reason, 'expired');
  assert.equal(h.hub.snapshot().navigation, null); assert.equal(h.hub.context().request.active, false);
});

test('same-ID retries are idempotent; a new booking ID deliberately starts a fresh plan', async t => {
  const h = harness(t); h.send('booking', booking('CANE'), 'b'); await h.hub.run();
  const revision = h.hub.snapshot().journey.revision, count = h.events.length;
  assert.equal(h.send('booking', booking('CANE'), 'b').duplicate, true);
  assert.equal(h.hub.snapshot().journey.revision, revision); assert.equal(h.events.length, count);
  h.send('booking', booking('CANE'), 'new-b'); await h.hub.run();
  assert.equal(h.calls(), 2); assert.equal(h.hub.snapshot().journey.journey_id, 'new-b');
});

test('after a completed journey the next booking is met by a fresh simulated bus with the bay free again', async t => {
  const h = harness(t); h.send('booking', booking()); await h.hub.run();
  // The passenger waits for the bus (the bridge's heartbeats keep the visit present), then leaves.
  h.send('perception', enter()); h.add(ARRIVAL_MS / 2); h.send('perception', present()); h.add(ARRIVAL_MS / 2); h.send('perception', exit());
  assert.equal(h.hub.cabin.wheelchair_bay_occupied, true);
  h.send('booking', booking()); await h.hub.run();
  assert.equal(h.hub.result.plan_status, 'READY'); assert.equal(h.hub.result.boarding_target.id, 'WHEELCHAIR_BAY');
});

test('stroller guidance consumes both targets; the next booking is served by a fresh simulated bus', async t => {
  const h = harness(t); h.send('booking', booking('STROLLER')); await h.hub.run();
  const prepared = h.hub.snapshot(), target = prepared.result.boarding_target;
  assert.equal(prepared.result.plan_status, 'READY');
  assert.ok(['S02', 'S03'].includes(target.id));
  assert.deepEqual(prepared.navigation.equipment_target, { type: 'WHEELCHAIR_BAY', id: 'WHEELCHAIR_BAY' });
  assert.equal(h.hub.cabin.wheelchair_bay_occupied, false, 'planning is not simulated occupancy');
  h.send('perception', enter('STROLLER')); h.send('perception', exit('STROLLER')); h.add(ARRIVAL_MS);
  const s = h.hub.snapshot();
  assert.equal(s.navigation.phase, 'TO_SEAT'); assert.deepEqual(s.navigation.destination, target);
  assert.equal(s.journey.animation.duration_ms, STROLLER_BOARDING_MS);
  assert.deepEqual(s.journey.animation.equipment_target, s.result.equipment_target);
  assert.ok(s.navigation.steps.some(step => step.maneuver === 'PARK_STROLLER'));
  assert.match(s.navigation.instruction, /stroller.*wheelchair\s+bay/i);
  assert.ok(h.hub.cabin.occupied_seat_ids.includes(target.id));
  assert.equal(h.hub.cabin.wheelchair_bay_occupied, true);
  assert.equal(h.calls(), 1, 'parking does not spend an additional model call');
  h.send('booking', booking()); await h.hub.run();
  assert.equal(h.hub.result.plan_status, 'READY', 'the next passenger receives a new simulated bus, not the occupied prior bus');
  assert.deepEqual(h.hub.result.boarding_target, { type: 'WHEELCHAIR_BAY', id: 'WHEELCHAIR_BAY' });
  assert.equal(h.hub.result.equipment_target, null, 'the wheelchair passenger and chair stay together');
  assert.equal(h.hub.cabin.wheelchair_bay_occupied, false, 'the new bus starts with a free parking bay');
  assert.ok(!h.hub.cabin.occupied_seat_ids.includes(target.id), 'the prior passenger seat is free on the new bus');
  assert.equal(h.calls(), 2, 'the new booking receives its own plan');
});

test('an occupied parking bay or foldable seat on the current bus is not cleared by an unfinished booking', async t => {
  for (const occupied of ['bay', 'foldable-seat']) {
    const h = harness(t);
    if (occupied === 'bay') h.hub.cabin.wheelchair_bay_occupied = true;
    else h.hub.cabin.occupied_seat_ids.push('F01');
    h.send('booking', booking('STROLLER')); await h.hub.run();
    assert.equal(h.hub.result.plan_status, 'NEEDS_CONFIRMATION');
    assert.equal(h.hub.result.boarding_target, null);
    assert.equal(h.hub.result.equipment_target, null);
    assert.equal(h.hub.snapshot().journey.completed, false);
    h.send('booking', booking(), 'wheelchair-next'); await h.hub.run();
    assert.equal(h.hub.result.plan_status, 'NEEDS_CONFIRMATION', 'a new booking alone does not replace the unfinished current bus');
    assert.equal(h.hub.result.boarding_target, null);
    assert.equal(h.hub.cabin.wheelchair_bay_occupied, occupied === 'bay');
    assert.equal(h.hub.cabin.occupied_seat_ids.includes('F01'), occupied === 'foldable-seat');
  }
});

test('stroller accepts supported farther seats but cannot begin a legacy plan missing the parking assignment', () => {
  const b = advance({ stage: 'IDLE' }, 'booking', booking('STROLLER'), null, { eventId: 'stroller' });
  const j = advance(b, 'perception', enter('STROLLER'));
  const nearby = { plan_status: 'READY', boarding_target: { type: 'SEAT', id: 'S02' } };
  assert.equal(reconcile(j, nearby).animation, null);
  const equipment_target = { type: 'WHEELCHAIR_BAY', id: 'WHEELCHAIR_BAY' };
  for (const id of ['S05', 'S06', 'S08', 'S09']) {
    const assigned = reconcile(j, { ...nearby, boarding_target: { type: 'SEAT', id }, equipment_target });
    assert.equal(assigned.animation.target.id, id);
    assert.deepEqual(assigned.animation.equipment_target, equipment_target);
  }
  for (const id of ['F01', 'S01', 'S10', 'UNKNOWN']) {
    assert.equal(reconcile(j, { ...nearby, boarding_target: { type: 'SEAT', id }, equipment_target }).animation, null);
  }
});

test('stroller with both closest seats occupied receives farther-seat phone navigation and consumes both targets', async t => {
  const h = harness(t);
  h.hub.cabin.occupied_seat_ids = [...new Set([...h.hub.cabin.occupied_seat_ids, 'S02', 'S03'])];
  h.send('booking', booking('STROLLER')); await h.hub.run();
  const result = h.hub.result, target = result.boarding_target;
  assert.equal(result.plan_status, 'READY'); assert.ok(['S05', 'S06'].includes(target.id));
  h.send('perception', enter('STROLLER')); h.send('perception', exit('STROLLER')); h.add(ARRIVAL_MS);
  const snapshot = h.hub.snapshot();
  assert.equal(snapshot.navigation.phase, 'TO_SEAT'); assert.deepEqual(snapshot.navigation.destination, target);
  assert.deepEqual(snapshot.navigation.equipment_target, result.equipment_target);
  assert.deepEqual(snapshot.navigation.steps, result.cabin_navigation.steps);
  assert.ok(snapshot.navigation.steps.some(step => step.maneuver === 'PARK_STROLLER'));
  assert.ok(h.hub.cabin.occupied_seat_ids.includes(target.id)); assert.equal(h.hub.cabin.wheelchair_bay_occupied, true);
});

test('CV-only confirmation and cancellation never spend an additional model call', async t => {
  const h = harness(t); h.send('perception', enter()); await h.hub.run();
  assert.equal(h.hub.result.plan_status, 'NEEDS_CONFIRMATION'); assert.equal(h.hub.result.meta.validation_passed, true);
  assert.equal(h.modes[0], 'rules');
  h.send('booking', booking()); await h.hub.run();
  assert.equal(h.modes[1], 'single');
  h.send('booking', { active: false }); await h.hub.run();
  assert.equal(h.modes[2], 'rules'); assert.equal(h.hub.snapshot().navigation, null);
});

test('cancellation in the safety-revalidation microtask cannot publish an old READY result', async t => {
  let h;
  h = harness(t, async c => {
    const r = await plan(c, { mode: 'rules' }); r.boarding_target = { type: 'SEAT', id: 'S04' };
    queueMicrotask(() => queueMicrotask(() => h.send('booking', { active: false })));
    return r;
  });
  h.send('booking', booking('CANE'));
  assert.equal((await h.hub.run()).discarded, true);
  assert.equal(h.hub.result, null); assert.equal(h.hub.snapshot().journey.stage, 'IDLE');
  assert.equal(h.events.filter(e => e.type === 'result').length, 0);
});

// --- Continuous one-at-a-time runs: coming back, lost exit, TTL at the stop, sequential bookings ---------------------

test('coming back during pending_exit cancels the held exit; the next proper exit boards', async t => {
  const h = harness(t); h.send('booking', booking()); await h.hub.run();
  h.send('perception', enter()); const animation = h.hub.snapshot().journey.animation;
  h.add(2000); h.send('perception', exit());
  assert.equal(h.hub.snapshot().journey.pending_exit, true);
  h.send('perception', enter('STROLLER', 'visit-x'));
  assert.equal(h.hub.snapshot().journey.pending_exit, true, 'somebody else entering leaves the held exit alone');
  h.send('perception', exit('STROLLER', 'visit-x'));
  h.add(1000); h.send('perception', enter('WHEELCHAIR', 'visit-2'));
  let j = h.hub.snapshot().journey;
  assert.deepEqual([j.stage, j.pending_exit, j.matched, j.visit_id], ['AT_STOP', false, true, 'visit-2']);
  assert.deepEqual(j.animation, animation, 'the arrival animation is not restarted');
  h.add(7000); h.send('perception', present('WHEELCHAIR', 'visit-2'));
  j = h.hub.snapshot().journey;
  assert.equal(j.stage, 'AT_STOP', 'arrival finished but the passenger is back at the stop: no boarding');
  assert.equal(h.hub.snapshot().navigation.phase, 'BOARD_BUS');
  h.add(2000); h.send('perception', exit('WHEELCHAIR', 'visit-2'));
  assert.deepEqual([h.hub.snapshot().journey.stage, h.hub.snapshot().journey.completed], ['ON_BOARD', true]);
  // Pure state machine: a re-entry on the same visit (a present) also cancels; an unconfirmed label does not.
  const b = advance({ stage: 'IDLE' }, 'booking', booking(), null, { eventId: 'b' });
  const held = advance(advance(b, 'perception', enter()), 'perception', exit());
  assert.equal(advance(held, 'perception', present()).pending_exit, false);
  assert.equal(advance(held, 'perception', { ...enter('WHEELCHAIR', 'visit-3'), target_match_confirmed: false }), held);
});

test('lost exit: a matched passenger told "Ready to board" whose visit is no longer reported is taken as boarded', async t => {
  const h = harness(t); h.send('booking', booking('STROLLER')); await h.hub.run();
  h.send('perception', enter('STROLLER'));
  for (let at = 2000; at <= ARRIVAL_MS; at += 2000) { h.add(2000); h.send('perception', present('STROLLER')); }
  assert.match(h.hub.snapshot().journey.guidance.title, /Ready to board/);
  h.add(PRESENCE_LOST_MS - 1);
  assert.equal(h.hub.snapshot().journey.stage, 'AT_STOP', 'one more heartbeat could still come');
  h.add(1);
  const s = h.hub.snapshot();
  assert.deepEqual([s.journey.stage, s.journey.completed, s.journey.pending_exit, s.navigation.phase], ['ON_BOARD', true, false, 'TO_SEAT']);
  assert.equal(s.journey.animation.duration_ms, STROLLER_BOARDING_MS);
  assert.equal(h.hub.cabin.wheelchair_bay_occupied, true);
  assert.ok(h.events.some(e => e.type === 'snapshot' && e.data.journey?.stage === 'ON_BOARD'), 'the transition is published');
});

test('lost exit before the bus was ready, or of an unmatched aid, waits for the passenger again in BOOKED', async t => {
  const h = harness(t); h.send('booking', booking()); await h.hub.run();
  h.send('perception', enter()); h.add(1000); h.send('perception', present());
  h.add(PRESENCE_LOST_MS); // lost 9 s after the enter, before the 10 s arrival preparation was complete
  let j = h.hub.snapshot().journey;
  assert.deepEqual([j.stage, j.matched, j.visit_id, j.animation, j.reason, h.hub.snapshot().navigation.phase],
    ['BOOKED', false, null, null, 'presence_lost', 'TO_STOP']);
  h.send('perception', enter('STROLLER', 'visit-2'));
  assert.deepEqual([h.hub.snapshot().journey.stage, h.hub.snapshot().journey.matched], ['AT_STOP', false]);
  h.add(PRESENCE_LOST_MS); assert.equal(h.hub.snapshot().journey.stage, 'BOOKED');
  // The passenger comes back and boards normally.
  h.send('perception', enter('WHEELCHAIR', 'visit-3')); h.send('perception', exit('WHEELCHAIR', 'visit-3')); h.add(ARRIVAL_MS);
  assert.equal(h.hub.snapshot().journey.stage, 'ON_BOARD');
});

test('no bridge, a manual enter without visit_id, and a held exit are not timed out by presence', async t => {
  const h = harness(t); h.send('booking', booking()); await h.hub.run();
  h.add(60000); assert.equal(h.hub.snapshot().journey.stage, 'BOOKED', 'bookings only: nothing changes');
  h.send('perception', enter('WHEELCHAIR', null)); h.add(30000);
  assert.equal(h.hub.snapshot().journey.stage, 'AT_STOP', 'manual curl signals send no heartbeats');
  h.send('perception', exit('WHEELCHAIR', null)); assert.equal(h.hub.snapshot().journey.stage, 'ON_BOARD');
  const p = harness(t); p.send('booking', booking()); await p.hub.run();
  p.send('perception', enter()); p.add(1000); p.send('perception', exit());
  p.add(PRESENCE_LOST_MS);
  assert.deepEqual([p.hub.snapshot().journey.stage, p.hub.snapshot().journey.pending_exit], ['AT_STOP', true], 'a held exit is not a lost visit');
  p.add(ARRIVAL_MS); assert.equal(p.hub.snapshot().journey.stage, 'ON_BOARD');
});

test('TTL is frozen while a matched passenger waits at the stop and counts from the booking once back in BOOKED', async t => {
  const h = harness(t); h.send('booking', booking()); await h.hub.run();
  h.send('perception', enter());
  for (let at = 0; at < BOOKING_TTL_MS + 20000; at += 2000) { h.add(2000); h.send('perception', present()); }
  let j = h.hub.snapshot().journey;
  assert.deepEqual([j.stage, j.matched, j.reason], ['AT_STOP', true, 'entered']);
  h.send('perception', { ...exit(), zone: { ...exit().zone, boarding: false } });
  j = h.hub.snapshot().journey;
  assert.deepEqual([j.stage, j.reason], ['IDLE', 'expired']);
  // A held exit is matched too: it still boards after a long wait.
  const p = harness(t); p.send('booking', booking()); await p.hub.run();
  p.send('perception', enter());
  for (let at = 0; at < BOOKING_TTL_MS; at += 2000) { p.add(2000); p.send('perception', present()); }
  p.send('perception', exit()); assert.equal(p.hub.snapshot().journey.stage, 'ON_BOARD');
  // An unmatched aid at the stop does not hold the booking.
  const u = harness(t); u.send('booking', booking()); await u.hub.run();
  u.send('perception', enter('STROLLER'));
  for (let at = 0; at < BOOKING_TTL_MS; at += 2000) { u.add(2000); u.send('perception', present('STROLLER')); }
  assert.equal(u.hub.snapshot().journey.reason, 'expired');
});

test('sequential passengers: each booking starts a fresh journey at once, even during the previous boarding animation', async t => {
  const h = harness(t);
  const ride = async (need, id) => {
    h.send('booking', booking(need), id);
    const fresh = h.hub.snapshot().journey;
    assert.deepEqual([fresh.stage, fresh.journey_id, fresh.need, fresh.completed, fresh.pending_exit, fresh.animation, fresh.visit_id, fresh.seat, fresh.boarding_target, fresh.equipment_target],
      ['BOOKED', id, need, false, false, null, null, null, null, null], `${id} starts clean`);
    assert.equal(h.hub.snapshot().navigation, null, 'no navigation left over from the previous passenger');
    assert.equal(h.hub.cabin.wheelchair_bay_occupied, false); assert.deepEqual(h.hub.cabin.occupied_seat_ids, structuredClone(h.hub.context().vehicle_context.cabin.occupied_seat_ids));
    await h.hub.run();
    assert.equal(h.hub.result.plan_status, 'READY', `${id}: a fresh simulated bus has room`);
    h.send('perception', enter(need, `${id}-v`)); h.add(3000); h.send('perception', exit(need, `${id}-v`));
    h.add(ARRIVAL_MS);
    const s = h.hub.snapshot();
    assert.deepEqual([s.journey.stage, s.journey.completed, s.journey.animation.phase], ['ON_BOARD', true, 'boarding']);
    assert.equal(Boolean(s.journey.equipment_target), need === 'STROLLER');
    h.add(1000); // the next booking arrives while the boarding animation (16/22 s) is still playing
  };
  await ride('WHEELCHAIR', 'b-1'); await ride('STROLLER', 'b-2'); await ride('CANE', 'b-3'); await ride('WHEELCHAIR', 'b-4');
  assert.equal(h.calls(), 4);
});

test('a new booking replaces a journey stuck anywhere; old timers cannot complete the new one', async t => {
  const stuck = {
    booked: () => {},
    unmatched: h => h.send('perception', enter('STROLLER', 'v-old')),
    matched: h => h.send('perception', enter('WHEELCHAIR', 'v-old')),
    pending_exit: h => { h.send('perception', enter('WHEELCHAIR', 'v-old')); h.send('perception', exit('WHEELCHAIR', 'v-old')); },
  };
  for (const [name, put] of Object.entries(stuck)) {
    const h = harness(t); h.send('booking', booking(), 'old'); await h.hub.run(); put(h);
    h.add(PRESENCE_MS + 1); h.send('booking', booking('CANE'), 'new'); // (a recent occupant is taken over: see below)
    let j = h.hub.snapshot().journey;
    assert.deepEqual([j.stage, j.journey_id, j.pending_exit, j.visit_id, j.animation], ['BOOKED', 'new', false, null, null], name);
    await h.hub.run(); h.add(ARRIVAL_MS); h.add(PRESENCE_LOST_MS);
    assert.equal(h.hub.snapshot().journey.stage, 'BOOKED', `${name}: nothing of the old journey fires into the new one`);
    // The old visit's late exit does not touch the new journey either.
    h.send('perception', exit('WHEELCHAIR', 'v-old'));
    assert.equal(h.hub.snapshot().journey.stage, 'BOOKED');
    h.send('perception', enter('CANE', 'v-new')); h.send('perception', exit('CANE', 'v-new')); h.add(ARRIVAL_MS);
    assert.equal(h.hub.snapshot().journey.stage, 'ON_BOARD', `${name}: the new passenger boards`);
  }
});

test('the previous passenger still in the region: another aid stays unmatched, the same aid is taken over', async t => {
  const h = harness(t); h.send('booking', booking()); await h.hub.run();
  h.send('perception', enter()); h.add(3000); h.send('perception', exit()); h.add(ARRIVAL_MS);
  assert.equal(h.hub.snapshot().journey.stage, 'ON_BOARD');
  h.send('perception', enter('WHEELCHAIR', 'back')); // walked back into the region after boarding
  h.send('booking', booking('STROLLER'), 'stroller');
  let j = h.hub.snapshot().journey;
  assert.deepEqual([j.stage, j.matched, j.animation], ['AT_STOP', false, null], 'shown as waiting, the bus does not come');
  h.send('perception', exit('WHEELCHAIR', 'back'));
  assert.equal(h.hub.snapshot().journey.stage, 'BOOKED');
  // Two wheelchair users in a row: a matching occupant is taken over as the new passenger's arrival (one at a time:
  // the operator books the next passenger once the previous one has left the region).
  h.send('perception', enter('WHEELCHAIR', 'back-2')); h.send('booking', booking(), 'wheelchair-2'); await h.hub.run();
  j = h.hub.snapshot().journey;
  assert.deepEqual([j.stage, j.matched, j.visit_id, j.animation?.phase], ['AT_STOP', true, 'back-2', 'arrival']);
});

test('cancel from any stage returns to IDLE and the next booking works on a fresh bus', async t => {
  const stages = {
    BOOKED: () => {},
    AT_STOP: h => h.send('perception', enter()),
    pending_exit: h => { h.send('perception', enter()); h.send('perception', exit()); },
    ON_BOARD: h => { h.send('perception', enter()); h.send('perception', exit()); h.add(ARRIVAL_MS); },
  };
  for (const [name, put] of Object.entries(stages)) {
    const h = harness(t); h.send('booking', booking(), 'first'); await h.hub.run(); put(h);
    h.send('booking', { active: false });
    assert.deepEqual([h.hub.snapshot().journey.stage, h.hub.snapshot().navigation], ['IDLE', null], name);
    h.add(ARRIVAL_MS + PRESENCE_LOST_MS); assert.equal(h.hub.snapshot().journey.stage, 'IDLE');
    h.send('booking', booking(), 'second'); await h.hub.run();
    assert.equal(h.hub.result.boarding_target?.id, 'WHEELCHAIR_BAY', `${name}: the bay is free for the next wheelchair`);
    h.send('perception', enter('WHEELCHAIR', 'v-2')); h.send('perception', exit('WHEELCHAIR', 'v-2')); h.add(ARRIVAL_MS);
    assert.equal(h.hub.snapshot().journey.stage, 'ON_BOARD', name);
  }
});
