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
};
export type ScenarioStep = { at: number; label: string; frame: TwinFrame };

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
  const audio = result.passenger_communication.audio_text, display = result.passenger_communication.display_text;
  const message = audio ?? display ?? 'Please wait for the safety operator.';

  if (result.plan_status === 'CANNOT_EXECUTE' || has(actions, 'ABORT_ASSISTANCE_SEQUENCE')) {
    return [{ at: 0, label: 'Assistance paused', frame: { ...IDLE_FRAME, announcement: { active: true, text: 'Boarding assistance is paused. Please wait for the safety operator.' } } }];
  }
  if (result.plan_status !== 'READY') {
    return [{ at: 0, label: 'Awaiting operator confirmation', frame: { ...IDLE_FRAME, boardingStatus: 'request_received', announcement: { active: true, text: message } } }];
  }

  let t = 0;
  steps.push({ at: t, label: 'Preparing', frame: { ...IDLE_FRAME, boardingStatus: 'preparing' } });
  const deployRamp = has(actions, 'DEPLOY_AUTOMATIC_SHORT_RAMP');
  const openDoor = has(actions, 'OPEN_SINGLE_ENTRANCE') || context.vehicle_context?.single_entrance_state === 'OPEN' || deployRamp;
  if (deployRamp) { t += 300; steps.push({ at: t, label: 'Kneeling', frame: { kneeling: true } }); }
  if (openDoor) {
    t += 300; steps.push({ at: t, label: 'Door opening', frame: { door: 'opening' } });
    t += DOOR_MS; steps.push({ at: t, label: 'Door open', frame: { door: 'open' } });
  }
  if (deployRamp) {
    t = Math.max(t, 300 + KNEEL_MS); t += 200;
    steps.push({ at: t, label: 'Ramp extending', frame: { ramp: 'extending' } });
    t += RAMP_MS; steps.push({ at: t, label: 'Ramp extended', frame: { ramp: 'extended' } });
  } else if (has(actions, 'KEEP_RAMPS_STOWED')) {
    steps.push({ at: t, label: 'Ramp kept stowed', frame: { ramp: 'retracted' } });
  }
  t += 300;
  const ready: TwinFrame = { boardingStatus: 'ready' };
  if (has(actions, 'ACTIVATE_EXTERNAL_SPEAKER', 'CONFIRM_ROUTE_IDENTITY', 'PLAY_ENTRANCE_AUDIO_BEACON') && audio) ready.announcement = { active: true, text: audio };
  if (has(actions, 'SHOW_EXTERNAL_DISPLAY') && display) ready.passengerInfo = { title: route ? `Route ${route}` : 'Boarding', message: display };
  else if (has(actions, 'EXTEND_DWELL_TIME')) ready.passengerInfo = { title: 'Extended boarding time', message: '+60 s dwell time · Board when the operator signals' };
  steps.push({ at: t, label: 'Ready to board', frame: ready });
  return steps;
}

/** Play a timeline: `send` receives each frame at its time. Returns a cancel function. */
export function playScenario(steps: ScenarioStep[], send: (frame: TwinFrame, step: ScenarioStep) => void) {
  const timers = steps.map(step => window.setTimeout(() => send(step.frame, step), step.at));
  return () => timers.forEach(id => window.clearTimeout(id));
}
