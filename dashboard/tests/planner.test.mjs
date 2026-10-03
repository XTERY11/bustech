import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { plan, revalidateForSimulation } from '../backend/planner/agent.mjs';
import { DeepSeekClient, DeepSeekError } from '../backend/planner/deepseek.mjs';
import { normalizeInput, buildPolicy, ruleProposal, boardingTargetFor } from '../backend/planner/policy.mjs';
import { SEAT_IDS } from '../backend/planner/contracts.mjs';
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
    assert.equal(body.max_tokens, 1400);
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

test('all fixtures use the same mixed cabin occupancy as the twin', () => {
  const expected = { layout_id: 'byd-b70a02-photo-v1', occupied_seat_ids: ['S01', 'S04', 'S06', 'S08', 'S10', 'S13', 'S15'], wheelchair_bay_occupied: false };
  const fixture = JSON.parse(readFileSync(new URL('../backend/examples/input.json', import.meta.url), 'utf8'));
  for (const input of [fixture, ...cases.map(c => c.input)]) assert.deepEqual(input.vehicle_context.cabin, expected);
});

test('trusted cabin destinations are echoed in the result, guidance action and short summary', async () => {
  for (const [name, target] of [['wheelchair_auto', { type: 'WHEELCHAIR_BAY', id: 'WHEELCHAIR_BAY' }], ['crutch', { type: 'SEAT', id: 'S03' }]]) {
    const result = await plan(cases.find(c => c.name === name).input, { mode: 'rules' });
    assert.equal(result.schema_version, '2.2');
    assert.deepEqual(result.boarding_target, target);
    assert.deepEqual(result.action_plan.find(a => a.action === 'GUIDE_PASSENGER_TO_ASSIGNED_PLACE').parameters, { target_type: target.type, target_id: target.id });
    assert.ok(result.decision_summary.length <= 3);
    assert.match(result.decision_summary.join(' '), target.type === 'SEAT' ? /Seat S03/ : /wheelchair bay/);
  }
});

test('one booking keeps its seat across reruns and all planner modes, while new bookings can vary', async () => {
  const input = structuredClone(cases.find(c => c.name === 'crutch').input);
  input.booking_event_id = 'stable-booking';
  const expected = boardingTargetFor(input);
  for (const mode of ['rules', 'single', 'two_turn']) {
    input.request_id = `rerun-${mode}`;
    const result = await plan(input, { mode, client: { async complete(messages, { phase }) {
      const { context, policy } = JSON.parse(messages[1].content);
      return mock(phase === 'summary' ? { request_id: context.request_id, decision_summary: ['A low-floor place is assigned.'] } : ruleProposal(context, policy));
    } } });
    assert.equal(result.meta.validation_passed, true);
    assert.deepEqual(result.boarding_target, expected);
  }
  const destinations = new Set();
  for (let i = 0; i < 24; i++) {
    input.booking_event_id = `booking-${i}`;
    const target = boardingTargetFor(input);
    assert.ok(['S03', 'S02', 'S09'].includes(target.id));
    destinations.add(target.id);
  }
  assert.ok(destinations.size > 1, 'New booking IDs should not always receive the same seat');
  delete input.booking_event_id;
  assert.deepEqual(boardingTargetFor(input), { type: 'SEAT', id: 'S03' }, 'Legacy demos keep their deterministic destination');
});

test('seat assignment stays in the highest available safe tier and fails closed when that area is full', async () => {
  const input = structuredClone(cases.find(c => c.name === 'crutch').input);
  input.vehicle_context.cabin.occupied_seat_ids = [];
  assert.equal(boardingTargetFor(input).id, 'S03');
  input.vehicle_context.cabin.occupied_seat_ids = ['S03', 'S02', 'S09', 'S06'];
  assert.equal(boardingTargetFor(input).id, 'S05');
  input.vehicle_context.cabin.occupied_seat_ids.push('S05');
  assert.equal(boardingTargetFor(input).id, 'S08');
  input.vehicle_context.cabin.occupied_seat_ids.push('S08');
  const unsuitable = await plan(input, { mode: 'rules' });
  assert.equal(unsuitable.plan_status, 'NEEDS_CONFIRMATION');
  assert.equal(unsuitable.boarding_target, null);
  assert.ok(unsuitable.safety_flags.includes('NO_ACCESSIBLE_PLACE_AVAILABLE'));
  assert.ok(!unsuitable.action_plan.some(a => a.action === 'GUIDE_PASSENGER_TO_ASSIGNED_PLACE'));
  input.vehicle_context.cabin.occupied_seat_ids = [...SEAT_IDS];
  assert.equal((await plan(input, { mode: 'rules' })).plan_status, 'NEEDS_CONFIRMATION');
});

test('missing cabin and occupied wheelchair bay or foldable seat cannot yield an assigned place', async () => {
  for (const mutate of [
    x => { delete x.vehicle_context.cabin; },
    x => { x.vehicle_context.cabin.wheelchair_bay_occupied = true; },
    x => { x.vehicle_context.cabin.occupied_seat_ids.push('F01'); },
  ]) {
    const input = base(); mutate(input);
    const result = await plan(input, { mode: 'rules' });
    assert.equal(result.plan_status, 'NEEDS_CONFIRMATION');
    assert.equal(result.boarding_target, null);
    assert.ok(!result.action_plan.some(a => a.action === 'GUIDE_PASSENGER_TO_ASSIGNED_PLACE'));
  }
});

test('ramp assistance for a cane or stroller does not assign a wheelchair bay', async () => {
  for (const need of ['CANE', 'STROLLER']) {
    const input = base();
    input.request.accessibility_need = need;
    const result = await plan(input, { mode: 'rules' });
    assert.equal(result.plan_status, 'READY');
    assert.deepEqual(result.boarding_target, { type: 'SEAT', id: 'S03' });
    assert.ok(result.action_plan.some(a => a.action === 'DEPLOY_AUTOMATIC_SHORT_RAMP'));
    assert.ok(!result.action_plan.some(a => a.action === 'PREPARE_WHEELCHAIR_AREA'));
  }
});

test('cabin and booking/visit identities are schema checked before any model call', async () => {
  for (const mutate of [
    x => { x.booking_event_id = 'invalid booking'; },
    x => { x.perception.zone = { visit_id: 'invalid visit' }; },
    x => { x.vehicle_context.cabin.layout_id = 'unknown-layout'; },
    x => { x.vehicle_context.cabin.occupied_seat_ids.push('S99'); },
    x => { x.vehicle_context.cabin.occupied_seat_ids.push('S01'); },
    x => { x.vehicle_context.cabin.wheelchair_bay_occupied = 'false'; },
    x => { delete x.vehicle_context.cabin.occupied_seat_ids; },
  ]) {
    const input = base(); mutate(input);
    const result = await plan(input, { client: { complete() { assert.fail('Invalid cabin or identity must not reach the model'); } } });
    assert.equal(result.meta.error, 'INPUT_INVALID');
    assert.equal(result.boarding_target, null);
    assert.equal(result.meta.api_calls, 0);
  }
  const input = base(); input.booking_event_id = 'booking:stable-01'; input.perception.zone = { triggered: true, event: 'enter', visit_id: 'visit:01' };
  assert.equal(normalizeInput(input).perception.zone.visit_id, 'visit:01');
});

test('missing, invented, occupied or semantically invalid model destinations are rejected', async () => {
  const input = structuredClone(cases.find(c => c.name === 'crutch').input);
  for (const mutate of [
    p => { delete p.boarding_target; },
    p => { p.boarding_target = null; },
    p => { p.boarding_target = { type: 'SEAT', id: 'S01' }; },
    p => { p.boarding_target = { type: 'SEAT', id: 'S99' }; },
    p => { p.boarding_target = { type: 'SEAT', id: 'F01' }; },
    p => { p.boarding_target = { type: 'SEAT', id: 'WHEELCHAIR_BAY' }; },
    p => { p.boarding_target = { type: 'WHEELCHAIR_BAY', id: 'S03' }; },
    p => { p.boarding_target.extra = 'select-this'; },
  ]) {
    const bad = proposal(input); mutate(bad);
    const result = await plan(input, { client: { async complete() { return mock(bad); } } });
    assert.equal(result.meta.error, 'MODEL_OUTPUT_REJECTED');
    assert.equal(result.boarding_target, null);
    assert.ok(!result.action_plan.some(a => a.action === 'GUIDE_PASSENGER_TO_ASSIGNED_PLACE'));
  }
  const reordered = proposal(input); reordered.boarding_target = { id: 'S03', type: 'SEAT' };
  const accepted = await plan(input, { client: { async complete() { return mock(reordered); } } });
  assert.equal(accepted.meta.validation_passed, true, 'Target equality is semantic, not JSON property order');
});

test('revalidation rejects occupied destinations and tampered guidance parameters', async () => {
  const input = structuredClone(cases.find(c => c.name === 'crutch').input);
  input.booking_event_id = 'stable-seat';
  const result = await plan(input, { mode: 'rules' });
  const occupied = structuredClone(input); occupied.vehicle_context.cabin.occupied_seat_ids.push(result.boarding_target.id);
  assert.equal(revalidateForSimulation(result, occupied).valid, false);
  const tampered = structuredClone(result); tampered.action_plan.find(a => a.action === 'GUIDE_PASSENGER_TO_ASSIGNED_PLACE').parameters.target_id = 'S01';
  assert.equal(revalidateForSimulation(tampered, input).valid, false);
  const wrongTarget = structuredClone(result); wrongTarget.boarding_target = { type: 'SEAT', id: 'S01' };
  assert.equal(revalidateForSimulation(wrongTarget, input).valid, false);
});

test('the model verbalises a trusted route in English for a passenger requesting visual assistance', async () => {
  const input = structuredClone(cases.find(c => c.name === 'visual').input);
  input.request.language = 'zh-CN';
  let called = 0;
  const result = await plan(input, { client: { async complete(messages) {
    called++;
    const { context, policy } = JSON.parse(messages[1].content);
    assert.equal(policy.navigation_route.origin.facing, 'INTO_BUS');
    const value = ruleProposal(context, policy);
    value.navigation_steps = value.navigation_steps.map(step => ({ ...step, text: step.maneuver === 'START'
      ? 'At the entrance, face into the bus.'
      : step.maneuver === 'STRAIGHT' ? `Move straight ahead for ${step.distance_m} metres.`
      : step.maneuver === 'TURN_LEFT' ? 'Please turn left.'
      : step.maneuver === 'TURN_RIGHT' ? 'Please turn right.'
      : `Arrive at seat ${policy.boarding_target.id}. Please wait for the safety operator.` }));
    return mock(value);
  } } });
  assert.equal(called, 1);
  assert.equal(result.meta.source, 'llm');
  assert.equal(result.meta.validation_passed, true);
  assert.equal(result.schema_version, '2.2');
  assert.equal(result.cabin_navigation.mode, 'map_based');
  assert.equal(result.cabin_navigation.simulated, true);
  assert.equal(result.cabin_navigation.requires_operator, true);
  assert.deepEqual(result.cabin_navigation.target, result.boarding_target);
  assert.deepEqual(result.cabin_navigation.origin, { type: 'ENTRANCE', id: 'SINGLE_ENTRANCE', facing: 'INTO_BUS' });
  assert.match(result.cabin_navigation.steps.find(step => step.maneuver === 'STRAIGHT').text, /straight ahead/);
});

test('invented route fields, reversed instructions, altered distances and unsupported navigation language fail closed', async () => {
  const input = structuredClone(cases.find(c => c.name === 'crutch').input);
  const firstStraight = p => p.navigation_steps.find(step => step.maneuver === 'STRAIGHT');
  const firstTurn = p => p.navigation_steps.find(step => step.maneuver === 'TURN_RIGHT');
  const arrive = p => p.navigation_steps.at(-1);
  for (const mutate of [
    p => { delete p.navigation_steps; },
    p => { p.navigation_steps = null; },
    p => { p.navigation_steps.shift(); },
    p => { p.navigation_steps.pop(); },
    p => { p.navigation_steps.reverse(); },
    p => { const turn = firstTurn(p); turn.maneuver = 'TURN_LEFT'; turn.text = 'Turn left.'; },
    p => { firstTurn(p).text = 'Turn left.'; },
    p => { firstTurn(p).text = 'Do not turn right.'; },
    p => { firstStraight(p).distance_m += 1; },
    p => { firstStraight(p).text = 'Continue straight for 100 metres.'; },
    p => { firstStraight(p).text = `Continue straight for ${firstStraight(p).distance_m} metres, then turn left.`; },
    p => { p.navigation_steps[0].text = 'From the entrance, face out of the bus.'; },
    p => { arrive(p).text = 'Arrive at seat S02 and wait for the operator.'; },
    p => { arrive(p).text = 'Arrive at seat S03. Your belt is secure; the bus may depart.'; },
    p => { firstTurn(p).text = 'Turn right at the rear window.'; },
    p => { firstTurn(p).text = 'Turn right through 90 degrees.'; },
    p => { firstTurn(p).text = '向右转 Turn right.'; },
    p => { firstStraight(p).text = 'x'.repeat(201); },
  ]) {
    const bad = proposal(input); mutate(bad);
    const result = await plan(input, { client: { async complete() { return mock(bad); } } });
    assert.equal(result.meta.error, 'MODEL_OUTPUT_REJECTED');
    assert.equal(result.meta.source, 'safe_fallback');
    assert.equal(result.cabin_navigation, null);
    assert.equal(result.boarding_target, null);
    assert.ok(!result.action_plan.some(action => action.action === 'GUIDE_PASSENGER_TO_ASSIGNED_PLACE'));
  }
});

test('a plan without an assigned target has no route, and an invented route is forbidden', async () => {
  const input = structuredClone(cases.find(c => c.name === 'yolo_only').input);
  const expected = proposal(input);
  assert.equal(expected.navigation_steps, null);
  const legitimate = await plan(input, { mode: 'rules' });
  assert.equal(legitimate.cabin_navigation, null);
  const bad = structuredClone(expected); bad.navigation_steps = proposal(base()).navigation_steps;
  const result = await plan(input, { client: { async complete() { return mock(bad); } } });
  assert.equal(result.meta.error, 'MODEL_OUTPUT_REJECTED');
  assert.equal(result.cabin_navigation, null);
});

test('fresh-state revalidation checks map origin, target, maneuvers, distances and spoken directions', async () => {
  const input = structuredClone(cases.find(c => c.name === 'crutch').input);
  const result = await plan(input, { mode: 'rules' });
  assert.equal(revalidateForSimulation(result, input).valid, true);
  for (const mutate of [
    r => { r.cabin_navigation.layout_id = 'different-map'; },
    r => { r.cabin_navigation.origin.facing = 'OUT_OF_BUS'; },
    r => { r.cabin_navigation.origin.id = 'UNKNOWN_DOOR'; },
    r => { r.cabin_navigation.target.id = 'S02'; },
    r => { r.cabin_navigation.mode = 'live_tracking'; },
    r => { r.cabin_navigation.requires_operator = false; },
    r => { r.cabin_navigation.steps.find(step => step.maneuver === 'TURN_RIGHT').maneuver = 'TURN_LEFT'; },
    r => { r.cabin_navigation.steps.find(step => step.maneuver === 'STRAIGHT').distance_m = 12; },
    r => { r.cabin_navigation.steps.find(step => step.maneuver === 'TURN_RIGHT').text = 'Turn left.'; },
  ]) {
    const tampered = structuredClone(result); mutate(tampered);
    assert.equal(revalidateForSimulation(tampered, input).valid, false);
  }
});

