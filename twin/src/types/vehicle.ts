import { createSeatOccupancy, type SeatOccupancy } from '../data/cabinLayout';

/**
 * Semantic vehicle state — the single source of truth for the digital twin.
 *
 * Everything the 3D view shows is derived from this object. It deliberately
 * describes *what the vehicle is doing*, never *how a mesh should move*.
 */

export type DoorState = 'closed' | 'opening' | 'open' | 'closing';
export type RampState = 'retracted' | 'extending' | 'extended' | 'retracting';

export type BoardingStatus =
  | 'idle'
  | 'request_received'
  | 'preparing'
  | 'ready'
  | 'boarding'
  | 'complete';

export interface Announcement {
  active: boolean;
  text: string;
}

export interface PassengerInfo {
  title?: string;
  message?: string;
}

export interface VehicleState {
  vehicleId?: string;
  /** Epoch ms of the last update applied (telemetry or local). */
  updatedAt?: number;
  door: DoorState;
  ramp: RampState;
  kneeling: boolean;
  boardingStatus: BoardingStatus;
  /** e.g. "400 Punggol Coast" — a leading route number is rendered as a badge. */
  destination?: string;
  announcement?: Announcement;
  passengerInfo?: PassengerInfo;
  /** Stable seat IDs mapped to simulated occupancy. Missing map means no supplied occupancy. */
  seatOccupancy?: SeatOccupancy;
}

/** A partial update, as produced by commands or telemetry messages. */
export type VehicleStatePatch = Partial<VehicleState>;

export const DEFAULT_VEHICLE_STATE: VehicleState = {
  vehicleId: 'bus-01',
  door: 'closed',
  ramp: 'retracted',
  kneeling: false,
  boardingStatus: 'idle',
  destination: '400 Punggol Coast',
  announcement: { active: false, text: '' },
  passengerInfo: undefined,
  seatOccupancy: createSeatOccupancy(),
};

/** Continuous animation parameters, all normalised 0 → 1. */
export interface AnimationValues {
  doorOpenAmount: number;
  rampDeployAmount: number;
  kneelAmount: number;
}

/** Camera presets the viewer understands. */
export type CameraPreset = 'overview' | 'entrance' | 'ramp' | 'cutaway' | 'interior';

/** Semantic component names (used for highlights, callouts and click events). */
export type VehicleComponent = 'door' | 'ramp' | 'body' | 'destinationDisplay' | 'wheels';

/** Events emitted by the viewer back to the host application. */
export type TwinAction =
  | { type: 'seatClicked'; seatId: string }
  | { type: 'componentClicked'; component: VehicleComponent }
  | { type: 'animationSettled'; channel: keyof AnimationValues; value: number }
  | { type: 'cameraPresetChanged'; preset: CameraPreset };
