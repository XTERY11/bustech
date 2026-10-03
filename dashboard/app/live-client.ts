import type { HubEvent, Snapshot } from './live-types';
const endpoint = (base: string, path: string) => `${base.trim().replace(/\/+$/, '')}${path}`;
export async function postSignal(base: string, token: string, path: string, body: unknown) {
  const response = await fetch(endpoint(base, path), { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  if (!response.ok) { const error = await response.json().catch(() => ({})); throw new Error(error.error || `HTTP_${response.status}`); }
  return response.json();
}

/** Every journey transition and completed plan can carry the same authoritative state. */
export function snapshotFromEvent(event: HubEvent): Snapshot | null {
  if (event.type === 'snapshot') return event.data as unknown as Snapshot;
  return event.data.snapshot ? event.data.snapshot as Snapshot : null;
}

// SSE over fetch supports an Authorization header without putting the token in a URL.
// Each reconnect receives a full state snapshot; no older result is blindly replayed.
export async function watchEvents(base: string, token: string, signal: AbortSignal, onEvent: (event: HubEvent) => void, onConnection: (connected: boolean) => void) {
  while (!signal.aborted) {
    try {
      const response = await fetch(endpoint(base, '/api/events'), { headers: { Accept: 'text/event-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, signal });
      if (!response.ok || !response.body) throw new Error('EVENT_CONNECTION_FAILED');
      onConnection(true);
      const reader = response.body.getReader(), decoder = new TextDecoder(); let pending = '';
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        let end;
        while ((end = pending.indexOf('\n\n')) >= 0) {
          const frame = pending.slice(0, end); pending = pending.slice(end + 2);
          const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
          if (data) onEvent(JSON.parse(data));
        }
      }
    } catch { /* Show disconnected status and reconnect without running another model request. */ }
    if (signal.aborted) return;
    onConnection(false);
    await new Promise<void>(resolve => {
      const complete = () => { clearTimeout(timer); signal.removeEventListener('abort', complete); resolve(); };
      const timer = setTimeout(complete, 2500); signal.addEventListener('abort', complete, { once: true });
    });
  }
}
