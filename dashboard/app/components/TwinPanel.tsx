"use client";
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Context, Result } from '../live-types';
import { actionLabel } from '../lib/actionLabels';
import { actionsToScenario, boardingScenario, cabinSeatOccupancy, playScenario, IDLE_FRAME, type ScenarioStep } from '../lib/twinScenario';

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

function AutoScrollMessage({ text }: { text: string }) {
  const viewport = useRef<HTMLDivElement>(null);
  const manual = useRef(false);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const node = viewport.current;
    if (!node) return;
    node.scrollTop = 0;
    manual.current = false;
    const measure = () => setOverflowing(node.scrollHeight > node.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [text]);

  useEffect(() => {
    const node = viewport.current;
    if (!node || !overflowing || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    let frame = 0;
    let direction = 1;
    let last = performance.now();
    let holdUntil = last + 1400;
    const tick = (now: number) => {
      const elapsed = Math.min(64, now - last);
      last = now;
      const maximum = Math.max(0, node.scrollHeight - node.clientHeight);
      if (!manual.current && maximum > 1 && now >= holdUntil) {
        node.scrollTop += direction * elapsed * 0.012;
        if (node.scrollTop >= maximum - 0.5) {
          node.scrollTop = maximum;
          direction = -1;
          holdUntil = now + 1600;
        } else if (node.scrollTop <= 0.5 && direction < 0) {
          node.scrollTop = 0;
          direction = 1;
          holdUntil = now + 1400;
        }
      }
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [overflowing, text]);

  const stopAutoScroll = () => { manual.current = true; };

  return <div
    ref={viewport}
    className={`twinDisplayScroll ${overflowing ? 'isOverflowing' : ''}`}
    tabIndex={overflowing ? 0 : undefined}
    aria-label="Scrollable passenger display message"
    title={overflowing ? 'Scroll to read the full message' : undefined}
    onPointerEnter={stopAutoScroll}
    onPointerDown={stopAutoScroll}
    onWheel={stopAutoScroll}
    onTouchStart={stopAutoScroll}
    onFocus={stopAutoScroll}
  ><p>{text}</p></div>;
}

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
    boardingTarget: result?.boarding_target ?? null,
    communication: result?.passenger_communication ?? null,
    cabin: context.vehicle_context?.cabin ?? null,
    entrance: context.vehicle_context?.single_entrance_state ?? '',
    route: context.request?.route_id ?? context.vehicle_context?.route_id ?? '',
    running,
  });
  // Boarding is an explicit presentation preview. Leaving the camera region is not proof that a passenger boarded.
  const [boarded, setBoarded] = useState<string[] | null>(null);
  useEffect(() => {
    const clear = window.setTimeout(() => setBoarded(null), 0);
    return () => window.clearTimeout(clear);
  }, [result?.request_id]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- key captures every input that changes the timeline
  const arrival = useMemo(() => actionsToScenario(result, context, running), [key]);
  const requestedAid = context.request?.accessibility_need ?? context.perception?.yolo_detections?.[0]?.label ?? 'NONE';
  const boardingKey = JSON.stringify({ boarded, requestedAid, playbackNonce, requestId: result?.request_id, target: result?.boarding_target, actions: result?.action_plan });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- boardingKey captures the immutable plan used by the preview
  const boarding = useMemo(() => boarded ? boardingScenario(result, boarded, requestedAid, playbackNonce) : [], [boardingKey]);
  const steps = boarded ? boarding : arrival;
  const initialSeatState = JSON.stringify(cabinSeatOccupancy(context) ?? null);
  const resultActions = result?.action_plan.map(item => item.action) ?? [];
  const rampReady = resultActions.includes('DEPLOY_AUTOMATIC_SHORT_RAMP');
  const doorReady = rampReady || resultActions.includes('OPEN_SINGLE_ENTRANCE') || context.vehicle_context?.single_entrance_state === 'OPEN';
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
    const initialSeats = JSON.parse(initialSeatState) as Record<string, boolean> | null;
    if (!boarded) {
      send({ type: 'twin:telemetry', frame: { ...IDLE_FRAME, ...(initialSeats ? { seatOccupancy: initialSeats } : {}) } });
      send({ type: 'twin:camera', preset: 'overview' });
    } else {
      send({ type: 'twin:telemetry', frame: {
        passengerJourney: null,
        boardingStatus: 'ready',
        door: doorReady ? 'open' : 'closed',
        ramp: rampReady ? 'extended' : 'retracted',
        kneeling: rampReady,
        ...(initialSeats ? { seatOccupancy: initialSeats } : {}),
      } });
    }
    const reset = window.setTimeout(() => setStep(null), 0);
    const stop = playScenario(steps, (f, s) => {
      send({ type: 'twin:telemetry', frame: f });
      if (s.camera) send({ type: 'twin:camera', preset: s.camera });
      setStep(s);
    });
    return () => { window.clearTimeout(reset); stop(); };
  }, [ready, steps, playbackNonce, iframeEpoch, boarded, initialSeatState, rampReady, doorReady]);

  const done = step ? steps.indexOf(step) + 1 : 0;
  const allActions = result?.action_plan ?? [];
  const displayAuthorized = allActions.some(item => item.action === 'SHOW_EXTERNAL_DISPLAY');
  const passengerMessage = (displayAuthorized ? result?.passenger_communication.display_text : result?.passenger_communication.audio_text)
    ?? (result?.plan_status === 'CANNOT_EXECUTE'
      ? 'Boarding assistance is paused. Please wait for the safety operator.'
      : result ? 'Please wait for the safety operator.' : null);
  const activeAction = allActions.find(item => item.action === step?.action);
  const firstActions = allActions.slice(0, 4);
  const visibleActions = activeAction && !firstActions.some(item => item.step === activeAction.step)
    ? [...firstActions.slice(0, 3), activeAction]
    : firstActions;
  const statusLabel = boarded ? (step ? step.label : 'Passenger boarding sequence')
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
        <div className="twinConsoleLabel"><span>{displayAuthorized ? 'External display' : 'Passenger guidance'}</span><strong>{result?.boarding_target?.type === 'SEAT' ? result.boarding_target.id : route === 'DEMO_ROUTE' ? '400' : route}</strong></div>
        <AutoScrollMessage text={passengerMessage ?? (running ? 'Preparing passenger guidance…' : 'Waiting for a validated passenger message.')} />
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
        {!boarded && <button className="replayAnimation previewBoarding" disabled={!ready || result?.plan_status !== 'READY' || running || !result?.boarding_target || step?.frame.boardingStatus !== 'ready'} onClick={() => {
          const label = ({ WHEELCHAIR: 'WHEELCHAIR', CANE: 'CANE', CRUTCH: 'CRUTCH', WALKER: 'WALKER', STROLLER: 'STROLLER' } as Record<string, string>)[requestedAid] ?? '';
          setBoarded(label ? [label] : []);
        }} aria-label="Preview passenger guidance and seating">▶ Preview boarding</button>}
        <button className="replayAnimation" disabled={!result || running || !steps.length} onClick={() => {
          setPlaybackNonce(value => value + 1);
        }} aria-label="Replay validated bus animation">↻ Replay</button>
      </span>
    </div>
  </section>;
}
