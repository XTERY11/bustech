import { normalizeSeatOccupancy, SEATS } from '../data/cabinLayout';
import type {
  BoardingStatus,
  DoorState,
  FixedSeatId,
  PassengerAid,
  PassengerDestination,
  PassengerJourney,
  PassengerJourneyStage,
  RampState,
  VehicleArrival,
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
  seatOccupancy?: unknown;
  passengerJourney?: unknown;
  arrival?: unknown;
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
const PASSENGER_AIDS = new Set<PassengerAid>(['wheelchair', 'cane', 'crutch', 'walker', 'stroller', 'visual', 'hearing', 'none']);
const PASSENGER_STAGES = new Set<PassengerJourneyStage>(['hidden', 'waiting', 'boarding', 'navigating', 'seated', 'secured']);
const FIXED_SEATS = new Set(SEATS.filter((seat) => seat.kind !== 'foldable').map((seat) => seat.id));
const STROLLER_SEATS = new Set(['S02', 'S03', 'S05', 'S06', 'S08', 'S09']);
const JOURNEY_ID = /^[A-Za-z0-9_.:-]{1,200}$/;

/** Invalid arrival frames leave the preceding pose intact. */
export function normalizeArrival(value: unknown): VehicleArrival | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== 'string' || !JOURNEY_ID.test(raw.id)) return undefined;
  if (typeof raw.progress !== 'number' || !Number.isFinite(raw.progress) || raw.progress < 0 || raw.progress > 1) return undefined;
  return { id: raw.id, progress: raw.progress };
}

/** Validate the optional wire-level passenger state without inventing defaults. */
export function normalizePassengerJourney(value: unknown): PassengerJourney | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.journeyId !== 'string' || !JOURNEY_ID.test(raw.journeyId)) return undefined;
  if (typeof raw.aid !== 'string' || !PASSENGER_AIDS.has(raw.aid as PassengerAid)) return undefined;
  if (typeof raw.stage !== 'string' || !PASSENGER_STAGES.has(raw.stage as PassengerJourneyStage)) return undefined;
  if (!raw.destination || typeof raw.destination !== 'object' || Array.isArray(raw.destination)) return undefined;

  const destination = raw.destination as Record<string, unknown>;
  if (!['SEAT', 'WHEELCHAIR_BAY'].includes(String(destination.type))) return undefined;
  if (typeof destination.id !== 'string') return undefined;
  if (destination.type === 'SEAT' && !FIXED_SEATS.has(destination.id)) return undefined;
  if (destination.type === 'WHEELCHAIR_BAY' && destination.id !== 'WHEELCHAIR_BAY') return undefined;
  if (raw.progress !== undefined && (typeof raw.progress !== 'number' || !Number.isFinite(raw.progress) || raw.progress < 0 || raw.progress > 1)) return undefined;
  let equipmentDestination: PassengerDestination | null | undefined;
  if (raw.equipmentDestination === null) equipmentDestination = null;
  else if (raw.equipmentDestination !== undefined) {
    const equipment = raw.equipmentDestination;
    if (raw.aid !== 'stroller' || destination.type !== 'SEAT' || !STROLLER_SEATS.has(destination.id)
      || !equipment || typeof equipment !== 'object' || Array.isArray(equipment)) return undefined;
    const target = equipment as Record<string, unknown>;
    if (target.type !== 'WHEELCHAIR_BAY' || target.id !== 'WHEELCHAIR_BAY') return undefined;
    equipmentDestination = { type: 'WHEELCHAIR_BAY', id: 'WHEELCHAIR_BAY' };
  }

  return {
    journeyId: raw.journeyId,
    aid: raw.aid as PassengerAid,
    stage: raw.stage as PassengerJourneyStage,
    destination: destination.type === 'SEAT'
      ? { type: 'SEAT', id: destination.id as FixedSeatId }
      : { type: 'WHEELCHAIR_BAY', id: 'WHEELCHAIR_BAY' },
    ...(typeof raw.progress === 'number' ? { progress: raw.progress } : {}),
    ...(equipmentDestination !== undefined ? { equipmentDestination } : {}),
  };
}

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
  if ('passengerJourney' in msg) {
    const journey = normalizePassengerJourney(msg.passengerJourney);
    if (journey !== undefined) patch.passengerJourney = journey;
  }
  if ('arrival' in msg) {
    const arrival = normalizeArrival(msg.arrival);
    if (arrival !== undefined) patch.arrival = arrival;
  }
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
