import type { Context, Result } from '../live-types';

/**
 * Hub result -> bus digital-twin timeline (open loop).
 *
 * The planner's validated actions are mapped to a short, timed sequence of
 * telemetry frames for the embedded twin (bus-digital-twin, `index.html?embed=1`).
 * Frames use the twin's TelemetryMessage wire format and go through its
 * normalizeTelemetry(); nothing here feeds back into vehicle_context.
 * Timings follow the twin's own mechanical constants (door 1.2 s, ramp 2.0 s).
 */
export type TwinFrame = {
  door?: 'closed' | 'opening' | 'open' | 'closing';
  ramp?: 'retracted' | 'extending' | 'extended' | 'retracting';
  kneeling?: boolean;
  boardingStatus?: 'idle' | 'request_received' | 'preparing' | 'ready' | 'boarding' | 'complete';
  destination?: string;
  announcement?: { active: boolean; text: string };
  passengerInfo?: { title?: string; message?: string } | null;
  seatOccupancy?: Record<string, boolean>;
};
/** `camera` asks the twin to change its view when the step starts. */
export type ScenarioStep = { at: number; label: string; action?: string; frame: TwinFrame; camera?: 'overview' | 'entrance' | 'ramp' | 'cutaway' | 'interior' };

const DOOR_MS = 1200, RAMP_MS = 2000, KNEEL_MS = 1600;
export const IDLE_FRAME: TwinFrame = { door: 'closed', ramp: 'retracted', kneeling: false, boardingStatus: 'idle', announcement: { active: false, text: '' }, passengerInfo: null };

const has = (actions: string[], ...names: string[]) => names.some(n => actions.includes(n));

/** Build the timeline for the current hub state. `running` = a plan is being generated. */
export function actionsToScenario(result: Result | null, context: Context, running: boolean): ScenarioStep[] {
  const steps: ScenarioStep[] = [];
  const route = context.request?.route_id ?? context.vehicle_context?.route_id;
  if (!result) {
    return running ? [{ at: 0, label: 'Request received', frame: { ...IDLE_FRAME, boardingStatus: 'request_received' } }] : [];
  }
  const actions = result.action_plan.map(a => a.action);
  const action = (...names: string[]) => names.find(name => actions.includes(name));
  const audio = result.passenger_communication.audio_text, display = result.passenger_communication.display_text;
  const message = audio ?? display ?? 'Please wait for the safety operator.';

  if (result.plan_status === 'CANNOT_EXECUTE' || has(actions, 'ABORT_ASSISTANCE_SEQUENCE')) {
    return [{ at: 0, label: 'Assistance paused', action: action('ABORT_ASSISTANCE_SEQUENCE'), frame: { ...IDLE_FRAME, announcement: { active: true, text: 'Boarding assistance is paused. Please wait for the safety operator.' } } }];
  }
  if (result.plan_status !== 'READY') {
    const hold = action('HOLD_AT_STOP');
    const requestOperator = action('REQUEST_ONBOARD_SAFETY_OPERATOR');
    const frame = { ...IDLE_FRAME, boardingStatus: 'request_received' as const, announcement: { active: true, text: message } };
    return [
      { at: 0, label: 'Safety hold active', action: hold, frame },
      ...(requestOperator ? [{ at: 900, label: 'Requesting safety operator', action: requestOperator, frame }] : []),
    ];
  }

  let t = 0;
  const prepareAction = action('HOLD_AT_STOP', 'CHECK_SINGLE_ENTRANCE_CLEARANCE', 'KEEP_SINGLE_ENTRANCE_CLEAR', 'PREPARE_WHEELCHAIR_AREA');
  steps.push({ at: t, label: 'Preparing', action: prepareAction, frame: { ...IDLE_FRAME, boardingStatus: 'preparing' } });
  const deployRamp = has(actions, 'DEPLOY_AUTOMATIC_SHORT_RAMP');
  const openDoor = has(actions, 'OPEN_SINGLE_ENTRANCE') || context.vehicle_context?.single_entrance_state === 'OPEN' || deployRamp;
  const rampAction = action('DEPLOY_AUTOMATIC_SHORT_RAMP');
  const doorAction = action('OPEN_SINGLE_ENTRANCE') ?? rampAction;
  if (deployRamp) { t += 300; steps.push({ at: t, label: 'Kneeling', action: rampAction, frame: { kneeling: true } }); }
  if (openDoor) {
    t += 300; steps.push({ at: t, label: 'Door opening', action: doorAction, frame: { door: 'opening' } });
    t += DOOR_MS; steps.push({ at: t, label: 'Door open', action: doorAction, frame: { door: 'open' } });
  }
  if (deployRamp) {
    t = Math.max(t, 300 + KNEEL_MS); t += 200;
    steps.push({ at: t, label: 'Ramp extending', action: rampAction, frame: { ramp: 'extending' } });
    t += RAMP_MS; steps.push({ at: t, label: 'Ramp extended', action: rampAction, frame: { ramp: 'extended' } });
  } else if (has(actions, 'KEEP_RAMPS_STOWED')) {
    steps.push({ at: t, label: 'Ramp kept stowed', action: action('KEEP_RAMPS_STOWED'), frame: { ramp: 'retracted' } });
  }
  t += 300;
  const ready: TwinFrame = { boardingStatus: 'ready' };
  if (has(actions, 'ACTIVATE_EXTERNAL_SPEAKER', 'CONFIRM_ROUTE_IDENTITY', 'PLAY_ENTRANCE_AUDIO_BEACON') && audio) ready.announcement = { active: true, text: audio };
  if (has(actions, 'SHOW_EXTERNAL_DISPLAY') && display) ready.passengerInfo = { title: route ? `Route ${route}` : 'Boarding', message: display };
  else if (has(actions, 'EXTEND_DWELL_TIME')) ready.passengerInfo = { title: 'Extended boarding time', message: '+60 s dwell time · Board when the operator signals' };
  const readyAction = action('ACTIVATE_EXTERNAL_SPEAKER', 'CONFIRM_ROUTE_IDENTITY', 'PLAY_ENTRANCE_AUDIO_BEACON', 'SHOW_EXTERNAL_DISPLAY', 'WAIT_FOR_BOARDING_CONFIRMATION', 'EXTEND_DWELL_TIME');
  steps.push({ at: t, label: 'Ready to board', action: readyAction, frame: ready });
  return steps;
}

/** The plan is ready but the passenger has not reached the stop: the bus prepares and waits. */
export function waitingScenario(guidance?: string, title = 'Booking received'): ScenarioStep[] {
  return [{ at: 0, label: 'Waiting for the passenger at the stop', frame: { ...IDLE_FRAME, boardingStatus: 'request_received', passengerInfo: { title, message: guidance ?? 'Assistance is prepared. Waiting for the passenger at the stop.' } } }];
}

/**
 * Second half of the story: the passenger has left the stop region after a READY plan, so they
 * are taken to have boarded. Continues from the READY pose (door open, ramp out if it was
 * deployed) and never resets it: board, stow the ramp, close the door, done.
 * `left` are the aid labels seen at the stop; `seat` and `guidance` come from the hub's journey.
 */
export function boardingScenario(result: Result | null, left: string[], seat: string | null = null, guidance?: string): ScenarioStep[] {
  const actions = result?.action_plan.map(a => a.action) ?? [];
  const ramp = has(actions, 'DEPLOY_AUTOMATIC_SHORT_RAMP');
  const who = left.includes('WHEELCHAIR') ? 'Wheelchair user' : left.includes('STROLLER') ? 'Passenger with stroller' : left.includes('CANE') ? 'Passenger with cane' : 'Passenger';
  // The wheelchair space has no occupancy model in the twin yet; a walking passenger's seat is marked occupied.
  if (seat === 'WHEELCHAIR_BAY') seat = null;
  const steps: ScenarioStep[] = [];
  let t = 0;
  steps.push({ at: t, label: 'Passenger boarding', camera: ramp ? 'ramp' : 'entrance', frame: { boardingStatus: 'boarding', announcement: { active: false, text: '' }, passengerInfo: { title: 'Boarding', message: `${who} boarding · doors held open` } } });
  t += 3000;
  steps.push({ at: t, label: seat ? 'Passenger seated' : 'Wheelchair space occupied', camera: 'cutaway', frame: { ...(seat ? { seatOccupancy: { [seat]: true } } : {}), passengerInfo: { title: seat ? `Priority seat ${seat}` : 'Wheelchair space', message: guidance ?? (seat ? `${who} seated in a priority seat` : 'Wheelchair secured in the wheelchair space') } } });
  t += 2500;
  if (ramp) {
    steps.push({ at: t, label: 'Ramp retracting', camera: 'ramp', frame: { ramp: 'retracting' } });
    t += RAMP_MS; steps.push({ at: t, label: 'Ramp stowed', frame: { ramp: 'retracted', kneeling: false } });
    t += 400;
  }
  steps.push({ at: t, label: 'Door closing', camera: 'entrance', frame: { door: 'closing' } });
  t += DOOR_MS; steps.push({ at: t, label: 'Door closed', frame: { door: 'closed' } });
  t += 400;
  steps.push({ at: t, label: 'Boarding complete', camera: 'overview', frame: { boardingStatus: 'complete', passengerInfo: { title: 'Boarding complete', message: `${who} on board · ready to depart` } } });
  return steps;
}

/** Play a timeline: `send` receives each frame at its time. Returns a cancel function. */
export function playScenario(steps: ScenarioStep[], send: (frame: TwinFrame, step: ScenarioStep) => void) {
  const timers = steps.map(step => window.setTimeout(() => send(step.frame, step), step.at));
  return () => timers.forEach(id => window.clearTimeout(id));
}
