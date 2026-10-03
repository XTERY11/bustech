import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { plan, revalidateForSimulation } from '../backend/planner/agent.mjs';
import { DeepSeekClient, DeepSeekError } from '../backend/planner/deepseek.mjs';
import { normalizeInput, buildPolicy, ruleProposal } from '../backend/planner/policy.mjs';
const cases = JSON.parse(readFileSync(new URL('../backend/examples/demo_cases.json', import.meta.url), 'utf8'));
const base = () => structuredClone(cases[0].input);
const mock = value => ({ model: 'mock', usage: { total_tokens: 10 }, value });
const proposal = input => ruleProposal(normalizeInput(input), buildPolicy(normalizeInput(input)));

for (const c of cases) test(`scenario: ${c.name}`, async () => {
  const result = await plan(c.input, { mode: 'rules' });
  assert.equal(result.plan_status, c.expected.status);
  assert.equal(result.meta.source, 'rules');
  assert.equal(result.execution_authorized, false);
  assert.equal(result.passenger_communication.language, 'en-SG');
  assert.doesNotMatch(JSON.stringify(result), /\p{Script=Han}/u);
  const actions = result.action_plan.map(a => a.action);
  c.expected.includes.forEach(a => assert.ok(actions.includes(a), `Missing ${a}`));
  c.expected.excludes.forEach(a => assert.ok(!actions.includes(a), `Unsafe ${a}`));
  if (result.plan_status === 'READY') {
    assert.ok(result.boarding_target, 'READY demo should have a boarding target');
    assert.ok(actions.includes('GUIDE_PASSENGER_TO_ASSIGNED_PLACE'));
  } else {
    assert.equal(result.boarding_target, null);
    assert.ok(!actions.includes('GUIDE_PASSENGER_TO_ASSIGNED_PLACE'));
  }
  assert.equal(result.meta.api_calls, 0);
});

test('passenger audio uses the public demo route and natural boarding guidance', async () => {
  const input = structuredClone(cases.find(c => c.name === 'visual').input);
  const result = await plan(input, { mode: 'rules' });
  assert.equal(result.passenger_communication.channel, 'EXTERNAL_AUDIO');
  assert.equal(
    result.passenger_communication.audio_text,
    'Route 400. Please keep clear of the entrance. Board only when the safety operator gives the signal. Proceed to seat S03 when the safety operator invites you to board.',
  );
  assert.equal(result.passenger_communication.display_text, null);
});

test('passenger route names replace underscores with spaces', async () => {
  const input = structuredClone(cases.find(c => c.name === 'visual').input);
  input.request.route_id = 'BLUE_LINE_2';
  input.vehicle_context.route_id = 'BLUE_LINE_2';
  const result = await plan(input, { mode: 'rules' });
  assert.match(result.passenger_communication.audio_text, /^Route BLUE LINE 2\./);
  assert.doesNotMatch(result.passenger_communication.audio_text, /_/);
});

test('trusted policy assigns an empty seat and injects the same target into guidance', async () => {
  const input = structuredClone(cases.find(c => c.name === 'crutch').input);
  const result = await plan(input, { mode: 'rules' });
  assert.deepEqual(result.boarding_target, { type: 'SEAT', id: 'S03' });
  const guideIndex = result.action_plan.findIndex(a => a.action === 'GUIDE_PASSENGER_TO_ASSIGNED_PLACE');
  const seatedIndex = result.action_plan.findIndex(a => a.action === 'WAIT_FOR_SEATED_AND_BELTED_CONFIRMATION');
  assert.ok(guideIndex >= 0 && guideIndex < seatedIndex);
  assert.deepEqual(result.action_plan[guideIndex].parameters, { target_type: 'SEAT', target_id: 'S03' });
  assert.match(result.passenger_communication.display_text, /seat S03/);

  input.vehicle_context.cabin.occupied_seat_ids.push('S03');
  assert.equal(revalidateForSimulation(result, input).valid, false);
  const next = await plan(input, { mode: 'rules' });
  assert.deepEqual(next.boarding_target, { type: 'SEAT', id: 'S02' });
  assert.ok(!input.vehicle_context.cabin.occupied_seat_ids.includes(next.boarding_target.id));
});

test('wheelchair uses the bay; known full cabin or occupied bay requires confirmation', async () => {
  const wheelchair = base();
  const ready = await plan(wheelchair, { mode: 'rules' });
  assert.deepEqual(ready.boarding_target, { type: 'WHEELCHAIR_BAY', id: 'WHEELCHAIR_BAY' });
  assert.deepEqual(
    ready.action_plan.find(a => a.action === 'GUIDE_PASSENGER_TO_ASSIGNED_PLACE').parameters,
    { target_type: 'WHEELCHAIR_BAY', target_id: 'WHEELCHAIR_BAY' },
  );

  wheelchair.vehicle_context.cabin.wheelchair_bay_occupied = true;
  const blockedBay = await plan(wheelchair, { mode: 'rules' });
  assert.equal(blockedBay.plan_status, 'NEEDS_CONFIRMATION');
  assert.equal(blockedBay.boarding_target, null);
  assert.ok(blockedBay.safety_flags.includes('NO_ACCESSIBLE_PLACE_AVAILABLE'));

  wheelchair.vehicle_context.cabin.wheelchair_bay_occupied = false;
  wheelchair.vehicle_context.cabin.occupied_seat_ids.push('F01');
  const foldableSeatInUse = await plan(wheelchair, { mode: 'rules' });
  assert.equal(foldableSeatInUse.plan_status, 'NEEDS_CONFIRMATION');
  assert.equal(foldableSeatInUse.boarding_target, null);

  const walking = structuredClone(cases.find(c => c.name === 'crutch').input);
  walking.vehicle_context.cabin.occupied_seat_ids = Array.from({ length: 16 }, (_, i) => `S${String(i + 1).padStart(2, '0')}`);
  const full = await plan(walking, { mode: 'rules' });
  assert.equal(full.plan_status, 'NEEDS_CONFIRMATION');
  assert.equal(full.boarding_target, null);
  assert.ok(full.safety_flags.includes('NO_ACCESSIBLE_PLACE_AVAILABLE'));
});

test('missing cabin remains backward compatible without inventing a destination', async () => {
  const input = base();
  delete input.vehicle_context.cabin;
  const result = await plan(input, { mode: 'rules' });
  assert.equal(result.plan_status, 'READY');
  assert.equal(result.boarding_target, null);
  assert.ok(!result.action_plan.some(a => a.action === 'GUIDE_PASSENGER_TO_ASSIGNED_PLACE'));
});

test('model target is compared by type and id, independent of JSON property order', async () => {
  const input = structuredClone(cases.find(c => c.name === 'crutch').input);
  const value = proposal(input);
  value.boarding_target = { id: value.boarding_target.id, type: value.boarding_target.type };
  const result = await plan(input, { client: { async complete() { return mock(value); } } });
  assert.equal(result.meta.source, 'llm');
  assert.equal(result.meta.validation_passed, true);
  assert.deepEqual(result.boarding_target, { id: 'S03', type: 'SEAT' });
});

test('every automatic-ramp interlock fails closed individually', async () => {
  const mutations = [
    x => delete x.vehicle_context.emergency_stop_active,
    x => { x.vehicle_context.motion_state = 'MOVING'; },
    x => { x.vehicle_context.parking_brake_engaged = false; },
    x => { x.vehicle_context.entrance_clear = null; },
    x => { x.vehicle_context.ramp_area_clear = null; },
    x => { x.vehicle_context.safety_operator_approval = false; },
    x => { x.vehicle_context.safety_operator_available = false; },
    x => { x.vehicle_context.wheelchair_area_ready = false; },
    x => { x.vehicle_context.hardware_capabilities.automatic_short_ramp = 'UNAVAILABLE'; },
    x => delete x.vehicle_context.hardware_capabilities.automatic_ramp_limits_verified,
    x => delete x.vehicle_context.hardware_capabilities.automatic_ramp_max_slope_deg,
    x => { x.perception.geometry.geometry_valid = false; },
    x => { x.perception.geometry.confidence = 0.1; },
    x => { x.perception.geometry.measured_slope_deg = 9; },
    x => delete x.perception.geometry.measured_gap_cm,
    x => delete x.perception.observation_age_ms,
  ];
  for (const mutate of mutations) {
    const input = base(); mutate(input);
    const result = await plan(input, { mode: 'rules' });
    assert.ok(!result.action_plan.some(a => a.action === 'DEPLOY_AUTOMATIC_SHORT_RAMP'));
  }
});

test('wrong types / negative ages / invalid confidence never reach API', async () => {
  const mutations = [
    x => { x.vehicle_context.parking_brake_engaged = 'true'; },
    x => { x.vehicle_context.observation_age_ms = -1; },
    x => { x.perception.geometry.measured_gap_cm = NaN; },
    x => { x.perception.yolo_detections[0].confidence = 2; },
    x => { x.request.active = 1; },
    x => { x.request_id = 'injected\ntext'; },
    x => { x.vehicle_context.cabin.occupied_seat_ids.push('S99'); },
    x => { x.vehicle_context.cabin.occupied_seat_ids.push('S01'); },
    x => { x.vehicle_context.cabin.wheelchair_bay_occupied = 'false'; },
  ];
  for (const mutate of mutations) {
    const input = base(); mutate(input);
    const result = await plan(input, { client: { complete() { assert.fail('API must not be called'); } } });
    assert.equal(result.meta.error, 'INPUT_INVALID');
    assert.equal(result.meta.api_calls, 0);
  }
});

test('single call strips private/free-text data and keeps provenance', async () => {
  const input = base(); input.request.notes = 'secret-person'; input.request.name = 'Alice';
  const calls = [];
  const result = await plan(input, { client: { async complete(messages) { calls.push(messages); return mock(proposal(input)); } } });
  assert.equal(calls.length, 1);
  assert.ok(!JSON.stringify(calls).includes('secret-person'));
  assert.ok(!JSON.stringify(calls).includes('Alice'));
  assert.equal(result.meta.source, 'llm');
  assert.equal(result.meta.validation_passed, true);
});

test('two turns retain original input and pass only short summary, then validate', async () => {
  const input = base(), calls = [], displayed = [];
  const result = await plan(input, { mode: 'two_turn', onSummary: s => displayed.push(s), client: {
    async complete(messages, { phase }) {
      calls.push(structuredClone(messages));
      return mock(phase === 'summary' ? { request_id: input.request_id, decision_summary: ['Test fact summary'] } : proposal(input));
    },
  } });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].length, 4);
  assert.equal(calls[1][1].content, calls[0][1].content);
  assert.equal(calls[1][2].role, 'assistant');
  assert.equal(displayed.length, 1);
  assert.equal(result.meta.usage.total_tokens, 20);
});

test('injected, incomplete, wrong-status, reordered or foreign-id actions are rejected', async () => {
  for (const mutate of [
    p => p.actions.push('DRIVE_AWAY'),
    p => { p.actions = []; },
    p => p.actions.reverse(),
    p => { p.plan_status = 'CANNOT_EXECUTE'; },
    p => { p.request_id = 'other-request'; },
    p => p.actions.push(p.actions[0]),
    p => { p.actuator_voltage = 240; },
    p => { delete p.boarding_target; },
    p => { p.boarding_target = { type: 'SEAT', id: 'S02' }; },
  ]) {
    const input = base(), bad = proposal(input); mutate(bad);
    const result = await plan(input, { client: { async complete() { return mock(bad); } } });
    assert.equal(result.meta.error, 'MODEL_OUTPUT_REJECTED');
    assert.ok(!result.action_plan.some(a => a.action.includes('RAMP')));
    assert.equal(result.meta.source, 'safe_fallback');
  }
});

test('model cannot add ramp to crutch plan', async () => {
  for (const name of ['crutch']) {
    const input = cases.find(c => c.name === name).input;
    const bad = proposal(input); bad.actions.push('DEPLOY_AUTOMATIC_SHORT_RAMP');
    const result = await plan(input, { client: { async complete() { return mock(bad); } } });
    assert.equal(result.meta.source, 'safe_fallback');
    assert.ok(!result.action_plan.some(a => a.action.includes('RAMP')));
  }
});

test('emergency and unsafe vehicle states bypass the cloud immediately', async () => {
  for (const name of ['emergency_stop', 'stale_vehicle', 'entrance_blocked']) {
    const input = cases.find(c => c.name === name).input;
    const result = await plan(input, { client: { async complete() { assert.fail('Unsafe state must bypass cloud'); } } });
    assert.equal(result.meta.source, 'safety_rules');
    assert.equal(result.meta.api_calls, 0);
    assert.ok(!result.action_plan.some(a => a.action.includes('RAMP')));
    if (name === 'emergency_stop') assert.deepEqual(result.action_plan.map(a => a.action), ['ABORT_ASSISTANCE_SEQUENCE', 'REQUEST_ONBOARD_SAFETY_OPERATOR']);
  }
});

test('API errors, timeout and malformed summary fail closed without retries', async () => {
  for (const code of ['API_HTTP_401', 'API_HTTP_402', 'API_HTTP_429', 'API_TIMEOUT', 'API_INVALID_JSON']) {
    let count = 0;
    const result = await plan(base(), { client: { async complete() { count++; throw new DeepSeekError(code); } } });
    assert.equal(result.meta.error, code); assert.equal(count, 1);
    assert.ok(!result.action_plan.some(a => a.action.includes('RAMP')));
  }
  const result = await plan(base(), { mode: 'two_turn', client: { async complete() { return mock({ actions: ['DRIVE_AWAY'] }); } } });
  assert.equal(result.meta.error, 'SUMMARY_INVALID'); assert.equal(result.meta.api_calls, 1);
});

test('real transport shape disables thinking, caps output, and refuses redirects', async () => {
  const client = new DeepSeekClient({ apiKey: 'test-only', fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body);
    assert.deepEqual(body.thinking, { type: 'disabled' });
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.equal(body.max_tokens, 800);
    return new Response(JSON.stringify({ model: 'test', choices: [{ finish_reason: 'stop', message: { content: '{}', reasoning_content: 'not retained' } }], usage: { total_tokens: 3 } }));
  } });
  const result = await client.complete([]);
  assert.ok(!JSON.stringify(result).includes('not retained'));
});

test('fresh-state revalidation rejects new obstruction, changed geometry and wrong request', async () => {
  const input = base(); const result = await plan(input, { mode: 'rules' });
  assert.equal(revalidateForSimulation(result, input).valid, true);
  for (const mutate of [
    x => { x.vehicle_context.entrance_clear = false; },
    x => { x.vehicle_context.emergency_stop_active = true; },
    x => { x.perception.geometry.measured_gap_cm = 9; },
    x => { x.request_id = 'another-request'; },
    x => { x.vehicle_context.observation_age_ms = 1501; },
    x => { x.vehicle_context.cabin.wheelchair_bay_occupied = true; },
  ]) {
    const changed = base(); mutate(changed);
    assert.equal(revalidateForSimulation(result, changed).valid, false);
  }
});

