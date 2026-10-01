"use client";
import { useEffect, useRef, useState } from 'react';
import cases from '../backend/examples/demo_cases.json';
import { ACTIONS } from '../backend/planner/contracts.mjs';
import { offlinePlan } from './offline';
import { postSignal, watchEvents } from './live-client';
import { VideoPanel } from './components/VideoPanel';
import { TwinPanel } from './components/TwinPanel';
import type { Context, HubEvent, Mode, Result, Snapshot, Summary } from './live-types';

const choices = [
  ['wheelchair_auto', 'Wheelchair', 'Ramp requested', 'orange'], ['crutch', 'Crutches', 'Extra boarding time', 'teal'],
  ['visual', 'Vision support', 'Audio guidance', 'blue'], ['hearing', 'Hearing support', 'Visual guidance', 'blue'],
  ['manual_unknown_limits', 'Manual help', 'Check ramp conditions', 'orange'], ['emergency_stop', 'Emergency stop', 'Pause assistance', 'red'],
];
const sample = (id: string) => ({ ...structuredClone(cases.find(c => c.name === id)!.input), presentation_mode: 'WEB_DEMO' }) as unknown as Context;
const presetFor = (c: Context) => {
  if (c.vehicle_context?.emergency_stop_active) return 'emergency_stop';
  if (c.request?.accessibility_need === 'WHEELCHAIR' && (c.vehicle_context?.hardware_capabilities as Record<string, unknown> | undefined)?.automatic_ramp_limits_verified === false) return 'manual_unknown_limits';
  return ({ WHEELCHAIR: 'wheelchair_auto', CRUTCH: 'crutch', VISUAL_ASSISTANCE: 'visual', HEARING_ASSISTANCE: 'hearing' } as Record<string, string>)[c.request?.accessibility_need ?? ''] ?? 'wheelchair_auto';
};
const sources: Record<string, string> = { llm: 'DeepSeek response', rules: 'Server rules', browser_rules: 'Browser rules', safety_rules: 'Demo safety rules', safe_fallback: 'Fallback · operator assistance' };
const labels: Record<string, string> = { booking: 'App booking', perception: 'YOLO detection', vehicle: 'Vehicle state', planning: 'Generation started', summary: 'Summary received', result: 'Actions received', cancelled: 'Previous run cancelled', failure: 'Generation failed', discarded: 'Previous result discarded' };
const actionNames: Record<string, string> = {
  ABORT_ASSISTANCE_SEQUENCE: 'Abort assistance', HOLD_AT_STOP: 'Hold at stop', REQUEST_ONBOARD_SAFETY_OPERATOR: 'Request operator assistance',
  CHECK_SINGLE_ENTRANCE_CLEARANCE: 'Check entrance clearance', KEEP_SINGLE_ENTRANCE_CLEAR: 'Keep entrance clear', PREPARE_WHEELCHAIR_AREA: 'Prepare wheelchair space',
  EXTEND_DWELL_TIME: 'Extend boarding time', KEEP_RAMPS_STOWED: 'Keep ramp stowed', OPEN_SINGLE_ENTRANCE: 'Open entrance door',
  DEPLOY_AUTOMATIC_SHORT_RAMP: 'Deploy automatic ramp', REQUEST_MANUAL_RAMP_DEPLOYMENT: 'Request manual ramp assistance',
  ACTIVATE_EXTERNAL_SPEAKER: 'Activate audio guidance', CONFIRM_ROUTE_IDENTITY: 'Announce route', PLAY_ENTRANCE_AUDIO_BEACON: 'Play entrance audio beacon',
  SHOW_EXTERNAL_DISPLAY: 'Show boarding message', WAIT_FOR_BOARDING_CONFIRMATION: 'Wait for boarding confirmation', WAIT_FOR_SEATED_AND_BELTED_CONFIRMATION: 'Wait for seating and securement',
};

export default function Dashboard() {
  const [scenarioId, setScenarioId] = useState('wheelchair_auto');
  const [context, setContext] = useState<Context>(() => sample('wheelchair_auto'));
  const [inputSource, setInputSource] = useState<'demo' | 'external'>('demo');
  const [mode, setMode] = useState<Mode>('single');
  const [connected, setConnected] = useState(false), [configured, setConfigured] = useState(false);
  const [apiBase, setApiBase] = useState(process.env.NEXT_PUBLIC_API_BASE_URL ?? '');
  const [draftBase, setDraftBase] = useState(process.env.NEXT_PUBLIC_API_BASE_URL ?? '');
  const [token, setToken] = useState(''), [draftToken, setDraftToken] = useState('');
  const [running, setRunning] = useState(false), [error, setError] = useState('');
  const [summary, setSummary] = useState<Summary | null>(null), [result, setResult] = useState<Result | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [events, setEvents] = useState<{ id: number; at: number; label: string }[]>([]);
  const [modal, setModal] = useState<'json' | 'library' | null>(null), [speaking, setSpeaking] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

  useEffect(() => {
    const abort = new AbortController();
    const applySnapshot = (s: Snapshot) => {
      setSnapshot(s);
      setRunning(Boolean(s.running)); setSummary(s.summary); setResult(s.result);
      if (!Object.keys(s.channels).length) return;
      setContext(s.context); setInputSource(s.source); setMode(s.mode); if (s.source === 'demo') setScenarioId(presetFor(s.context));
    };
    const onEvent = (event: HubEvent) => {
      const d = event.data;
      if (event.type === 'snapshot') applySnapshot(d as unknown as Snapshot);
      if (event.type === 'settings') setMode(d.mode as Mode);
      if (event.type === 'signal') { applySnapshot(d.snapshot as Snapshot); if (d.changed === false) return; }
      if (event.type === 'planning') { setRunning(true); setResult(null); setSummary(null); setError(''); setContext(d.context as Context); setInputSource(d.source as 'demo' | 'external'); setMode(d.mode as Mode); }
      if (event.type === 'summary') setSummary(d.summary as Summary);
      if (event.type === 'result') {
        const next = d.result as Result;
        setResult(next); setSummary(previous => next.meta.source === 'safe_fallback' ? { request_id: next.request_id, decision_summary: next.decision_summary } : previous ?? { request_id: next.request_id, decision_summary: next.decision_summary }); setRunning(false);
        if (next.meta.error) setError(`Backend returned ${next.meta.error}. The plan is waiting for operator assistance.`);
      }
      if (['cancelled', 'failure', 'discarded'].includes(event.type)) { setRunning(false); setResult(null); setSummary(null); setError(String(d.message ?? 'Inputs have changed')); }
      const label = event.type === 'signal' ? labels[String(d.channel)] : labels[event.type];
      if (label) setEvents(old => [{ id: event.id, at: event.at, label }, ...old].slice(0, 6));
    };
    void fetch(`${apiBase}/api/health`, { signal: abort.signal }).then(r => r.ok ? r.json() : null).then(health => { if (health) setConfigured(health.llm_configured); }).catch(() => {});
    void watchEvents(apiBase, token, abort.signal, onEvent, online => { setConnected(online); if (!online) setRunning(false); });
    return () => abort.abort();
  }, [apiBase, token]);
  useEffect(() => { if (modal && !dialog.current?.open) dialog.current?.showModal(); if (!modal && dialog.current?.open) dialog.current?.close(); }, [modal]);
  useEffect(() => () => { if ('speechSynthesis' in window) window.speechSynthesis.cancel(); }, []);

  function reset() { setResult(null); setSummary(null); setError(''); setSpeaking(false); if ('speechSynthesis' in window) window.speechSynthesis.cancel(); }
  function choose(id: string) { reset(); setScenarioId(id); setInputSource('demo'); setContext(sample(id)); }
  function edit(change: (next: Context) => void) { reset(); const next = structuredClone(context); change(next); setContext(next); }
  async function run() {
    reset();
    if (!connected) {
      if (mode !== 'rules' || inputSource === 'external') { setError('Connect the signal server to use DeepSeek, or choose Offline rules to try a preset.'); return; }
      try { const next = offlinePlan(context); setResult(next); setSummary({ request_id: next.request_id, decision_summary: next.decision_summary }); } catch { setError('Invalid input. Please select a demo preset again.'); }
      return;
    }
    setRunning(true);
    try {
      if (inputSource === 'demo') await postSignal(apiBase, token, '/api/demo', { mode, context: { ...context, request_id: `demo-${crypto.randomUUID()}` } });
      else { await postSignal(apiBase, token, '/api/settings', { mode }); await postSignal(apiBase, token, '/api/run', {}); }
    } catch (failure) { setRunning(false); setError(failure instanceof Error ? failure.message : 'Could not connect to the server'); }
  }
  async function changeMode(next: Mode) { setMode(next); reset(); if (connected) try { await postSignal(apiBase, token, '/api/settings', { mode: next }); } catch { setError('Could not update the generation mode.'); } }
  function play() {
    if (!('speechSynthesis' in window) || !result?.passenger_communication.audio_text) return;
    window.speechSynthesis.cancel(); if (speaking) { setSpeaking(false); return; }
    const speech = new SpeechSynthesisUtterance(result.passenger_communication.audio_text);
    speech.lang = result.passenger_communication.language; speech.onend = () => setSpeaking(false); speech.onerror = () => setSpeaking(false);
    setSpeaking(true); window.speechSynthesis.speak(speech);
  }
  const disabled = running || inputSource === 'external', request = context.request ?? {}, vehicle = context.vehicle_context ?? {};
  const detection = context.perception?.yolo_detections?.[0];
  const message = result?.passenger_communication.audio_text ?? result?.passenger_communication.display_text;
  const actions = result?.action_plan.map(a => a.action) ?? [];
  const rampPreview = actions.includes('DEPLOY_AUTOMATIC_SHORT_RAMP') ? 'Deploy ramp' : actions.includes('REQUEST_MANUAL_RAMP_DEPLOYMENT') ? 'Manual help' : actions.includes('KEEP_RAMPS_STOWED') ? 'Keep stowed' : 'Awaiting plan';

  return <main className="demoShell">
    <header className="topbar"><div className="brandLockup"><div className="brandMark">AR</div><div><div className="eyebrow">Accessible boarding · Live demo</div><h1>AccessRide Prompt Lab</h1></div></div><div className="topbarStatus"><span className={`connectionDot ${connected ? 'online' : ''}`} /><span>{connected ? 'Signal server connected' : 'Signal server disconnected'}</span><span className="statusDivider" /><span>Simulated vehicle actions</span></div></header>
    <section className="connectionBar" aria-label="Connection and generation mode">
      <label>Generation mode<select value={mode} disabled={running} onChange={e => void changeMode(e.target.value as Mode)}><option value="single">DeepSeek · Single call</option><option value="two_turn">DeepSeek · Two turns</option><option value="rules">Offline rules · No API calls</option></select></label>
      <div className="connectionDescription">{mode === 'two_turn' ? 'Turn 1 explains the decision. Turn 2 returns the actions.' : mode === 'single' ? 'One call returns a decision summary and actions.' : 'Run the same decision rules without using API credits.'}<small>{connected ? configured ? 'DeepSeek is configured on the server' : 'No DeepSeek key configured. Rules mode is available.' : 'Connect a signal server or use Offline rules.'}</small></div>
      <details className="connectionSettings"><summary>Connection settings</summary><div className="settingsFields"><label>Server URL<input placeholder="Same-origin /api, or https://your-server" value={draftBase} onChange={e => setDraftBase(e.target.value)} /></label><label>Access token (optional)<input type="password" autoComplete="off" value={draftToken} onChange={e => setDraftToken(e.target.value)} placeholder="Signal server token, not your DeepSeek key" /></label><button className="secondaryButton" onClick={() => { const value = draftBase.trim().replace(/\/$/, ''); if (value && !/^https?:\/\//.test(value)) { setError('Server URL must start with http:// or https://.'); return; } setApiBase(value); setToken(draftToken.trim()); setError(''); }}>Connect</button></div></details>
    </section>
    <section className="scenarioBar" aria-label="Demo scenarios"><div className="vehicleThumb"><img src={`${basePath}/bus-exterior.jpg`} alt="Green autonomous bus reference photo" /><div className="vehicleThumbOverlay"><span>Web simulation</span><strong>Accessible boarding demo</strong></div></div><div className="scenarioPicker"><div className="scenarioPickerHead"><div><p className="sectionKicker">Signal presets</p><h2>Choose a demo scenario</h2></div><button className="textButton" onClick={() => setModal('library')}>Allowed actions →</button></div><div className="scenarioTabs">{choices.map(([id, label, subtitle, accent], i) => <button key={id} disabled={running} className={`scenarioTab scenarioTab--${accent} ${scenarioId === id && inputSource === 'demo' ? 'isActive' : ''}`} onClick={() => choose(id)} aria-pressed={scenarioId === id && inputSource === 'demo'}><span className="scenarioNumber">{String(i + 1).padStart(2, '0')}</span><span><strong>{label}</strong><small>{subtitle}</small></span></button>)}</div></div></section>
    <section className="stageRow" aria-label="Camera and vehicle">
      <VideoPanel />
      <TwinPanel result={result} context={context} running={running} basePath={basePath} />
    </section>
    <section className="workspace" aria-label="Live boarding assistant">
      <aside className="panel inputPanel"><div className="panelHeader"><div><p className="sectionKicker">01 · Signals</p><h2>Input signals</h2></div><span className="simBadge">{inputSource === 'demo' ? 'Demo data' : 'External signals'}</span></div>
        <div className="inputSourceSwitch"><button className={inputSource === 'demo' ? 'active' : ''} disabled={running} onClick={() => choose(scenarioId)}>Demo inputs</button><button className={inputSource === 'external' ? 'active' : ''} disabled={running || !connected} onClick={() => { reset(); setInputSource('external'); if (snapshot) setContext(snapshot.context); }}>Listen to Python / App</button></div>
        <div className="inputSection"><h3>Mobile app booking</h3><div className="liveForm"><label>Assistance needed<select disabled={disabled} value={request.accessibility_need ?? 'UNKNOWN'} onChange={e => edit(c => { c.request = { ...c.request, accessibility_need: e.target.value }; })}>{[['WHEELCHAIR', 'Wheelchair'], ['CRUTCH', 'Crutches'], ['STROLLER', 'Stroller'], ['VISUAL_ASSISTANCE', 'Vision support'], ['HEARING_ASSISTANCE', 'Hearing support'], ['UNKNOWN', 'Awaiting booking']].map(([v, title]) => <option key={v} value={v}>{title}</option>)}</select></label><label className="checkLabel"><input type="checkbox" disabled={disabled} checked={request.ramp_preference === 'REQUESTED'} onChange={e => edit(c => { c.request = { ...c.request, ramp_preference: e.target.checked ? 'REQUESTED' : 'UNSPECIFIED', assistance_requested: e.target.checked ? ['WHEELCHAIR_RAMP', 'ADDITIONAL_BOARDING_TIME'] : ['ADDITIONAL_BOARDING_TIME'] }; })} />Ramp requested for this booking</label><small>Route {request.route_id ?? 'Not received'} · Stop {request.stop_id ?? 'Not received'}</small></div></div>
        <div className="inputSection"><h3>YOLO detections</h3><div className="liveForm"><label>Detected object<select disabled={disabled} value={detection?.label ?? 'NONE'} onChange={e => edit(c => { c.perception = { ...c.perception, yolo_detections: e.target.value === 'NONE' ? [] : [{ label: e.target.value, confidence: 0.94 }] }; })}>{['NONE', 'WHEELCHAIR', 'CRUTCH', 'CANE', 'WALKER', 'STROLLER', 'UNKNOWN'].map(x => <option key={x}>{x}</option>)}</select></label><label>Confidence<input type="number" min="0" max="1" step="0.01" disabled={disabled || !detection} value={detection?.confidence ?? 0} onChange={e => edit(c => { if (c.perception?.yolo_detections?.[0]) c.perception.yolo_detections[0].confidence = Number(e.target.value); })} /></label><small>Send detections; images stay on the vision device.</small></div></div>
        <details className="inputSection"><summary>Simulation settings · Automatic</summary><div className="liveForm">{[['entrance_clear', 'Entrance clear'], ['safety_operator_approval', 'Operator approval'], ['emergency_stop_active', 'Emergency stop']].map(([key, label]) => <label className="checkLabel" key={key}><input type="checkbox" disabled={disabled} checked={vehicle[key] === true} onChange={e => edit(c => { c.vehicle_context = { ...c.vehicle_context, [key]: e.target.checked }; })} />{label}</label>)}<small>Vehicle {vehicle.motion_state ?? 'STOPPED'} · Door {vehicle.single_entrance_state ?? 'OPEN'}<br />Ramp {vehicle.ramp_state ?? 'STOWED'}<br />Preset conditions; no vehicle connection needed.</small></div></details>
        <details className="inputSection"><summary>View input JSON</summary><pre className="inputJson">{JSON.stringify(context, null, 2)}</pre></details>
      </aside>
      <section className="panel tracePanel"><div className="panelHeader traceHeader"><div><p className="sectionKicker">02 · Live reasoning summary</p><h2>Thinking → Action</h2></div><button className="primaryButton" disabled={running} onClick={() => void run()}><span className={running ? 'buttonSpinner' : 'buttonPlay'} aria-hidden="true" />{running ? 'Generating…' : inputSource === 'external' ? 'Run with current signals' : 'Send signals & run'}</button></div>
        <div className="promptNotice"><span className="wrenchIcon">◆</span><div><strong>App + YOLO → Decisions & actions</strong><p>Two signal sources · Vehicle conditions are simulated</p></div><span className="promptVersion">DEMO</span></div>{error && <div className="errorNotice" role="alert">{error}</div>}
        <div className="flowRibbon"><span>Receive inputs</span><span>→</span><span className={running ? 'current' : ''}>Generate / validate</span><span>→</span><span>Update display</span></div>
        <article className={`liveTraceCard ${summary ? 'complete' : ''}`} aria-live="polite"><div className="stepLabel"><span>01</span> Thinking · Decision summary</div>{summary ? <ul className="summaryList">{summary.decision_summary.map((line, i) => <li key={i}>{line}</li>)}</ul> : <p className="waitingText">{running ? 'Generating a short summary from the received signals…' : 'Run a demo preset, or wait for Python and app signals.'}</p>}<small>{mode === 'two_turn' ? 'The first response appears here while turn 2 generates actions.' : 'A short explanation of the facts and selected response.'}</small></article>
        <article className={`liveTraceCard ${result ? 'complete' : ''}`} aria-live="polite"><div className="stepLabel"><span>02</span> Action · Structured actions</div>{result ? <><div className="resultMeta"><strong>{result.plan_status}</strong><span>{sources[result.meta.source] ?? result.meta.source}</span></div><p>{result.action_plan.length} actions returned. Review the full action plan.</p><div className="metricRow"><span><strong>{result.meta.api_calls}</strong> API calls</span><span><strong>{result.meta.latency_ms}</strong> ms</span><span><strong>{result.meta.usage.total_tokens ?? '—'}</strong> tokens</span></div></> : <p className="waitingText">{summary && running ? 'Summary received. Generating actions…' : 'Waiting for a validated action plan.'}</p>}</article>
        <div className="signalHistory"><h3>Signal timeline</h3>{events.length ? <ol>{events.map((e, i) => <li key={`${e.id}-${i}`}><time>{new Date(e.at).toLocaleTimeString('en-SG', { hour12: false })}</time><span>{e.label}</span></li>)}</ol> : <p>Bookings, detections and generation stages appear here.</p>}</div>
      </section>
      <aside className="panel outputPanel"><div className="panelHeader"><div><p className="sectionKicker">03 · Output</p><h2>Actions & passenger guidance</h2></div><span className={`planStatus planStatus--${result?.plan_status.toLowerCase() ?? 'waiting'}`}>{result?.plan_status ?? 'WAITING'}</span></div>
        <div className="simulationPreview" aria-label="Simulated action preview"><div><small>Ramp simulation</small><strong>{rampPreview}</strong></div><div><small>Boarding time</small><strong>{actions.includes('EXTEND_DWELL_TIME') ? '+60 seconds' : 'Awaiting plan'}</strong></div><p>Web simulation · {inputSource === 'external' ? 'Latest input snapshot retained' : 'Demo preset'}</p></div>
        <div className="outputBlock actionOutput"><div className="outputBlockHead"><h3>Action plan</h3><span>Simulated actions</span></div>{result ? <ol className="actionList">{result.action_plan.map(a => <li className={`actionItem actionItem--${a.action.includes('OPERATOR') ? 'operator' : 'ready'}`} key={a.step}><span className="actionIndex">{String(a.step).padStart(2, '0')}</span><div><strong className="actionTitle">{actionNames[a.action] ?? a.action}</strong><div className="actionName"><code>{a.action}</code></div>{Object.keys(a.parameters).length > 0 && <p className="actionParameters">{JSON.stringify(a.parameters)}</p>}</div></li>)}</ol> : <div className="emptyOutput"><span>→</span><p>Selected actions will appear after a run.</p></div>}</div>
        <div className="outputBlock passengerOutput"><div className="outputBlockHead"><div><p className="sectionKicker">{result?.passenger_communication.channel ?? 'Passenger message'}</p><h3>Passenger guidance</h3></div>{result?.passenger_communication.audio_text && <button className="audioButton" onClick={play}>{speaking ? 'Stop audio' : 'Play audio'}</button>}</div>{message ? <div className="externalDisplay"><div className="displayRoute">ACCESSRIDE · PLEASE WAIT</div><p>{message}</p></div> : <p className="waitingText">{result ? 'No audio or display message is needed. Await operator assistance.' : 'Passenger guidance appears when the plan is ready.'}</p>}</div>
        <div className="outputActions"><button className="secondaryButton" disabled={!result} onClick={() => setModal('json')}>View full JSON</button><span>Display only</span></div></aside>
    </section>
    <section className="safetyStrip" aria-label="Validation status"><div className="safetyTitle"><span className="shieldMark">✓</span><div><p className="sectionKicker">Demo pipeline</p><h2>Demo pipeline</h2></div></div><div className="safetyChecks">{[[result ? result.meta.validation_passed ? 'Actions validated' : 'Fallback active' : 'Awaiting validation', 'Action types, allowed set and order'], ['Two input sources', 'App booking + Python YOLO'], ['Web simulation', 'Vehicle and ramp states are preset'], ['Results stay visible', 'New inputs update the decision and actions']].map(([title, detail]) => <div className="safetyCheck" key={title}><div><strong>{title}</strong><span>{detail}</span></div></div>)}</div></section>
    <footer className="footer"><span>AccessRide · Camera YOLO + App → DeepSeek → Dashboard + Digital twin</span><span>{result ? sources[result.meta.source] : 'Signal-driven demo'} · {inputSource === 'demo' ? 'Synthetic inputs' : 'External inputs'}</span></footer>
    <dialog className="modal liveDialog" ref={dialog} onClose={() => setModal(null)}><div className="modalHeader"><div><p className="sectionKicker">{modal === 'json' ? 'Received response' : 'Allowed meta-actions'}</p><h2>{modal === 'json' ? 'Response JSON' : 'Allowed actions'}</h2></div><button className="closeButton" aria-label="Close dialog" onClick={() => setModal(null)}>×</button></div>{modal === 'json' ? <pre className="jsonCode">{JSON.stringify(result, null, 2)}</pre> : <ul className="allowlist">{ACTIONS.map((a: string) => <li key={a}><code>{a}</code></li>)}</ul>}</dialog>
  </main>;
}
