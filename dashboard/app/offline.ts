import { normalizeInput, buildPolicy, ruleProposal, parametersFor, passengerCommunication } from '../backend/planner/policy.mjs';
import type { Context, Result } from './live-types';
export function offlinePlan(input: Context): Result {
  const context = normalizeInput({ ...input, presentation_mode: 'WEB_DEMO' }), policy = buildPolicy(context), proposal = ruleProposal(context, policy);
  return {
    ...proposal, simulated: true, execution_authorized: false,
    action_plan: proposal.actions.map((action: string, i: number) => ({ step: i + 1, action, parameters: parametersFor(action, context) })),
    passenger_communication: passengerCommunication(context, policy, proposal.actions), safety_flags: policy.safety_flags,
    meta: { mode: 'rules', source: 'browser_rules', model: null, api_calls: 0, latency_ms: 0, validation_passed: true, usage: {} },
  };
}
