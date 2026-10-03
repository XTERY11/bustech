"use client";
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Context, Journey, Result } from '../live-types';
import { actionLabel } from '../lib/actionLabels';
import { buildScenario, cabinSeatOccupancy, playScenario, IDLE_FRAME, type ScenarioStep } from '../lib/twinScenario';

/**
 * Embedded bus digital twin. The twin runs in an iframe (public/twin/index.html,
 * built from ../twin with `npm run build:single`) and only receives frames:
 *   { type: 'twin:telemetry', frame } / { type: 'twin:reset' }
 * It is a presentation of the validated plan, not a vehicle interface.
 */
type TwinPanelProps = {
  result: Result | null;
  context: Context;
  running: boolean;
  /** Passenger journey for live App + camera input; null for demo presets, which play their plan directly. */
  journey?: Journey | null;
  basePath?: string;
  onStatusChange?: (ready: boolean) => void;
};

export function TwinPanel({ result, context, running, journey = null, basePath = '', onStatusChange }: TwinPanelProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const [step, setStep] = useState<ScenarioStep | null>(null);
  const [playbackNonce, setPlaybackNonce] = useState(0);
  const [iframeEpoch, setIframeEpoch] = useState(0);
  const playedNonce = useRef(0);
  const currentJourney = useRef(journey);
  const currentInputs = useRef({ context, result });
  useEffect(() => {
    currentJourney.current = journey;
    currentInputs.current = { context, result };
  }, [journey, context, result]);
  const key = JSON.stringify({
    requestId: result?.request_id ?? '',
    status: result?.plan_status ?? '',
    actions: result?.action_plan ?? [],
    entrance: context.vehicle_context?.single_entrance_state ?? '',
    route: context.request?.route_id ?? context.vehicle_context?.route_id ?? '',
    active: context.request?.active,
    intent: context.request?.intent,
    stage: journey?.stage,
    matched: journey?.matched,
    journeyId: journey?.journey_id,
    need: journey?.need,
    animation: journey?.animation ?? null,
    running,
  });
  // The hub's journey decides which half of the story the twin shows (see backend/journey.mjs):
  // BOOKED: the plan exists but the passenger is not at the stop, so the bus waits;
  // AT_STOP: the camera has matched the passenger, so the plan is carried out;
  // ON_BOARD: a matching exit begins a presentation preview; operator confirmation is still required.
  const stage = journey?.stage ?? null;
  const boarded = stage === 'ON_BOARD';
  const steps = useMemo(() => {
    return buildScenario(result, context, running, journey);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the keys capture every input that changes the timeline
  }, [key]);
  const route = String(context.request?.route_id ?? context.vehicle_context?.route_id ?? 'DEMO_ROUTE');

  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      if (ev.source !== frame.current?.contentWindow) return;
      if (ev.data?.type === 'twin:ready') setReady(true);
    };
    window.addEventListener('message', onMessage);
    // The iframe usually finishes loading before this component hydrates, so ask it to repeat 'ready'.
    frame.current?.contentWindow?.postMessage({ type: 'twin:hello' }, '*');
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => onStatusChange?.(ready), [onStatusChange, ready]);

  const send = (message: Record<string, unknown>) => frame.current?.contentWindow?.postMessage(message, '*');
  useEffect(() => {
    if (!ready) return;
    if (!boarded) {
      send({ type: 'twin:telemetry', frame: IDLE_FRAME });
      send({ type: 'twin:camera', preset: 'overview' });
    } else {
      // Reset the route actor for explicit Replay while preserving the entrance pose.
      const inputs = currentInputs.current;
      send({ type: 'twin:telemetry', frame: { passengerJourney: null, arrival: null,
        seatOccupancy: cabinSeatOccupancy(inputs.context, currentJourney.current?.boarding_target ?? inputs.result?.boarding_target) } });
    }
    const replay = playedNonce.current !== playbackNonce;
    playedNonce.current = playbackNonce;
    const animation = currentJourney.current?.animation;
    const elapsed = !replay && animation ? Math.max(0, Date.now() - animation.started_at) : 0;
    const reset = window.setTimeout(() => setStep(null), 0);
    const stop = playScenario(steps, (f, s) => {
      send({ type: 'twin:telemetry', frame: f });
      if (s.camera) send({ type: 'twin:camera', preset: s.camera });
      setStep(s);
    }, elapsed);
    return () => { window.clearTimeout(reset); stop(); };
  }, [ready, steps, playbackNonce, iframeEpoch, boarded]);

  const guidanceTitle = journey?.guidance.title;
  const guidanceText = journey?.guidance.display_text;
  useEffect(() => {
    if (ready && guidanceText) send({ type: 'twin:telemetry', frame: { passengerInfo: { title: guidanceTitle, message: guidanceText } } });
  }, [ready, guidanceTitle, guidanceText]);

  const done = step ? steps.findIndex(item => item.at === step.at && item.label === step.label) + 1 : 0;
  // Before the passenger is at the stop, and once they are on board, the journey's guidance is what applies.
  const passengerMessage = journey ? journey.guidance.display_text
    : result?.passenger_communication.display_text
    ?? result?.passenger_communication.audio_text
    ?? (result?.plan_status === 'CANNOT_EXECUTE'
      ? 'Boarding assistance is paused. Please wait for the safety operator.'
      : result ? 'Please wait for the safety operator.' : null);
  const allActions = result?.action_plan ?? [];
  const activeAction = allActions.find(item => item.action === step?.action);
  const firstActions = allActions.slice(0, 4);
  const visibleActions = activeAction && !firstActions.some(item => item.step === activeAction.step)
    ? [...firstActions.slice(0, 3), activeAction]
    : firstActions;
  const statusLabel = boarded ? (step ? step.label : 'Passenger boarding')
    : stage === 'BOOKED' && result?.plan_status === 'READY' ? 'Plan ready · waiting for the passenger at the stop'
    : result?.plan_status === 'NEEDS_CONFIRMATION'
    ? 'Safety hold · bus remains stationary'
    : result?.plan_status === 'CANNOT_EXECUTE'
      ? 'Assistance paused · bus remains stationary'
      : step ? step.label : result ? 'Plan received' : running ? 'Generating plan…' : 'Idle · waiting for signals';
  return <section className="panel stagePanel twinPanel" aria-label="Bus digital twin">
    <div className="panelHeader"><div><p className="sectionKicker">Vehicle · Digital twin</p><h2>Simulated bus response</h2></div>
      <span className={`simBadge ${ready ? 'online' : ''}`}>{ready ? 'Twin ready' : 'Loading twin…'}</span></div>
    <div className="stageMedia">
      <iframe ref={frame} title="Bus digital twin" onLoad={() => {
        setReady(false);
        setIframeEpoch(value => value + 1);
        frame.current?.contentWindow?.postMessage({ type: 'twin:hello' }, '*');
      }} src={`${basePath}/twin/index.html?embed=1&destination=${encodeURIComponent(`${route === 'DEMO_ROUTE' ? '400' : route} Punggol Coast`)}`} />
    </div>
    <div className="twinConsole" aria-label="Digital twin outputs">
      <div className="twinExternalDisplay">
        <div className="twinConsoleLabel"><span>External display</span><strong>{route === 'DEMO_ROUTE' ? '400' : route}</strong></div>
        <p tabIndex={0} aria-label="Scrollable external display message" style={{ display: 'block', WebkitLineClamp: 'unset', maxHeight: 92, overflowY: 'auto' }}>{passengerMessage ?? (running ? 'Preparing passenger guidance…' : 'Waiting for a validated passenger message.')}</p>
      </div>
      <div className="twinActions">
        <div className="twinConsoleLabel"><span>Validated actions</span><strong>{result ? result.action_plan.length : 0}</strong></div>
        {visibleActions.length ? <ol>{visibleActions.map(action => <li className={activeAction?.step === action.step ? 'isActive' : ''} key={action.step}><span>{String(action.step).padStart(2, '0')}</span>{actionLabel(action.action)}</li>)}</ol> : <p>{running ? 'Building the action sequence…' : 'No plan received yet.'}</p>}
        {(result?.action_plan.length ?? 0) > visibleActions.length && <small>+{result!.action_plan.length - visibleActions.length} more in details</small>}
      </div>
    </div>
    <div className="stageFooter">
      <span className="stageFooterStatus"><strong>{statusLabel}</strong>{activeAction && <small>Now: {actionLabel(activeAction.action)}</small>}</span>
      <span className="stageFooterControls">
        <span className="stageMeta">{steps.length ? `${done}/${steps.length} steps` : 'Simulated actions'}</span>
        <button className="replayAnimation" disabled={!result || running || !steps.length} onClick={() => {
          setPlaybackNonce(value => value + 1);
        }} aria-label="Replay validated bus animation">↻ Replay</button>
      </span>
    </div>
  </section>;
}
