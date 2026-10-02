import { getCabinSnapshot } from './data/cabinLayout';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { BusDigitalTwin } from './components/BusDigitalTwin';
import { createVehicleStore, useVehicleState } from './state/vehicleState';
import { connectTelemetry, normalizeTelemetry, type TelemetryMessage } from './adapters/telemetryAdapter';
import { PostMessageTelemetrySource, TWIN_MESSAGE, postToHost } from './adapters/postMessageSource';
import { DEFAULT_VEHICLE_STATE, type CameraPreset, type TwinAction, type VehicleStatePatch } from './types/vehicle';

/**
 * Embed shell (`index.html?embed=1`).
 *
 *   host page ──postMessage──► PostMessageTelemetrySource ──► normalizeTelemetry ──► VehicleStore ──► <BusDigitalTwin />
 *
 * No MockBus, no control panel: the host (AccessRide dashboard) is the only
 * producer of vehicle state, so its frames are never overwritten.
 * Query options: theme=light|dark, hud=0, camera=overview|entrance|ramp, vehicle=<id>, destination=<text>.
 */
export function EmbedApp() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const vehicleId = params.get('vehicle') ?? 'bus-01';
  const store = useMemo(
    () => createVehicleStore({ ...DEFAULT_VEHICLE_STATE, vehicleId, destination: params.get('destination') ?? DEFAULT_VEHICLE_STATE.destination }),
    [vehicleId, params],
  );
  const state = useVehicleState(store);
  const theme = params.get('theme') === 'dark' ? 'dark' : 'light';
  const showHud = params.get('hud') !== '0';
  const cameraParam = params.get('camera');
  const [camera, setCamera] = useState<CameraPreset>(['overview', 'entrance', 'ramp', 'cutaway', 'interior'].includes(cameraParam ?? '') ? cameraParam as CameraPreset : 'overview');

  useEffect(() => {
    const reset = () => store.replaceState({ ...DEFAULT_VEHICLE_STATE, vehicleId, destination: store.getState().destination, updatedAt: Date.now() });
    const ready = () => postToHost({ type: TWIN_MESSAGE.ready, vehicleId });
    const source = new PostMessageTelemetrySource([], reset, ready);
    const disconnect = connectTelemetry(store, source);
    Object.assign(window, {
      twin: {
        store,
        getCabinSnapshot: () => getCabinSnapshot(store.getState()),
        setVehicleState: (p: VehicleStatePatch) => store.setVehicleState(p),
        telemetry: (m: TelemetryMessage) => store.setVehicleState(normalizeTelemetry(m)),
        reset,
      },
    });
    ready();
    return disconnect;
  }, [store, vehicleId]);

  const onAction = useCallback((action: TwinAction) => {
    if (action.type === 'cameraPresetChanged') setCamera(action.preset);
    postToHost({ type: TWIN_MESSAGE.action, action });
  }, []);

  return (
    <div className="app embed" data-theme={theme} style={{ width: '100%', height: '100%' }}>
      <BusDigitalTwin state={state} onAction={onAction} theme={theme} showHud={showHud} showCameraPresets cameraPreset={camera} />
    </div>
  );
}
