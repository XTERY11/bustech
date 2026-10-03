import test from 'node:test';
import assert from 'node:assert/strict';
import { advance, reconcile, matches, ARRIVAL_MS, STROLLER_BOARDING_MS } from '../backend/journey.mjs';
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

test('stroller guidance parks the equipment in the bay and consumes a nearby seat as well', async t => {
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
  assert.equal(h.hub.result.plan_status, 'NEEDS_CONFIRMATION', 'a wheelchair cannot reuse the stroller parking bay');
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
