import { readFileSync } from 'node:fs';
import { DeepSeekClient } from './deepseek.mjs';
import { SUMMARY_SCHEMA } from './contracts.mjs';
import { validate } from './schema.mjs';
import { normalizeInput, buildPolicy, ruleProposal, validateProposal, parametersFor, passengerCommunication, safeFallback } from './policy.mjs';

const SYSTEM = readFileSync(new URL('../prompts/system_prompt.txt', import.meta.url), 'utf8');
export const MODES = ['rules', 'single', 'two_turn'];

export async function plan(raw, { mode = 'single', client, onSummary } = {}) {
  if (!MODES.includes(mode)) throw new Error('INVALID_MODE');
  const started = performance.now();
  const meta = { mode, source: mode === 'rules' ? 'rules' : 'llm', model: null, api_calls: 0, usage: {}, latency_ms: 0, validation_passed: false };
  let context, policy, proposal, firstStage = null, rejection = null;
  const accumulate = result => {
    meta.model = result.model;
    for (const [k, v] of Object.entries(result.usage ?? {})) meta.usage[k] = (meta.usage[k] ?? 0) + v;
  };
  try {
    context = normalizeInput(raw);
    policy = buildPolicy(context);
    if (mode === 'rules' || policy.scenario === 'emergency' || policy.scenario === 'wait') {
      proposal = ruleProposal(context, policy);
      if (mode !== 'rules') meta.source = 'safety_rules';
    }
    else {
      const api = client ?? new DeepSeekClient();
      const messages = [{ role: 'system', content: SYSTEM }, {
        role: 'user', content: JSON.stringify({ phase: mode === 'two_turn' ? 'summary' : 'action', context, policy }),
      }];
      if (mode === 'two_turn') {
        meta.api_calls++;
        const result = await api.complete(messages, { phase: 'summary' });
        accumulate(result);
        const errors = validate(result.value, SUMMARY_SCHEMA);
        if (errors.length || result.value.request_id !== context.request_id) throw new Error('SUMMARY_INVALID');
        firstStage = result.value;
        if (onSummary) await onSummary(firstStage);
        messages.push({ role: 'assistant', content: JSON.stringify(firstStage) });
        messages.push({ role: 'user', content: JSON.stringify({ phase: 'action', instruction: 'Return the final JSON in English using the original context and policy. The summary cannot replace the source facts.' }) });
      }
      meta.api_calls++;
      const result = await api.complete(messages, { phase: 'action' });
      accumulate(result);
      proposal = result.value;
    }
    const errors = validateProposal(proposal, context, policy);
    if (errors.length) { rejection = errors; throw new Error('MODEL_OUTPUT_REJECTED'); }
    meta.validation_passed = true;
  } catch (error) {
    // Invalid input is never carried through to a model, and unknown types cannot authorize motion.
    if (!context) context = { request_id: typeof raw?.request_id === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(raw.request_id) ? raw.request_id : 'invalid-request', vehicle_context: raw?.vehicle_context?.emergency_stop_active === true ? { emergency_stop_active: true } : {} };
    const code = error.message.startsWith('INPUT_INVALID') ? 'INPUT_INVALID' : ['MODEL_OUTPUT_REJECTED', 'SUMMARY_INVALID'].includes(error.message) ? error.message : error.code ?? 'PLANNER_ERROR';
    const safe = safeFallback(context, code);
    proposal = safe.proposal;
    policy = { scenario: code === 'INPUT_INVALID' ? 'wait' : context.vehicle_context?.emergency_stop_active === true ? 'emergency' : 'wait', safety_flags: safe.flags };
    meta.source = 'safe_fallback';
    meta.error = code;
  }
  meta.latency_ms = Math.round(performance.now() - started);
  return {
    schema_version: '2.3', request_id: proposal.request_id,
    simulated: true, execution_authorized: false,
    presentation_mode: context.presentation_mode ?? null,
    vehicle_context_source: context.presentation_mode === 'WEB_DEMO' ? 'SIMULATED_SCENARIO' : 'SUPPLIED_CONTEXT',
    requires_fresh_vehicle_state: context.presentation_mode !== 'WEB_DEMO',
    plan_status: proposal.plan_status,
    boarding_target: proposal.boarding_target,
    equipment_target: proposal.equipment_target,
    cabin_navigation: policy.navigation_route && proposal.navigation_steps
      ? { ...policy.navigation_route, steps: proposal.navigation_steps, mode: 'map_based', simulated: true, requires_operator: true } : null,
    decision_summary: proposal.decision_summary,
    first_stage_summary: firstStage,
    action_plan: proposal.actions.map((action, i) => ({ step: i + 1, action, parameters: parametersFor(action, context) })),
    passenger_communication: passengerCommunication(context, policy, proposal.actions),
    requires_human_confirmation: true, boarding_complete: false,
    safety_flags: [...new Set([...policy.safety_flags, ...(rejection ?? [])])],
    meta,
  };
}

// Called with a NEW, trusted telemetry snapshot before a simulated actuator dispatch.
// Does not turn a plan into authorization. Real controller interlocks are outside this demo.
export function revalidateForSimulation(result, freshRaw) {
  if (result.meta?.source === 'safe_fallback') return { valid: false, errors: ['FALLBACK_NOT_DISPATCHABLE'] };
  try {
    const context = normalizeInput(freshRaw), policy = buildPolicy(context);
    const proposal = { request_id: result.request_id, plan_status: result.plan_status, decision_summary: result.decision_summary, actions: result.action_plan.map(a => a.action), boarding_target: result.boarding_target ?? null, equipment_target: result.equipment_target ?? null, navigation_steps: result.cabin_navigation?.steps ?? null };
    const errors = validateProposal(proposal, context, policy);
    const saved = result.cabin_navigation, route = policy.navigation_route;
    if (route ? !saved || saved.layout_id !== route.layout_id || saved.origin?.type !== route.origin.type || saved.origin?.id !== route.origin.id || saved.origin?.facing !== route.origin.facing || saved.target?.type !== route.target.type || saved.target?.id !== route.target.id || saved.mode !== 'map_based' || saved.simulated !== true || saved.requires_operator !== true : saved != null) errors.push('NAVIGATION_ROUTE_CHANGED_REPLAN_REQUIRED');
    if ((saved?.equipment_target?.type ?? null) !== (route?.equipment_target?.type ?? null) || (saved?.equipment_target?.id ?? null) !== (route?.equipment_target?.id ?? null)) errors.push('EQUIPMENT_ROUTE_CHANGED_REPLAN_REQUIRED');
    for (const a of result.action_plan) if (JSON.stringify(a.parameters) !== JSON.stringify(parametersFor(a.action, context))) errors.push('PARAMETERS_CHANGED_REPLAN_REQUIRED');
    return { valid: errors.length === 0, errors };
  } catch { return { valid: false, errors: ['FRESH_STATE_INVALID'] }; }
}
