import type { BoardingTarget, Context, Result } from '../live-types';

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
  passengerJourney?: {
    journeyId: string;
    aid: 'wheelchair' | 'cane' | 'crutch' | 'walker' | 'stroller' | 'visual' | 'hearing' | 'none';
    stage: 'hidden' | 'boarding' | 'navigating' | 'seated' | 'secured';
    destination: BoardingTarget;
    progress?: number;
  } | null;
};
/** `camera` asks the twin to change its view when the step starts. */
export type ScenarioStep = { at: number; label: string; action?: string; frame: TwinFrame; camera?: 'overview' | 'entrance' | 'ramp' | 'cutaway' | 'interior' };

const DOOR_MS = 1200, RAMP_MS = 2000, KNEEL_MS = 1600;
export const IDLE_FRAME: TwinFrame = { door: 'closed', ramp: 'retracted', kneeling: false, boardingStatus: 'idle', announcement: { active: false, text: '' }, passengerInfo: null, passengerJourney: null };

const SEAT_IDS = [...Array.from({ length: 16 }, (_, index) => `S${String(index + 1).padStart(2, '0')}`), 'F01'];

/** Convert the planner's compact cabin snapshot into the twin's full occupancy patch. */
export function cabinSeatOccupancy(context: Context): Record<string, boolean> | undefined {
  const occupied = context.vehicle_context?.cabin?.occupied_seat_ids;
  if (!occupied) return undefined;
  const occupiedSet = new Set<string>(occupied);
  return Object.fromEntries(SEAT_IDS.map(id => [id, occupiedSet.has(id)]));
}

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
 * Explicit presentation preview for the second half of the story. It continues
 * from the READY pose, guides the passenger to the trusted boarding target and
 * stops at the operator-confirmation boundary. `left` can describe the aid that
 * was observed, but leaving the camera region is never treated as proof of boarding.
 */
export function boardingScenario(result: Result | null, left: string[], fallbackAid?: string, playbackNonce = 0): ScenarioStep[] {
  const actions = result?.action_plan.map(a => a.action) ?? [];
  const ramp = has(actions, 'DEPLOY_AUTOMATIC_SHORT_RAMP');
  const observedAid = left.find(label => ['WHEELCHAIR', 'CANE', 'CRUTCH', 'WALKER', 'STROLLER'].includes(label));
  const sourceAid = observedAid ?? fallbackAid ?? 'NONE';
  const aid = ({
    WHEELCHAIR: 'wheelchair', CANE: 'cane', CRUTCH: 'crutch', WALKER: 'walker', STROLLER: 'stroller',
    VISUAL_ASSISTANCE: 'visual', HEARING_ASSISTANCE: 'hearing',
  } as const)[sourceAid as 'WHEELCHAIR' | 'CANE' | 'CRUTCH' | 'WALKER' | 'STROLLER' | 'VISUAL_ASSISTANCE' | 'HEARING_ASSISTANCE'] ?? 'none';
  const who = aid === 'wheelchair' ? 'Wheelchair user'
    : aid === 'stroller' ? 'Passenger with stroller'
      : aid === 'cane' ? 'Passenger with cane'
        : aid === 'crutch' ? 'Passenger with crutches'
          : aid === 'walker' ? 'Passenger with walker'
            : aid === 'visual' ? 'Passenger using vision support'
              : aid === 'hearing' ? 'Passenger using hearing support' : 'Passenger';
  const target = result?.boarding_target ?? null;
  if (!result || !target) {
    return [{
      at: 0,
      label: 'Awaiting assigned place',
      camera: 'entrance',
      frame: {
        boardingStatus: 'request_received',
        passengerInfo: { title: 'Operator assistance', message: 'No validated empty place has been assigned.' },
        passengerJourney: null,
      },
    }];
  }
  const targetLabel = target.type === 'SEAT' ? `seat ${target.id}` : 'the wheelchair bay';
  const journeyId = `${result.request_id}:${target.type}:${target.id}:${playbackNonce}`;
  const journey = (stage: 'boarding' | 'navigating' | 'seated' | 'secured', progress: number) => ({
    journeyId, aid, stage, destination: target, progress,
  });
  // Deliberately paced for a live presentation: each target gives the actor
  // enough time to traverse the corresponding path segment before the next
  // camera change. Wheelchair movement is slightly slower than walking.
  const wheelchair = aid === 'wheelchair';
  const enteringMs = wheelchair ? 3800 : 3200;
  const guidingMs = wheelchair ? 3600 : 3000;
  const approachingMs = wheelchair ? 3200 : 2700;
  const confirmationHoldMs = 2200;
  const steps: ScenarioStep[] = [];
  let t = 0;
  steps.push({ at: t, label: 'Passenger entering', action: 'WAIT_FOR_BOARDING_CONFIRMATION', camera: ramp ? 'ramp' : 'entrance', frame: { boardingStatus: 'boarding', announcement: { active: false, text: '' }, passengerInfo: { title: 'Boarding', message: `${who} entering · assigned to ${targetLabel}` }, passengerJourney: journey('boarding', 0.36) } });
  t += enteringMs;
  steps.push({ at: t, label: `Guiding to ${targetLabel}`, action: 'GUIDE_PASSENGER_TO_ASSIGNED_PLACE', camera: 'cutaway', frame: { passengerInfo: { title: 'Interior guidance', message: `Follow the highlighted route to ${targetLabel}` }, passengerJourney: journey('navigating', 0.70) } });
  t += guidingMs;
  // Reach progress 1 while still navigating; the later seated frame can then
  // hand off to the static occupant without a visible teleport.
  steps.push({ at: t, label: `Approaching ${targetLabel}`, action: 'GUIDE_PASSENGER_TO_ASSIGNED_PLACE', camera: 'interior', frame: { passengerJourney: journey('navigating', 1) } });
  t += approachingMs;
  const finalStage = 'seated';
  steps.push({ at: t, label: target.type === 'SEAT' ? `Preview: passenger reached ${target.id}` : 'Preview: wheelchair reached bay', action: 'WAIT_FOR_SEATED_AND_BELTED_CONFIRMATION', camera: 'cutaway', frame: { ...(target.type === 'SEAT' ? { seatOccupancy: { [target.id]: true } } : {}), passengerJourney: journey(finalStage, 1), passengerInfo: { title: 'Awaiting operator confirmation', message: target.type === 'SEAT' ? `${who} is shown seated in ${target.id}` : 'Wheelchair is positioned in the bay; securement is not yet confirmed' } } });
  t += confirmationHoldMs;
  steps.push({ at: t, label: 'Waiting for safety confirmation', action: 'WAIT_FOR_SEATED_AND_BELTED_CONFIRMATION', frame: { boardingStatus: 'boarding', passengerJourney: journey(finalStage, 1), passengerInfo: { title: 'Safety hold', message: 'Door and ramp remain in their validated boarding state until the operator confirms.' } } });
  return steps;
}

/** Play a timeline: `send` receives each frame at its time. Returns a cancel function. */
export function playScenario(steps: ScenarioStep[], send: (frame: TwinFrame, step: ScenarioStep) => void) {
  const timers = steps.map(step => window.setTimeout(() => send(step.frame, step), step.at));
  return () => timers.forEach(id => window.clearTimeout(id));
}
