// Passenger journey: one small state machine shared by the dashboard, the twin and the App.
//
//   IDLE ──booking──► BOOKED ──aid enters the stop region──► AT_STOP ──leaves after READY──► ON_BOARD
//
// The App sends the booking; the camera bridge reports the stop region (perception.zone). Nothing
// here authorises vehicle motion: it only says which part of the story to show and tell.

export const STAGES = ['IDLE', 'BOOKED', 'AT_STOP', 'ON_BOARD'];

// Which detected aids agree with a booked need. Needs with no visible aid cannot be contradicted
// by the camera, so anything at the stop is accepted for them.
const VISIBLE = {
  WHEELCHAIR: ['WHEELCHAIR'], STROLLER: ['STROLLER'], WALKER: ['WALKER'],
  CANE: ['CANE', 'CRUTCH'], CRUTCH: ['CRUTCH', 'CANE'], VISUAL_ASSISTANCE: ['CANE'],
};
// Free priority seats in the twin's default cabin (twin/src/data/cabinLayout.ts), nearest the entrance first.
const PRIORITY_SEATS = ['S02', 'S03', 'S09'];

export const matches = (need, labels) => Boolean(need) && (!VISIBLE[need] || labels.some(label => VISIBLE[need].includes(label)));

/** Next journey state after one accepted signal. `planStatus` is the plan in force before the signal. */
export function advance(journey, channel, payload, planStatus) {
  const next = { ...journey };
  if (channel === 'booking') {
    const active = payload?.active === true && payload?.intent !== 'ALIGHTING';
    next.need = active ? payload.accessibility_need ?? 'UNKNOWN' : null;
    if (next.stage !== 'AT_STOP') next.stage = active ? 'BOOKED' : 'IDLE';
    if (next.stage !== 'ON_BOARD') next.seat = null;
  }
  if (channel === 'perception') {
    const zone = payload?.zone ?? {};
    const labels = (payload?.yolo_detections ?? []).map(d => d.label).filter(Boolean);
    if (zone.triggered === true) {
      next.stage = 'AT_STOP'; next.labels = [...new Set(labels)]; next.seat = null;
    } else if (next.stage === 'AT_STOP' && zone.triggered === false) {
      // Leaving the stop after a READY plan for a matching passenger is taken as boarding.
      const boarded = planStatus === 'READY' && matches(next.need, next.labels ?? []);
      next.stage = boarded ? 'ON_BOARD' : next.need ? 'BOOKED' : 'IDLE';
      if (boarded) {
        next.boarded = (next.boarded ?? 0) + 1;
        next.seat = next.need === 'WHEELCHAIR' ? 'WHEELCHAIR_BAY' : PRIORITY_SEATS[(next.boarded - 1) % PRIORITY_SEATS.length];
      }
    }
  }
  next.matched = next.stage === 'AT_STOP' ? matches(next.need, next.labels ?? []) : next.stage === 'ON_BOARD';
  return next;
}

/** What to tell the passenger at this stage. The App only has to show (or speak) this. */
export function guidance(journey, context, result) {
  const request = context.request ?? {};
  const route = request.route_id === 'DEMO_ROUTE' || !request.route_id ? '400' : String(request.route_id).replaceAll('_', ' ');
  const say = (title, text) => ({ title, display_text: text, audio_text: text });
  if (journey.stage === 'BOOKED') return say('Booking received', `Route ${route} is being prepared for you. Please go to the marked boarding point at the stop.`);
  if (journey.stage === 'AT_STOP') {
    if (journey.matched && result?.plan_status === 'READY') {
      const told = result.passenger_communication ?? {};
      return { title: 'Ready to board', display_text: told.display_text ?? told.audio_text ?? 'Please board when the safety operator signals.', audio_text: told.audio_text ?? told.display_text ?? 'Please board when the safety operator signals.' };
    }
    return say('We see you at the stop', journey.need && !journey.matched
      ? 'The assistance at the stop does not match the booking. Please wait for the safety operator.'
      : 'Please wait for the safety operator.');
  }
  if (journey.stage === 'ON_BOARD') {
    return journey.seat === 'WHEELCHAIR_BAY'
      ? say('Welcome on board', 'The wheelchair space is next to the entrance. The safety operator will help secure the wheelchair.')
      : say('Welcome on board', `Priority seat ${journey.seat} in the low-floor area near the entrance is reserved for you.`);
  }
  return say('No active booking', 'Book assistance in the app before you travel.');
}
