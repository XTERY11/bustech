// Shared open-loop presentation state. A camera exit is not proof of boarding or securement.
export const STAGES = ['IDLE', 'BOOKED', 'AT_STOP', 'ON_BOARD'];
export const DOCK_MS = 4200, ARRIVAL_MS = 10000, BOARDING_MS = 16000;
export const STROLLER_BOARDING_MS = 22000;
// Later passengers of the same simulated bus: it is already at the stop with the entrance open, so their arrival
// phase is a short preparation instead of the drive-in (animation.phase 'arrival', duration_ms 3000, docked: true).
export const DOCKED_ARRIVAL_MS = 3000;
const VISIBLE = {
  WHEELCHAIR: ['WHEELCHAIR'], STROLLER: ['STROLLER'], WALKER: ['WALKER'],
  CANE: ['CANE', 'CRUTCH'], CRUTCH: ['CRUTCH', 'CANE'], VISUAL_ASSISTANCE: ['CANE'],
};
const AIDS = { WHEELCHAIR: 'wheelchair', STROLLER: 'stroller', CANE: 'cane', CRUTCH: 'crutch',
  WALKER: 'walker', VISUAL_ASSISTANCE: 'visual', HEARING_ASSISTANCE: 'hearing' };
const STROLLER_SEATS = ['S02', 'S03', 'S05', 'S06', 'S08', 'S09'];
export const matches = (need, labels) => Boolean(need) && labels.length > 0 &&
  (!VISIBLE[need] || labels.some(label => VISIBLE[need].includes(label)));
export const aidForNeed = need => AIDS[need] ?? 'none';
/** A booking with a visible aid whose aid is among the labels (needs without a visible aid match no label here). */
export const visibleMatch = (need, labels) => Boolean(VISIBLE[need]) && labels.some(label => VISIBLE[need].includes(label));
/** Labels that pass the hub's gate: a confirmed target, confidence >= 0.75, not NONE/UNKNOWN. */
export const confirmedLabels = payload => payload?.target_match_confirmed === true ? [...new Set((payload.yolo_detections ?? [])
  .filter(d => d.confidence >= 0.75 && !['NONE', 'UNKNOWN'].includes(d.label)).map(d => d.label))].sort() : [];
/** When the arrival phase (10 s drive-in, or the short docked preparation) is over. */
const arrivalEnd = animation => animation.started_at + (animation.duration_ms ?? ARRIVAL_MS);

export function advance(journey, channel, payload, _planStatus, { eventId, now = Date.now() } = {}) {
  if (channel === 'booking') {
    const active = payload?.active === true && payload?.intent === 'BOARDING';
    return { journey_id: eventId ?? payload?.event_id ?? null, revision: (journey.revision ?? 0) + 1,
      stage: active ? 'BOOKED' : 'IDLE', need: active ? payload.accessibility_need ?? 'UNKNOWN' : null,
      labels: [], matched: false, seat: null, boarding_target: null, equipment_target: null, completed: false,
      pending_exit: false, animation: null, visit_id: null, roi_id: null, reason: active ? 'booked' : 'cancelled', updated_at: now };
  }
  if (channel !== 'perception' || !journey.need || journey.completed || journey.stage === 'IDLE') return journey;
  const next = { ...journey }, zone = payload?.zone ?? {};
  const labels = confirmedLabels(payload);
  if (zone.triggered === true && (!zone.event || ['enter', 'present'].includes(zone.event))) {
    if (next.pending_exit) {
      // Came back into the region before the held exit boarded: cancel it and wait at the stop again (the arrival
      // animation keeps running); the next proper exit boards. Anybody else entering leaves the held exit alone.
      if (!matches(next.need, labels)) return journey;
      next.pending_exit = false; next.labels = labels; next.matched = true; next.reason = 'entered';
      next.visit_id = zone.visit_id ?? next.visit_id ?? null;
      next.roi_id = zone.roi_id ?? next.roi_id ?? null;
      return next;
    }
    if (next.visit_id && zone.visit_id && next.visit_id !== zone.visit_id && zone.event !== 'enter') return journey;
    if (zone.event === 'enter' && zone.visit_id && next.visit_id !== zone.visit_id) next.animation = null;
    next.stage = 'AT_STOP'; next.labels = labels; next.matched = matches(next.need, labels);
    next.visit_id = zone.visit_id ?? next.visit_id ?? null;
    next.roi_id = zone.roi_id ?? next.roi_id ?? null;
    next.reason = next.matched ? 'entered' : 'unmatched';
  } else if (zone.triggered === false && zone.event === 'exit' && next.stage === 'AT_STOP') {
    if (next.visit_id && zone.visit_id !== next.visit_id) return journey;
    if (next.roi_id && zone.roi_id !== next.roi_id) return journey;
    const left = zone.left ?? [];
    // zone.boarding === false: the bridge judged that the passenger did not leave towards the bus (a short
    // stay, or walked off another way), so we wait for them again. true or absent behaves as before.
    if (next.matched && zone.boarding !== false && matches(next.need, left) && left.some(label => next.labels.includes(label))) {
      next.pending_exit = true; next.reason = 'left_stop';
    } else {
      next.stage = 'BOOKED'; next.labels = []; next.matched = false; next.visit_id = null; next.animation = null;
      if (zone.boarding === false) next.reason = 'not_boarding';
    }
  }
  return next;
}

/**
 * The camera stopped reporting the visit the journey waits on (no exit: the bridge stopped or restarted after the
 * passenger left). One passenger at a time, and the demo must never stick: if the passenger matched and had been
 * told "Ready to board" (arrival preparation complete) by the time presence was lost, take it as having left to
 * board (the exit becomes pending and reconcile boards); otherwise wait for the passenger again in BOOKED.
 */
export function presenceLost(journey, lostAt) {
  const prepared = journey.matched && journey.animation?.phase === 'arrival' && lostAt >= arrivalEnd(journey.animation);
  if (prepared) return { ...journey, pending_exit: true, reason: 'presence_lost' };
  return { ...journey, stage: 'BOOKED', labels: [], matched: false, visit_id: null, animation: null, reason: 'presence_lost' };
}

/**
 * The initial LLM result can arrive after either CV event. Never lose that pending exit.
 * docked: the bus already boarded somebody and waits at the stop, so the arrival phase is the short preparation.
 */
export function reconcile(journey, result, now = Date.now(), { docked = false } = {}) {
  if (journey.stage === 'IDLE' || journey.completed) return journey;
  let target = result?.plan_status === 'READY' ? result.boarding_target ?? null : null;
  const equipment = result?.plan_status === 'READY' && journey.need === 'STROLLER' ? result.equipment_target ?? null : null;
  if (journey.need === 'STROLLER' && (equipment?.type !== 'WHEELCHAIR_BAY' || equipment.id !== 'WHEELCHAIR_BAY'
    || target?.type !== 'SEAT' || !STROLLER_SEATS.includes(target.id))) target = null;
  const next = { ...journey, boarding_target: target, equipment_target: target ? equipment : null, seat: target?.id ?? null };
  if (next.stage !== 'AT_STOP' || !next.matched || !target) {
    next.animation = null;
    return next;
  }
  next.animation ??= { id: `${next.journey_id}:${next.visit_id ?? 'legacy'}:${next.revision}:arrival`, phase: 'arrival', aid: aidForNeed(next.need),
    started_at: now, duration_ms: docked ? DOCKED_ARRIVAL_MS : ARRIVAL_MS, target, equipment_target: next.equipment_target, ...(docked ? { docked: true } : {}) };
  if (next.pending_exit && now >= arrivalEnd(next.animation)) {
    next.stage = 'ON_BOARD'; next.completed = true; next.pending_exit = false; next.reason = 'boarding_preview';
    next.animation = { id: `${next.journey_id}:boarding`, phase: 'boarding', aid: aidForNeed(next.need),
      started_at: now, duration_ms: next.need === 'STROLLER' ? STROLLER_BOARDING_MS : BOARDING_MS,
      target, equipment_target: next.equipment_target };
  }
  return next;
}

/** queue.ahead: bookings of the waiting list served before this one (0 or absent: nobody, the text is as without a list). */
export function guidance(journey, context, result, now = Date.now(), queue = {}) {
  const request = context.request ?? {};
  const route = request.route_id === 'DEMO_ROUTE' || !request.route_id ? '400' : String(request.route_id).replaceAll('_', ' ');
  const stop = request.stop_id === 'DEMO_STOP' || !request.stop_id ? 'the demo bus stop' : String(request.stop_id).replaceAll('_', ' ');
  const say = (title, text) => ({ title, display_text: text, audio_text: text });
  if (journey.stage === 'BOOKED') {
    if (journey.reason === 'no_place') return say('No place on this bus', 'Your booking was received, but no suitable place is free on this bus. Please wait for the safety operator.');
    if (journey.reason === 'waiting_turn') return say('Please wait', 'We see you at the stop. Please wait, another passenger is boarding.');
    const ahead = queue.ahead ?? 0;
    if (ahead > 0) {
      const turn = `${ahead === 1 ? '1 passenger' : `${ahead} passengers`} ahead of you. You will be served after them.`;
      return result?.plan_status === 'READY'
        ? say('Go to the bus stop', `Booking received. Please go to the marked boarding point at ${stop} for route ${route}. ${turn}`)
        : say('Booking received', `Booking received. We are preparing your assistance plan. ${turn}`);
    }
    return result?.plan_status === 'READY'
      ? say('Go to the bus stop', `Please go to the marked boarding point at ${stop} for route ${route}. Your assistance plan is ready.`)
      : say('Booking received', result?.passenger_communication?.display_text ?? 'We are preparing your assistance plan. Please wait for confirmation.');
  }
  if (journey.stage === 'AT_STOP') {
    // No label passed the confidence gate yet (a live camera often triggers on a first, partial view; the
    // bridge's next heartbeat carries the best score of the visit): still checking, not a mismatch.
    if (!journey.matched && !journey.labels?.length) return say('Please wait at the stop', 'We can see someone at the boarding point and are confirming your assistance. Please wait.');
    if (!journey.matched) return say('Please wait at the stop', 'The detected assistance does not match the booking. Please wait for the safety operator.');
    if (result?.plan_status !== 'READY') return say('We see you at the stop', result?.passenger_communication?.display_text ?? 'Your arrival has been recognised. Please wait while we prepare your assistance plan.');
    const animation = journey.animation, elapsed = now - (animation?.started_at ?? now);
    if (animation?.docked) {
      if (elapsed < animation.duration_ms) return say('Preparing to board', 'We have recognised you at the bus stop. The bus is at the stop and the entrance is being prepared for you. Please wait for the safety operator to signal.');
    } else {
      if (elapsed < DOCK_MS) return say('Bus arriving', 'We have recognised you at the bus stop. The bus is arriving; please stay behind the marked boarding line.');
      if (elapsed < (animation?.duration_ms ?? ARRIVAL_MS)) return say('Preparing to board', 'The bus has stopped and is preparing the entrance. Please wait for the safety operator to signal.');
    }
    return say('Ready to board', result.passenger_communication?.display_text ?? 'Please board when the safety operator signals.');
  }
  if (journey.stage === 'ON_BOARD' && result?.cabin_navigation?.steps?.length) {
    return say(journey.boarding_target?.type === 'WHEELCHAIR_BAY' ? 'Follow the wheelchair-space guidance' : `Follow guidance to seat ${journey.seat}`,
      result.cabin_navigation.steps.map(step => step.text).join(' '));
  }
  if (journey.stage === 'ON_BOARD') return journey.boarding_target?.type === 'WHEELCHAIR_BAY'
    ? say('Follow the wheelchair-space guidance', 'Move to the wheelchair space beside the entrance. The safety operator must confirm positioning and securement before departure.')
    : journey.equipment_target ? say(`Park the stroller, then follow guidance to seat ${journey.seat}`,
      `Park the stroller in the wheelchair bay following the safety operator's instructions, then follow the highlighted path to assigned seat ${journey.seat}. Please wait for the operator's confirmation.`)
    : say(`Follow guidance to seat ${journey.seat}`, `Follow the highlighted path to seat ${journey.seat} near the entrance. Please sit down and wait for the safety operator's confirmation.`);
  if (journey.reason === 'expired') return say('Booking expired', 'Your booking has expired. Please submit a new assistance request.');
  if (journey.reason === 'cancelled') return say('Booking cancelled', 'Your assistance request has been cancelled.');
  return say('No active booking', 'Book assistance in the app before you travel.');
}

/** Immediate, structured phone navigation; a stop ID is not an invented GPS route. */
export function navigation(journey, context, result, now = Date.now(), queue = {}) {
  if (!journey.journey_id || journey.stage === 'IDLE' || result?.plan_status !== 'READY' || !journey.boarding_target) return null;
  let phase = 'TO_STOP', destination = { type: 'BUS_STOP', id: context.request?.stop_id ?? 'DEMO_STOP' };
  if (journey.stage === 'AT_STOP') phase = journey.matched && journey.animation && now >= arrivalEnd(journey.animation) ? 'BOARD_BUS' : 'WAIT_AT_STOP';
  if (journey.stage === 'ON_BOARD') {
    destination = journey.boarding_target;
    phase = destination.type === 'SEAT' ? 'TO_SEAT' : 'TO_WHEELCHAIR_BAY';
  }
  return { id: journey.journey_id, revision: journey.revision ?? 0, phase, destination,
    equipment_target: journey.equipment_target ?? null,
    instruction: guidance(journey, context, result, now, queue).display_text, simulated: true, animation: journey.animation ?? null,
    steps: journey.stage === 'ON_BOARD' ? result.cabin_navigation?.steps ?? [] : [], cabin_route: result.cabin_navigation ?? null };
}
