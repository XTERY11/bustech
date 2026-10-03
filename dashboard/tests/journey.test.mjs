import test from 'node:test';
import assert from 'node:assert/strict';
import { advance, reconcile, matches, ARRIVAL_MS } from '../backend/journey.mjs';
import { SignalHub } from '../backend/hub.mjs';
import { plan } from '../backend/planner/agent.mjs';

const booking = (need = 'WHEELCHAIR') => ({ active: true, intent: 'BOARDING', route_id: 'DEMO_ROUTE', stop_id: 'DEMO_STOP', accessibility_need: need,
  ramp_preference: need === 'WHEELCHAIR' ? 'REQUESTED' : 'UNSPECIFIED', assistance_requested: need === 'WHEELCHAIR' ? ['WHEELCHAIR_RAMP'] : ['ADDITIONAL_BOARDING_TIME'], preferred_interaction: 'BOTH', language: 'en-SG' });
const enter = (label = 'WHEELCHAIR', visit = 'visit-1') => ({ yolo_detections: [{ label, confidence: 0.95 }], target_match_confirmed: true, zone: { triggered: true, roi_id: 'stop', event: 'enter', ...(visit ? { visit_id: visit } : {}) } });
const exit = (label = 'WHEELCHAIR', visit = 'visit-1') => ({ yolo_detections: [], target_match_confirmed: false, zone: { triggered: false, roi_id: 'stop', event: 'exit', left: [label], ...(visit ? { visit_id: visit } : {}) } });
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

test('a new booking cannot reserve the already consumed wheelchair bay', async t => {
  const h = harness(t); h.send('booking', booking()); await h.hub.run();
  h.send('perception', enter()); h.add(ARRIVAL_MS); h.send('perception', exit());
  h.send('booking', booking()); await h.hub.run();
  assert.equal(h.hub.result.plan_status, 'NEEDS_CONFIRMATION'); assert.equal(h.hub.snapshot().navigation, null);
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
