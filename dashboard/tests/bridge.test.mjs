import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { SignalHub } from '../backend/hub.mjs';
import { createBridge } from '../backend/server.mjs';
import { plan } from '../backend/planner/agent.mjs';

const input = JSON.parse(readFileSync(new URL('../backend/examples/input.json', import.meta.url), 'utf8'));
const envelope = (id, payload, at = Date.now()) => ({ event_id: id, observed_at: new Date(at).toISOString(), payload });
const detection = { yolo_detections: input.perception.yolo_detections };
const seed = (hub, at) => { hub.receive('booking', envelope('app-1', input.request, at)); hub.receive('perception', envelope('yolo-1', detection, at)); };

test('signals fuse, deduplicate and do not replan for heartbeat/confidence jitter', async t => {
  let calls = 0, now = Date.now();
  const hub = new SignalHub({ autoRun: false, now: () => now, planner: c => { calls++; return plan(c, { mode: 'rules' }); } }); t.after(() => hub.close());
  seed(hub, now); await hub.run(); assert.equal(calls, 1);
  assert.ok(hub.result.action_plan.some(a => a.action === 'DEPLOY_AUTOMATIC_SHORT_RAMP'));
  assert.deepEqual(Object.keys(hub.snapshot().channels).sort(), ['booking', 'perception']);
  assert.equal(hub.result.vehicle_context_source, 'SIMULATED_SCENARIO');
  assert.equal(hub.receive('perception', envelope('yolo-1', detection, now)).duplicate, true);
  now += 100;
  const p = structuredClone(detection); p.yolo_detections[0].confidence = 0.93;
  assert.equal(hub.receive('perception', envelope('yolo-2', p, now)).changed, false);
  await hub.run(); assert.equal(calls, 1);
  assert.throws(() => hub.receive('perception', envelope('yolo-2', {}, now)), /EVENT_ID_CONFLICT/);
  assert.throws(() => hub.receive('perception', envelope('old', p, now - 1)), /OUT_OF_ORDER/);
  now += 600000; hub.tick(); await hub.run(); assert.equal(calls, 1); assert.equal(hub.result, null);
  assert.equal(hub.snapshot().journey.reason, 'expired');
});

test('new emergency supersedes an in-flight model result', async t => {
  let release; const events = [];
  const hub = new SignalHub({ autoRun: false, planner: async c => {
    if (!c.vehicle_context.emergency_stop_active) await new Promise(r => { release = r; });
    return plan(c, { mode: 'rules' });
  } }); t.after(() => hub.close()); hub.on('event', e => events.push(e));
  seed(hub, Date.now()); const old = hub.run();
  await hub.loadDemo({ ...input, vehicle_context: { ...input.vehicle_context, emergency_stop_active: true } }, 'rules'); release(); await old;
  assert.equal(hub.result.plan_status, 'CANNOT_EXECUTE');
  assert.equal(events.filter(e => e.type === 'result').length, 1);
});

test('two-turn summary arrives as a separate event before final action', async t => {
  const hub = new SignalHub({ autoRun: false, planner: async (c, options) => {
    await options.onSummary({ request_id: c.request_id, decision_summary: ['first turn'] });
    return plan(c, { mode: 'rules' });
  } }); t.after(() => hub.close()); const kinds = []; hub.on('event', e => kinds.push(e.type));
  await hub.loadDemo(input, 'two_turn');
  assert.ok(kinds.indexOf('summary') < kinds.indexOf('result'));
  // External signals clear preset App/YOLO inputs and receive explicit simulated conditions.
  hub.receive('booking', envelope('real-app', input.request));
  assert.equal(hub.context().presentation_mode, 'WEB_DEMO');
  assert.equal(hub.context().vehicle_context.motion_state, 'STOPPED');
  assert.equal(hub.channels.perception, undefined);
  assert.equal(hub.context().perception.yolo_detections, undefined);
});

test('slow model still completes a frozen presentation snapshot without vehicle telemetry', async t => {
  let now = Date.now();
  const hub = new SignalHub({ now: () => now, autoRun: false, planner: async c => { now += 5000; return plan(c, { mode: 'rules' }); } }); t.after(() => hub.close());
  seed(hub, now); const result = await hub.run();
  assert.equal(result.plan_status, 'READY'); assert.equal(hub.result, result);
  assert.equal(result.requires_fresh_vehicle_state, false);
});

test('HTTP + SSE authenticate signals and deliver actual result events', async t => {
  const hub = new SignalHub({ autoRun: false, planner: c => plan(c, { mode: 'rules' }) });
  const server = createBridge({ hub, token: 'test-bridge' });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const abort = new AbortController();
  t.after(() => { abort.abort(); server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer test-bridge' };
  assert.equal((await fetch(base + '/api/state')).status, 401);
  const stream = await fetch(base + '/api/events', { headers, signal: abort.signal });
  assert.match(stream.headers.get('content-type'), /text\/event-stream/);
  const reader = stream.body.getReader(), decoder = new TextDecoder();
  const first = decoder.decode((await reader.read()).value); assert.match(first, /snapshot/);
  const response = await fetch(base + '/api/demo', { method: 'POST', headers, body: JSON.stringify({ mode: 'rules', context: input }) });
  assert.equal(response.status, 202);
  let output = ''; while (!output.includes('"type":"result"')) output += decoder.decode((await reader.read()).value);
  assert.match(output, /DEPLOY_AUTOMATIC_SHORT_RAMP/);
  assert.equal((await fetch(base + '/api/perception', { method: 'POST', headers, body: JSON.stringify(envelope('bad', { yolo_detections: [{ label: 'WHEELCHAIR', confidence: 'high' }] })) })).status, 400);
  assert.equal((await fetch(base + '/api/vehicle', { method: 'POST', headers, body: '{}' })).status, 404);
  assert.equal((await fetch(base + '/api/state', { headers: { ...headers, Origin: 'https://untrusted.example' } })).status, 403);
});
