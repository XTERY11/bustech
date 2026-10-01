import { memo, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { BUS, DOOR_CENTER_X } from './dimensions';
import { getMaterials } from './materials';
import { clamp01, useTwin } from './twinContext';
import { easeInOutCubic } from '../../state/animationController';
import { driveAccent, makeAccentMaterial } from './accent';

/**
 * RampAssembly — a slide-out wheelchair ramp stowed under the door floor.
 *
 * rampDeployAmount (linear 0 → 1) is shaped into two overlapping phases:
 *   0.00–0.60  plate slides straight out of its slot under the threshold
 *   0.50–1.00  plate tips down about its inner edge until the lip meets the road
 * The tip angle is solved every frame from the *current* sill height, so the
 * ramp still lands on the ground when the bus is kneeling (or not).
 */

const { width: W, length: L, thickness: T, topY } = BUS.ramp;
const Z_STOWED = BUS.sideZ - L - 0.03;
const Z_DEPLOYED = BUS.sideZ + 0.005;

function useTreadTexture() {
  return useMemo(() => {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 288;
    const g = c.getContext('2d')!;
    g.fillStyle = '#5b6068';
    g.fillRect(0, 0, c.width, c.height);
    // diamond tread
    g.fillStyle = '#6d737b';
    for (let y = 10; y < c.height - 40; y += 16) {
      for (let x = 24 + ((y / 16) % 2) * 8; x < c.width - 24; x += 16) {
        g.save();
        g.translate(x, y);
        g.rotate(Math.PI / 4);
        g.fillRect(-2.2, -5, 4.4, 10);
        g.restore();
      }
    }
    // yellow side edges
    g.fillStyle = '#f2c200';
    g.fillRect(0, 0, 14, c.height);
    g.fillRect(c.width - 14, 0, 14, c.height);
    // hazard stripes at the outer lip (bottom of canvas = outer end)
    const y0 = c.height - 36;
    g.fillStyle = '#f2c200';
    g.fillRect(0, y0, c.width, 36);
    g.fillStyle = '#16181b';
    for (let x = -40; x < c.width + 40; x += 28) {
      g.beginPath();
      g.moveTo(x, y0);
      g.lineTo(x + 14, y0);
      g.lineTo(x + 14 + 36, y0 + 36);
      g.lineTo(x + 36, y0 + 36);
      g.closePath();
      g.fill();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return tex;
  }, []);
}

export const RampAssembly = memo(function RampAssembly() {
  const ctx = useTwin();
  const m = getMaterials();
  const slider = useRef<THREE.Group>(null!);
  const tilt = useRef<THREE.Group>(null!);
  const tread = useTreadTexture();
  const topMat = useMemo(() => new THREE.MeshStandardMaterial({ map: tread, roughness: 0.8, metalness: 0.15 }), [tread]);
  const edgeGlow = useMemo(() => makeAccentMaterial(), []);

  useFrame((_, dt) => {
    const r = ctx.anim.values.rampDeployAmount;
    const k = ctx.anim.values.kneelAmount;
    const slide = easeInOutCubic(clamp01(r / 0.6));
    const tip = easeInOutCubic(clamp01((r - 0.5) / 0.5));

    const z = Z_STOWED + (Z_DEPLOYED - Z_STOWED) * slide;
    slider.current.position.set(DOOR_CENTER_X, topY, z);

    // Solve the landing angle from the pivot's current height above ground.
    const roll = BUS.kneel.roll * k;
    const pivotWorldY = topY * Math.cos(roll) - z * Math.sin(roll) - BUS.kneel.drop * k;
    const worldAngle = Math.asin(clamp01((pivotWorldY - T * 0.6) / L));
    tilt.current.rotation.x = tip * (worldAngle - roll);

    // The plate is fully hidden inside the body when stowed.
    slider.current.visible = r > 0.001;

    driveAccent(edgeGlow, ctx.presentation.current.highlights.ramp ?? null, ctx.time.current, dt, 0.9);
  });

  return (
    <group
      name="RampAssembly"
      onClick={(e) => {
        e.stopPropagation();
        ctx.emit({ type: 'componentClicked', component: 'ramp' });
      }}
    >
      <group ref={slider} name="RampSlider">
        <group ref={tilt} name="Ramp">
          {/* plate body */}
          <mesh position={[0, -T / 2, L / 2]} material={m.frame} castShadow>
            <boxGeometry args={[W, T, L]} />
          </mesh>
          {/* tread surface */}
          <mesh position={[0, 0.0015, L / 2]} rotation={[-Math.PI / 2, 0, 0]} material={topMat}>
            <planeGeometry args={[W - 0.004, L - 0.004]} />
          </mesh>
          {/* bevelled landing lip */}
          <mesh position={[0, -T + 0.006, L + 0.03]} rotation={[0.3, 0, 0]} material={m.darkPlastic}>
            <boxGeometry args={[W, 0.012, 0.07]} />
          </mesh>
          {/* side edge light strips (highlight channel) */}
          {[-1, 1].map((s) => (
            <mesh key={s} position={[s * (W / 2 + 0.006), -T / 2, L / 2]} rotation={[0, s * Math.PI / 2, 0]} material={edgeGlow}>
              <planeGeometry args={[L, T * 0.7]} />
            </mesh>
          ))}
          <mesh position={[0, 0.003, L - 0.01]} rotation={[-Math.PI / 2, 0, 0]} material={edgeGlow}>
            <planeGeometry args={[W, 0.018]} />
          </mesh>
        </group>
      </group>
    </group>
  );
});
