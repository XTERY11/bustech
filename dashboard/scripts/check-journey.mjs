// Explicit paid integration check: real DeepSeek + authenticated HTTP/SSE.
// No rules substitute can pass. CV events are simulated, not a physical camera test.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { SignalHub } from '../backend/hub.mjs';
import { createBridge } from '../backend/server.mjs';
import { ARRIVAL_MS } from '../backend/journey.mjs';

if (process.argv.includes('--key-stdin')) {
  console.log('DeepSeek key input (hidden, memory only):');
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  const rl = createInterface({ input: process.stdin, terminal: false });
  process.env.DEEPSEEK_API_KEY = await new Promise(resolve => rl.once('line', line => { rl.close(); process.stdin.pause(); resolve(line.trim()); }));
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
}
if (!process.env.DEEPSEEK_API_KEY) throw new Error('Set DEEPSEEK_API_KEY or use --key-stdin. This check never uses rules instead.');
const categoryFlag = process.argv.indexOf('--categories');
const categories = categoryFlag >= 0 ? (process.argv[categoryFlag + 1] ?? '').split(',') : ['WHEELCHAIR', 'CANE', 'STROLLER', 'VISUAL_ASSISTANCE'];
if (!categories.length || categories.some(need => !['WHEELCHAIR', 'CANE', 'STROLLER', 'VISUAL_ASSISTANCE'].includes(need))) throw new Error('INVALID_CHECK_CATEGORY');
const strollerNearbyFull = process.argv.includes('--stroller-nearby-full');
let clock = Date.now();
const hub = new SignalHub({ autoRun: false, now: () => clock });
const initialCabin = structuredClone(hub.cabin);
const token = randomUUID(), origin = 'http://localhost:3300';
const server = createBridge({ hub, token, allowedOrigins: [origin] });
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, Origin: origin };
const events = [], abort = new AbortController();
const stream = await fetch(`${base}/api/events`, { headers, signal: abort.signal });
assert.equal(stream.status, 200);
const streamTask = (async () => {
  const reader = stream.body.getReader(), decoder = new TextDecoder(); let pending = '';
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      pending += decoder.decode(value, { stream: true });
      let end;
      while ((end = pending.indexOf('\n\n')) >= 0) {
        const frame = pending.slice(0, end); pending = pending.slice(end + 2);
        const data = frame.split('\n').find(line => line.startsWith('data: '));
        if (data) events.push(JSON.parse(data.slice(6)));
      }
    }
  } catch (error) { if (!abort.signal.aborted) throw error; }
})();
const post = async (path, body) => {
  const response = await fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal(response.status, 202, `${path}: HTTP ${response.status}`); return response.json();
};
const state = async () => (await fetch(`${base}/api/state`, { headers })).json();
const send = (channel, payload) => post(`/api/${channel}`, { event_id: `${channel}-${randomUUID()}`, observed_at: new Date(clock).toISOString(), payload });
const until = async predicate => {
  const end = Date.now() + 45000;
  while (!predicate()) { if (Date.now() >= end) throw new Error('TIMED_OUT_WAITING_FOR_REAL_MODEL_OR_SSE'); await new Promise(r => setTimeout(r, 25)); }
};
try {
  assert.equal((await fetch(`${base}/api/state`)).status, 401);
  const report = [];
  for (const need of categories) {
    // Each category is an independent simulated bus: the previous journey was reset by the phone's "next passenger"
    // cancel below, which gives a fresh bus. Overlapping bookings sharing a bus are covered by the unit tests.
    hub.cabin = structuredClone(initialCabin);
    if (need === 'STROLLER' && strollerNearbyFull) {
      hub.cabin.occupied_seat_ids = [...new Set([...hub.cabin.occupied_seat_ids, 'S02', 'S03'])];
    }
    clock = Math.max(clock + 1, Date.now());
    await send('booking', { active: true, intent: 'BOARDING', accessibility_need: need,
      route_id: 'DEMO_ROUTE', stop_id: 'DEMO_STOP', ramp_preference: need === 'WHEELCHAIR' ? 'REQUESTED' : 'UNSPECIFIED',
      assistance_requested: need === 'WHEELCHAIR' ? ['WHEELCHAIR_RAMP', 'ADDITIONAL_BOARDING_TIME'] : ['ADDITIONAL_BOARDING_TIME'],
      preferred_interaction: 'BOTH', language: 'en-SG' });
    const journeyId = hub.journey.journey_id;
    await post('/api/run', {}); await until(() => !hub.active);
    let snapshot = await state(); const result = snapshot.result;
    assert.ok(result, 'Model must produce a result');
    assert.equal(result.meta.source, 'llm', `No rules/fallback accepted: ${result.meta.error ?? result.meta.source}`);
    assert.equal(result.meta.mode, 'single'); assert.equal(result.meta.api_calls, 1);
    assert.equal(result.meta.validation_passed, true); assert.equal(result.plan_status, 'READY');
    assert.ok(result.meta.usage.total_tokens > 0); assert.equal(snapshot.navigation.phase, 'TO_STOP');
    await until(() => events.some(e => e.type === 'navigation' && e.data.navigation?.id === journeyId && e.data.navigation.phase === 'TO_STOP'));
    assert.ok(events.some(e => e.type === 'result' && e.data.snapshot?.navigation?.id === journeyId));
    const target = result.boarding_target;
    if (need === 'WHEELCHAIR') assert.deepEqual(target, { type: 'WHEELCHAIR_BAY', id: 'WHEELCHAIR_BAY' });
    else assert.equal(target.type, 'SEAT');
    if (need === 'STROLLER') {
      const preferred = ['S02', 'S03'].filter(id => !hub.cabin.occupied_seat_ids.includes(id));
      const expectedSeats = preferred.length ? preferred : ['S05', 'S06'].filter(id => !hub.cabin.occupied_seat_ids.includes(id));
      assert.ok(expectedSeats.includes(target.id), 'Stroller seating must prefer the nearest available tier');
      assert.deepEqual(result.equipment_target, { type: 'WHEELCHAIR_BAY', id: 'WHEELCHAIR_BAY' });
      assert.equal(result.cabin_navigation.steps.filter(step => step.maneuver === 'PARK_STROLLER').length, 1);
    } else assert.equal(result.equipment_target, null);
    const visit = `visit-${randomUUID()}`, label = need === 'VISUAL_ASSISTANCE' ? 'CANE' : need;
    assert.ok(result.cabin_navigation?.steps?.length >= 4, 'LLM must provide structured interior directions');
    assert.ok(result.cabin_navigation.steps.some(step => step.maneuver === 'STRAIGHT' && step.distance_m > 0));
    assert.ok(result.cabin_navigation.steps.some(step => ['TURN_LEFT', 'TURN_RIGHT'].includes(step.maneuver)));
    await send('perception', { target_match_confirmed: true, yolo_detections: [{ label, confidence: 0.96 }], zone: { triggered: true, roi_id: 'monitor_roi', visit_id: visit, event: 'enter' } });
    snapshot = await state(); assert.equal(snapshot.journey.animation.phase, 'arrival');
    assert.equal(snapshot.navigation.phase, 'WAIT_AT_STOP'); assert.equal(snapshot.journey.matched, true);
    await send('perception', { target_match_confirmed: false, yolo_detections: [], zone: { triggered: false, roi_id: 'monitor_roi', visit_id: visit, event: 'exit', left: [label] } });
    assert.equal((await state()).journey.pending_exit, true);
    clock += ARRIVAL_MS; hub.tick(); snapshot = await state();
    assert.equal(snapshot.navigation.phase, need === 'WHEELCHAIR' ? 'TO_WHEELCHAIR_BAY' : 'TO_SEAT');
    assert.deepEqual(snapshot.navigation.destination, target); assert.equal(snapshot.journey.animation.phase, 'boarding');
    assert.deepEqual(snapshot.navigation.equipment_target, result.equipment_target);
    assert.deepEqual(snapshot.navigation.steps, result.cabin_navigation.steps);
    assert.equal(snapshot.result.request_id, result.request_id, 'CV must not trigger another model call');
    await until(() => events.some(e => e.type === 'navigation' && e.data.navigation?.id === journeyId && e.data.navigation.destination.id === target.id));
    report.push({ category: need, model: result.meta.model, target: target.id, equipment_target: result.equipment_target, navigation: snapshot.navigation.phase, steps: snapshot.navigation.steps,
      api_calls: result.meta.api_calls, total_tokens: result.meta.usage.total_tokens, latency_ms: result.meta.latency_ms });
    // The phone's reset ("next passenger"): the boarded journey ends as completed and the bus is fresh again.
    assert.equal((await post('/api/booking', { event_id: `reset-${randomUUID()}`, observed_at: new Date(clock).toISOString(), payload: { active: false, cancels: journeyId } })).journey_id, journeyId);
    const after = await state();
    assert.deepEqual([after.journey.stage, after.journey.reason, after.navigation], ['IDLE', 'completed', null]);
  }
  console.log(JSON.stringify({ ok: true, real_deepseek: true, cv_source: 'simulated HTTP events', cabin_reset_between_categories: true, stroller_nearby_full: strollerNearbyFull, authenticated_sse_navigation: true, results: report }, null, 2));
} finally {
  abort.abort(); await streamTask; server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  delete process.env.DEEPSEEK_API_KEY;
}
