import { ACTIONS, INPUT_SCHEMA, MODEL_OUTPUT_SCHEMA } from './contracts.mjs';
import { project, validate } from './schema.mjs';

export const THRESHOLDS = Object.freeze({ vehicle_age_ms: 1500, perception_age_ms: 1500, app_age_ms: 300000, yolo_confidence: 0.75, geometry_confidence: 0.85 });
const available = x => x === 'AVAILABLE' || x === 'AVAILABLE_FOR_DEMO';
const fresh = (age, max) => typeof age === 'number' && age >= 0 && age <= max;
const number = x => typeof x === 'number' && Number.isFinite(x);
export function normalizeInput(raw) {
  const errors = validate(raw, INPUT_SCHEMA);
  if (errors.length) throw new Error(`INPUT_INVALID: ${errors.slice(0, 6).join('; ')}`);
  // Drop names, free-text notes, images, bboxes, tokens, and unrecognized fields before sending to API.
  return project(raw, INPUT_SCHEMA);
}

export function buildPolicy(context) {
  const r = context.request ?? {}, p = context.perception ?? {}, v = context.vehicle_context ?? {};
  const h = v.hardware_capabilities ?? {}, g = p.geometry ?? {};
  const flags = [], facts = [], required = [], optional = [];
  let status = 'READY', scenario = 'general';
  const add = (...actions) => { for (const a of actions) if (!required.includes(a)) required.push(a); };
  const needs = (flag, fact) => { status = 'NEEDS_CONFIRMATION'; flags.push(flag); facts.push(fact); add('REQUEST_ONBOARD_SAFETY_OPERATOR'); };
  const finish = () => {
    const allowed = [...new Set([...required, ...optional])].sort((a, b) => ACTIONS.indexOf(a) - ACTIONS.indexOf(b));
    return { plan_status: status, scenario, required_actions: allowed.filter(a => required.includes(a)), allowed_actions: allowed, facts, safety_flags: flags };
  };
  if (v.emergency_stop_active === true) {
    status = 'CANNOT_EXECUTE'; scenario = 'emergency'; flags.push('EMERGENCY_STOP');
    facts.push('Emergency stop is active. Abort boarding assistance and notify the operator.');
    add('ABORT_ASSISTANCE_SEQUENCE', 'REQUEST_ONBOARD_SAFETY_OPERATOR');
    return finish();
  }
  const vehicleFresh = fresh(v.observation_age_ms, THRESHOLDS.vehicle_age_ms);
  if (v.motion_state === 'STOPPED' && vehicleFresh) add('HOLD_AT_STOP');
  if (!vehicleFresh || v.emergency_stop_active !== false || v.motion_state !== 'STOPPED' || v.parking_brake_engaged !== true) {
    scenario = 'wait'; needs('VEHICLE_NOT_READY', 'Stopping, parking brake, emergency state or data freshness is unconfirmed. Wait for the operator.');
    return finish();
  }
  if (v.supervision_mode !== 'ONBOARD_SAFETY_OPERATOR' || v.safety_operator_available !== true) {
    scenario = 'wait'; needs('OPERATOR_UNAVAILABLE', 'The scenario requires an onboard operator, whose availability is not confirmed.'); return finish();
  }
  const appFresh = r.active === true && fresh(r.observation_age_ms, THRESHOLDS.app_age_ms) && r.intent === 'BOARDING';
  const button = v.wheelchair_button_pressed === true;
  const requests = appFresh ? (r.assistance_requested ?? []) : [];
  const need = appFresh ? r.accessibility_need : 'UNKNOWN';
  const perceptionFresh = fresh(p.observation_age_ms, THRESHOLDS.perception_age_ms);
  const aids = (p.yolo_detections ?? []).filter(d => ['WHEELCHAIR', 'CRUTCH', 'CANE', 'WALKER', 'STROLLER'].includes(d.label));
  const confidentAids = perceptionFresh ? aids.filter(d => number(d.confidence) && d.confidence >= THRESHOLDS.yolo_confidence) : [];
  const usableAids = p.target_match_confirmed === true ? confidentAids : [];
  if (aids.length && !perceptionFresh) flags.push('STALE_PERCEPTION');
  if (confidentAids.length && p.target_match_confirmed !== true) flags.push('YOLO_TARGET_UNMATCHED');
  if (aids.length && !confidentAids.length && perceptionFresh) flags.push('LOW_CONFIDENCE_YOLO');
  if (appFresh) facts.push(`The app booking requests ${need ?? 'UNKNOWN'}. A missed visual detection does not cancel the booking.`);
  if (button) facts.push('The wheelchair button provides an explicit assistance request.');
  if (!appFresh && r.active === true) flags.push('APP_REQUEST_STALE_OR_NOT_BOARDING');

  if (!appFresh && !button) {
    scenario = 'confirm';
    needs('REQUEST_NOT_CONFIRMED', usableAids.length ? 'YOLO detected a mobility aid, but no active booking or button request is confirmed.' : 'Boarding assistance needs are unconfirmed. Ask the operator to check with the passenger.');
    return finish();
  }
  if (appFresh && (!r.route_id || !r.stop_id || !v.route_id || !v.stop_id || r.route_id !== v.route_id || r.stop_id !== v.stop_id)) {
    scenario = 'confirm'; needs('ROUTE_OR_STOP_MISMATCH', 'The booking route or stop does not match the current vehicle context.'); return finish();
  }
  if (v.entrance_clear !== true) {
    scenario = 'wait'; add('CHECK_SINGLE_ENTRANCE_CLEARANCE');
    needs('ENTRANCE_NOT_CLEAR', 'Entrance clearance is unconfirmed. Keep waiting.'); return finish();
  }
  if (!['STOWED', 'DEPLOYED'].includes(v.ramp_state) || !['OPEN', 'CLOSED'].includes(v.single_entrance_state)) {
    scenario = 'wait'; needs('DOOR_OR_RAMP_TRANSITION', 'The door or ramp state is unknown or moving. Wait for an updated state before planning again.'); return finish();
  }
  if (v.ramp_state === 'DEPLOYED' && v.single_entrance_state !== 'OPEN') {
    scenario = 'wait'; needs('INCONSISTENT_HARDWARE_STATE', 'Door and ramp states are inconsistent. Ask the operator to check.'); return finish();
  }
  const declined = appFresh && r.ramp_preference === 'DECLINED';
  const rampRequested = requests.includes('WHEELCHAIR_RAMP') || r.ramp_preference === 'REQUESTED' && appFresh || button;
  const wheelchair = need === 'WHEELCHAIR' || requests.includes('WHEELCHAIR_RAMP') || button;
  add('CHECK_SINGLE_ENTRANCE_CLEARANCE', 'KEEP_SINGLE_ENTRANCE_CLEAR', 'EXTEND_DWELL_TIME', 'WAIT_FOR_BOARDING_CONFIRMATION', 'WAIT_FOR_SEATED_AND_BELTED_CONFIRMATION');
  if (wheelchair) add('PREPARE_WHEELCHAIR_AREA');

  if (declined && rampRequested) {
    scenario = 'confirm'; needs('CONFLICTING_RAMP_REQUEST', 'A declined ramp conflicts with another ramp request. Confirm the passenger preference first.');
    if (v.ramp_state === 'STOWED') add('KEEP_RAMPS_STOWED');
  } else if (rampRequested && !declined) {
    if (v.ramp_area_clear !== true || v.wheelchair_area_ready !== true) {
      scenario = 'wait'; needs('BOARDING_AREA_NOT_READY', 'Ramp clearance or boarding-area readiness is unconfirmed.');
    } else if (v.ramp_state === 'DEPLOYED') {
      scenario = 'ramp_ready'; facts.push('The ramp is already deployed. Do not deploy it again; wait for operator guidance.');
    } else if (v.single_entrance_state !== 'OPEN') {
      scenario = 'door_first'; add('OPEN_SINGLE_ENTRANCE');
      facts.push('Request door opening first. Plan ramp deployment after receiving an open-door state.');
    } else {
      const measurementsValid = perceptionFresh && g.geometry_valid === true && number(g.confidence) && g.confidence >= THRESHOLDS.geometry_confidence;
      const withinLimits = h.automatic_ramp_limits_verified === true &&
        number(h.automatic_ramp_max_gap_cm) && h.automatic_ramp_max_gap_cm > 0 &&
        number(h.automatic_ramp_max_slope_deg) && h.automatic_ramp_max_slope_deg > 0 &&
        number(g.measured_gap_cm) && number(g.measured_slope_deg) &&
        g.measured_gap_cm <= h.automatic_ramp_max_gap_cm && g.measured_slope_deg <= h.automatic_ramp_max_slope_deg;
      if (available(h.automatic_short_ramp) && measurementsValid && withinLimits && v.safety_operator_approval === true) {
        scenario = 'auto_ramp'; add('DEPLOY_AUTOMATIC_SHORT_RAMP');
        facts.push(context.presentation_mode === 'WEB_DEMO'
          ? 'A ramp is requested. The simulated stop, door, ramp limits and approval conditions are satisfied; show ramp deployment.'
          : 'The ramp request, measurements, verified limits and operator approval meet the conditions for simulated ramp deployment.');
      } else {
        scenario = 'manual_ramp'; needs('AUTO_RAMP_NOT_APPROVED', 'Automatic ramp conditions are incomplete. A nominal 30 cm ramp length does not establish safe operating limits.');
        if (available(h.manual_ramp)) add('REQUEST_MANUAL_RAMP_DEPLOYMENT');
        else flags.push('MANUAL_RAMP_UNAVAILABLE');
      }
    }
  } else {
    if (v.ramp_state === 'STOWED') add('KEEP_RAMPS_STOWED');
    if (v.single_entrance_state === 'CLOSED' && v.ramp_state === 'STOWED') add('OPEN_SINGLE_ENTRANCE');
    if (wheelchair && !declined) {
      scenario = 'confirm'; needs('RAMP_PREFERENCE_UNKNOWN', 'The booking indicates wheelchair assistance without an explicit ramp request. Confirm the preference first.');
    } else facts.push('No ramp was requested. Allow extra boarding time and keep the ramp stowed.');
  }
  if (need === 'VISUAL_ASSISTANCE' || requests.includes('AUDIO_BOARDING_GUIDANCE') || ['AUDIO', 'BOTH'].includes(r.preferred_interaction) && appFresh) {
    if (available(h.external_speaker)) { add('ACTIVATE_EXTERNAL_SPEAKER'); if (v.route_id) add('CONFIRM_ROUTE_IDENTITY'); }
    else needs('AUDIO_UNAVAILABLE', 'Audio guidance is unavailable. Ask the operator to assist.');
    if (v.single_entrance_state === 'OPEN' && available(h.entrance_audio_beacon) && !['wait', 'confirm', 'manual_ramp', 'auto_ramp'].includes(scenario)) optional.push('PLAY_ENTRANCE_AUDIO_BEACON');
  }
  if (need === 'HEARING_ASSISTANCE' || requests.includes('VISUAL_BOARDING_GUIDANCE') || ['VISUAL', 'BOTH'].includes(r.preferred_interaction) && appFresh) {
    if (available(h.external_display)) add('SHOW_EXTERNAL_DISPLAY');
    else if (need === 'HEARING_ASSISTANCE') needs('DISPLAY_UNAVAILABLE', 'The external display is unavailable. Ask the operator to provide visible guidance.');
  }
  if ((need === 'UNKNOWN' || need == null) && !button) needs('NEED_UNKNOWN', 'The booking does not specify an assistance need. Await operator confirmation.');
  return finish();
}

export function ruleProposal(context, policy) {
  return { request_id: context.request_id, plan_status: policy.plan_status, decision_summary: policy.facts.slice(0, 3), actions: policy.required_actions };
}

export function validateProposal(proposal, context, policy) {
  const errors = validate(proposal, MODEL_OUTPUT_SCHEMA);
  if (errors.length) return errors;
  if (proposal.request_id !== context.request_id) errors.push('REQUEST_ID_MISMATCH');
  if (proposal.plan_status !== policy.plan_status) errors.push('STATUS_MISMATCH');
  for (const a of proposal.actions) if (!policy.allowed_actions.includes(a)) errors.push(`FORBIDDEN_ACTION:${a}`);
  for (const a of policy.required_actions) if (!proposal.actions.includes(a)) errors.push(`MISSING_REQUIRED_ACTION:${a}`);
  const order = proposal.actions.map(a => policy.allowed_actions.indexOf(a));
  if (order.some((x, i) => i > 0 && x <= order[i - 1])) errors.push('ACTION_ORDER_INVALID');
  return errors;
}

export function parametersFor(action, context) {
  if (action === 'EXTEND_DWELL_TIME') return { seconds: 60 };
  // HOLD is indefinite until a fresh state transition; a dwell timeout must not authorize departure.
  if (action === 'HOLD_AT_STOP') return { until: 'SAFETY_OPERATOR_RELEASE' };
  if (action === 'DEPLOY_AUTOMATIC_SHORT_RAMP') return {
    measured_gap_cm: context.perception.geometry.measured_gap_cm,
    measured_slope_deg: context.perception.geometry.measured_slope_deg,
  };
  if (action === 'CONFIRM_ROUTE_IDENTITY') return { route_id: context.vehicle_context.route_id };
  if (action === 'WAIT_FOR_SEATED_AND_BELTED_CONFIRMATION') return { source: 'ONBOARD_SAFETY_OPERATOR', wheelchair_securement: 'IF_APPLICABLE_OPERATOR_CONFIRMED' };
  return {};
}

export function passengerCommunication(context, policy, actions) {
  // Templates avoid broadcasting an unvalidated model summary or claiming a proposal succeeded.
  const route = context.vehicle_context?.route_id;
  const passengerRoute = route === 'DEMO_ROUTE' ? '400' : route?.replaceAll('_', ' ');
  const identity = actions.includes('CONFIRM_ROUTE_IDENTITY') && passengerRoute ? `Route ${passengerRoute}. ` : '';
  const message = identity + (policy.scenario === 'emergency'
    ? 'Please wait for the safety operator. Boarding assistance is paused.'
    : 'Please keep clear of the entrance. Board only when the safety operator gives the signal.');
  const audio = actions.includes('ACTIVATE_EXTERNAL_SPEAKER');
  const display = actions.includes('SHOW_EXTERNAL_DISPLAY');
  return { channel: audio && display ? 'BOTH' : audio ? 'EXTERNAL_AUDIO' : display ? 'EXTERNAL_DISPLAY' : 'NONE', language: 'en-SG', audio_text: audio ? message : null, display_text: display ? message : null };
}

export function safeFallback(context, errorCode) {
  const emergency = context.vehicle_context?.emergency_stop_active === true;
  const actions = emergency ? ['ABORT_ASSISTANCE_SEQUENCE', 'REQUEST_ONBOARD_SAFETY_OPERATOR'] : ['REQUEST_ONBOARD_SAFETY_OPERATOR'];
  if (!emergency && context.vehicle_context?.motion_state === 'STOPPED' && fresh(context.vehicle_context?.observation_age_ms, THRESHOLDS.vehicle_age_ms)) actions.unshift('HOLD_AT_STOP');
  return { proposal: { request_id: context.request_id ?? 'invalid-request', plan_status: emergency ? 'CANNOT_EXECUTE' : 'NEEDS_CONFIRMATION', decision_summary: ['Input or model output failed validation. Await operator assistance.'], actions }, flags: [errorCode] };
}
