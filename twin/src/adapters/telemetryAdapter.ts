import { normalizeSeatOccupancy } from '../data/cabinLayout';
import type {
  BoardingStatus,
  DoorState,
  RampState,
  VehicleStatePatch,
} from '../types/vehicle';
import type { VehicleStore } from '../state/vehicleState';

/**
 * Telemetry adapter boundary
 * --------------------------
 *   WebSocket / REST / MQTT  ──►  TelemetrySource  ──►  normalizeTelemetry()  ──►  VehicleStore
 *
 * Only this file knows the wire format. Swapping the transport or the message
 * schema never touches the 3D model or the animation controller.
 */

/** Raw message shape we expect from the vehicle gateway (loosely typed on purpose). */
export interface TelemetryMessage {
  vehicleId?: string;
  timestamp?: number; // seconds or ms since epoch
  door?: string;
  ramp?: string;
  kneeling?: boolean | 'true' | 'false' | 0 | 1;
  boardingStatus?: string;
  destination?: string;
  announcement?: { active?: boolean; text?: string };
  passengerInfo?: { title?: string; message?: string } | null;
  [extra: string]: unknown;
}

const DOOR_ALIASES: Record<string, DoorState> = {
  closed: 'closed', close: 'closed', locked: 'closed',
  opening: 'opening',
  open: 'open', opened: 'open',
  closing: 'closing',
};
const RAMP_ALIASES: Record<string, RampState> = {
  retracted: 'retracted', stowed: 'retracted', stored: 'retracted',
  extending: 'extending', deploying: 'extending',
  extended: 'extended', deployed: 'extended',
  retracting: 'retracting', stowing: 'retracting',
};
const BOARDING: BoardingStatus[] = ['idle', 'request_received', 'preparing', 'ready', 'boarding', 'complete'];

/** Map one raw message to a validated VehicleState patch. Unknown values are dropped. */
export function normalizeTelemetry(msg: TelemetryMessage): VehicleStatePatch {
  const patch: VehicleStatePatch = {};
  if (typeof msg.vehicleId === 'string') patch.vehicleId = msg.vehicleId;
  if (typeof msg.timestamp === 'number') {
    patch.updatedAt = msg.timestamp < 1e12 ? msg.timestamp * 1000 : msg.timestamp;
  }
  const door = DOOR_ALIASES[String(msg.door ?? '').toLowerCase()];
  if (door) patch.door = door;
  const ramp = RAMP_ALIASES[String(msg.ramp ?? '').toLowerCase()];
  if (ramp) patch.ramp = ramp;
  if (msg.kneeling !== undefined) patch.kneeling = msg.kneeling === true || msg.kneeling === 'true' || msg.kneeling === 1;
  if (BOARDING.includes(msg.boardingStatus as BoardingStatus)) patch.boardingStatus = msg.boardingStatus as BoardingStatus;
  if (typeof msg.destination === 'string') patch.destination = msg.destination;
  if (msg.announcement && typeof msg.announcement === 'object') {
    patch.announcement = { active: !!msg.announcement.active, text: String(msg.announcement.text ?? '') };
  }
  if (msg.passengerInfo === null) patch.passengerInfo = undefined;
  else if (msg.passengerInfo) patch.passengerInfo = { ...msg.passengerInfo };
  if (msg.seatOccupancy !== undefined) patch.seatOccupancy = normalizeSeatOccupancy(msg.seatOccupancy);
  return patch;
}

/** Anything that can push telemetry messages. */
export interface TelemetrySource {
  start(onMessage: (msg: TelemetryMessage) => void): void;
  stop(): void;
}

/** Wire a source into a store through the normalizer. Returns a disconnect fn. */
export function connectTelemetry(store: VehicleStore, source: TelemetrySource, vehicleId?: string) {
  source.start((msg) => {
    if (vehicleId && msg.vehicleId && msg.vehicleId !== vehicleId) return;
    store.setVehicleState(normalizeTelemetry(msg));
  });
  return () => source.stop();
}

/**
 * Ready-to-use WebSocket source (not used by the demo — there is no backend yet).
 *   connectTelemetry(store, new WebSocketTelemetrySource('wss://gateway/bus-01'))
 */
export class WebSocketTelemetrySource implements TelemetrySource {
  private ws?: WebSocket;
  private retry?: number;
  private stopped = false;

  constructor(private readonly url: string, private readonly reconnectMs = 2000) {}

  start(onMessage: (msg: TelemetryMessage) => void) {
    this.stopped = false;
    const open = () => {
      this.ws = new WebSocket(this.url);
      this.ws.onmessage = (ev) => {
        try {
          onMessage(JSON.parse(String(ev.data)));
        } catch {
          /* ignore malformed frames */
        }
      };
      this.ws.onclose = () => {
        if (!this.stopped) this.retry = window.setTimeout(open, this.reconnectMs);
      };
    };
    open();
  }

  stop() {
    this.stopped = true;
    window.clearTimeout(this.retry);
    this.ws?.close();
  }
}
