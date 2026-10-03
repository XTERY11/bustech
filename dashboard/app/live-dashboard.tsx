"use client";

import { useEffect, useRef, useState } from 'react';
import cases from '../backend/examples/demo_cases.json';
import { ACTIONS } from '../backend/planner/contracts.mjs';
import { TwinPanel } from './components/TwinPanel';
import { VideoPanel } from './components/VideoPanel';
import { JourneyCountdown } from './components/JourneyCountdown';
import { WordReveal } from './components/WordReveal';
import { ACTION_LABELS } from './lib/actionLabels';
import { postSignal, snapshotFromEvent, watchEvents } from './live-client';
import type { Context, HubEvent, Journey, JourneyEntry, Mode, Navigation, Result, Snapshot, Summary } from './live-types';
import { offlinePlan } from './offline';

const choices = [
  ['wheelchair_auto', 'Wheelchair', 'Ramp requested', 'orange'],
  ['crutch', 'Crutches', 'Extra boarding time', 'teal'],
  ['visual', 'Vision support', 'Audio guidance', 'blue'],
  ['hearing', 'Hearing support', 'Visual guidance', 'blue'],
  ['manual_unknown_limits', 'Manual help', 'Check ramp conditions', 'orange'],
  ['emergency_stop', 'Emergency stop', 'Pause assistance', 'red'],
];

const sample = (id: string) => ({
  ...structuredClone(cases.find(c => c.name === id)!.input),
  presentation_mode: 'WEB_DEMO',
}) as unknown as Context;

const presetFor = (context: Context) => {
  if (context.vehicle_context?.emergency_stop_active) return 'emergency_stop';
  const hardware = context.vehicle_context?.hardware_capabilities as Record<string, unknown> | undefined;
  if (context.request?.accessibility_need === 'WHEELCHAIR' && hardware?.automatic_ramp_limits_verified === false) return 'manual_unknown_limits';
  return ({
    WHEELCHAIR: 'wheelchair_auto',
    CRUTCH: 'crutch',
    VISUAL_ASSISTANCE: 'visual',
    HEARING_ASSISTANCE: 'hearing',
  } as Record<string, string>)[context.request?.accessibility_need ?? ''] ?? 'wheelchair_auto';
};

const sources: Record<string, string> = {
  llm: 'DeepSeek response',
  rules: 'Server rules',
  browser_rules: 'Browser rules',
  safety_rules: 'Demo safety rules',
  safe_fallback: 'Fallback · operator assistance',
};

const labels: Record<string, string> = {
  booking: 'App booking',
  perception: 'YOLO detection',
  vehicle: 'Vehicle state',
  planning: 'Generation started',
  summary: 'Summary received',
  result: 'Actions received',
  navigation: 'Passenger guidance updated',
  cancelled: 'Previous run cancelled',
  failure: 'Generation failed',
  discarded: 'Previous result discarded',
};

const NEED_ALREADY_BOOKED = 'A request for this type of assistance is already active. Please try again after that passenger has boarded.';
const needLabel = (need?: string | null) => need ? need.charAt(0) + need.slice(1).toLowerCase().replaceAll('_', ' ') : 'Booking';
const placeLabel = (target?: Journey['boarding_target']) => target?.type === 'WHEELCHAIR_BAY' ? 'Wheelchair bay' : target?.type === 'SEAT' ? `Seat ${target.id}` : null;
const isWaitingEntry = (entry: JourneyEntry) => entry.stage !== 'IDLE' && !entry.completed
  && (entry.queued === true || (entry.position ?? 0) > 0 || entry.reason === 'waiting_turn' || entry.reason === 'no_place');

/** One chip of the waiting list: the hub serves one passenger at a time, oldest booking first. */
function waitingChip(entry: JourneyEntry, currentId: string | null | undefined) {
  const ahead = entry.position ?? 0;
  const current = Boolean(entry.journey_id) && entry.journey_id === currentId && !isWaitingEntry(entry);
  let state: string, tone: 'online' | 'active' | 'waiting' | 'offline';
  if (entry.stage === 'IDLE') {
    state = entry.reason === 'cancelled' ? 'Cancelled' : entry.reason === 'expired' ? 'Expired' : 'Done';
    tone = 'waiting';
  } else if (current) {
    state = `In progress · ${entry.stage === 'ON_BOARD' ? 'On board' : entry.stage === 'AT_STOP'
      ? entry.pending_exit || entry.navigation?.phase === 'BOARD_BUS' ? 'Boarding' : 'At the stop' : 'On the way'}`;
    tone = 'active';
  } else if (entry.completed) {
    state = 'Done';
    tone = 'online';
  } else if (entry.reason === 'no_place') {
    state = 'No place · operator';
    tone = 'offline';
  } else if (entry.reason === 'waiting_turn') {
    state = `Waiting at the stop · ${ahead > 0 ? `${ahead} ahead` : 'next'}`;
    tone = 'waiting';
  } else {
    state = `Waiting · ${ahead > 0 ? `${ahead} ahead` : 'next'}`;
    tone = 'waiting';
  }
  return { id: entry.journey_id ?? `${entry.need}-${entry.updated_at}`, need: needLabel(entry.need), state, tone, current,
    place: entry.stage === 'IDLE' ? null : placeLabel(entry.boarding_target) };
}

const TOKEN_KEY = 'accessride.hubToken';

export default function Dashboard() {
  const [scenarioId, setScenarioId] = useState('wheelchair_auto');
  const [context, setContext] = useState<Context>(() => sample('wheelchair_auto'));
  const [inputSource, setInputSource] = useState<'demo' | 'external'>('demo');
  const [mode, setMode] = useState<Mode>('single');
  const [connected, setConnected] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [apiBase, setApiBase] = useState(process.env.NEXT_PUBLIC_API_BASE_URL ?? '');
  const [draftBase, setDraftBase] = useState(process.env.NEXT_PUBLIC_API_BASE_URL ?? '');
  const [token, setToken] = useState('');
  const [draftToken, setDraftToken] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [resetting, setResetting] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [events, setEvents] = useState<{ id: number; at: number; label: string }[]>([]);
  const [modal, setModal] = useState<'json' | 'library' | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [visionStatus, setVisionStatus] = useState({ online: false, triggered: false, fps: 0 });
  const [twinReady, setTwinReady] = useState(false);
  const [journey, setJourney] = useState<Journey | null>(null);
  const [navigation, setNavigation] = useState<Navigation | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

  useEffect(() => {
    const abort = new AbortController();
    const applySnapshot = (next: Snapshot) => {
      setSnapshot(next);
      setJourney(next.journey ?? null);
      setNavigation(next.navigation ?? null);
      setRunning(Boolean(next.running));
      setSummary(next.summary);
      setResult(next.result);
      if (!Object.keys(next.channels).length) return;
      setContext(next.context);
      setInputSource(next.source);
      setMode(next.mode);
      if (next.source === 'demo') setScenarioId(presetFor(next.context));
    };
    const onEvent = (event: HubEvent) => {
      const data = event.data;
      const authoritative = snapshotFromEvent(event);
      if (authoritative) applySnapshot(authoritative);
      if (event.type === 'settings') setMode(data.mode as Mode);
      if (event.type === 'signal') {
        if (data.changed === false) return;
      }
      if (event.type === 'navigation' && !authoritative) setNavigation(data.navigation as Navigation | null);
      if (event.type === 'planning') {
        setRunning(true);
        setResult(null);
        setSummary(null);
        setError('');
        setContext(data.context as Context);
        setInputSource(data.source as 'demo' | 'external');
        setMode(data.mode as Mode);
      }
      if (event.type === 'summary') setSummary(data.summary as Summary);
      if (event.type === 'result') {
        const next = data.result as Result;
        setResult(next);
        setSummary(previous => next.meta.source === 'safe_fallback'
          ? { request_id: next.request_id, decision_summary: next.decision_summary }
          : previous ?? { request_id: next.request_id, decision_summary: next.decision_summary });
        setRunning(false);
        if (next.meta.error) setError(`Backend returned ${next.meta.error}. The plan is waiting for operator assistance.`);
      }
      if (['cancelled', 'failure', 'discarded'].includes(event.type)) {
        setRunning(false);
        setResult(null);
        setSummary(null);
        setError(String(data.message ?? 'Inputs have changed'));
      }
      const label = event.type === 'signal' ? labels[String(data.channel)] : labels[event.type];
      if (label) setEvents(old => [{ id: event.id, at: event.at, label }, ...old].slice(0, 6));
    };

    void fetch(`${apiBase}/api/health`, { signal: abort.signal })
      .then(response => response.ok ? response.json() : null)
      .then(health => {
        if (!health) return;
        setConfigured(health.llm_configured);
        // LAN mode: the hub wants a token. Take it from the address (start_demo.sh opens .../#token=…,
        // the fragment never reaches a server), else the one this browser used last time, else ask once.
        // A page reload or a hub restart therefore reconnects by itself.
        if (!health.token_required) return;
        const fromUrl = new URLSearchParams(window.location.hash.slice(1)).get('token') ?? '';
        if (fromUrl) window.history.replaceState(null, '', window.location.pathname + window.location.search);
        let saved = '';
        try { saved = window.localStorage.getItem(TOKEN_KEY) ?? ''; } catch { /* storage unavailable */ }
        const candidate = fromUrl || token || saved;
        const accepted = async (value: string) => Boolean(value) && (await fetch(`${apiBase}/api/state`, { headers: { Authorization: `Bearer ${value}` }, signal: abort.signal })).ok;
        void (async () => {
          let next = candidate;
          if (!(await accepted(next))) next = window.prompt('Signal hub access token (printed in the terminal as "Access token")')?.trim() ?? '';
          if (!next || next === token) return;
          try { window.localStorage.setItem(TOKEN_KEY, next); } catch { /* ignore */ }
          setDraftToken(next); setToken(next);
        })().catch(() => {});
      })
      .catch(() => {});
    void watchEvents(apiBase, token, abort.signal, onEvent, online => {
      setConnected(online);
      if (!online) setRunning(false);
    });
    return () => abort.abort();
  }, [apiBase, token]);

  useEffect(() => {
    if (modal && !dialog.current?.open) dialog.current?.showModal();
    if (!modal && dialog.current?.open) dialog.current?.close();
  }, [modal]);

  function reset() {
    setResult(null);
    setSummary(null);
    setError('');
  }

  function choose(id: string) {
    reset();
    setScenarioId(id);
    setInputSource('demo');
    setContext(sample(id));
  }

  function edit(change: (next: Context) => void) {
    reset();
    const next = structuredClone(context);
    change(next);
    setContext(next);
  }

  async function run() {
    reset();
    if (!connected) {
      if (mode !== 'rules' || inputSource === 'external') {
        setError('Connect the signal server to use DeepSeek, or choose Offline rules to try a preset.');
        return;
      }
      try {
        const next = offlinePlan({ ...context, request_id: `demo-${crypto.randomUUID()}` });
        setResult(next);
        setSummary({ request_id: next.request_id, decision_summary: next.decision_summary });
      } catch {
        setError('Invalid input. Please select a demo preset again.');
      }
      return;
    }
    setRunning(true);
    try {
      if (inputSource === 'demo') {
        await postSignal(apiBase, token, '/api/demo', {
          mode,
          context: { ...context, request_id: `demo-${crypto.randomUUID()}` },
        });
      } else {
        await postSignal(apiBase, token, '/api/settings', { mode });
        await postSignal(apiBase, token, '/api/run', {});
      }
    } catch (failure) {
      setRunning(false);
      setError(failure instanceof Error ? failure.message : 'Could not connect to the server');
    }
  }

  /** Books assistance for one need, as the App would; the replay bridge then plays that clip and its signals. */
  async function replayFlow(need: string) {
    const wheelchair = need === 'WHEELCHAIR';
    setError('');
    try {
      await postSignal(apiBase, token, '/api/settings', { mode });
      await postSignal(apiBase, token, '/api/booking', { event_id: `replay-${crypto.randomUUID()}`, observed_at: new Date().toISOString(), payload: {
        active: true, intent: 'BOARDING', route_id: 'DEMO_ROUTE', stop_id: 'DEMO_STOP', accessibility_need: need,
        ramp_preference: wheelchair ? 'REQUESTED' : 'UNSPECIFIED', assistance_requested: wheelchair ? ['WHEELCHAIR_RAMP', 'ADDITIONAL_BOARDING_TIME'] : ['ADDITIONAL_BOARDING_TIME'],
        preferred_interaction: 'BOTH', language: 'en-SG' } });
    } catch (failure) {
      // 409: the hub keeps one booking per need category until that passenger has boarded.
      setError(failure instanceof Error ? failure.message === 'NEED_ALREADY_BOOKED' ? NEED_ALREADY_BOOKED : failure.message : 'Could not connect to the server');
    }
  }

  /**
   * Operator reset between passengers: the App's cancellation naming the journey shown, plus operator_reset:true.
   * Only with this flag does the hub end a boarded journey (reason `completed`, clean idle screen, fresh bus); the
   * phone's Finish leaves it on this screen. Before boarding it cancels that booking.
   */
  async function resetJourney() {
    if (!journey?.journey_id || resetting) return;
    setResetting(true);
    setError('');
    try {
      await postSignal(apiBase, token, '/api/booking', { event_id: `reset-${crypto.randomUUID()}`, observed_at: new Date().toISOString(), payload: {
        active: false, intent: 'BOARDING', route_id: request.route_id ?? 'DEMO_ROUTE', stop_id: request.stop_id ?? 'DEMO_STOP',
        accessibility_need: journey.need ?? 'UNKNOWN', cancels: journey.journey_id, operator_reset: true } });
    } catch (failure) {
      setError(failure instanceof Error ? `Reset not accepted: ${failure.message}` : 'Could not connect to the server');
    } finally {
      setResetting(false);
    }
  }

  async function changeMode(next: Mode) {
    setMode(next);
    reset();
    if (connected) {
      try {
        await postSignal(apiBase, token, '/api/settings', { mode: next });
      } catch {
        setError('Could not update the generation mode.');
      }
    }
  }

  const disabled = running || inputSource === 'external';
  const request = context.request ?? {};
  const vehicle = context.vehicle_context ?? {};
  const detection = context.perception?.yolo_detections?.[0];
  const actions = result?.action_plan.map(action => action.action) ?? [];
  const rampPreview = actions.includes('DEPLOY_AUTOMATIC_SHORT_RAMP')
    ? 'Deploy ramp'
    : actions.includes('REQUEST_MANUAL_RAMP_DEPLOYMENT')
      ? 'Manual help'
      : actions.includes('KEEP_RAMPS_STOWED')
        ? 'Keep stowed'
        : 'Awaiting plan';
  // The booking channel keeps its last payload after a journey ends (Finish / Reset); the journey decides.
  const bookingActive = Boolean(request.active) && !(inputSource === 'external' && journey?.stage === 'IDLE');
  const detectionActive = Boolean(detection?.label && detection.label !== 'NONE' && (detection.confidence ?? 0) >= 0.75);
  const modeLabel = mode === 'single' ? 'DeepSeek · Single' : mode === 'two_turn' ? 'DeepSeek · Two turns' : 'Offline rules';
  // Waiting-list hubs list every booking; the rest of the page follows the journey in progress (`journey`).
  const journeys = inputSource === 'external' ? snapshot?.journeys ?? [] : [];
  const waitingList = journeys.filter(entry => entry.stage !== 'IDLE' && !entry.completed).length > 1 || journeys.some(isWaitingEntry)
    ? journeys.map(entry => waitingChip(entry, journey?.journey_id)) : [];
  // The replay bridge plays one clip per booking and cannot interleave: disabled only while a booking waits or is at
  // the stop (BOOKED / AT_STOP). The hub frees the slot at ON_BOARD, so the next passenger can start at once.
  const replayBusy = inputSource === 'external' && (journey?.stage === 'BOOKED' || journey?.stage === 'AT_STOP'
    || journeys.some(entry => entry.stage === 'BOOKED' || entry.stage === 'AT_STOP'));
  const navigationTitle = navigation ?({ TO_STOP: 'Go to the boarding point', WAIT_AT_STOP: 'Wait at the boarding point', BOARD_BUS: 'Your bus is ready', TO_SEAT: navigation.equipment_target ? 'Park the stroller, then your seat' : 'Your assigned seat', TO_WHEELCHAIR_BAY: 'Your wheelchair space' })[navigation.phase] : running ? 'Preparing passenger guidance' : journey?.guidance.title ?? 'Waiting for an app booking';

  const communication = [
    { label: 'Signal hub', value: connected ? 'Connected' : 'Offline', tone: connected ? 'online' : 'offline' },
    { label: 'Camera bridge', value: visionStatus.online ? `${Math.round(visionStatus.fps)} fps` : 'Offline', tone: visionStatus.triggered ? 'active' : visionStatus.online ? 'online' : 'offline' },
    { label: 'App booking', value: bookingActive ? String(request.accessibility_need ?? 'Received').replaceAll('_', ' ') : 'Waiting', tone: bookingActive ? 'online' : 'waiting' },
    { label: 'YOLO channel', value: detectionActive ? `${detection?.label} ${Math.round((detection?.confidence ?? 0) * 100)}%` : 'Waiting', tone: detectionActive ? 'active' : 'waiting' },
    { label: 'Journey', value: journey && inputSource === 'external' ? ({ IDLE: 'Waiting', BOOKED: 'Booked · on the way', AT_STOP: journey.matched ? 'At the stop' : 'At the stop · unmatched', ON_BOARD: 'On board' })[journey.stage] : 'Demo preset', tone: journey?.stage === 'AT_STOP' ? 'active' : journey && journey.stage !== 'IDLE' ? 'online' : 'waiting' },
    { label: 'Digital twin', value: twinReady ? 'Ready' : 'Loading', tone: twinReady ? 'online' : 'waiting' },
    { label: 'Decision', value: running ? 'Generating' : result?.plan_status ?? 'Standby', tone: running ? 'active' : result?.plan_status === 'READY' ? 'online' : result?.plan_status === 'CANNOT_EXECUTE' ? 'offline' : 'waiting' },
  ];

  return <main className="demoShell">
    <header className="topbar topbarCompact">
      <div className="brandLockup teamBrand" aria-label="Team NUSNextBus">
        <div className="brandMark" aria-hidden="true">NB</div>
        <div><p className="eyebrow">Team</p><h1>NUSNextBus</h1></div>
      </div>
      <div className="topbarActions">
        <div className="topbarStatus">
          <span className={`connectionDot ${connected ? 'online' : ''}`} />
          <span>{connected ? 'Signal server connected' : 'Signal server disconnected'}</span>
          <span className="statusDivider" />
          <span>{modeLabel}</span>
        </div>
        <button className="detailsToggle" aria-expanded={showDetails} aria-controls="dashboard-details" onClick={() => setShowDetails(open => !open)}>
          <span>{showDetails ? 'Hide' : 'Show'} controls & details</span><span aria-hidden="true">{showDetails ? '−' : '+'}</span>
        </button>
      </div>
    </header>

    <section className="intelligenceRow" aria-label="Reasoning and live communication">
      <section className="panel primaryThinking" aria-label="Live reasoning summary">
        <div className="thinkingHeader">
          <div><p className="sectionKicker">Signals → reasoning → validated plan</p><h2>Thinking</h2></div>
          <div className="thinkingHeaderActions">
            <span className={`planStatus planStatus--${result?.plan_status.toLowerCase() ?? 'waiting'}`}>{running ? 'THINKING' : result?.plan_status ?? 'STANDBY'}</span>
            <button className="primaryButton" disabled={running} onClick={() => void run()}>
              <span className={running ? 'buttonSpinner' : 'buttonPlay'} aria-hidden="true" />
              {running ? 'Generating…' : inputSource === 'external' ? 'Run current signals' : 'Send signals & run'}
            </button>
          </div>
        </div>
        {error && <div className="errorNotice" role="alert">{error}</div>}
        <div className="thinkingLayout">
          <article className={`thinkingStage ${summary ? 'isComplete' : ''}`}>
            <div className="thinkingStageLabel"><span>{running && !summary ? 'Reading' : summary ? 'Decision summary' : 'Ready'}</span><small>word-by-word live reveal</small></div>
            <WordReveal key={summary?.request_id ?? 'empty'} lines={summary?.decision_summary ?? []} running={running} />
          </article>
          <aside className="decisionSnapshot">
            <div><small>Input source</small><strong>{inputSource === 'demo' ? 'Demo preset' : 'App + camera'}</strong></div>
            <div><small>Generator</small><strong>{result ? sources[result.meta.source] ?? result.meta.source : modeLabel}</strong></div>
            <div><small>Validated actions</small><strong>{result?.action_plan.length ?? '—'}</strong></div>
            <div><small>Latency</small><strong>{result ? `${result.meta.latency_ms} ms` : '—'}</strong></div>
          </aside>
        </div>
      </section>

      <section className="communicationStrip" aria-label="Live communication status">
        <div className="communicationTitle"><span className="livePulse" />Live channels</div>
        <div className="communicationItems">
          {communication.map(item => <div className={`communicationItem communicationItem--${item.tone}`} key={item.label}>
            <span className="communicationState" />
            <span><small>{item.label}</small><strong>{item.value}</strong></span>
          </div>)}
        </div>
      </section>
    </section>

    {waitingList.length > 0 && <section className="waitingList" aria-label="Waiting list, oldest booking first. One passenger is served at a time.">
      <div className="communicationTitle"><span className="livePulse" />Waiting list</div>
      <ol className="waitingListItems">
        {waitingList.map((chip, index) => <li key={chip.id} className={`communicationItem communicationItem--${chip.tone} waitingChip ${chip.current ? 'isCurrent' : ''}`}
          aria-current={chip.current ? 'step' : undefined} aria-label={`${index + 1}. ${chip.need}: ${chip.state}${chip.place ? `, ${chip.place}` : ''}`}>
          <span className="communicationState" aria-hidden="true" />
          <span aria-hidden="true"><small>{chip.need}</small><strong>{chip.state}</strong>{chip.place && <em>{chip.place}</em>}</span>
        </li>)}
      </ol>
    </section>}

    {inputSource === 'external' && journey && <section className="passengerNavigation" aria-label="Passenger journey guidance" aria-live="polite">
      <div className="passengerNavigationMessage"><p className="sectionKicker">Passenger guidance · shared with app</p><h2>{navigationTitle}</h2><p>{navigation?.instruction ?? (running ? 'Your assistance plan is being prepared. Please wait.' : journey.guidance.display_text)}</p></div>
      <ol className="journeyProgress" aria-label="Booking, arrival and boarding progress">{[
        ['BOOKED', 'Request received'], ['AT_STOP', 'At the stop'], ['ON_BOARD', 'On board'],
      ].map(([stage, label], index) => <li key={stage} className={['BOOKED', 'AT_STOP', 'ON_BOARD'].indexOf(journey.stage) >= index ? 'isReached' : ''} aria-current={journey.stage === stage ? 'step' : undefined}><span>{index + 1}</span>{label}</li>)}</ol>
      <JourneyCountdown journey={journey} />
      {navigation && <strong className="navigationDestination">{navigation.destination.type === 'SEAT' ? `Seat ${navigation.destination.id}` : navigation.destination.type === 'WHEELCHAIR_BAY' ? 'Wheelchair bay' : `Stop ${navigation.destination.id.replaceAll('_', ' ')}`}</strong>}
      {connected && journey.journey_id && journey.stage !== 'IDLE' && <button className="secondaryButton journeyReset" disabled={resetting} onClick={() => void resetJourney()}
        aria-label={journey.stage === 'ON_BOARD' ? 'Reset: finish this journey and get the bus ready for the next passenger' : 'Reset: cancel this booking and clear the screen'}>
        {resetting ? 'Resetting…' : 'Reset'}</button>}
    </section>}

    <section className="stageRow" aria-label="Camera and vehicle">
      <VideoPanel onStatusChange={setVisionStatus} onReplay={connected ? replayFlow : undefined} replayBusy={replayBusy} />
      <TwinPanel
        result={result}
        context={context}
        running={running}
        journey={inputSource === 'external' ? journey : null}
        basePath={basePath}
        onStatusChange={setTwinReady}
      />
    </section>

    <div id="dashboard-details" className="detailsContent" hidden={!showDetails}>
      <section className="connectionBar" aria-label="Connection and generation mode">
        <label>Generation mode
          <select value={mode} disabled={running} onChange={event => void changeMode(event.target.value as Mode)}>
            <option value="single">DeepSeek · Single call</option>
            <option value="two_turn">DeepSeek · Two turns</option>
            <option value="rules">Offline rules · No API calls</option>
          </select>
        </label>
        <div className="connectionDescription">
          {mode === 'two_turn' ? 'Turn 1 explains the decision. Turn 2 returns the actions.' : mode === 'single' ? 'One call returns a decision summary and actions.' : 'Run the same decision rules without using API credits.'}
          <small>{connected ? configured ? 'DeepSeek is configured on the server' : 'No DeepSeek key configured. Rules mode is available.' : 'Connect a signal server or use Offline rules.'}</small>
        </div>
        <details className="connectionSettings"><summary>Connection settings</summary><div className="settingsFields">
          <label>Server URL<input placeholder="Same-origin /api, or https://your-server" value={draftBase} onChange={event => setDraftBase(event.target.value)} /></label>
          <label>Access token (optional)<input type="password" autoComplete="off" value={draftToken} onChange={event => setDraftToken(event.target.value)} placeholder="Signal server token, not your DeepSeek key" /></label>
          <button className="secondaryButton" onClick={() => {
            const value = draftBase.trim().replace(/\/$/, '');
            if (value && !/^https?:\/\//.test(value)) {
              setError('Server URL must start with http:// or https://.');
              return;
            }
            setApiBase(value);
            setToken(draftToken.trim());
            setError('');
          }}>Connect</button>
        </div></details>
      </section>

      <section className="scenarioBar" aria-label="Demo scenarios">
        <div className="vehicleThumb">
          {/* eslint-disable-next-line @next/next/no-img-element -- local reference photo with a fixed crop */}
          <img src={`${basePath}/bus-exterior.jpg`} alt="Green autonomous bus reference" />
          <div className="vehicleThumbOverlay"><span>Web simulation</span><strong>Accessible boarding demo</strong></div>
        </div>
        <div className="scenarioPicker">
          <div className="scenarioPickerHead"><div><p className="sectionKicker">Signal presets</p><h2>Choose a demo scenario</h2></div><button className="textButton" onClick={() => setModal('library')}>Allowed actions →</button></div>
          <div className="scenarioTabs">{choices.map(([id, label, subtitle, accent], index) => <button key={id} disabled={running} className={`scenarioTab scenarioTab--${accent} ${scenarioId === id && inputSource === 'demo' ? 'isActive' : ''}`} onClick={() => choose(id)} aria-pressed={scenarioId === id && inputSource === 'demo'}>
            <span className="scenarioNumber">{String(index + 1).padStart(2, '0')}</span><span><strong>{label}</strong><small>{subtitle}</small></span>
          </button>)}</div>
        </div>
      </section>

      <section className="detailWorkspace" aria-label="Controls and diagnostics">
        <aside className="panel inputPanel">
          <div className="panelHeader"><div><p className="sectionKicker">Inputs</p><h2>Signal controls</h2></div><span className="simBadge">{inputSource === 'demo' ? 'Demo data' : 'External signals'}</span></div>
          <div className="inputSourceSwitch"><button className={inputSource === 'demo' ? 'active' : ''} disabled={running} onClick={() => choose(scenarioId)}>Demo inputs</button><button className={inputSource === 'external' ? 'active' : ''} disabled={running || !connected} onClick={() => { reset(); setInputSource('external'); if (snapshot) setContext(snapshot.context); }}>Listen to Python / App</button></div>
          <div className="inputSection"><h3>Mobile app booking</h3><div className="liveForm">
            <label>Assistance needed<select disabled={disabled} value={request.accessibility_need ?? 'UNKNOWN'} onChange={event => edit(next => { next.request = { ...next.request, accessibility_need: event.target.value }; })}>{[
              ['WHEELCHAIR', 'Wheelchair'], ['CRUTCH', 'Crutches'], ['STROLLER', 'Stroller'], ['VISUAL_ASSISTANCE', 'Vision support'], ['HEARING_ASSISTANCE', 'Hearing support'], ['UNKNOWN', 'Awaiting booking'],
            ].map(([value, title]) => <option key={value} value={value}>{title}</option>)}</select></label>
            <label className="checkLabel"><input type="checkbox" disabled={disabled} checked={request.ramp_preference === 'REQUESTED'} onChange={event => edit(next => { next.request = { ...next.request, ramp_preference: event.target.checked ? 'REQUESTED' : 'UNSPECIFIED', assistance_requested: event.target.checked ? ['WHEELCHAIR_RAMP', 'ADDITIONAL_BOARDING_TIME'] : ['ADDITIONAL_BOARDING_TIME'] }; })} />Ramp requested for this booking</label>
            <small>Route {request.route_id ?? 'Not received'} · Stop {request.stop_id ?? 'Not received'}</small>
          </div></div>
          <div className="inputSection"><h3>YOLO detections</h3><div className="liveForm">
            <label>Detected object<select disabled={disabled} value={detection?.label ?? 'NONE'} onChange={event => edit(next => { next.perception = { ...next.perception, yolo_detections: event.target.value === 'NONE' ? [] : [{ label: event.target.value, confidence: 0.94 }] }; })}>{['NONE', 'WHEELCHAIR', 'CRUTCH', 'CANE', 'WALKER', 'STROLLER', 'UNKNOWN'].map(value => <option key={value}>{value}</option>)}</select></label>
            <label>Confidence<input type="number" min="0" max="1" step="0.01" disabled={disabled || !detection} value={detection?.confidence ?? 0} onChange={event => edit(next => { if (next.perception?.yolo_detections?.[0]) next.perception.yolo_detections[0].confidence = Number(event.target.value); })} /></label>
            <small>Only structured detections leave the vision device.</small>
          </div></div>
          <details className="inputSection"><summary>Simulation settings</summary><div className="liveForm">{[
            ['entrance_clear', 'Entrance clear'], ['safety_operator_approval', 'Operator approval'], ['emergency_stop_active', 'Emergency stop'],
          ].map(([key, label]) => <label className="checkLabel" key={key}><input type="checkbox" disabled={disabled} checked={vehicle[key] === true} onChange={event => edit(next => { next.vehicle_context = { ...next.vehicle_context, [key]: event.target.checked }; })} />{label}</label>)}<small>Vehicle {vehicle.motion_state ?? 'STOPPED'} · Door {vehicle.single_entrance_state ?? 'OPEN'} · Ramp {vehicle.ramp_state ?? 'STOWED'}</small></div></details>
          <details className="inputSection"><summary>View input JSON</summary><pre className="inputJson">{JSON.stringify(context, null, 2)}</pre></details>
        </aside>

        <section className="panel diagnosticsPanel">
          <div className="panelHeader"><div><p className="sectionKicker">Diagnostics</p><h2>Generation & signals</h2></div><span className="simBadge">{modeLabel}</span></div>
          <div className="diagnosticMetrics">
            <div><small>Plan status</small><strong>{result?.plan_status ?? 'Waiting'}</strong></div>
            <div><small>API calls</small><strong>{result?.meta.api_calls ?? '—'}</strong></div>
            <div><small>Tokens</small><strong>{result?.meta.usage.total_tokens ?? '—'}</strong></div>
            <div><small>Validation</small><strong>{result ? result.meta.validation_passed ? 'Passed' : 'Fallback' : '—'}</strong></div>
          </div>
          <div className="signalHistory"><h3>Signal timeline</h3>{events.length ? <ol>{events.map((event, index) => <li key={`${event.id}-${index}`}><time>{new Date(event.at).toLocaleTimeString('en-SG', { hour12: false })}</time><span>{event.label}</span></li>)}</ol> : <p>Bookings, detections and generation stages appear here.</p>}</div>
          <div className="promptNotice"><span className="wrenchIcon">◆</span><div><strong>App + YOLO → Decisions & actions</strong><p>Two live signal sources · vehicle conditions are simulated</p></div><span className="promptVersion">DEMO</span></div>
        </section>

        <aside className="panel outputPanel">
          <div className="panelHeader"><div><p className="sectionKicker">Full output</p><h2>Validated action plan</h2></div><span className={`planStatus planStatus--${result?.plan_status.toLowerCase() ?? 'waiting'}`}>{result?.plan_status ?? 'WAITING'}</span></div>
          <div className="simulationPreview"><div><small>Ramp simulation</small><strong>{rampPreview}</strong></div><div><small>Assigned place</small><strong>{result?.boarding_target?.type === 'SEAT' ? result.boarding_target.id : result?.boarding_target?.type === 'WHEELCHAIR_BAY' ? 'Wheelchair bay' : 'Awaiting plan'}</strong></div><p>{actions.includes('EXTEND_DWELL_TIME') ? '+60 seconds boarding time' : 'Standard boarding time'} · Web simulation · {inputSource === 'external' ? 'Latest external snapshot' : 'Demo preset'}</p></div>
          <div className="outputBlock actionOutput"><div className="outputBlockHead"><h3>All actions</h3><span>Simulated only</span></div>{result ? <ol className="actionList">{result.action_plan.map(action => <li className={`actionItem actionItem--${action.action.includes('OPERATOR') ? 'operator' : 'ready'}`} key={action.step}><span className="actionIndex">{String(action.step).padStart(2, '0')}</span><div><strong className="actionTitle">{ACTION_LABELS[action.action] ?? action.action}</strong><div className="actionName"><code>{action.action}</code></div>{Object.keys(action.parameters).length > 0 && <p className="actionParameters">{JSON.stringify(action.parameters)}</p>}</div></li>)}</ol> : <div className="emptyOutput"><span>→</span><p>Validated actions will appear after a run.</p></div>}</div>
          <div className="outputActions"><button className="secondaryButton" disabled={!result} onClick={() => setModal('json')}>View full JSON</button><span>Display only · no vehicle commands</span></div>
        </aside>
      </section>

      <section className="safetyStrip" aria-label="Validation status">
        <div className="safetyTitle"><span className="shieldMark">✓</span><div><p className="sectionKicker">Safety boundary</p><h2>Validated simulation</h2></div></div>
        <div className="safetyChecks">{[
          [result ? result.meta.validation_passed ? 'Actions validated' : 'Fallback active' : 'Awaiting validation', 'Action types, allowed set and order'],
          ['Two input sources', 'App booking + Python YOLO'],
          ['Web simulation', 'Vehicle and ramp states are preset'],
          ['Results stay visible', 'New inputs update the plan'],
        ].map(([title, detail]) => <div className="safetyCheck" key={title}><div><strong>{title}</strong><span>{detail}</span></div></div>)}</div>
      </section>
      <footer className="footer"><span>NUSNextBus · Camera YOLO + App → DeepSeek → Dashboard + Digital twin</span><span>{result ? sources[result.meta.source] : 'Signal-driven demo'} · {inputSource === 'demo' ? 'Synthetic inputs' : 'External inputs'}</span></footer>
    </div>

    <dialog className="modal liveDialog" ref={dialog} onClose={() => setModal(null)}>
      <div className="modalHeader"><div><p className="sectionKicker">{modal === 'json' ? 'Received response' : 'Allowed meta-actions'}</p><h2>{modal === 'json' ? 'Response JSON' : 'Allowed actions'}</h2></div><button className="closeButton" aria-label="Close dialog" onClick={() => setModal(null)}>×</button></div>
      {modal === 'json' ? <pre className="jsonCode">{JSON.stringify(result, null, 2)}</pre> : <ul className="allowlist">{ACTIONS.map((action: string) => <li key={action}><code>{action}</code></li>)}</ul>}
    </dialog>
  </main>;
}
