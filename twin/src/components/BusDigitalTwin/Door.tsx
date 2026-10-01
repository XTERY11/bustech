import { memo, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { BUS, DOOR_CENTER_X, DOOR_WIDTH } from './dimensions';
import { getMaterials } from './materials';
import { smoothstep, useTwin } from './twinContext';
import { driveAccent, makeAccentMaterial } from './accent';

/**
 * FrontDoor — a two-leaf outward plug-sliding door.
 *
 * doorOpenAmount 0 → 1 maps to two overlapping phases:
 *   0.00–0.30  leaves swing out of the aperture (plug)
 *   0.22–1.00  leaves slide apart along the body side
 * Because the leaves are clear of the skin before they slide, they never cut
 * through the bodywork; reversing mid-way retraces the exact same path.
 */

const LEAF_W = DOOR_WIDTH / 2;
const LEAF_H = BUS.door.y1 - BUS.door.y0;
const LEAF_T = 0.035;
const CLOSED_Z = BUS.sideZ + 0.022;
const PLUG_OUT = 0.1;
const SLIDE = LEAF_W - 0.03;

function DoorLeaf({ name, hingeSide }: { name: string; hingeSide: -1 | 1 }) {
  const m = getMaterials();
  const bar = 0.055;
  const midY = -LEAF_H / 2 + 0.78; // lower rail height
  return (
    <group name={name}>
      {/* glass */}
      <mesh material={m.doorGlass} renderOrder={2}>
        <boxGeometry args={[LEAF_W - 0.04, LEAF_H - 0.04, 0.012]} />
      </mesh>
      {/* frame */}
      <mesh position={[0, LEAF_H / 2 - bar / 2, 0]} material={m.frame} castShadow>
        <boxGeometry args={[LEAF_W, bar, LEAF_T]} />
      </mesh>
      <mesh position={[0, -LEAF_H / 2 + bar / 2, 0]} material={m.frame}>
        <boxGeometry args={[LEAF_W, bar, LEAF_T]} />
      </mesh>
      <mesh position={[0, midY, 0]} material={m.frame}>
        <boxGeometry args={[LEAF_W, bar * 0.8, LEAF_T]} />
      </mesh>
      {[-1, 1].map((s) => (
        <mesh key={s} position={[(s * (LEAF_W - bar)) / 2, 0, 0]} material={m.frame} castShadow>
          <boxGeometry args={[bar, LEAF_H, LEAF_T]} />
        </mesh>
      ))}
      {/* rubber seal on the meeting edge */}
      <mesh position={[(-hingeSide * LEAF_W) / 2, 0, 0.004]} material={m.rubber}>
        <boxGeometry args={[0.02, LEAF_H - 0.02, LEAF_T + 0.004]} />
      </mesh>
      {/* grab handle */}
      <mesh position={[(-hingeSide * (LEAF_W - 0.16)) / 2, -0.05, LEAF_T / 2 + 0.02]} material={m.rim}>
        <boxGeometry args={[0.022, 0.5, 0.022]} />
      </mesh>
    </group>
  );
}

export const FrontDoor = memo(function FrontDoor() {
  const ctx = useTwin();
  const a = useRef<THREE.Group>(null!);
  const b = useRef<THREE.Group>(null!);
  const portal = useMemo(() => makeAccentMaterial(), []);

  useFrame((_, dt) => {
    const d = ctx.anim.values.doorOpenAmount;
    const plug = smoothstep(0, 0.3, d);
    const slide = smoothstep(0.22, 1, d);
    const z = CLOSED_Z + plug * PLUG_OUT;
    a.current.position.set(DOOR_CENTER_X - LEAF_W / 2 - slide * SLIDE, BUS.door.y0 + LEAF_H / 2, z);
    b.current.position.set(DOOR_CENTER_X + LEAF_W / 2 + slide * SLIDE, BUS.door.y0 + LEAF_H / 2, z);

    const pres = ctx.presentation.current;
    driveAccent(portal, pres.highlights.door ?? (d > 0.02 ? 'neutral' : null), ctx.time.current, dt);
  });

  const { x0, x1, y0, y1 } = BUS.door;
  const zP = BUS.sideZ + 0.009;
  const s = 0.028;

  return (
    <group
      name="FrontDoor"
      onClick={(e) => {
        e.stopPropagation();
        ctx.emit({ type: 'componentClicked', component: 'door' });
      }}
    >
      <group ref={a}>
        <DoorLeaf name="DoorLeafA" hingeSide={-1} />
      </group>
      <group ref={b}>
        <DoorLeaf name="DoorLeafB" hingeSide={1} />
      </group>
      {/* Portal light strip — the door's highlight channel */}
      <group name="DoorPortalLight">
        <mesh position={[x0 - s / 2 - 0.012, (y0 + y1) / 2 + s / 2, zP]} material={portal}>
          <planeGeometry args={[s, y1 - y0 + s]} />
        </mesh>
        <mesh position={[x1 + s / 2 + 0.012, (y0 + y1) / 2 + s / 2, zP]} material={portal}>
          <planeGeometry args={[s, y1 - y0 + s]} />
        </mesh>
        <mesh position={[(x0 + x1) / 2, y1 + s / 2 + 0.012, zP]} material={portal}>
          <planeGeometry args={[x1 - x0 + 2 * s + 0.024, s]} />
        </mesh>
      </group>
    </group>
  );
});
