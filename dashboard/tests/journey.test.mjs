import test from 'node:test';
import assert from 'node:assert/strict';
import { advance, guidance, matches } from '../backend/journey.mjs';
import { SignalHub } from '../backend/hub.mjs';

const booking = (need = 'WHEELCHAIR') => ({ active: true, intent: 'BOARDING', route_id: 'DEMO_ROUTE', stop_id: 'DEMO_STOP', accessibility_need: need,
  ramp_preference: need === 'WHEELCHAIR' ? 'REQUESTED' : 'UNSPECIFIED', assistance_requested: need === 'WHEELCHAIR' ? ['WHEELCHAIR_RAMP'] : ['ADDITIONAL_BOARDING_TIME'], preferred_interaction: 'BOTH', language: 'en-SG' });
const enter = (label = 'WHEELCHAIR') => ({ yolo_detections: [{ label, confidence: 0.95 }], target_match_confirmed: true, zone: { triggered: true, roi_id: 'stop', event: 'enter' } });
const exit = (label = 'WHEELCHAIR') => ({ yolo_detections: [], target_match_confirmed: false, zone: { triggered: false, roi_id: 'stop', event: 'exit', left: [label] } });

test('journey: booked, at the stop, on board', () => {
  let j = advance({ stage: 'IDLE' }, 'booking', booking(), undefined);
  assert.equal(j.stage, 'BOOKED');
  j = advance(j, 'perception', enter(), 'READY');
  assert.deepEqual([j.stage, j.matched], ['AT_STOP', true]);
  j = advance(j, 'perception', exit(), 'READY');
  assert.deepEqual([j.stage, j.seat], ['ON_BOARD', 'WHEELCHAIR_BAY']);
  assert.match(guidance(j, { request: booking() }, null).display_text, /wheelchair space/);
  // The journey is finished: somebody else at the stop does not interrupt it; a new booking starts the next one.
  j = advance(advance(j, 'perception', enter('CANE'), 'READY'), 'perception', exit('CANE'), 'READY');
  assert.deepEqual([j.stage, j.seat, j.need], ['ON_BOARD', 'WHEELCHAIR_BAY', null]);
  j = advance(j, 'booking', booking('CANE'), 'READY');
  assert.deepEqual([j.stage, j.seat, j.need], ['BOOKED', null, 'CANE']);
});

test('journey: leaving without a READY plan or with the wrong aid is not boarding', () => {
  let j = advance({ stage: 'IDLE' }, 'perception', enter(), undefined);
  assert.deepEqual([j.stage, j.matched], ['AT_STOP', false]);
  assert.equal(advance(j, 'perception', exit(), 'NEEDS_CONFIRMATION').stage, 'IDLE');
  j = advance(advance({ stage: 'IDLE' }, 'booking', booking('WHEELCHAIR'), undefined), 'perception', enter('CANE'), 'READY');
  assert.equal(j.matched, false);
  assert.equal(advance(j, 'perception', exit('CANE'), 'READY').stage, 'BOOKED');
});

test('journey: a walking passenger is given a priority seat; needs without a visible aid match anything', () => {
  let j = advance(advance({ stage: 'IDLE' }, 'booking', booking('VISUAL_ASSISTANCE'), undefined), 'perception', enter('CANE'), 'READY');
  j = advance(j, 'perception', exit('CANE'), 'READY');
  assert.equal(j.seat, 'S02');
  assert.equal(matches('HEARING_ASSISTANCE', ['STROLLER']), true);
  assert.equal(matches('WHEELCHAIR', ['STROLLER']), false);
});

test('hub: the plan is made at booking and kept when the passenger reaches and leaves the stop', async t => {
  let calls = 0, clock = Date.parse('2026-10-02T10:00:00Z');
  const planner = async (context, options) => { calls++; return (await import('../backend/planner/agent.mjs')).plan(context, { ...options, mode: 'rules' }); };
  const hub = new SignalHub({ planner, debounceMs: 0, now: () => clock });
  t.after(() => hub.close());
  const send = (channel, payload) => { clock += 1000; return hub.receive(channel, { event_id: `e-${clock}`, observed_at: new Date(clock - 100).toISOString(), payload }); };
  const settled = () => new Promise(resolve => setTimeout(resolve, 30));

  send('booking', booking()); await settled();
  assert.equal(calls, 1);
  assert.deepEqual([hub.result.plan_status, hub.snapshot().journey.stage], ['READY', 'BOOKED']);
  const planned = hub.result.request_id;

  send('perception', enter()); await settled();
  assert.equal(calls, 1, 'arrival is checked by the rules, not replanned');
  assert.deepEqual([hub.result.request_id, hub.snapshot().journey.stage, hub.snapshot().journey.matched], [planned, 'AT_STOP', true]);

  send('perception', exit()); await settled();
  assert.equal(calls, 1);
  const journey = hub.snapshot().journey;
  assert.deepEqual([journey.stage, journey.seat, journey.guidance.title], ['ON_BOARD', 'WHEELCHAIR_BAY', 'Welcome on board']);
});

test('hub: an aid at the stop without a booking is handled by the rules at once', async t => {
  const modes = [];
  const planner = async (context, options) => { modes.push(options.mode); return (await import('../backend/planner/agent.mjs')).plan(context, { ...options, mode: 'rules' }); };
  let clock = Date.parse('2026-10-02T10:00:00Z');
  const hub = new SignalHub({ planner, debounceMs: 0, now: () => clock });
  t.after(() => hub.close());
  clock += 1000; hub.receive('perception', { event_id: 'p-1', observed_at: new Date(clock - 100).toISOString(), payload: enter() });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(modes, ['rules']);
  assert.equal(hub.result.plan_status, 'NEEDS_CONFIRMATION');
});
