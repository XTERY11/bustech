import { ACTIONS, INPUT_SCHEMA, MODEL_OUTPUT_SCHEMA } from './contracts.mjs';
import { project, validate } from './schema.mjs';
import { cabinRouteFor } from './cabinRoute.mjs';

export const THRESHOLDS = Object.freeze({ vehicle_age_ms: 1500, perception_age_ms: 1500, app_age_ms: 300000, yolo_confidence: 0.75, geometry_confidence: 0.85 });
// Only low-floor destinations with a clear approach in the simulated cabin are suitable.
const SEAT_TIERS = Object.freeze([['S03', 'S02', 'S09', 'S06'], ['S05', 'S08']]);
// Keep the stroller close when possible; otherwise walk, without the parked aid,
// to the next clear low-floor seat column. Never cross occupied window seats.
const STROLLER_SEAT_TIERS = Object.freeze([['S03', 'S02'], ['S05', 'S06'], ['S08', 'S09']]);
const seatScore = value => {
  let hash = 2166136261;
  for (const character of value) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  return (hash ^ (hash >>> 16)) >>> 0;
};
const available = x => x === 'AVAILABLE' || x === 'AVAILABLE_FOR_DEMO';
const fresh = (age, max) => typeof age === 'number' && age >= 0 && age <= max;
const number = x => typeof x === 'number' && Number.isFinite(x);
export function normalizeInput(raw) {
  const errors = validate(raw, INPUT_SCHEMA);
  if (errors.length) throw new Error(`INPUT_INVALID: ${errors.slice(0, 6).join('; ')}`);
  // Drop names, free-text notes, images, bboxes, tokens, and unrecognized fields before sending to API.
  return project(raw, INPUT_SCHEMA);
}

/** The booking ID keeps one destination stable across reruns and all planner modes. */
export function boardingTargetFor(context) {
  const r = context.request ?? {}, v = context.vehicle_context ?? {}, cabin = v.cabin;
  if (!cabin || cabin.layout_id !== 'byd-b70a02-photo-v1' || !Array.isArray(cabin.occupied_seat_ids)) return null;
  const occupied = new Set(cabin.occupied_seat_ids);
  const stroller = r.accessibility_need === 'STROLLER';
  if (stroller && (v.wheelchair_button_pressed === true || cabin.wheelchair_bay_occupied !== false || occupied.has('F01'))) return null;
  if (!stroller && (r.accessibility_need === 'WHEELCHAIR' || v.wheelchair_button_pressed === true)) {
    return cabin.wheelchair_bay_occupied === false && !occupied.has('F01')
      ? { type: 'WHEELCHAIR_BAY', id: 'WHEELCHAIR_BAY' } : null;
  }
  const tiers = stroller ? STROLLER_SEAT_TIERS : SEAT_TIERS;
  const candidates = tiers.map(tier => tier.filter(id => !occupied.has(id))).find(tier => tier.length);
  if (!candidates) return null;
  const seed = context.booking_event_id;
  const seat = seed ? candidates.reduce((best, id) => seatScore(`${seed}:${id}`) > seatScore(`${seed}:${best}`) ? id : best) : candidates[0];
  return { type: 'SEAT', id: seat };
}

export function equipmentTargetFor(context) {
  const cabin = context.vehicle_context?.cabin;
  return context.request?.accessibility_need === 'STROLLER' && cabin?.layout_id === 'byd-b70a02-photo-v1'
    && context.vehicle_context.wheelchair_button_pressed !== true
    && cabin.wheelchair_bay_occupied === false && Array.isArray(cabin.occupied_seat_ids) && !cabin.occupied_seat_ids.includes('F01')
    ? { type: 'WHEELCHAIR_BAY', id: 'WHEELCHAIR_BAY' } : null;
}

export function buildPolicy(context) {
  const r = context.request ?? {}, p = context.perception ?? {}, v = context.vehicle_context ?? {};
  const h = v.hardware_capabilities ?? {}, g = p.geometry ?? {};
  const flags = [], facts = [], required = [], optional = [];
  let status = 'READY', scenario = 'general', boardingTarget = null, equipmentTarget = null;
  const add = (...actions) => { for (const a of actions) if (!required.includes(a)) required.push(a); };
  const needs = (flag, fact) => { status = 'NEEDS_CONFIRMATION'; flags.push(flag); facts.push(fact); add('REQUEST_ONBOARD_SAFETY_OPERATOR'); };
  const finish = () => {
    const target = status === 'READY' ? boardingTarget : null;
    const equipment = target ? equipmentTarget : null;
    if (target) {
      add('GUIDE_PASSENGER_TO_ASSIGNED_PLACE');
      facts.splice(Math.min(facts.length, 2), 0, equipment
        ? ['S02', 'S03'].includes(target.id)
          ? `Park the stroller in the free wheelchair bay, then walk alone to nearby unoccupied seat ${target.id}.`
          : `The nearby seats are occupied. Park the stroller in the free wheelchair bay, then walk alone to unoccupied seat ${target.id}.`
        : target.type === 'SEAT'
        ? `Seat ${target.id} is unoccupied and assigned for this passenger.`
        : 'The wheelchair bay is unoccupied and assigned for this passenger.');
    }
    const allowed = [...new Set([...required, ...optional])].sort((a, b) => ACTIONS.indexOf(a) - ACTIONS.indexOf(b));
    return { plan_status: status, scenario, boarding_target: target, equipment_target: equipment, navigation_route: target ? cabinRouteFor(target, equipment) : null, required_actions: allowed.filter(a => required.includes(a)), allowed_actions: allowed, facts, safety_flags: flags };
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
  // A target the camera module confirmed is taken as it is; the confidence threshold only judges raw,
  // unconfirmed detections (see confirmedLabels in journey.mjs).
  const confirmed = p.target_match_confirmed === true;
  const confidentAids = perceptionFresh ? aids.filter(d => number(d.confidence) && (confirmed || d.confidence >= THRESHOLDS.yolo_confidence)) : [];
  const usableAids = confirmed ? confidentAids : [];
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
  if (need === 'STROLLER' && button) {
    scenario = 'confirm';
    needs('CONFLICTING_ASSISTANCE_CATEGORY', 'A stroller booking conflicts with a wheelchair-button request. Ask the operator to confirm the passenger and equipment.');
    if (v.ramp_state === 'STOWED') add('KEEP_RAMPS_STOWED');
    return finish();
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
  const wheelchair = need === 'WHEELCHAIR' || button;
  boardingTarget = boardingTargetFor(context);
  equipmentTarget = equipmentTargetFor(context);
  if (!boardingTarget) {
    scenario = 'wait';
    needs(v.cabin ? 'NO_ACCESSIBLE_PLACE_AVAILABLE' : 'CABIN_STATE_UNCONFIRMED', !v.cabin
      ? 'Cabin occupancy is unconfirmed. Keep the bus stopped and ask the safety operator to assist.'
      : need === 'STROLLER' ? equipmentTarget
        ? 'No suitable unoccupied low-floor seat is available after stroller parking. Ask the safety operator to assist.'
        : 'The stroller parking bay or its foldable seat is occupied. Ask the safety operator to assist.'
      : wheelchair ? 'The wheelchair bay or its foldable seat is occupied. Ask the safety operator to assist.'
      : 'No suitable unoccupied low-floor seat is available. Ask the safety operator to assist.');
    return finish();
  }
  add('CHECK_SINGLE_ENTRANCE_CLEARANCE', 'KEEP_SINGLE_ENTRANCE_CLEAR', 'EXTEND_DWELL_TIME', 'WAIT_FOR_BOARDING_CONFIRMATION', 'WAIT_FOR_SEATED_AND_BELTED_CONFIRMATION');
  if (wheelchair || need === 'STROLLER') add('PREPARE_WHEELCHAIR_AREA');

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

export function templateNavigationSteps(route) {
  if (!route) return null;
  const destination = route.target.type === 'SEAT' ? `seat ${route.target.id}` : 'the wheelchair bay';
  return route.steps.map(step => ({ ...step, text: step.maneuver === 'START'
    ? 'From the entrance, face into the bus.'
    : step.maneuver === 'STRAIGHT' ? `Continue straight for ${step.distance_m} metres.`
    : step.maneuver === 'TURN_LEFT' ? 'Turn left.'
    : step.maneuver === 'TURN_RIGHT' ? 'Turn right.'
    : step.maneuver === 'PARK_STROLLER' ? 'Park the stroller in the wheelchair bay and wait for the safety operator.'
    : `Arrive at ${destination} and wait for the safety operator.` }));
}

export function ruleProposal(context, policy) {
  return { request_id: context.request_id, plan_status: policy.plan_status, decision_summary: policy.facts.slice(0, 3), actions: policy.required_actions, boarding_target: policy.boarding_target, equipment_target: policy.equipment_target, navigation_steps: templateNavigationSteps(policy.navigation_route) };
}

function navigationTextErrors(step, route) {
  const errors = [], message = step.text;
  const invalid = code => errors.push(`${code}:${step.step}`);
  if (!/[A-Za-z]/.test(message) || (message.match(/\p{L}/gu) ?? []).some(letter => !/\p{Script=Latin}/u.test(letter))) invalid('NAVIGATION_TEXT_NOT_ENGLISH');
  if (/\b(?:depart\w*|drive\s+away|leave|exit|secure\w*|belt\w*|steer\w*|accelerat\w*|stairs?|staircase|rear|front|back|backward|window|platform|street|driver|north|south|east|west|deck|floor|gps|tracking|located|current\s+position|row\s*\d+|not|never|instead)\b|don['’]t/i.test(message)) invalid('NAVIGATION_TEXT_UNSUPPORTED');
  const namedSeats = message.match(/\b[SF]\d{1,3}\b/gi) ?? [];
  if (namedSeats.some(id => route.target.type !== 'SEAT' || id.toUpperCase() !== route.target.id)) invalid('NAVIGATION_TEXT_WRONG_TARGET');
  const distances = [...message.matchAll(/(\d+(?:\.\d+)?)\s*(?:met(?:er|re)s?|m)\b/gi)].map(match => Number(match[1]));
  if (step.distance_m === null ? distances.length > 0 : distances.length !== 1 || distances[0] !== step.distance_m) invalid('NAVIGATION_TEXT_DISTANCE_MISMATCH');
  const extras = message.replace(/\b[SF]\d{1,3}\b/gi, '').replace(/\d+(?:\.\d+)?\s*(?:met(?:er|re)s?|m)\b/gi, '');
  if (/\d|°|\bdegrees?\b/i.test(extras)) invalid('NAVIGATION_TEXT_UNSUPPORTED');
  const left = /\bleft\b/i.test(message), right = /\bright\b/i.test(message), straight = /\b(?:straight|forward)\b/i.test(message);
  if (step.maneuver === 'START') {
    if (!/\bentrance\b/i.test(message) || !/\b(?:face|facing)\b/i.test(message) || !/\binto\s+the\s+bus\b/i.test(message) || left || right || straight || /\bturn\b/i.test(message)) invalid('NAVIGATION_TEXT_ORIGIN_MISMATCH');
  } else if (step.maneuver === 'STRAIGHT') {
    if (!straight || left || right || /\bturn\b/i.test(message)) invalid('NAVIGATION_TEXT_DIRECTION_MISMATCH');
  } else if (step.maneuver === 'TURN_LEFT' || step.maneuver === 'TURN_RIGHT') {
    const direction = step.maneuver === 'TURN_LEFT' ? 'left' : 'right';
    if (!new RegExp(`\\b(?:turn\\s+(?:to\\s+(?:your\\s+|the\\s+)?)?${direction}|${direction}\\s+turn)\\b`, 'i').test(message) || (direction === 'left' ? right : left) || straight) invalid('NAVIGATION_TEXT_DIRECTION_MISMATCH');
  } else if (step.maneuver === 'PARK_STROLLER') {
    if (route.equipment_target?.type !== 'WHEELCHAIR_BAY' || !/\bstroller\b/i.test(message) || !/\bwheelchair\s+bay\b/i.test(message)
      || !/\boperator\b/i.test(message) || !/\b(?:park|position)\b/i.test(message) || namedSeats.length || left || right || straight) invalid('NAVIGATION_TEXT_STROLLER_PARKING_MISMATCH');
  } else {
    const targetMentioned = route.target.type === 'SEAT'
      ? new RegExp(`\\bseat\\s+${route.target.id}\\b`, 'i').test(message)
      : /\bwheelchair\s+(?:bay|space)\b/i.test(message);
    if (!targetMentioned || left || right || straight || !/\b(?:arriv\w*|reach\w*|wait|operator)\b/i.test(message)) invalid('NAVIGATION_TEXT_TARGET_MISMATCH');
  }
  return errors;
}

export function validateProposal(proposal, context, policy) {
  const errors = validate(proposal, MODEL_OUTPUT_SCHEMA);
  if (errors.length) return errors;
  if (proposal.request_id !== context.request_id) errors.push('REQUEST_ID_MISMATCH');
  if (proposal.plan_status !== policy.plan_status) errors.push('STATUS_MISMATCH');
  const targetMatches = proposal.boarding_target === null && policy.boarding_target === null ||
    proposal.boarding_target?.type === policy.boarding_target?.type && proposal.boarding_target?.id === policy.boarding_target?.id;
  if (!targetMatches) errors.push('BOARDING_TARGET_MISMATCH');
  if (proposal.boarding_target?.type === 'SEAT' && proposal.boarding_target.id === 'WHEELCHAIR_BAY') errors.push('BOARDING_TARGET_INVALID');
  if (proposal.boarding_target?.type === 'WHEELCHAIR_BAY' && proposal.boarding_target.id !== 'WHEELCHAIR_BAY') errors.push('BOARDING_TARGET_INVALID');
  const equipmentMatches = proposal.equipment_target === null && policy.equipment_target === null ||
    proposal.equipment_target?.type === policy.equipment_target?.type && proposal.equipment_target?.id === policy.equipment_target?.id;
  if (!equipmentMatches) errors.push('EQUIPMENT_TARGET_MISMATCH');
  const route = policy.navigation_route;
  if (!route) {
    if (proposal.navigation_steps !== null) errors.push('NAVIGATION_STEPS_NOT_ALLOWED');
  } else if (!Array.isArray(proposal.navigation_steps) || proposal.navigation_steps.length !== route.steps.length) {
    errors.push('NAVIGATION_STEPS_MISMATCH');
  } else {
    const parkedAt = route.steps.findIndex(step => step.maneuver === 'PARK_STROLLER');
    for (let i = 0; i < route.steps.length; i++) {
      const expected = route.steps[i], actual = proposal.navigation_steps[i];
      if (actual.step !== expected.step || actual.maneuver !== expected.maneuver || actual.distance_m !== expected.distance_m) errors.push(`NAVIGATION_ROUTE_MISMATCH:${expected.step}`);
      errors.push(...navigationTextErrors(actual, route));
      if (parkedAt >= 0 && i > parkedAt && /\bstroller\b/i.test(actual.text)) errors.push(`NAVIGATION_TEXT_STROLLER_ALREADY_PARKED:${expected.step}`);
    }
  }
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
  if (action === 'GUIDE_PASSENGER_TO_ASSIGNED_PLACE') {
    const target = boardingTargetFor(context);
    const equipment = equipmentTargetFor(context);
    return target ? { target_type: target.type, target_id: target.id, ...(equipment ? { equipment_target: equipment } : {}) } : {};
  }
  if (action === 'WAIT_FOR_SEATED_AND_BELTED_CONFIRMATION') return { source: 'ONBOARD_SAFETY_OPERATOR', wheelchair_securement: 'IF_APPLICABLE_OPERATOR_CONFIRMED' };
  return {};
}

export function passengerCommunication(context, policy, actions) {
  // Templates avoid broadcasting an unvalidated model summary or claiming a proposal succeeded.
  const route = context.vehicle_context?.route_id;
  const passengerRoute = route === 'DEMO_ROUTE' ? '400' : route?.replaceAll('_', ' ');
  const identity = actions.includes('CONFIRM_ROUTE_IDENTITY') && passengerRoute ? `Route ${passengerRoute}. ` : '';
  const target = actions.includes('GUIDE_PASSENGER_TO_ASSIGNED_PLACE') ? policy.boarding_target : null;
  const destination = target && policy.equipment_target
    ? ` Park the stroller in the wheelchair bay with the safety operator, then proceed to seat ${target.id}.`
    : target?.type === 'SEAT'
    ? ` Proceed to seat ${target.id} when the safety operator invites you to board.`
    : target?.type === 'WHEELCHAIR_BAY' ? ' Proceed to the wheelchair bay and follow the safety operator\'s securement instructions.' : '';
  const message = identity + (policy.scenario === 'emergency'
    ? 'Please wait for the safety operator. Boarding assistance is paused.'
    : 'Please keep clear of the entrance. Board only when the safety operator gives the signal.') + destination;
  const audio = actions.includes('ACTIVATE_EXTERNAL_SPEAKER');
  const display = actions.includes('SHOW_EXTERNAL_DISPLAY');
  return { channel: audio && display ? 'BOTH' : audio ? 'EXTERNAL_AUDIO' : display ? 'EXTERNAL_DISPLAY' : 'NONE', language: 'en-SG', audio_text: audio ? message : null, display_text: display ? message : null };
}

export function safeFallback(context, errorCode) {
  const emergency = context.vehicle_context?.emergency_stop_active === true;
  const actions = emergency ? ['ABORT_ASSISTANCE_SEQUENCE', 'REQUEST_ONBOARD_SAFETY_OPERATOR'] : ['REQUEST_ONBOARD_SAFETY_OPERATOR'];
  if (!emergency && context.vehicle_context?.motion_state === 'STOPPED' && fresh(context.vehicle_context?.observation_age_ms, THRESHOLDS.vehicle_age_ms)) actions.unshift('HOLD_AT_STOP');
  return { proposal: { request_id: context.request_id ?? 'invalid-request', plan_status: emergency ? 'CANNOT_EXECUTE' : 'NEEDS_CONFIRMATION', decision_summary: ['Input or model output failed validation. Await operator assistance.'], actions, boarding_target: null, equipment_target: null, navigation_steps: null }, flags: [errorCode] };
}
