import test from 'node:test';
import assert from 'node:assert/strict';
import type { Journey, Snapshot } from '../app/live-types.ts';
import { appSignalFromSnapshot } from '../app/lib/appSignal.ts';

const request = { active: true, accessibility_need: 'WHEELCHAIR', ramp_preference: 'REQUESTED',
  assistance_requested: ['WHEELCHAIR_RAMP', 'ADDITIONAL_BOARDING_TIME'], route_id: 'ROUTE_400',
  stop_id: 'STOP_A', preferred_interaction: 'BOTH' };
const journey = (stage: Journey['stage'], extra: Partial<Journey> = {}): Journey => ({
  stage, journey_id: 'app-1', need: 'WHEELCHAIR',
  guidance: { title: 'Passenger guidance', display_text: `Guidance for ${stage}`, audio_text: '' }, ...extra,
});
const snapshot = (extra: Partial<Snapshot> = {}): Snapshot => ({
  source: 'external', mode: 'rules', context: { request_id: 'snapshot', booking_event_id: 'app-1', request },
  channels: { booking: { event_id: 'app-1', received_at: 1234, observed_at: 1230 } },
  running: null, summary: null, result: null, journey: journey('BOOKED'), navigation: null, ...extra,
});

test('only external booking-channel receipts qualify; initial sample, demo and camera-only inputs never qualify', () => {
  for (const state of [null, snapshot({ source: 'demo' }), snapshot({ channels: {} }),
    snapshot({ channels: { perception: { event_id: 'cv-1', received_at: 1234, observed_at: 1230 } } }),
    snapshot({ channels: { booking: { event_id: '', received_at: 1234, observed_at: 1230 } } })]) {
    const signal = appSignalFromSnapshot(state);
    assert.equal(signal.received, false);
    assert.equal(signal.status, 'awaiting');
    assert.equal(signal.aid, null);
    assert.deepEqual(signal.assistance, []);
    assert.equal(signal.eventId, null);
  }
  assert.equal(appSignalFromSnapshot(snapshot({ source: 'demo' })).source, 'demo');
});

test('a received booking shows actual assistance fields without inventing route or stop defaults', () => {
  const signal = appSignalFromSnapshot(snapshot());
  assert.equal(signal.received, true);
  assert.equal(signal.source, 'app');
  assert.equal(signal.status, 'booked');
  assert.equal(signal.aidLabel, 'Wheelchair');
  assert.equal(signal.rampPreference, 'Requested');
  assert.deepEqual(signal.assistance, ['Wheelchair ramp', 'Additional boarding time']);
  assert.deepEqual([signal.route, signal.stop, signal.interaction], ['ROUTE_400', 'STOP_A', 'Both']);
  assert.equal(signal.eventId, 'app-1');
  assert.equal(signal.receivedAt, 1234);
  const sparse = appSignalFromSnapshot(snapshot({ context: { request_id: 'snapshot', request: { active: true } } }));
  assert.deepEqual([sparse.route, sparse.stop, sparse.rampPreference, sparse.interaction], [null, null, null, null]);
});

test('at-stop and onboard state keep feedback; onboard is not cleared by inactive request', () => {
  assert.equal(appSignalFromSnapshot(snapshot({ journey: journey('AT_STOP') })).status, 'at_stop');
  const state = snapshot({ journey: journey('ON_BOARD', { completed: true }),
    context: { request_id: 'snapshot', request: { ...request, active: false } } });
  const signal = appSignalFromSnapshot(state);
  assert.equal(signal.status, 'on_board');
  assert.equal(signal.aid, 'WHEELCHAIR');
  assert.equal(signal.route, 'ROUTE_400');
  assert.equal(signal.guidance, 'Guidance for ON_BOARD');
  assert.equal(appSignalFromSnapshot(snapshot({ journey: journey('ON_BOARD', { completed: true }),
    context: { request_id: 'snapshot' } })).aid, 'WHEELCHAIR');
  assert.equal(appSignalFromSnapshot(snapshot({ journey: journey('BOOKED'), context: { request_id: 'snapshot' } })).received, false);
});

test('cancellation and expiry remain received events with explicit feedback even when navigation and result are empty', () => {
  for (const reason of ['cancelled', 'expired'] as const) {
    const signal = appSignalFromSnapshot(snapshot({ context: { request_id: 'snapshot', request: { active: false } },
      journey: journey('IDLE', { need: null, reason, guidance: { title: reason, display_text: `Booking ${reason}`, audio_text: '' } }) }));
    assert.equal(signal.received, true);
    assert.equal(signal.status, reason);
    assert.equal(signal.guidance, `Booking ${reason}`);
    assert.equal(signal.aid, null, 'minimal cancellation must not invent a category from the previous passenger');
  }
});

test('navigation instruction wins for active journeys, while absent text uses a non-empty stage-aware fallback', () => {
  const instruction = 'Go to the marked boarding point.';
  const signal = appSignalFromSnapshot(snapshot({ navigation: { id: 'app-1', revision: 1, phase: 'TO_STOP',
    destination: { type: 'BUS_STOP', id: 'STOP_A' }, instruction, simulated: true } }));
  assert.equal(signal.guidance, instruction);
  const blank = appSignalFromSnapshot(snapshot({ journey: journey('IDLE', { reason: 'cancelled',
    guidance: { title: '', display_text: '', audio_text: '' } }), context: { request_id: 'snapshot', request: { active: false } } }));
  assert.match(blank.guidance, /cancelled/);
});
