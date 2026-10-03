import { memo, useEffect, useRef } from 'react';
import { CameraControls } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type CameraControlsImpl from 'camera-controls';
import type { CameraPreset } from '../../types/vehicle';

/**
 * Configurator-style camera: orbit / dolly / limited pan, smooth damping,
 * bounded so the user can't get lost under the bus or drift away.
 * Presets animate with the controls' own smoothing (interruptible by the user).
 */

interface PresetDef {
  pos: [number, number, number];
  target: [number, number, number];
}

export const CAMERA_PRESETS: Record<CameraPreset, PresetDef> = {
  cutaway: { pos: [-7.8, 8.6, 10.8], target: [0, 0.95, 0] },
  interior: { pos: [-2.02, 1.89, 0.31], target: [2.75, 1.48, 0.12] },
  overview: { pos: [-8.2, 3.4, 11.2], target: [1.15, 1.0, 0.2] },
  entrance: { pos: [-5.0, 2.45, 8.8], target: [-1.1, 1.2, 1.0] },
  ramp: { pos: [-6.3, 2.7, 9.4], target: [-0.95, 0.8, 1.5] },
};

function framed(preset: CameraPreset, aspect: number): PresetDef {
  const p = CAMERA_PRESETS[preset];
  if (preset === 'interior') return p;
  // Close entrance/ramp views retain roof clearance; overview can move up to 28% closer.
  const closest = { overview: 0.72, cutaway: 0.78, entrance: 0.92, ramp: 0.98 }[preset];
  const k = aspect > 2.4 ? THREE.MathUtils.clamp(1 - (aspect - 2.4) * 0.45, closest, 1)
    : THREE.MathUtils.clamp(1.5 / aspect, 1, 2.6);
  const pos = p.pos.map((v, i) => p.target[i] + (v - p.target[i]) * k) as [number, number, number];
  return { pos, target: p.target };
}

export const CameraRig = memo(function CameraRig({ preset, presetNonce }: { preset: CameraPreset; presetNonce: number }) {
  const ref = useRef<CameraControlsImpl>(null);
  const size = useThree((s) => s.size);
  const invalidate = useThree((s) => s.invalidate);
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const first = useRef(true);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    c.setBoundary(new THREE.Box3(new THREE.Vector3(-4.5, 0.2, -2.5), new THREE.Vector3(4.5, 2.6, 4)));
    c.boundaryFriction = 0.2;
    if (import.meta.env.DEV) Object.assign(window, { __twinControls: c, __twinGl: gl });
  }, [gl]);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    if (camera instanceof THREE.PerspectiveCamera) {
      camera.fov = preset === 'interior' ? 72 : 30;
      camera.near = preset === 'interior' ? 0.035 : 0.1;
      camera.updateProjectionMatrix();
    }
    const f = framed(preset, size.width / Math.max(1, size.height));
    const animate = !first.current;
    first.current = false;
    c.setLookAt(...f.pos, ...f.target, animate);
    invalidate();
    // Re-run when the viewport aspect changes class, or a preset is re-clicked.
  }, [preset, presetNonce, Math.round((size.width / Math.max(1, size.height)) * 4)]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <CameraControls
      ref={ref}
      makeDefault
      minDistance={preset === 'interior' ? 0.25 : 3.2}
      maxDistance={19}
      minPolarAngle={0.2}
      maxPolarAngle={preset === 'interior' ? Math.PI - 0.1 : Math.PI / 2 - 0.05}
      smoothTime={0.55}
      draggingSmoothTime={0.14}
      dollySpeed={0.6}
      truckSpeed={1}
    />
  );
});
