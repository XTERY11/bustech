import { CabinControls } from './CabinControls';
import { useEffect, useRef, useState } from 'react';
import type { AnimationValues, VehicleState } from '../../types/vehicle';
import type { BusEvent, MockBusSimulator, ScenarioStep } from '../../simulation/mockBus';
import './demoControls.css';

/**
 * Prototype-only control panel. It talks to the *mock bus* (commands), never
 * to the 3D component — the twin only ever sees the resulting VehicleState.
 */

export type ViewerSize = 'fill' | '1200x700' | '800x500' | '600x400';

interface Props {
  bus: MockBusSimulator;
  state: VehicleState;
  anim: AnimationValues;
  events: BusEvent[];
  scenario: ScenarioStep[];
  scenarioProgress: { running: boolean; step: number };
  viewerSize: ViewerSize;
  onViewerSize: (s: ViewerSize) => void;
  theme: 'light' | 'dark';
  onTheme: (t: 'light' | 'dark') => void;
  speak: boolean;
  onSpeak: (v: boolean) => void;
}

const DEST_PRESETS = ['400 Punggol Coast', '43 Upper East Coast', '9 Tampines Hub', 'Not in service'];

export function DemoControls(p: Props) {
  const { bus, state } = p;
  const [annText, setAnnText] = useState('Wheelchair boarding in progress.');
  const [dest, setDest] = useState(state.destination ?? '');
  const [interlocks, setInterlocks] = useState(bus.interlocks);
  const [tab, setTab] = useState<'state' | 'anim' | 'log'>('state');

  useEffect(() => setDest(state.destination ?? ''), [state.destination]);

  const doorBusy = state.door === 'opening' || state.door === 'closing';
  const rampBusy = state.ramp === 'extending' || state.ramp === 'retracting';
  const running = p.scenarioProgress.running;

  return (
    <aside className="dc">
      <CabinControls bus={bus} state={state} />
      {/* Scenario */}
      <section className="dc-card dc-hero">
        <div className="dc-row between">
          <div>
            <h3>Boarding demo</h3>
            <p className="dc-sub">Simulated telemetry · 16 s</p>
          </div>
          {running ? (
            <button className="dc-btn" onClick={() => bus.stopScenario()}>Stop</button>
          ) : (
            <button className="dc-btn primary" onClick={() => bus.runScenario(p.scenario)}>
              <PlayIcon /> Run Boarding Demo
            </button>
          )}
        </div>
        <ol className={`dc-timeline ${running ? 'running' : ''}`}>
          {p.scenario.map((s, i) => (
            <li key={i} className={i < p.scenarioProgress.step ? 'done' : i === p.scenarioProgress.step && running ? 'now' : ''}>
              <span className="t">{s.at}s</span>
              <span className="l">{s.label}</span>
            </li>
          ))}
        </ol>
      </section>

      {/* Manual commands */}
      <section className="dc-card">
        <h4>Vehicle commands</h4>
        <div className="dc-grid">
          <Label text="Door" value={state.door} busy={doorBusy} />
          <div className="dc-seg">
            <button disabled={running} className={state.door === 'open' || state.door === 'opening' ? 'on' : ''} onClick={() => bus.openDoor()}>Open</button>
            <button disabled={running} className={state.door === 'closed' || state.door === 'closing' ? 'on' : ''} onClick={() => bus.closeDoor()}>Close</button>
          </div>

          <Label text="Ramp" value={state.ramp} busy={rampBusy} />
          <div className="dc-seg">
            <button disabled={running} className={state.ramp === 'extended' || state.ramp === 'extending' ? 'on' : ''} onClick={() => bus.extendRamp()}>Extend</button>
            <button disabled={running} className={state.ramp === 'retracted' || state.ramp === 'retracting' ? 'on' : ''} onClick={() => bus.retractRamp()}>Retract</button>
          </div>

          <Label text="Kneeling" value={state.kneeling ? 'lowered' : 'normal'} />
          <Switch disabled={running} checked={state.kneeling} onChange={(v) => bus.setKneeling(v)} label="Toggle kneeling" />
        </div>
      </section>

      <section className="dc-card">
        <div className="dc-row between">
          <h4>Boarding assistance</h4>
          <span className={`dc-pill s-${state.boardingStatus}`}>{state.boardingStatus.replace('_', ' ')}</span>
        </div>
        <div className="dc-btns3">
          <button className="dc-btn" disabled={running} onClick={() => bus.requestBoarding()}>Boarding request</button>
          <button className="dc-btn" disabled={running} onClick={() => bus.readyForBoarding()}>Ready for boarding</button>
          <button className="dc-btn" disabled={running} onClick={() => bus.boardingComplete()}>Boarding complete</button>
        </div>
        <div className="dc-row between dc-mt">
          <label className="dc-check">
            <Switch
              checked={interlocks}
              onChange={(v) => {
                bus.interlocks = v;
                setInterlocks(v);
              }}
              label="Safety interlocks"
            />
            <span>
              Safety interlocks
              <small>Ramp waits for door · door waits for ramp</small>
            </span>
          </label>
          <button className="dc-link" onClick={() => bus.reset()}>Reset</button>
        </div>
      </section>

      <section className="dc-card">
        <h4>Announcement</h4>
        <div className="dc-row">
          <input className="dc-input" value={annText} onChange={(e) => setAnnText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && bus.playAnnouncement(annText)} aria-label="Announcement text" />
          {state.announcement?.active ? (
            <button className="dc-btn" onClick={() => bus.stopAnnouncement()}>Stop</button>
          ) : (
            <button className="dc-btn" onClick={() => bus.playAnnouncement(annText)}>Play</button>
          )}
        </div>
        <label className="dc-check dc-mt">
          <Switch checked={p.speak} onChange={p.onSpeak} label="Speak aloud" />
          <span>Speak aloud <small>Browser text-to-speech</small></span>
        </label>

        <h4 className="dc-mt2">Destination</h4>
        <form
          className="dc-row"
          onSubmit={(e) => {
            e.preventDefault();
            bus.setDestination(dest);
          }}
        >
          <input className="dc-input" value={dest} onChange={(e) => setDest(e.target.value)} aria-label="Destination" />
          <button className="dc-btn" type="submit">Apply</button>
        </form>
        <div className="dc-chips">
          {DEST_PRESETS.map((d) => (
            <button key={d} className={state.destination === d ? 'on' : ''} onClick={() => bus.setDestination(d)}>{d}</button>
          ))}
        </div>
      </section>

      <section className="dc-card">
        <h4>Viewer</h4>
        <div className="dc-grid">
          <span className="dc-label">Embed size</span>
          <div className="dc-seg small">
            {(['fill', '1200x700', '800x500', '600x400'] as const).map((s) => (
              <button key={s} className={p.viewerSize === s ? 'on' : ''} onClick={() => p.onViewerSize(s)}>{s === 'fill' ? 'Fill' : s.replace('x', '×')}</button>
            ))}
          </div>
          <span className="dc-label">Theme</span>
          <div className="dc-seg small">
            <button className={p.theme === 'light' ? 'on' : ''} onClick={() => p.onTheme('light')}>Light</button>
            <button className={p.theme === 'dark' ? 'on' : ''} onClick={() => p.onTheme('dark')}>Dark</button>
          </div>
        </div>
      </section>

      <section className="dc-card dc-debug">
        <div className="dc-tabs">
          {(['state', 'anim', 'log'] as const).map((t) => (
            <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
              {t === 'state' ? 'VehicleState' : t === 'anim' ? 'Animation' : `Events (${p.events.length})`}
            </button>
          ))}
        </div>
        {tab === 'state' && <pre className="dc-json">{JSON.stringify(stripUndefined(state), null, 2)}</pre>}
        {tab === 'anim' && <AnimBars anim={p.anim} />}
        {tab === 'log' && <EventLog events={p.events} />}
      </section>
    </aside>
  );
}

function Label({ text, value, busy }: { text: string; value: string; busy?: boolean }) {
  return (
    <span className="dc-label">
      {text}
      <em className={busy ? 'busy' : ''}>{value}</em>
    </span>
  );
}

function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`dc-switch ${checked ? 'on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}

function AnimBars({ anim }: { anim: AnimationValues }) {
  return (
    <div className="dc-bars">
      {(Object.keys(anim) as (keyof AnimationValues)[]).map((k) => (
        <div key={k} className="dc-bar">
          <code>{k}</code>
          <span className="track">
            <span className="fill" style={{ width: `${anim[k] * 100}%` }} />
          </span>
          <code className="num">{anim[k].toFixed(2)}</code>
        </div>
      ))}
      <p className="dc-sub">Interpolated 0 → 1 parameters driving the 3D transforms.</p>
    </div>
  );
}

function EventLog({ events }: { events: BusEvent[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [events.length]);
  if (!events.length) return <p className="dc-sub">No events yet.</p>;
  return (
    <div className="dc-log" ref={ref}>
      {events.map((e, i) => (
        <div key={i} className={`k-${e.kind}`}>
          <time>{new Date(e.time).toLocaleTimeString([], { hour12: false })}</time>
          <span>{e.text}</span>
        </div>
      ))}
    </div>
  );
}

const PlayIcon = () => (
  <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden>
    <path d="M3 1.8v8.4L10 6z" fill="currentColor" />
  </svg>
);

function stripUndefined<T>(o: T): T {
  return JSON.parse(JSON.stringify(o));
}
