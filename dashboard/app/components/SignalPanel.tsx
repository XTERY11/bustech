import type { Snapshot } from '../live-types';
import { appSignalFromSnapshot } from '../lib/appSignal';

export function SignalPanel({ snapshot, connected }: { snapshot: Snapshot | null; connected: boolean }) {
  const signal = appSignalFromSnapshot(snapshot);
  const details = [
    ['Ramp preference', signal.rampPreference], ['Route', signal.route], ['Stop', signal.stop],
    ['Interaction', signal.interaction],
  ].filter(([, value]) => value !== null);
  return <section className="panel signalPanel" aria-label="App booking signal">
    <div className="panelHeader signalPanelHeader">
      <div><p className="sectionKicker">App booking</p><h2>Signal</h2></div>
      <span className={`signalServerStatus ${connected ? 'isOnline' : 'isOffline'}`}>
        {connected ? 'Live' : 'Offline'}
      </span>
    </div>
    <p className="signalSource">{signal.source === 'app' ? 'App booking received'
      : signal.source === 'demo' ? 'Demo data · no app booking' : 'Awaiting app booking'}</p>
    {signal.received ? <>
      <div className="signalHero">
        <span className="signalAidLabel">Assistance category</span>
        <strong className="signalAid">{signal.aidLabel ?? 'Not supplied'}</strong>
        <span className={`signalBookingStatus signalBookingStatus--${signal.status}`}>{signal.statusLabel}</span>
      </div>
      {details.length > 0 && <dl className="signalDetails">{details.map(([label, value]) =>
        <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>}
      {signal.assistance.length > 0 && <div className="signalAssistance">
        <h3>Requested assistance</h3><ul>{signal.assistance.map(item => <li key={item}>{item}</li>)}</ul>
      </div>}
      {(signal.status === 'cancelled' || signal.status === 'expired') && <p className="signalGuidance" aria-live="polite">{signal.guidance}</p>}
      {signal.receivedAt !== null && <p className="signalReceipt">Received <time dateTime={new Date(signal.receivedAt).toISOString()}>{new Date(signal.receivedAt).toLocaleTimeString('en-SG', { hour12: false })}</time></p>}
      {!connected && <p className="signalConnectionNote">Showing the last received booking. The signal server is offline.</p>}
    </> : <div className="signalEmpty">
      <p>No app booking received.</p>
      <span>{connected ? 'The signal server is online. Submit an assistance request in the app.'
        : 'Connect to the signal server to receive app requests.'}</span>
    </div>}
  </section>;
}
