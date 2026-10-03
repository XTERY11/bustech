import { getCabinSnapshot } from '../../data/cabinLayout';
import { memo, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { AnimationValues, CameraPreset, TwinAction, VehicleState } from '../../types/vehicle';
import { AnimationController } from '../../state/animationController';
import { derivePresentation, type Callout, type Presentation } from '../../state/presentation';
import { TwinContext, useTwin, type TwinFrameContext } from './twinContext';
import { BusModel } from './BusModel';
import { Stage } from './Stage';
import { CameraRig } from './CameraRig';
import { TwinHud } from './TwinHud';
import './twin.css';

export interface BusDigitalTwinProps {
  /** Semantic vehicle state. Every change animates smoothly from the current pose. */
  state: VehicleState;
  /** Events back to the host: component clicks, animation settled, camera changes. */
  onAction?: (action: TwinAction) => void;
  /** Continuous animation values (~12 Hz while moving) — useful for debugging/telemetry echo. */
  onAnimationUpdate?: (values: AnimationValues) => void;
  theme?: 'light' | 'dark';
  /** Overlay: status chips, boarding sequence, announcement bar. */
  showHud?: boolean;
  /** Dashboard host already shows actions and passenger guidance outside the iframe. */
  compactHud?: boolean;
  showCameraPresets?: boolean;
  /** Controlled camera preset (optional). */
  cameraPreset?: CameraPreset;
  className?: string;
  style?: CSSProperties;
}

/**
 * <BusDigitalTwin state={vehicleState} onAction={...} />
 *
 * Self-contained, embeddable viewer. It fills its parent box (any size),
 * renders on demand (idle = zero GPU work) and never mutates vehicle state.
 */
export function BusDigitalTwin({
  state,
  onAction,
  onAnimationUpdate,
  theme = 'light',
  showHud = true,
  compactHud = false,
  showCameraPresets = true,
  cameraPreset,
  className,
  style,
}: BusDigitalTwinProps) {
  const presentation = useMemo(() => derivePresentation(state), [state]);

  // Stable per-frame context (refs mutated in place, no re-renders).
  const [selectedSeatId, setSelectedSeatId] = useState<string>();
  const onActionRef = useRef(onAction);
  onActionRef.current = onAction;
  const ctx = useMemo<TwinFrameContext>(
    () => ({
      anim: new AnimationController(state),
      state: { current: state },
      presentation: { current: presentation },
      time: { current: 0 },
      destinationChangedAt: { current: -1e9 },
      emit: (a) => {
        if (a.type === 'seatClicked') setSelectedSeatId(a.seatId);
        onActionRef.current?.(a);
      },
    }),
    [], // eslint-disable-line react-hooks/exhaustive-deps
  );
  ctx.state.current = state;
  ctx.presentation.current = presentation;

  // Destination change → display flash + short callout.
  const [destCallout, setDestCallout] = useState<Callout | null>(null);
  const firstDest = useRef(true);
  useEffect(() => {
    if (firstDest.current) {
      firstDest.current = false;
      return;
    }
    ctx.destinationChangedAt.current = performance.now();
    setDestCallout({ key: `dest-${state.destination}`, anchor: 'display', icon: 'route', title: 'Destination updated', subtitle: state.destination ?? '', tone: 'neutral' });
    const id = window.setTimeout(() => setDestCallout(null), 3200);
    return () => window.clearTimeout(id);
  }, [state.destination, ctx]);

  // Camera preset: controlled or internal.
  const [internalPreset, setInternalPreset] = useState<CameraPreset>('overview');
  const [presetNonce, setPresetNonce] = useState(0);
  const preset = cameraPreset ?? internalPreset;
  const cabinView = preset === 'interior' || preset === 'cutaway';
  const cabin = getCabinSnapshot(state);
  const selectedSeat = cabin.seats.find((s) => s.id === selectedSeatId);
  const choosePreset = (p: CameraPreset) => {
    setInternalPreset(p);
    setPresetNonce((n) => n + 1);
    onActionRef.current?.({ type: 'cameraPresetChanged', preset: p });
  };

  // Compact layout for small embeds (container width, not viewport).
  const rootRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setCompact(e.contentRect.width < 700));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={rootRef} className={`twin-root ${compact ? 'compact' : ''} ${compactHud ? 'dashboard-hud' : ''} ${className ?? ''}`} data-theme={theme} style={style}>
      <Canvas
        className="twin-canvas"
        frameloop="demand"
        dpr={[1, 2]}
        camera={{ fov: 30, near: 0.1, far: 120, position: [-8.4, 3.3, 9.4] }}
        gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
        onCreated={({ gl }) => {
          gl.toneMapping = THREE.NeutralToneMapping;
          gl.toneMappingExposure = 1.08;
        }}
      >
        <TwinContext.Provider value={ctx}>
          <AnimationDriver state={state} presentation={presentation} onAnimationUpdate={onAnimationUpdate} />
          <Stage theme={theme} />
          <BusModel
            cutaway={preset === 'cutaway'}
            occupancy={state.seatOccupancy}
            passengerJourney={state.passengerJourney}
            arrival={state.arrival}
            selectedSeatId={selectedSeatId}
            destination={state.destination}
            announcementActive={!!state.announcement?.active}
            primaryCallout={cabinView ? null : presentation.callout}
            destinationCallout={cabinView ? null : destCallout}
          />
          <CameraRig preset={preset} presetNonce={presetNonce} />
        </TwinContext.Provider>
      </Canvas>

      {showHud && !cabinView && <TwinHud state={state} presentation={presentation} compact={compactHud} />}

      {showHud && cabinView && <div className={`twin-cabin-summary glass${compactHud ? ' is-compact' : ''}`} aria-live="polite">
        <span className="twin-cabin-eyebrow">B70A02 · SIMULATED CABIN</span>
        <strong>{compactHud
          ? <>Occupied {cabin.occupiedFixedSeats}<span> / {cabin.fixedSeatCount}</span></>
          : <>{cabin.occupiedFixedSeats} occupied <span> / {cabin.fixedSeatCount} fixed seats</span></>}</strong>
        <span className="twin-cabin-availability" title={`Fold-up seat ${state.seatOccupancy?.F01 ? 'occupied' : 'stowed'}`}>
          {compactHud ? `${cabin.availableFixedSeats} free · F01 ${state.seatOccupancy?.F01 ? 'occupied' : 'stowed'}` : `${cabin.availableFixedSeats} available · Fold-up seat ${state.seatOccupancy?.F01 ? 'occupied' : 'stowed'}`}
        </span>
        <small className={selectedSeat ? 'twin-cabin-seat' : 'twin-cabin-hint'}>{selectedSeat ? `${selectedSeat.id} · ${selectedSeat.kind} · ${selectedSeat.occupied ? 'Occupied' : 'Empty'}` : 'Select a seat in the model to inspect it.'}</small>
      </div>}

      {showCameraPresets && (
        <div className="twin-presets" role="group" aria-label="Camera view">
          {(['overview', 'entrance', 'ramp', 'cutaway', 'interior'] as const).map((p) => (
            <button key={p} aria-pressed={p === preset} className={p === preset ? 'on' : ''} onClick={() => choosePreset(p)}>
              {{ overview: 'Overview', entrance: 'Entrance', ramp: 'Ramp', cutaway: 'Cutaway', interior: 'Interior' }[p]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Steps the animation controller each rendered frame and decides whether
 * another frame is needed (demand-driven rendering: idle scene = no GPU work).
 */
const AnimationDriver = memo(function AnimationDriver({
  state,
  presentation,
  onAnimationUpdate,
}: {
  state: VehicleState;
  presentation: Presentation;
  onAnimationUpdate?: (v: AnimationValues) => void;
}) {
  const ctx = useTwin();
  const invalidate = useThree((s) => s.invalidate);
  const lastChange = useRef(performance.now());
  const lastReport = useRef(0);
  const cbRef = useRef(onAnimationUpdate);
  cbRef.current = onAnimationUpdate;

  useEffect(() => {
    ctx.anim.setTargets(state);
    lastChange.current = performance.now();
    invalidate();
  }, [state, ctx, invalidate]);

  useFrame((_, dt) => {
    ctx.time.current += Math.min(dt, 0.1);
    const settled = ctx.anim.step(dt);
    settled.forEach((ch) => ctx.emit({ type: 'animationSettled', channel: ch, value: ctx.anim.channels[ch].target }));

    const now = performance.now();
    if (cbRef.current && (ctx.anim.isAnimating || settled.length) && (now - lastReport.current > 80 || settled.length)) {
      lastReport.current = now;
      cbRef.current(ctx.anim.values);
    }

    const p = presentation;
    const continuous =
      ctx.anim.isAnimating ||
      now - lastChange.current < 1600 || // let accent fades finish
      now - ctx.destinationChangedAt.current < 3200 ||
      Object.values(p.highlights).includes('progress') ||
      p.entranceHalo === 'progress' ||
      p.path === 'boarding' ||
      p.accessibilityIndicator;
    if (continuous) invalidate();
  });

  return null;
});
