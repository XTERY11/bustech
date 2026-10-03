import type { Snapshot } from '../live-types';
import { appSignalFromSnapshot } from '../lib/appSignal';

function AidPictogram({ aid }: { aid: string | null }) {
  let drawing = <><rect x="14" y="6" width="20" height="36" rx="4" /><path d="M21 11h6M22 37h4" /></>;
  if (aid === 'WHEELCHAIR') drawing = <><circle cx="22" cy="9" r="4" /><path d="M20 17v12h12l6 10h5M20 21h12" /><path d="M16 23a12 12 0 1 0 15 17" /></>;
  else if (aid === 'STROLLER') drawing = <><path d="M7 9h6l8 23h15l5-16H18M18 16l9-9c7 0 12 4 14 9M17 25h21" /><circle cx="22" cy="38" r="4" /><circle cx="35" cy="38" r="4" /></>;
  else if (aid === 'CANE' || aid === 'VISUAL_ASSISTANCE') drawing = <><circle cx="19" cy="8" r="4" /><path d="M19 16v14l-6 12M19 30l7 12M19 19l10 5M29 24l5 18M15 18l-6 9" /></>;
  else if (aid === 'CRUTCH') drawing = <><circle cx="24" cy="8" r="4" /><path d="M24 16v14l-5 12M24 30l5 12M24 20l-10 5M24 20l10 5M9 18h8M13 18v24M31 18h8M35 18v24" /></>;
  else if (aid === 'WALKER' || aid === 'MOBILITY_ASSISTANCE') drawing = <><circle cx="18" cy="8" r="4" /><path d="M18 16v13l-5 13M18 29l8 13M18 19l13 5M27 22h14M28 22l-3 20M40 22l3 20M26 34h16" /></>;
  else if (aid === 'HEARING_ASSISTANCE') drawing = <><path d="M15 18a11 11 0 0 1 22 0c0 8-8 7-9 15-1 8-10 9-12 2M21 20a5 5 0 1 1 9 3l-5 5M7 15v13M2 18v7" /></>;
  return <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{drawing}</svg>;
}

const assistanceLabels: Record<string, string> = {
  'Wheelchair ramp': 'Ramp', 'Additional boarding time': 'Extra time',
  'Audio boarding guidance': 'Audio guidance', 'Visual boarding guidance': 'Visual guidance',
  'Confirm bus identity': 'Bus identity',
};

export function SignalPanel({ snapshot, connected }: { snapshot: Snapshot | null; connected: boolean }) {
  const signal = appSignalFromSnapshot(snapshot);
  const details = [
    ['Route', signal.route], ['Stop', signal.stop], ['Interaction', signal.interaction],
  ].filter(([, value]) => value !== null);
  const rampLabel = signal.rampPreference === 'Requested' ? 'Ramp requested'
    : signal.rampPreference === 'Declined' ? 'No ramp'
    : signal.rampPreference === 'Unspecified' ? 'Ramp not specified'
    : signal.rampPreference ? `Ramp · ${signal.rampPreference}` : null;
  return <section className="panel signalPanel signalPanel--compact" aria-label="App booking signal">
    <div className="panelHeader signalPanelHeader">
      <div><p className="sectionKicker">App-based</p><h2>Signal</h2></div>
      <span className={`signalServerStatus ${connected ? 'isOnline' : 'isOffline'}`} aria-label={`Signal server ${connected ? 'online' : 'offline'}`}>
        Server {connected ? 'online' : 'offline'}
      </span>
    </div>
    <p className="signalSource">{signal.source === 'app' ? 'App booking'
      : signal.source === 'demo' ? 'Demo · no app booking' : 'Awaiting app booking'}</p>
    {signal.received ? <>
      <div className="signalHero">
        <div className="signalIdentity">
          <span className="signalCategoryIcon"><AidPictogram aid={signal.aid} /></span>
          <div className="signalNeed"><span className="signalAidLabel">Need</span><strong className="signalAid">{signal.aidLabel ?? 'Not supplied'}</strong></div>
        </div>
        <div className="signalBadges">
          <span className={`signalBookingStatus signalBookingStatus--${signal.status}`}>{signal.statusLabel}</span>
          {rampLabel && <span className="signalRampBadge">{rampLabel}</span>}
        </div>
      </div>
      {signal.assistance.length > 0 && <ul className="signalChips" aria-label="Requested assistance">
        {signal.assistance.map(item => <li key={item}>{assistanceLabels[item] ?? item}</li>)}
      </ul>}
      {(signal.status === 'cancelled' || signal.status === 'expired') && <p className="signalGuidance" aria-live="polite">{signal.guidance}</p>}
      {(details.length > 0 || signal.receivedAt !== null) && <details className="signalBookingDetails">
        <summary>Booking details</summary>
        <dl className="signalDetails">{details.map(([label, value]) =>
          <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
          {signal.receivedAt !== null && <div><dt>Received</dt><dd><time dateTime={new Date(signal.receivedAt).toISOString()}>{new Date(signal.receivedAt).toLocaleTimeString('en-SG', { hour12: false })}</time></dd></div>}
        </dl>
      </details>}
      {!connected && <p className="signalConnectionNote">Last received booking · server offline</p>}
    </> : <div className="signalEmpty">
      <span className="signalCategoryIcon"><AidPictogram aid={null} /></span>
      <p>Awaiting booking</p>
      <span>{connected ? 'Submit a request in the app.' : 'Signal server offline.'}</span>
    </div>}
  </section>;
}
