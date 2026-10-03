import type { BoardingTarget, Context, Journey, Result } from '../live-types';

/** Presentation frames only: no animation feeds back into vehicle safety state. */
type Aid = 'wheelchair' | 'cane' | 'crutch' | 'walker' | 'stroller' | 'visual' | 'hearing' | 'none';
type PassengerStage = 'hidden' | 'waiting' | 'boarding' | 'navigating' | 'seated' | 'secured';
type PassengerFrame = { journeyId: string; aid: Aid; stage: PassengerStage; destination: BoardingTarget; equipmentDestination?: BoardingTarget | null; progress?: number };
export type TwinFrame = {
  door?: 'closed' | 'opening' | 'open' | 'closing';
  ramp?: 'retracted' | 'extending' | 'extended' | 'retracting';
  kneeling?: boolean;
  boardingStatus?: 'idle' | 'request_received' | 'preparing' | 'ready' | 'boarding' | 'complete';
  destination?: string;
  announcement?: { active: boolean; text: string };
  passengerInfo?: { title?: string; message?: string } | null;
  seatOccupancy?: Record<string, boolean>;
  passengerJourney?: PassengerFrame | null;
  arrival?: { id: string; progress: number } | null;
};
export type ScenarioStep = { at: number; label: string; action?: string; frame: TwinFrame; camera?: 'overview' | 'entrance' | 'ramp' | 'cutaway' | 'interior' };
export const DOCK_MS = 4200, ARRIVAL_MS = 10000, BOARDING_MS = 16000, STROLLER_BOARDING_MS = 22000;
/** A hub arrival this short means the bus is already at the stop (a later passenger of the same bus): no drive-in. */
export const DOCKED_ARRIVAL_MAX_MS = 5000;
const DOOR_MS = 1200, RAMP_MS = 2000, KNEEL_MS = 1600;
export const IDLE_FRAME: TwinFrame = { door: 'closed', ramp: 'retracted', kneeling: false, boardingStatus: 'idle', announcement: { active: false, text: '' }, passengerInfo: null, passengerJourney: null, arrival: null };
const SEAT_IDS = [...Array.from({ length: 16 }, (_, index) => `S${String(index + 1).padStart(2, '0')}`), 'F01'];
const has = (actions: string[], ...names: string[]) => names.some(n => actions.includes(n));
const aidFor = (value?: string | null): Aid => ({
  WHEELCHAIR: 'wheelchair', CANE: 'cane', CRUTCH: 'crutch', WALKER: 'walker', STROLLER: 'stroller',
  VISUAL_ASSISTANCE: 'visual', HEARING_ASSISTANCE: 'hearing',
} as Record<string, Aid>)[value ?? ''] ?? (['wheelchair', 'cane', 'crutch', 'walker', 'stroller', 'visual', 'hearing'].includes(value ?? '') ? value as Aid : 'none');

const equipmentFor = (result: Result | null, journey?: Journey | null) =>
  journey?.animation?.equipment_target ?? journey?.equipment_target ?? result?.equipment_target ?? null;
const STROLLER_SEATS: Record<string, { x: number; z: number }> = {
  S02: { x: -0.66, z: -0.29 }, S03: { x: -0.66, z: 0.77 },
  S05: { x: 0.04, z: -0.29 }, S06: { x: 0.04, z: 0.77 },
  S08: { x: 0.74, z: -0.29 }, S09: { x: 0.74, z: 0.77 },
};
const validStrollerAssignment = (target?: BoardingTarget | null, equipment?: BoardingTarget | null) =>
  target?.type === 'SEAT' && Object.hasOwn(STROLLER_SEATS, target.id) && equipment?.type === 'WHEELCHAIR_BAY' && equipment.id === 'WHEELCHAIR_BAY';

/** Presentation anchors mirror the twin path; tests check them against its cabin geometry. */
export function strollerPathMilestones(target: BoardingTarget): { entranceProgress: number; parkingProgress: number } | null {
  if (target.type !== 'SEAT' || !Object.hasOwn(STROLLER_SEATS, target.id)) return null;
  const floorY = 0.36, entranceX = (-1.92 - 0.72) / 2, sideZ = 2.3 / 2, rampLength = 1.06, aisleZ = 0.24;
  const bayX = -1.55, bayZ = -0.54, { x: seatX, z: seatZ } = STROLLER_SEATS[target.id];
  const approach = [
    [entranceX, 0.025, sideZ + rampLength + 0.66], [entranceX, 0.04, sideZ + rampLength + 0.04],
    [entranceX, floorY, sideZ - 0.03], [entranceX, floorY, aisleZ], [bayX, floorY, aisleZ], [bayX, floorY, bayZ + 0.62],
  ];
  const fullPath = [...approach, [bayX, floorY, aisleZ], [seatX, floorY, aisleZ], [seatX, floorY, seatZ]];
  const length = (points: number[][]) => points.slice(1).reduce((sum, point, index) =>
    sum + Math.hypot(...point.map((value, axis) => value - points[index][axis])), 0);
  const total = length(fullPath);
  return { entranceProgress: length(approach.slice(0, 3)) / total, parkingProgress: length(approach) / total };
}

/** Reconstruct the trusted cabin baseline; the arriving passenger is added only after reaching it. */
export function cabinSeatOccupancy(context: Context, target?: BoardingTarget | null): Record<string, boolean> | undefined {
  const occupied = context.vehicle_context?.cabin?.occupied_seat_ids;
  if (!occupied) return undefined;
  const occupiedSet = new Set(occupied);
  if (target?.type === 'SEAT') occupiedSet.delete(target.id);
  return Object.fromEntries(SEAT_IDS.map(id => [id, occupiedSet.has(id)]));
}

function waitingPassenger(result: Result | null, context: Context, journey?: Journey | null): PassengerFrame | null {
  const need = journey?.need ?? (context.request?.active === true ? context.request.accessibility_need : undefined);
  const detected = context.perception?.yolo_detections?.filter(item => (item.confidence ?? 0) >= 0.75 && aidFor(item.label) !== 'none')
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0];
  const aid = aidFor(need) === 'none' ? aidFor(detected?.label) : aidFor(need);
  if (aid === 'none') return null;
  // A placeholder destination only positions the waiting actor; it never authorises boarding.
  const destination = journey?.boarding_target ?? result?.boarding_target ??
    (aid === 'wheelchair' ? { type: 'WHEELCHAIR_BAY' as const, id: 'WHEELCHAIR_BAY' } : { type: 'SEAT' as const, id: 'S03' });
  return { journeyId: journey?.journey_id ?? result?.request_id ?? 'waiting', aid, stage: 'waiting', destination,
    equipmentDestination: aid === 'stroller' ? equipmentFor(result, journey) : null, progress: 0 };
}

export function waitingScenario(guidance?: string, passenger: PassengerFrame | null = null, occupancy?: Record<string, boolean>): ScenarioStep[] {
  return [{ at: 0, label: 'Waiting at the stop', camera: 'overview', frame: { ...IDLE_FRAME,
    boardingStatus: 'request_received', passengerJourney: passenger, ...(occupancy ? { seatOccupancy: occupancy } : {}),
    passengerInfo: { title: 'Passenger guidance', message: guidance ?? 'Please wait for the safety operator.' } } }];
}

/** READY is a prepared plan; the live journey gate decides when this timeline may begin. */
export function actionsToScenario(result: Result | null, context: Context, running: boolean, journey?: Journey | null): ScenarioStep[] {
  const passenger = waitingPassenger(result, context, journey);
  const occupancy = cabinSeatOccupancy(context, journey?.boarding_target ?? result?.boarding_target);
  if (!result || result.plan_status !== 'READY') return waitingScenario(
    result?.passenger_communication.display_text ?? (running ? 'Preparing your assistance plan. Please wait.' : undefined), passenger, occupancy);
  const assignedTarget = journey?.animation?.target ?? journey?.boarding_target ?? result.boarding_target;
  if (passenger?.aid === 'stroller' && !validStrollerAssignment(assignedTarget, equipmentFor(result, journey))) return waitingScenario(
    'A free wheelchair space and a supported low-floor seat must be assigned together. Please wait for the safety operator.', passenger, occupancy);
  const actions = result.action_plan.map(item => item.action);
  if (has(actions, 'ABORT_ASSISTANCE_SEQUENCE')) return waitingScenario('Assistance is paused. Please wait for the safety operator.', passenger, occupancy);
  const action = (...names: string[]) => names.find(name => actions.includes(name));
  const arrivalId = journey?.animation?.id ?? `${result.request_id}:arrival`;
  // The hub times the arrival (animation.duration_ms). A short one is for a later passenger of the same bus,
  // which is already docked: start at the stop and go straight to the entrance (door, ramp) without a drive-in.
  const hubArrivalMs = journey?.animation?.phase === 'arrival' && Number.isFinite(journey.animation.duration_ms) && journey.animation.duration_ms > 0
    ? journey.animation.duration_ms : ARRIVAL_MS;
  const docked = hubArrivalMs <= DOCKED_ARRIVAL_MAX_MS;
  const dockMs = docked ? 0 : DOCK_MS;
  const preparing: ScenarioStep = { at: dockMs, label: 'Preparing entrance', action: action('HOLD_AT_STOP', 'CHECK_SINGLE_ENTRANCE_CLEARANCE', 'KEEP_SINGLE_ENTRANCE_CLEAR', 'PREPARE_WHEELCHAIR_AREA'),
    frame: { boardingStatus: 'preparing', passengerInfo: { title: 'Preparing to board', message: 'The bus is stopping and preparing the entrance. Please wait for the operator.' } } };
  const initial: TwinFrame = { ...IDLE_FRAME, ...(occupancy ? { seatOccupancy: occupancy } : {}),
    passengerJourney: passenger, arrival: { id: arrivalId, progress: docked ? 1 : 0 }, boardingStatus: 'request_received',
    passengerInfo: { title: 'Bus arriving', message: 'Your arrival has been recognised. Please stay behind the marked boarding line.' } };
  const steps: ScenarioStep[] = docked
    ? [{ ...preparing, camera: 'overview', frame: { ...initial, ...preparing.frame } }]
    : [
      { at: 0, label: 'Bus arriving', camera: 'overview', frame: initial },
      { at: 50, label: 'Bus approaching the stop', frame: { arrival: { id: arrivalId, progress: 1 } } },
      preparing,
    ];
  let t = dockMs;
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
    t = Math.max(t, dockMs + 300 + KNEEL_MS) + 200;
    steps.push({ at: t, label: 'Ramp extending', action: rampAction, frame: { ramp: 'extending' } });
    t += RAMP_MS; steps.push({ at: t, label: 'Ramp extended', action: rampAction, frame: { ramp: 'extended' } });
  } else if (has(actions, 'KEEP_RAMPS_STOWED')) {
    steps.push({ at: t, label: 'Ramp kept stowed', action: 'KEEP_RAMPS_STOWED', frame: { ramp: 'retracted' } });
  }
  const audio = result.passenger_communication.audio_text, display = result.passenger_communication.display_text;
  const ready: TwinFrame = { boardingStatus: 'ready', passengerInfo: { title: 'Ready to board', message: display ?? audio ?? 'Please board when the safety operator signals.' } };
  if (has(actions, 'ACTIVATE_EXTERNAL_SPEAKER', 'CONFIRM_ROUTE_IDENTITY', 'PLAY_ENTRANCE_AUDIO_BEACON') && audio) ready.announcement = { active: true, text: audio };
  // Ready when the hub's arrival ends (10 s from the constants for a full drive-in), never before the entrance is ready.
  steps.push({ at: docked ? Math.max(hubArrivalMs, t) : ARRIVAL_MS, label: 'Ready to board', action: action('SHOW_EXTERNAL_DISPLAY', 'WAIT_FOR_BOARDING_CONFIRMATION', 'EXTEND_DWELL_TIME'), frame: ready });
  return steps;
}

/** An open-loop path preview ends at operator confirmation with the entrance held open. */
export function boardingScenario(result: Result | null, context: Context, journey?: Journey | null): ScenarioStep[] {
  const target = journey?.animation?.target ?? journey?.boarding_target ?? result?.boarding_target;
  if (!result || result.plan_status !== 'READY' || !target) return waitingScenario('No validated place has been assigned. Please wait for the safety operator.');
  const aid = aidFor(journey?.animation?.aid ?? journey?.need ?? context.request?.accessibility_need);
  const equipment = aid === 'stroller' ? equipmentFor(result, journey) : null;
  if (aid === 'stroller' && !validStrollerAssignment(target, equipment)) return waitingScenario(
    'A free wheelchair space and a supported low-floor seat must be assigned together. Please wait for the safety operator.', waitingPassenger(result, context, journey));
  if (aid === 'wheelchair' && (target.type !== 'WHEELCHAIR_BAY' || target.id !== 'WHEELCHAIR_BAY')) return waitingScenario(
    'A free wheelchair space must be assigned. Please wait for the safety operator.', waitingPassenger(result, context, journey));
  const journeyId = journey?.animation?.id ?? `${result.request_id}:boarding`;
  const passenger = (stage: PassengerStage, progress: number): PassengerFrame => ({ journeyId, aid, stage, destination: target, equipmentDestination: equipment, progress });
  const actions = result.action_plan.map(item => item.action);
  const ramp = has(actions, 'DEPLOY_AUTOMATIC_SHORT_RAMP');
  const occupancy = cabinSeatOccupancy(context, target);
  const place = target.type === 'SEAT' ? `seat ${target.id}` : 'the wheelchair space';
  if (aid === 'stroller') {
    const milestones = strollerPathMilestones(target)!;
    const nearby = ['S02', 'S03'].includes(target.id);
    const assignedPlace = `${nearby ? 'nearby' : 'assigned'} ${place}`;
    const guidanceTitle = nearby ? 'Nearby seat guidance' : 'Assigned seat guidance';
    return [
      { at: 0, label: 'Passenger pushing stroller aboard', action: 'WAIT_FOR_BOARDING_CONFIRMATION', camera: ramp ? 'ramp' : 'entrance',
        frame: { ...IDLE_FRAME, door: 'open', ramp: ramp ? 'extended' : 'retracted', kneeling: ramp,
          boardingStatus: 'boarding', ...(occupancy ? { seatOccupancy: occupancy } : {}), passengerJourney: passenger('boarding', 0),
          passengerInfo: { title: 'Stroller boarding', message: `Park the stroller in the wheelchair space, then walk to ${assignedPlace}. Wait for the operator's assistance.` } } },
      { at: 50, label: 'Passenger entering with stroller', action: 'WAIT_FOR_BOARDING_CONFIRMATION',
        frame: { passengerJourney: passenger('boarding', milestones.entranceProgress) } },
      { at: 4500, label: 'Guiding stroller to wheelchair space', action: 'GUIDE_PASSENGER_TO_ASSIGNED_PLACE', camera: 'cutaway',
        frame: { passengerJourney: passenger('navigating', milestones.parkingProgress), passengerInfo: { title: 'Park the stroller',
          message: `Position the stroller in the wheelchair space. Your ${assignedPlace} remains reserved for you.` } } },
      { at: 8000, label: 'Stroller parked · passenger beside it', action: 'GUIDE_PASSENGER_TO_ASSIGNED_PLACE', camera: 'interior',
        frame: { passengerJourney: passenger('navigating', milestones.parkingProgress), passengerInfo: { title: 'Stroller parking preview',
          message: `The stroller is shown in the wheelchair space. After the operator assists, walk to ${assignedPlace}.` } } },
      { at: 11000, label: `Stroller parked · walking to ${place}`, action: 'GUIDE_PASSENGER_TO_ASSIGNED_PLACE', camera: 'cutaway',
        frame: { passengerJourney: passenger('navigating', 1), passengerInfo: { title: guidanceTitle,
          message: `Leave the stroller in the wheelchair space and follow the ${nearby ? 'short ' : ''}highlighted path to ${place}.` } } },
      { at: 15000, label: `Passenger approaching ${assignedPlace}`, action: 'GUIDE_PASSENGER_TO_ASSIGNED_PLACE', camera: 'interior',
        frame: { passengerInfo: { title: guidanceTitle, message: `Your assigned ${nearby ? 'nearby ' : ''}seat is ${target.id}. The stroller remains in the wheelchair space.` } } },
      { at: 19000, label: `Passenger reached ${target.id} · stroller remains in bay`, camera: 'cutaway', action: 'WAIT_FOR_SEATED_AND_BELTED_CONFIRMATION',
        frame: { passengerJourney: passenger('seated', 1), seatOccupancy: { [target.id]: true }, passengerInfo: { title: 'Awaiting operator confirmation',
          message: `The passenger is shown seated in ${target.id}${nearby ? ', close to the stroller' : ''}. The stroller remains in the wheelchair space. The operator must confirm safe positioning.` } } },
      { at: STROLLER_BOARDING_MS, label: 'Waiting for operator confirmation', action: 'WAIT_FOR_SEATED_AND_BELTED_CONFIRMATION',
        frame: { boardingStatus: 'boarding', passengerInfo: { title: 'Operator confirmation required',
          message: 'The stroller remains parked. The entrance remains in the boarding position until the operator confirms.' } } },
    ];
  }
  return [
    { at: 0, label: 'Passenger entering', action: 'WAIT_FOR_BOARDING_CONFIRMATION', camera: ramp ? 'ramp' : 'entrance',
      frame: { ...IDLE_FRAME, door: 'open', ramp: ramp ? 'extended' : 'retracted', kneeling: ramp,
        boardingStatus: 'boarding', ...(occupancy ? { seatOccupancy: occupancy } : {}), passengerJourney: passenger('boarding', 0),
        passengerInfo: { title: 'Boarding guidance', message: `Follow the highlighted path to ${place}. The entrance is held open.` } } },
    { at: 50, label: 'Passenger boarding', action: 'WAIT_FOR_BOARDING_CONFIRMATION', frame: { passengerJourney: passenger('boarding', 0.36) } },
    { at: 4500, label: `Guiding to ${place}`, action: 'GUIDE_PASSENGER_TO_ASSIGNED_PLACE', camera: 'cutaway',
      frame: { passengerJourney: passenger('navigating', 0.70), passengerInfo: { title: 'Interior guidance', message: `Follow the highlighted path to ${place}.` } } },
    { at: 8500, label: `Approaching ${place}`, action: 'GUIDE_PASSENGER_TO_ASSIGNED_PLACE', camera: 'interior',
      frame: { passengerJourney: passenger('navigating', 1) } },
    { at: 12000, label: target.type === 'SEAT' ? `Passenger reached ${target.id}` : 'Wheelchair reached the bay', camera: 'cutaway',
      action: 'WAIT_FOR_SEATED_AND_BELTED_CONFIRMATION', frame: { passengerJourney: passenger('seated', 1),
        ...(target.type === 'SEAT' ? { seatOccupancy: { [target.id]: true } } : {}),
        passengerInfo: { title: 'Awaiting operator confirmation', message: target.type === 'SEAT'
          ? `The passenger is shown seated in ${target.id}. Please wait for the operator's confirmation.`
          : 'The wheelchair is shown in the bay. The operator must confirm positioning and securement.' } } },
    { at: BOARDING_MS, label: 'Waiting for operator confirmation', action: 'WAIT_FOR_SEATED_AND_BELTED_CONFIRMATION',
      frame: { boardingStatus: 'boarding', passengerInfo: { title: 'Operator confirmation required',
        message: 'The door and ramp remain in the boarding position until the operator confirms.' } } },
  ];
}

/** One shared gate for live signals; presets can play the complete prepared-plan preview. */
export function buildScenario(result: Result | null, context: Context, running: boolean, journey: Journey | null): ScenarioStep[] {
  if (journey) {
    const active = context.request?.active === true && context.request?.intent === 'BOARDING';
    // No journey under way (ended, reset or cancelled): the empty idle bus. Only someone the camera sees at the
    // stop right now is drawn; the ended journey's need (or a stale booking channel) never keeps an actor there.
    if (!active || journey.stage === 'IDLE') return [{ at: 0, label: 'Idle', camera: 'overview',
      frame: { ...IDLE_FRAME, passengerJourney: waitingPassenger(null, { ...context, request: undefined }, null),
        ...(cabinSeatOccupancy(context) ? { seatOccupancy: cabinSeatOccupancy(context) } : {}) } }];
    if (!running && result?.plan_status === 'READY' && journey.matched) {
      if (journey.stage === 'ON_BOARD' && journey.animation?.phase === 'boarding') return boardingScenario(result, context, journey);
      if (journey.stage === 'AT_STOP' && journey.animation?.phase === 'arrival') return actionsToScenario(result, context, false, journey);
    }
    return waitingScenario(journey.guidance.display_text, waitingPassenger(result, context, journey), cabinSeatOccupancy(context));
  }
  const arrival = actionsToScenario(result, context, running);
  if (running || result?.plan_status !== 'READY' || !result.boarding_target) return arrival;
  return [...arrival, ...boardingScenario(result, context).map(step => ({ ...step, at: step.at + ARRIVAL_MS }))];
}

function mergeFrame(previous: TwinFrame, frame: TwinFrame): TwinFrame {
  return { ...previous, ...frame, ...(frame.seatOccupancy ? { seatOccupancy: { ...previous.seatOccupancy, ...frame.seatOccupancy } } : {}) };
}

/** Restore the pose at a server time, then continue toward its current animation targets. */
export function frameAtElapsed(steps: ScenarioStep[], elapsedMs: number) {
  const passed = steps.filter(step => step.at <= elapsedMs);
  if (!passed.length) return null;
  let frame: TwinFrame = {}, passengerProgress = 0, arrivalProgress = 1, previousAt = 0;
  let passengerId: string | undefined, arrivalId: string | undefined;
  const move = (to: number) => {
    const seconds = Math.max(0, to - previousAt) / 1000;
    const passenger = frame.passengerJourney;
    if (passenger) {
      const target = passenger.progress ?? 0;
      passengerProgress += Math.sign(target - passengerProgress) * Math.min(Math.abs(target - passengerProgress), seconds * (passenger.aid === 'wheelchair' ? 0.1 : 0.12));
    }
    if (frame.arrival) {
      const target = frame.arrival.progress;
      arrivalProgress += Math.sign(target - arrivalProgress) * Math.min(Math.abs(target - arrivalProgress), seconds / 4.2);
    }
    previousAt = to;
  };
  for (const step of passed) {
    move(step.at);
    frame = mergeFrame(frame, step.frame);
    if (step.frame.passengerJourney === null) { passengerId = undefined; passengerProgress = 0; }
    else if (step.frame.passengerJourney && passengerId !== step.frame.passengerJourney.journeyId) {
      passengerId = step.frame.passengerJourney.journeyId;
      passengerProgress = step.frame.passengerJourney.stage === 'boarding' ? 0 : step.frame.passengerJourney.progress ?? 0;
    }
    if (step.frame.arrival === null) { arrivalId = undefined; arrivalProgress = 1; }
    else if (step.frame.arrival && arrivalId !== step.frame.arrival.id) {
      arrivalId = step.frame.arrival.id; arrivalProgress = step.frame.arrival.progress;
    }
  }
  move(elapsedMs);
  const targets: TwinFrame = {};
  if (frame.arrival && arrivalProgress !== frame.arrival.progress) targets.arrival = { ...frame.arrival };
  if (frame.passengerJourney && Math.abs(passengerProgress - (frame.passengerJourney.progress ?? 0)) > 0.000001) targets.passengerJourney = { ...frame.passengerJourney };
  const restored: TwinFrame = { ...frame,
    ...(frame.arrival ? { arrival: { ...frame.arrival, progress: arrivalProgress } } : {}),
    ...(frame.passengerJourney ? { passengerJourney: { ...frame.passengerJourney, progress: passengerProgress,
      stage: frame.passengerJourney.stage === 'boarding' && elapsedMs > 0 ? 'navigating' : frame.passengerJourney.stage } } : {}) };
  const active = passed[passed.length - 1];
  const camera = [...passed].reverse().find(step => step.camera)?.camera;
  return { frame: restored, targets, step: camera ? { ...active, camera } : active };
}

/** Reconnect uses server elapsed time; Replay explicitly passes zero and only affects this viewer. */
export function playScenario(steps: ScenarioStep[], send: (frame: TwinFrame, step: ScenarioStep) => void, elapsedMs = 0) {
  const elapsed = Math.max(0, elapsedMs), restored = elapsed > 0 ? frameAtElapsed(steps, elapsed) : null;
  const future = steps.filter(step => !restored || step.at > elapsed);
  const timers: number[] = [];
  if (restored) {
    send(restored.frame, restored.step);
    if (Object.keys(restored.targets).length) {
      const recoveryDelay = Math.min(50, future.length ? Math.max(1, (future[0].at - elapsed) / 2) : 50);
      timers.push(window.setTimeout(() => send(restored.targets, restored.step), recoveryDelay));
    }
  }
  for (const step of future) timers.push(window.setTimeout(() => send(step.frame, step), Math.max(0, step.at - elapsed)));
  return () => timers.forEach(id => window.clearTimeout(id));
}
