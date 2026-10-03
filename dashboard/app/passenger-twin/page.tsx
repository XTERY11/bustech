"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { TwinPanel } from '../components/TwinPanel';
import { snapshotFromEvent, watchEvents } from '../live-client';
import type { Context, Snapshot } from '../live-types';

/**
 * Passenger view for the BusPulse SG app's web view: only the bus digital twin, full-bleed, driven by
 * the same hub stream as the dashboard. Connection settings come from the URL fragment, which the
 * browser never sends to a server: /passenger-twin#token=<hub token>[&hub=http://<host>:8787].
 * Without `hub` the page uses the dashboard's default (NEXT_PUBLIC_API_BASE_URL, else the same-origin /api proxy).
 */
const EMPTY_CONTEXT: Context = { request_id: 'passenger-twin' };

const subscribeToHash = (onChange: () => void) => {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
};

function useConnection() {
  // null until the client has read the fragment, so no stream starts with the wrong settings.
  const hash = useSyncExternalStore(subscribeToHash, () => window.location.hash, () => null);
  return useMemo(() => {
    if (hash === null) return null;
    const params = new URLSearchParams(hash.replace(/^#/, ''));
    const hub = params.get('hub')?.trim().replace(/\/+$/, '') ?? '';
    const base = /^https?:\/\//.test(hub) ? hub : process.env.NEXT_PUBLIC_API_BASE_URL ?? '';
    return { base, token: params.get('token')?.trim() ?? '' };
  }, [hash]);
}

export default function PassengerTwinPage() {
  const connection = useConnection();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);

  useEffect(() => {
    if (!connection) return;
    const abort = new AbortController();
    void watchEvents(connection.base, connection.token, abort.signal, event => {
      const next = snapshotFromEvent(event);
      if (next) setSnapshot(next);
    }, () => {});
    return () => abort.abort();
  }, [connection]);

  return <main className="passengerTwinPage" aria-label="Bus digital twin">
    <style>{`
      .passengerTwinPage { position: fixed; inset: 0; overflow: hidden; background: #eceef1; }
      .passengerTwinPage .twinPanel { height: 100%; margin: 0; padding: 0; border: 0; border-radius: 0; box-shadow: none; background: transparent; }
      .passengerTwinPage .panelHeader, .passengerTwinPage .twinConsole, .passengerTwinPage .stageFooter { display: none; }
      .passengerTwinPage .stageMedia { height: 100%; margin: 0; border: 0; border-radius: 0; aspect-ratio: auto; }
    `}</style>
    <TwinPanel
      result={snapshot?.result ?? null}
      context={snapshot?.context ?? EMPTY_CONTEXT}
      running={Boolean(snapshot?.running)}
      journey={snapshot?.source === 'external' ? snapshot.journey ?? null : null}
      basePath={process.env.NEXT_PUBLIC_BASE_PATH ?? ''}
    />
  </main>;
}
