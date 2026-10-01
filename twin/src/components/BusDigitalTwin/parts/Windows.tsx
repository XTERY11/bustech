import { memo } from 'react';
import * as THREE from 'three';
import { BUS } from '../dimensions';
import { getMaterials } from '../materials';

/**
 * Black window band, glazing, windscreen and trim strip.
 * Thin panels sit just proud of the body surface; quarter-cylinders wrap the
 * band around the rounded corners so it reads as one continuous glass belt.
 */

type Side = 1 | -1;
const EPS = 0.003;

function SidePanel({ x0, x1, y0, y1, side, offset = EPS, depth = 0.006, material }: {
  x0: number; x1: number; y0: number; y1: number; side: Side; offset?: number; depth?: number; material: THREE.Material;
}) {
  return (
    <mesh position={[(x0 + x1) / 2, (y0 + y1) / 2, side * (BUS.sideZ + offset)]} material={material}>
      <boxGeometry args={[x1 - x0, y1 - y0, depth]} />
    </mesh>
  );
}

function EndPanel({ z0, z1, y0, y1, end, offset = EPS, depth = 0.006, material }: {
  z0: number; z1: number; y0: number; y1: number; end: 'front' | 'rear'; offset?: number; depth?: number; material: THREE.Material;
}) {
  const x = end === 'front' ? BUS.frontX - offset : BUS.rearX + offset;
  return (
    <mesh position={[x, (y0 + y1) / 2, (z0 + z1) / 2]} material={material}>
      <boxGeometry args={[depth, y1 - y0, z1 - z0]} />
    </mesh>
  );
}

/** Quarter cylinder hugging a vertical body corner. */
function CornerWrap({ corner, y0, y1, material }: {
  corner: 'fl' | 'fr' | 'rl' | 'rr'; y0: number; y1: number; material: THREE.Material;
}) {
  const r = BUS.cornerRadius;
  const front = corner[0] === 'f';
  const left = corner[1] === 'l'; // l = +Z (kerb side)
  const x = front ? BUS.frontX + r : BUS.rearX - r;
  const z = left ? BUS.sideZ - r : -(BUS.sideZ - r);
  const thetaStart = front ? (left ? Math.PI * 1.5 : Math.PI) : left ? 0 : Math.PI / 2;
  return (
    <mesh position={[x, (y0 + y1) / 2, z]} material={material}>
      <cylinderGeometry args={[r + EPS, r + EPS, y1 - y0, 10, 1, true, thetaStart, Math.PI / 2]} />
    </mesh>
  );
}

const FLAT_X0 = BUS.frontX + BUS.cornerRadius; // -3.64
const FLAT_X1 = BUS.rearX - BUS.cornerRadius;
const FLAT_Z = BUS.sideZ - BUS.cornerRadius;

export const Windows = memo(function Windows() {
  const m = getMaterials();
  const { band, stripe, windows: w, door } = BUS;

  const kerbPanes: [number, number, number?][] = [
    [-3.56, -2.0, 2.2],
    [-0.66, 0.56], [0.62, 1.86], [1.92, 3.1], [3.16, 3.58],
  ];
  const roadPanes: [number, number][] = [
    [-3.56, -2.4], [-2.34, -1.1], [-1.04, 0.2], [0.26, 1.5], [1.56, 2.8], [2.86, 3.58],
  ];

  return (
    <group name="Windows">
      {/* ── Kerb side (+Z), interrupted by the door ── */}
      <SidePanel x0={FLAT_X0} x1={door.x0} y0={band.y0} y1={band.y1} side={1} material={m.gloss} />
      <SidePanel x0={door.x1} x1={FLAT_X1} y0={band.y0} y1={band.y1} side={1} material={m.gloss} />
      <SidePanel x0={door.x0} x1={door.x1} y0={door.y1} y1={band.y1} side={1} material={m.gloss} />
      <SidePanel x0={FLAT_X0} x1={door.x0} y0={stripe.y0} y1={stripe.y1} side={1} material={m.trim} />
      <SidePanel x0={door.x1} x1={FLAT_X1} y0={stripe.y0} y1={stripe.y1} side={1} material={m.trim} />
      {kerbPanes.map(([a, b, top]) => (
        <SidePanel key={a} x0={a} x1={b} y0={w.y0} y1={top ?? w.y1} side={1} offset={0.008} depth={0.008} material={m.glass} />
      ))}

      {/* ── Road side (-Z) ── */}
      <SidePanel x0={FLAT_X0} x1={FLAT_X1} y0={band.y0} y1={band.y1} side={-1} material={m.gloss} />
      <SidePanel x0={FLAT_X0} x1={FLAT_X1} y0={stripe.y0} y1={stripe.y1} side={-1} material={m.trim} />
      {roadPanes.map(([a, b]) => (
        <SidePanel key={a} x0={a} x1={b} y0={w.y0} y1={w.y1} side={-1} offset={0.008} depth={0.008} material={m.glass} />
      ))}

      {/* ── Corner wraps ── */}
      {(['fl', 'fr', 'rl', 'rr'] as const).map((c) => (
        <group key={c}>
          <CornerWrap corner={c} y0={band.y0} y1={band.y1} material={m.gloss} />
          <CornerWrap corner={c} y0={stripe.y0} y1={stripe.y1} material={m.trim} />
        </group>
      ))}

      {/* ── Front: windscreen surround + glass ── */}
      <EndPanel end="front" z0={-FLAT_Z} z1={FLAT_Z} y0={1.12} y1={2.66} material={m.gloss} />
      <EndPanel end="front" z0={-0.95} z1={0.95} y0={1.2} y1={2.38} offset={0.008} depth={0.008} material={m.glass} />

      {/* ── Rear: band + rear window ── */}
      <EndPanel end="rear" z0={-FLAT_Z} z1={FLAT_Z} y0={band.y0} y1={band.y1} material={m.gloss} />
      <EndPanel end="rear" z0={-FLAT_Z} z1={FLAT_Z} y0={stripe.y0} y1={stripe.y1} material={m.trim} />
      <EndPanel end="rear" z0={-0.8} z1={0.8} y0={1.62} y1={2.44} offset={0.008} depth={0.008} material={m.glass} />
    </group>
  );
});
