"use client";
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Context, Result } from '../live-types';
import { actionLabel } from '../lib/actionLabels';
import { actionsToScenario, boardingScenario, playScenario, IDLE_FRAME, type ScenarioStep } from '../lib/twinScenario';

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
  basePath?: string;
  onStatusChange?: (ready: boolean) => void;
};

export function TwinPanel({ result, context, running, basePath = '', onStatusChange }: TwinPanelProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const [step, setStep] = useState<ScenarioStep | null>(null);
  const [playbackNonce, setPlaybackNonce] = useState(0);
  const [iframeEpoch, setIframeEpoch] = useState(0);
  const key = JSON.stringify({
    requestId: result?.request_id ?? '',
    status: result?.plan_status ?? '',
    actions: result?.action_plan ?? [],
    communication: result?.passenger_communication ?? null,
    entrance: context.vehicle_context?.single_entrance_state ?? '',
    route: context.request?.route_id ?? context.vehicle_context?.route_id ?? '',
    running,
  });
  // Second trigger: the camera bridge reports what happens at the stop in perception.zone. A passenger who
  // leaves the region after a READY plan is taken to have boarded, and the twin plays the boarding half.
  const zone = context.perception?.zone as { triggered?: boolean; event?: string; left?: string[] } | undefined;
  const armed = useRef(false);  // a READY plan was shown while the passenger was at the stop
  const [boarded, setBoarded] = useState<string[] | null>(null);
  const atStop = zone?.triggered === true, leftStop = zone?.event === 'exit';
  const leftKey = (zone?.left ?? []).join(',');
  useEffect(() => {
    if (atStop) {
      if (result?.plan_status === 'READY') armed.current = true;
      const clear = window.setTimeout(() => setBoarded(null), 0);  // someone new is at the stop
      return () => window.clearTimeout(clear);
    }
    if (leftStop && armed.current) {
      armed.current = false;
      const start = window.setTimeout(() => setBoarded(leftKey ? leftKey.split(',') : []), 0);
      return () => window.clearTimeout(start);
    }
  }, [atStop, leftStop, leftKey, result?.plan_status]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- key captures every input that changes the timeline
  const arrival = useMemo(() => actionsToScenario(result, context, running), [key]);
  // While the boarding half plays (and after it), a re-plan must not restart the arrival half.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the plan in force when the passenger left is the one to finish
  const steps = useMemo(() => boarded ? boardingScenario(result, boarded) : arrival, [boarded, arrival]);
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
    if (!boarded) {  // the boarding half continues from the READY pose instead of resetting it
      send({ type: 'twin:telemetry', frame: IDLE_FRAME });
      send({ type: 'twin:camera', preset: 'overview' });
    }
    const reset = window.setTimeout(() => setStep(null), 0);
    const stop = playScenario(steps, (f, s) => {
      send({ type: 'twin:telemetry', frame: f });
      if (s.camera) send({ type: 'twin:camera', preset: s.camera });
      setStep(s);
    });
    return () => { window.clearTimeout(reset); stop(); };
  }, [ready, steps, playbackNonce, iframeEpoch, boarded]);

  const done = step ? steps.indexOf(step) + 1 : 0;
  const passengerMessage = result?.passenger_communication.display_text
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
  const statusLabel = boarded ? (step ? step.label : 'Passenger left the stop')
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
        <p>{passengerMessage ?? (running ? 'Preparing passenger guidance…' : 'Waiting for a validated passenger message.')}</p>
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
