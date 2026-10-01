import type { TelemetryMessage, TelemetrySource } from './telemetryAdapter';

/**
 * postMessage telemetry source (iframe embedding)
 * ------------------------------------------------
 * The host page (AccessRide dashboard) owns the twin inside an <iframe> and
 * sends telemetry frames with:
 *
 *   iframe.contentWindow.postMessage({ type: 'twin:telemetry', frame: TelemetryMessage }, '*')
 *
 * Frames pass through the same normalizeTelemetry() path as WebSocket/mock
 * telemetry, so the host never needs to know the twin's internal state shape.
 * The twin answers with { type: 'twin:ready' } once mounted (and again on each
 * { type: 'twin:hello' }, since the host may hydrate after the iframe loads) and
 * { type: 'twin:action', action } for viewer events.
 */
export const TWIN_MESSAGE = {
  telemetry: 'twin:telemetry',
  reset: 'twin:reset',
  hello: 'twin:hello',
  ready: 'twin:ready',
  action: 'twin:action',
} as const;

export interface TwinHostMessage {
  type: typeof TWIN_MESSAGE.telemetry | typeof TWIN_MESSAGE.reset | typeof TWIN_MESSAGE.hello;
  frame?: TelemetryMessage;
}

export class PostMessageTelemetrySource implements TelemetrySource {
  private handler?: (ev: MessageEvent) => void;

  constructor(
    private readonly allowedOrigins: string[] = [],
    private readonly onReset?: () => void,
    private readonly onHello?: () => void,
  ) {}

  start(onMessage: (msg: TelemetryMessage) => void) {
    this.handler = (ev: MessageEvent) => {
      if (this.allowedOrigins.length && !this.allowedOrigins.includes(ev.origin)) return;
      const data = ev.data as TwinHostMessage | undefined;
      if (!data || typeof data !== 'object') return;
      if (data.type === TWIN_MESSAGE.telemetry && data.frame && typeof data.frame === 'object') onMessage(data.frame);
      else if (data.type === TWIN_MESSAGE.reset) this.onReset?.();
      else if (data.type === TWIN_MESSAGE.hello) this.onHello?.(); // host (re)mounted after our first 'ready'
    };
    window.addEventListener('message', this.handler);
  }

  stop() {
    if (this.handler) window.removeEventListener('message', this.handler);
    this.handler = undefined;
  }
}

/** Send a message to the embedding page (no-op when not embedded). */
export function postToHost(message: Record<string, unknown>) {
  if (window.parent && window.parent !== window) window.parent.postMessage(message, '*');
}
