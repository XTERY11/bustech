import { memo, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { BUS } from '../dimensions';
import { getMaterials } from '../materials';
import { wheelRotationForTravel } from '../../../simulation/arrival';

/** Lathe-profiled tyre + steel rim. Wheels stay planted while the body kneels. */
function useTyreGeometry() {
  return useMemo(() => {
    const { radius: R, width: W } = BUS.wheel;
    const h = W / 2;
    const pts = [
      [0.29, -h], [R - 0.05, -h], [R - 0.012, -h + 0.03], [R, -h + 0.07],
      [R, h - 0.07], [R - 0.012, h - 0.03], [R - 0.05, h], [0.29, h],
    ].map(([x, y]) => new THREE.Vector2(x, y));
    const g = new THREE.LatheGeometry(pts, 56);
    g.rotateX(Math.PI / 2);
    return g;
  }, []);
}

function Wheel({ position, side, travel }: { position: [number, number, number]; side: 1 | -1; travel?: { current: number } }) {
  const m = getMaterials();
  const tyre = useTyreGeometry();
  const face = BUS.wheel.width / 2 - 0.035;
  const wheel = useRef<THREE.Group>(null!);
  useFrame(() => { if (wheel.current) wheel.current.rotation.z = wheelRotationForTravel(travel?.current ?? 0, BUS.wheel.radius); });
  return (
    <group ref={wheel} position={position}>
      <mesh geometry={tyre} material={m.rubber} castShadow />
      {/* rim barrel */}
      <mesh rotation={[Math.PI / 2, 0, 0]} material={m.rim}>
        <cylinderGeometry args={[0.295, 0.295, BUS.wheel.width - 0.05, 40, 1, true]} />
      </mesh>
      <group position={[0, 0, side * face]} rotation={[side > 0 ? 0 : Math.PI, 0, 0]}>
        {/* dished face */}
        <mesh rotation={[Math.PI / 2, 0, 0]} material={m.rim}>
          <cylinderGeometry args={[0.29, 0.26, 0.03, 40]} />
        </mesh>
        {/* vent holes */}
        {Array.from({ length: 8 }).map((_, i) => {
          const a = (i / 8) * Math.PI * 2;
          return (
            <mesh key={i} position={[Math.cos(a) * 0.19, Math.sin(a) * 0.19, 0.018]} material={m.wheelWell}>
              <circleGeometry args={[0.035, 16]} />
            </mesh>
          );
        })}
        {/* hub */}
        <mesh position={[0, 0, 0.03]} rotation={[Math.PI / 2, 0, 0]} material={m.hub}>
          <cylinderGeometry args={[0.1, 0.12, 0.07, 28]} />
        </mesh>
        {Array.from({ length: 8 }).map((_, i) => {
          const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
          return (
            <mesh key={`n${i}`} position={[Math.cos(a) * 0.125, Math.sin(a) * 0.125, 0.03]} rotation={[Math.PI / 2, 0, 0]} material={m.rim}>
              <cylinderGeometry args={[0.013, 0.013, 0.04, 6]} />
            </mesh>
          );
        })}
      </group>
    </group>
  );
}

export const Wheels = memo(function Wheels({ travel }: { travel?: { current: number } }) {
  const { frontX, rearX, radius, trackZ } = BUS.wheel;
  return (
    <group name="Wheels">
      {[frontX, rearX].flatMap((x) =>
        ([1, -1] as const).map((s) => <Wheel key={`${x}${s}`} position={[x, radius, s * trackZ]} side={s} travel={travel} />),
      )}
    </group>
  );
});
