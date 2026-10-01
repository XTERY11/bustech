"use client";
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Context, Result } from '../live-types';
import { actionsToScenario, playScenario, IDLE_FRAME, type ScenarioStep } from '../lib/twinScenario';

/**
 * Embedded bus digital twin. The twin runs in an iframe (public/twin/index.html,
 * built from ../twin with `npm run build:single`) and only receives frames:
 *   { type: 'twin:telemetry', frame } / { type: 'twin:reset' }
 * It is a presentation of the validated plan, not a vehicle interface.
 */
export function TwinPanel({ result, context, running, basePath = '' }: { result: Result | null; context: Context; running: boolean; basePath?: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const [step, setStep] = useState<ScenarioStep | null>(null);
  const key = `${result?.request_id ?? ''}:${result?.plan_status ?? ''}:${running}`;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- key captures every input that changes the timeline
  const steps = useMemo(() => actionsToScenario(result, context, running), [key]);
  const route = context.request?.route_id ?? context.vehicle_context?.route_id ?? 'DEMO_ROUTE';

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

  const send = (message: Record<string, unknown>) => frame.current?.contentWindow?.postMessage(message, '*');
  useEffect(() => {
    if (!ready) return;
    send({ type: 'twin:telemetry', frame: IDLE_FRAME });
    const reset = window.setTimeout(() => setStep(null), 0);
    const stop = playScenario(steps, (f, s) => { send({ type: 'twin:telemetry', frame: f }); setStep(s); });
    return () => { window.clearTimeout(reset); stop(); };
  }, [ready, steps]);

  const done = step ? steps.indexOf(step) + 1 : 0;
  return <section className="panel stagePanel twinPanel" aria-label="Bus digital twin">
    <div className="panelHeader"><div><p className="sectionKicker">Vehicle · Digital twin</p><h2>Simulated bus response</h2></div>
      <span className={`simBadge ${ready ? 'online' : ''}`}>{ready ? 'Twin ready' : 'Loading twin…'}</span></div>
    <div className="stageMedia">
      <iframe ref={frame} title="Bus digital twin" onLoad={() => frame.current?.contentWindow?.postMessage({ type: 'twin:hello' }, '*')} src={`${basePath}/twin/index.html?embed=1&destination=${encodeURIComponent(`${route === 'DEMO_ROUTE' ? '400' : route} Punggol Coast`)}`} allow="autoplay" />
    </div>
    <div className="stageFooter">
      <span>{step ? step.label : result ? 'Plan received' : running ? 'Generating plan…' : 'Idle · waiting for signals'}</span>
      <span className="stageMeta">{steps.length ? `${done}/${steps.length} steps` : 'Simulated actions'}</span>
    </div>
  </section>;
}
