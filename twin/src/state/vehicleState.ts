import { normalizeSeatOccupancy } from '../data/cabinLayout';
import { useSyncExternalStore } from 'react';
import {
  DEFAULT_VEHICLE_STATE,
  type VehicleState,
  type VehicleStatePatch,
} from '../types/vehicle';

/**
 * Minimal observable store for VehicleState.
 *
 * Any producer (demo buttons, simulator, WebSocket adapter, replay) calls
 * `setVehicleState(patch)`. Any consumer (the 3D twin, a debug panel)
 * subscribes. The store knows nothing about rendering.
 */
export interface VehicleStore {
  getState(): VehicleState;
  setVehicleState(patch: VehicleStatePatch): void;
  replaceState(next: VehicleState): void;
  subscribe(listener: (s: VehicleState) => void): () => void;
}

/** Merge a patch into a state. Nested objects are merged shallowly. */
export function applyPatch(state: VehicleState, patch: VehicleStatePatch): VehicleState {
  const next: VehicleState = { ...state, ...patch, updatedAt: patch.updatedAt ?? Date.now() };
  if (patch.announcement) {
    next.announcement = { ...(state.announcement ?? { active: false, text: '' }), ...patch.announcement };
  }
  if ('passengerInfo' in patch) {
    next.passengerInfo = patch.passengerInfo ? { ...patch.passengerInfo } : undefined;
  }
  if (patch.seatOccupancy) {
    next.seatOccupancy = { ...state.seatOccupancy, ...normalizeSeatOccupancy(patch.seatOccupancy) };
  }
  if ('passengerJourney' in patch) {
    next.passengerJourney = patch.passengerJourney
      ? { ...patch.passengerJourney, destination: { ...patch.passengerJourney.destination } }
      : null;
  }
  if ('arrival' in patch) next.arrival = patch.arrival ? { ...patch.arrival } : null;
  return next;
}

export function createVehicleStore(initial: VehicleState = DEFAULT_VEHICLE_STATE): VehicleStore {
  let state: VehicleState = { ...initial, updatedAt: Date.now() };
  const listeners = new Set<(s: VehicleState) => void>();
  const emit = () => listeners.forEach((l) => l(state));

  return {
    getState: () => state,
    setVehicleState(patch) {
      state = applyPatch(state, patch);
      emit();
    },
    replaceState(next) {
      state = { ...next };
      emit();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** React binding: re-renders whenever the store changes. */
export function useVehicleState(store: VehicleStore): VehicleState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}
