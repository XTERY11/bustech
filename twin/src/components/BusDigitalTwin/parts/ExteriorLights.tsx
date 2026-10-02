import { memo, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { RoundedBox } from '@react-three/drei';
import * as THREE from 'three';
import { BUS } from '../dimensions';
import { getMaterials } from '../materials';
import { useTwin } from '../twinContext';

/**
 * Head/tail lamps, DRLs, amber side markers and camera-mirror pods.
 * Side markers flash while the suspension or ramp is moving — the same cue a
 * real bus gives bystanders.
 */
export const ExteriorLights = memo(function ExteriorLights({ cutaway = false }: { cutaway?: boolean }) {
  const ctx = useTwin();
  const m = getMaterials();
  const drl = useMemo(
    () => new THREE.MeshBasicMaterial({ color: '#f5f9ff', toneMapped: false }),
    [],
  );

  useFrame(() => {
    const ch = ctx.anim.channels;
    const moving = ch.kneelAmount.moving || ch.rampDeployAmount.moving;
    const on = moving && Math.floor(ctx.time.current * 2.4) % 2 === 0;
    m.markerAmber.emissiveIntensity = on ? 3.2 : 0.3;
  });

  const fx = BUS.frontX;
  const rx = BUS.rearX;
  return (
    <group name="ExteriorLights">
      {/* headlamps */}
      {[-1, 1].map((s) => (
        <group key={`h${s}`}>
          <RoundedBox args={[0.04, 0.14, 0.36]} radius={0.018} smoothness={2} position={[fx - 0.006, 0.81, s * 0.76]} material={m.gloss} />
          <mesh position={[fx - 0.028, 0.79, s * 0.76]} rotation={[0, -Math.PI / 2, 0]} material={m.headlight}>
            <planeGeometry args={[0.28, 0.05]} />
          </mesh>
          {/* DRL bar */}
          <mesh position={[fx - 0.028, 0.855, s * 0.76]} rotation={[0, -Math.PI / 2, 0]} material={drl}>
            <planeGeometry args={[0.3, 0.012]} />
          </mesh>
          {/* front indicator */}
          <mesh position={[fx - 0.01, 0.8, s * 1.0]} rotation={[0, -Math.PI / 2, 0]} material={m.markerAmber}>
            <planeGeometry args={[0.06, 0.1]} />
          </mesh>
          {/* tail lamps */}
          <RoundedBox visible={!cutaway} args={[0.04, 0.55, 0.12]} radius={0.015} smoothness={2} position={[rx + 0.005, 0.95, s * 0.93]} material={m.tailLight} />
        </group>
      ))}
      {/* front lower grille + plate */}
      <mesh position={[fx - 0.004, 0.58, 0]} material={m.darkPlastic}>
        <boxGeometry args={[0.01, 0.1, 1.1]} />
      </mesh>
      <mesh position={[fx - 0.03, 0.44, 0]} rotation={[0, -Math.PI / 2, 0]} material={m.trim}>
        <planeGeometry args={[0.52, 0.12]} />
      </mesh>

      {/* amber side markers (both sides) */}
      {[-1, 1].map((s) =>
        [-3.2, -0.2, 1.0, 3.2].map((x) => (
          <mesh key={`${s}${x}`} position={[x, 0.52, s * (BUS.sideZ + 0.004)]} rotation={[0, s > 0 ? 0 : Math.PI, 0]} material={m.markerAmber}>
            <planeGeometry args={[0.1, 0.035]} />
          </mesh>
        )),
      )}

      {/* camera-mirror pods on stalks (front top corners) */}
      {[-1, 1].map((s) => (
        <group key={`c${s}`} visible={!cutaway} position={[fx + 0.12, 2.64, s * (BUS.sideZ + 0.02)]}>
          <mesh position={[0, 0, s * 0.06]} rotation={[Math.PI / 2, 0, 0]} material={m.darkPlastic}>
            <cylinderGeometry args={[0.018, 0.018, 0.14, 10]} />
          </mesh>
          <RoundedBox args={[0.16, 0.1, 0.07]} radius={0.025} smoothness={2} position={[-0.02, -0.02, s * 0.15]} material={m.gloss} />
        </group>
      ))}
    </group>
  );
});
