import { memo, useMemo } from 'react';
import { RoundedBox } from '@react-three/drei';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { Brush, Evaluator, SUBTRACTION } from 'three-bvh-csg';
import { BUS, DOOR_CENTER_X, DOOR_WIDTH } from '../dimensions';
import { getMaterials } from '../materials';

/**
 * Main body shell: a rounded box with the door vestibule and four wheel wells
 * carved out by CSG (computed once). The cut faces get their own materials,
 * so the doorway reads as a real opening with an interior behind it.
 */
function buildShell() {
  const m = getMaterials();
  const ev = new Evaluator();
  ev.useGroups = true;

  const body = new Brush(
    new RoundedBoxGeometry(BUS.length, BUS.height, BUS.width, 5, BUS.cornerRadius),
    m.paint,
  );
  body.position.set(0, (BUS.bottom + BUS.top) / 2, 0);
  body.updateMatrixWorld();

  // Door vestibule pocket.
  const pocketDepth = BUS.door.pocketDepth;
  const pocketH = BUS.door.y1 - BUS.floorY;
  const pocket = new Brush(new THREE.BoxGeometry(DOOR_WIDTH, pocketH, pocketDepth + 0.2), m.interior);
  pocket.position.set(DOOR_CENTER_X, BUS.floorY + pocketH / 2, BUS.sideZ - pocketDepth / 2 + 0.1);
  pocket.updateMatrixWorld();

  let result = ev.evaluate(body, pocket, SUBTRACTION);

  // Wheel wells, both sides.
  const { wheel } = BUS;
  for (const x of [wheel.frontX, wheel.rearX]) {
    for (const side of [1, -1]) {
      const g = new THREE.CylinderGeometry(wheel.wellRadius, wheel.wellRadius, 0.62, 40);
      g.rotateX(Math.PI / 2);
      const well = new Brush(g, m.wheelWell);
      well.position.set(x, wheel.radius, side * (BUS.sideZ - 0.2));
      well.updateMatrixWorld();
      result = ev.evaluate(result, well, SUBTRACTION);
    }
  }
  result.castShadow = true;
  result.name = 'BodyShell';
  return result;
}

export const Body = memo(function Body() {
  const shell = useMemo(buildShell, []);
  const m = getMaterials();
  const pod = BUS.roofPod;

  return (
    <group name="Body">
      <primitive object={shell} />

      {/* Roof battery / HVAC pod */}
      <RoundedBox position={[pod.x, BUS.top + pod.height / 2 - 0.06, 0]} material={m.paint} args={[pod.length, pod.height, pod.width]} smoothness={4} radius={0.09} />
      {/* Front sensor domes */}
      {[-0.72, 0.72].map((z) => (
        <mesh key={z} position={[BUS.frontX + 0.32, BUS.top + 0.02, z]} material={m.gloss}>
          <sphereGeometry args={[0.055, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2]} />
        </mesh>
      ))}
      {/* Roof lidar puck */}
      <mesh position={[BUS.frontX + 1.05, BUS.top + 0.06, 0]} material={m.darkPlastic}>
        <cylinderGeometry args={[0.1, 0.11, 0.12, 28]} />
      </mesh>
      {/* Bumpers */}
      <RoundedBox position={[BUS.frontX + 0.05, 0.36, 0]} material={m.darkPlastic} args={[0.22, 0.2, BUS.width - 0.06]} smoothness={3} radius={0.06} />
      <RoundedBox position={[BUS.rearX - 0.05, 0.36, 0]} material={m.darkPlastic} args={[0.22, 0.2, BUS.width - 0.06]} smoothness={3} radius={0.06} />

      {/* Side battery vents (rear, both sides) */}
      {[1, -1].map((s) => (
        <mesh key={s} position={[2.75, 0.72, s * (BUS.sideZ + 0.004)]} rotation={[0, s > 0 ? 0 : Math.PI, 0]}>
          <planeGeometry args={[0.95, 0.42]} />
          <meshStandardMaterial color="#6fb81a" roughness={0.65} />
        </mesh>
      ))}

      <DoorVestibule />
    </group>
  );
});

/** Interior details visible through the open door. */
function DoorVestibule() {
  const m = getMaterials();
  const d = BUS.door;
  const zIn = BUS.sideZ - d.pocketDepth;
  return (
    <group name="DoorVestibule">
      {/* Anti-slip floor */}
      <mesh position={[DOOR_CENTER_X, BUS.floorY + 0.004, BUS.sideZ - d.pocketDepth / 2]} rotation={[-Math.PI / 2, 0, 0]} material={m.floor}>
        <planeGeometry args={[DOOR_WIDTH - 0.01, d.pocketDepth - 0.01]} />
      </mesh>
      {/* Yellow threshold edge */}
      <mesh position={[DOOR_CENTER_X, BUS.floorY + 0.006, BUS.sideZ - 0.035]} rotation={[-Math.PI / 2, 0, 0]} material={m.safetyYellow}>
        <planeGeometry args={[DOOR_WIDTH - 0.01, 0.06]} />
      </mesh>
      {/* Ceiling light */}
      <mesh position={[DOOR_CENTER_X, d.y1 - 0.004, BUS.sideZ - d.pocketDepth / 2]} rotation={[Math.PI / 2, 0, 0]} material={m.interiorLight}>
        <planeGeometry args={[DOOR_WIDTH - 0.3, 0.1]} />
      </mesh>
      {/* Grab poles */}
      {[d.x0 + 0.1, d.x1 - 0.1].map((x) => (
        <mesh key={x} position={[x, (BUS.floorY + d.y1) / 2, zIn + 0.12]} material={m.handrail}>
          <cylinderGeometry args={[0.018, 0.018, d.y1 - BUS.floorY, 12]} />
        </mesh>
      ))}
      {/* Ramp slot below the doorway */}
      <mesh position={[DOOR_CENTER_X, 0.318, BUS.sideZ + 0.003]} material={m.darkPlastic}>
        <boxGeometry args={[BUS.ramp.width + 0.06, 0.06, 0.006]} />
      </mesh>
    </group>
  );
}
