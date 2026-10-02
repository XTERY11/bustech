import { getCabinSnapshot } from './data/cabinLayout';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { BusDigitalTwin } from './components/BusDigitalTwin';
import { DemoControls, type ViewerSize } from './components/DemoControls/DemoControls';
import { createVehicleStore, useVehicleState } from './state/vehicleState';
import { connectTelemetry, normalizeTelemetry, type TelemetryMessage } from './adapters/telemetryAdapter';
import { MockBusSimulator, type BusEvent } from './simulation/mockBus';
import { BOARDING_SCENARIO } from './simulation/boardingScenario';
import type { AnimationValues, TwinAction, VehicleStatePatch } from './types/vehicle';

/**
 * Demo shell.
 *
 *   MockBusSimulator ──telemetry──► normalizeTelemetry ──► VehicleStore ──► <BusDigitalTwin state />
 *          ▲
 *   DemoControls (commands)
 *
 * The twin is unaware of the panel; replacing the mock bus with a
 * WebSocketTelemetrySource is a one-line change in this file.
 */
export function App() {
  const store = useMemo(() => createVehicleStore(), []);
  const bus = useMemo(() => new MockBusSimulator('bus-01', '400 Punggol Coast'), []);
  const state = useVehicleState(store);

  const [anim, setAnim] = useState<AnimationValues>({ doorOpenAmount: 0, rampDeployAmount: 0, kneelAmount: 0 });
  const [events, setEvents] = useState<BusEvent[]>([]);
  const [scenario, setScenario] = useState({ running: false, step: -1 });
  const [viewerSize, setViewerSize] = useState<ViewerSize>('fill');
  const [theme, setTheme] = useState<'light' | 'dark'>(initialTheme);
  const [speak, setSpeak] = useState(false);

  // Data path: mock vehicle → adapter → store.
  useEffect(() => {
    const disconnect = connectTelemetry(store, bus, 'bus-01');
    const offEv = bus.onEvent((e) => setEvents((l) => [...l.slice(-80), e]));
    const offSc = bus.onScenario((s) => setScenario({ running: s.running, step: s.step }));
    // Console API for experimenting (not used by the component itself).
    Object.assign(window, {
      twin: {
        store,
        bus,
        getCabinSnapshot: () => getCabinSnapshot(store.getState()),
        setVehicleState: (p: VehicleStatePatch) => store.setVehicleState(p),
        telemetry: (m: TelemetryMessage) => store.setVehicleState(normalizeTelemetry(m)),
      },
    });
    return () => {
      disconnect();
      offEv();
      offSc();
    };
  }, [store, bus]);

  // Optional text-to-speech for announcements (demo layer only).
  useEffect(() => {
    if (!speak || !state.announcement?.active || !('speechSynthesis' in window)) return;
    const u = new SpeechSynthesisUtterance(state.announcement.text);
    u.lang = 'en-SG';
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  }, [speak, state.announcement?.active, state.announcement?.text]);

  const onAction = useCallback(
    (a: TwinAction) => {
      if (a.type === 'componentClicked') {
        setEvents((l) => [...l.slice(-80), { time: Date.now(), kind: 'telemetry', text: `Viewer: ${a.component} clicked` }]);
      }
    },
    [],
  );

  const frameStyle =
    viewerSize === 'fill'
      ? undefined
      : { width: `${viewerSize.split('x')[0]}px`, height: `${viewerSize.split('x')[1]}px`, flex: 'none' as const };

  return (
    <div className="app" data-theme={theme}>
      <header className="app-head">
        <div className="brand">
          <span className="brand-dot" />
          <div>
            <h1>Bus Digital Twin</h1>
            <p>BYD B70A02 · cabin & accessible boarding simulation</p>
          </div>
        </div>
        <div className="head-meta">
          <span className={`conn ${scenario.running ? 'live' : ''}`}>
            <i /> {scenario.running ? 'Streaming demo telemetry' : 'Mock vehicle connected'}
          </span>
          <span className="vid">{state.vehicleId}</span>
        </div>
      </header>

      <main className="app-main">
        <div className={`viewer-area ${viewerSize !== 'fill' ? 'sized' : ''}`}>
          <div className="viewer-frame" style={frameStyle}>
            <BusDigitalTwin state={state} onAction={onAction} onAnimationUpdate={setAnim} theme={theme} />
          </div>
          {viewerSize !== 'fill' && <span className="size-tag">{viewerSize.replace('x', ' × ')}</span>}
        </div>
        <div className="panel-area">
          <DemoControls
            bus={bus}
            state={state}
            anim={anim}
            events={events}
            scenario={BOARDING_SCENARIO}
            scenarioProgress={scenario}
            viewerSize={viewerSize}
            onViewerSize={setViewerSize}
            theme={theme}
            onTheme={setTheme}
            speak={speak}
            onSpeak={setSpeak}
          />
        </div>
      </main>
    </div>
  );
}

/** Follow the host page: explicit data-theme wins, else the OS preference. */
function initialTheme(): 'light' | 'dark' {
  const explicit = document.documentElement.getAttribute('data-theme');
  if (explicit === 'dark' || explicit === 'light') return explicit;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
