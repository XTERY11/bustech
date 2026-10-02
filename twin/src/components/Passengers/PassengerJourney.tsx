import { memo, useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { PassengerAid, PassengerJourney as PassengerJourneyState } from '../../types/vehicle';
import { buildPassengerPath, journeyStageTarget, samplePassengerPath, type Point3 } from '../../simulation/passengerPath';

type MutableGroup = THREE.Group | null;

function Bar({ from, to, radius = 0.025, color = '#9aa9ad' }: { from: Point3; to: Point3; radius?: number; color?: string }) {
  const { position, quaternion, length } = useMemo(() => {
    const a = new THREE.Vector3(...from), b = new THREE.Vector3(...to);
    return {
      position: a.clone().add(b).multiplyScalar(0.5),
      quaternion: new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize()),
      length: a.distanceTo(b),
    };
  }, [from.join(','), to.join(',')]);
  return <mesh position={position} quaternion={quaternion} castShadow>
    <cylinderGeometry args={[radius, radius, length, 9]} />
    <meshStandardMaterial color={color} metalness={0.2} roughness={0.64} />
  </mesh>;
}

function Limb({ side, kind, limbRef }: { side: -1 | 1; kind: 'arm' | 'leg'; limbRef: React.MutableRefObject<MutableGroup> }) {
  const arm = kind === 'arm';
  const x = side * (arm ? 0.21 : 0.105);
  const y = arm ? 1.16 : 0.76;
  const length = arm ? 0.48 : 0.7;
  const color = arm ? '#c98767' : '#24445c';
  return <group ref={limbRef} position={[x, y, 0]}>
    <mesh position={[0, -length / 2, 0]} castShadow>
      <capsuleGeometry args={[arm ? 0.055 : 0.07, length - (arm ? 0.11 : 0.14), 5, 9]} />
      <meshStandardMaterial color={color} roughness={0.83} />
    </mesh>
    {!arm && <mesh position={[0, -length + 0.035, 0.075]} castShadow>
      <boxGeometry args={[0.15, 0.09, 0.27]} />
      <meshStandardMaterial color="#263039" roughness={0.9} />
    </mesh>}
  </group>;
}

function MobilityAid({ aid }: { aid: PassengerAid }) {
  if (aid === 'cane' || aid === 'visual') {
    const color = aid === 'visual' ? '#f4f5ed' : '#71523d';
    return <group position={[0.28, 0, 0.04]} rotation={[0.14, 0, -0.12]}>
      <Bar from={[0, 0.04, 0.12]} to={[0, 1.03, 0]} radius={0.018} color={color} />
      <Bar from={[0, 1.02, 0]} to={[-0.08, 1.10, 0]} radius={0.018} color={color} />
      {aid === 'visual' && <mesh position={[0, 0.29, 0.08]}><cylinderGeometry args={[0.021, 0.021, 0.33, 8]} /><meshStandardMaterial color="#d64545" /></mesh>}
    </group>;
  }
  if (aid === 'crutch') return <group>
    {[-1, 1].map((side) => <group key={side} position={[side * 0.29, 0, 0.02]} rotation={[0.08, 0, side * -0.08]}>
      <Bar from={[0, 0.04, 0.12]} to={[0, 1.20, 0]} radius={0.018} />
      <Bar from={[-0.09, 1.09, 0]} to={[0.09, 1.09, 0]} radius={0.027} color="#5d6c70" />
      <Bar from={[-0.065, 0.75, 0]} to={[0.065, 0.75, 0]} radius={0.018} color="#30393d" />
    </group>)}
  </group>;
  if (aid === 'walker') return <group position={[0, 0, 0.42]}>
    {[-1, 1].map((side) => <group key={side}>
      <Bar from={[side * 0.34, 0.04, -0.22]} to={[side * 0.34, 0.91, -0.22]} />
      <Bar from={[side * 0.34, 0.04, 0.24]} to={[side * 0.34, 0.91, 0.24]} />
      <Bar from={[side * 0.34, 0.88, -0.22]} to={[side * 0.34, 0.88, 0.24]} />
    </group>)}
    <Bar from={[-0.34, 0.88, 0.24]} to={[0.34, 0.88, 0.24]} />
  </group>;
  if (aid === 'stroller') return <group position={[0, 0, 0.62]}>
    {[-1, 1].flatMap((side) => [-1, 1].map((front) => <mesh key={`${side}:${front}`} position={[side * 0.24, 0.15, front * 0.23]} rotation={[0, Math.PI / 2, 0]}>
      <torusGeometry args={[0.105, 0.026, 8, 18]} /><meshStandardMaterial color="#2d353c" roughness={0.75} />
    </mesh>))}
    <Bar from={[-0.23, 0.17, -0.2]} to={[0.23, 0.17, 0.2]} radius={0.025} color="#4f626a" />
    <Bar from={[0, 0.18, -0.2]} to={[0, 0.78, 0.24]} radius={0.028} color="#4f626a" />
    <mesh position={[0, 0.55, 0.08]} rotation={[-0.25, 0, 0]} castShadow>
      <boxGeometry args={[0.48, 0.24, 0.55]} /><meshStandardMaterial color="#3f7f78" roughness={0.82} />
    </mesh>
    <Bar from={[-0.25, 0.93, 0.13]} to={[0.25, 0.93, 0.13]} radius={0.035} color="#27343a" />
  </group>;
  return null;
}

function WalkingPassenger({ aid, moving }: { aid: PassengerAid; moving: boolean }) {
  const leftArm = useRef<MutableGroup>(null), rightArm = useRef<MutableGroup>(null);
  const leftLeg = useRef<MutableGroup>(null), rightLeg = useRef<MutableGroup>(null);
  const body = useRef<THREE.Group>(null);

  useFrame(({ clock }) => {
    const swing = moving ? Math.sin(clock.elapsedTime * 7.2) * 0.38 : 0;
    if (leftArm.current) leftArm.current.rotation.x = swing;
    if (rightArm.current) rightArm.current.rotation.x = -swing;
    if (leftLeg.current) leftLeg.current.rotation.x = -swing * 0.72;
    if (rightLeg.current) rightLeg.current.rotation.x = swing * 0.72;
    if (body.current) body.current.position.y = moving ? Math.abs(Math.sin(clock.elapsedTime * 7.2)) * 0.025 : 0;
  });

  return <group ref={body} name={`Passenger_${aid}`}>
    <mesh position={[0, 1.43, 0]} castShadow><sphereGeometry args={[0.145, 16, 12]} /><meshStandardMaterial color="#c98767" roughness={0.88} /></mesh>
    <mesh position={[0, 1.08, 0]} castShadow><capsuleGeometry args={[0.19, 0.43, 6, 12]} /><meshStandardMaterial color="#e0a946" roughness={0.8} /></mesh>
    <Limb side={-1} kind="arm" limbRef={leftArm} /><Limb side={1} kind="arm" limbRef={rightArm} />
    <Limb side={-1} kind="leg" limbRef={leftLeg} /><Limb side={1} kind="leg" limbRef={rightLeg} />
    <MobilityAid aid={aid} />
    {aid === 'hearing' && <group>
      {[-1, 1].map((side) => <mesh key={side} position={[side * 0.137, 1.44, 0]}><sphereGeometry args={[0.029, 10, 8]} /><meshStandardMaterial color="#43d3d0" emissive="#198e92" emissiveIntensity={1.4} /></mesh>)}
    </group>}
  </group>;
}

function WheelchairPassenger({ moving }: { moving: boolean }) {
  const body = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    if (body.current) body.current.position.y = moving ? Math.sin(clock.elapsedTime * 5.2) * 0.008 : 0;
  });
  return <group ref={body} name="Passenger_wheelchair">
    {[-1, 1].map((side) => <mesh key={side} position={[side * 0.34, 0.34, -0.02]} rotation={[0, Math.PI / 2, 0]} castShadow>
      <torusGeometry args={[0.31, 0.038, 10, 30]} /><meshStandardMaterial color="#252d33" metalness={0.25} roughness={0.62} />
    </mesh>)}
    <Bar from={[-0.29, 0.36, -0.08]} to={[0.29, 0.36, -0.08]} radius={0.03} color="#6c7b80" />
    <Bar from={[-0.28, 0.28, -0.13]} to={[-0.28, 0.84, -0.20]} radius={0.025} color="#6c7b80" />
    <Bar from={[0.28, 0.28, -0.13]} to={[0.28, 0.84, -0.20]} radius={0.025} color="#6c7b80" />
    <mesh position={[0, 0.53, -0.05]} castShadow><boxGeometry args={[0.54, 0.08, 0.46]} /><meshStandardMaterial color="#315d78" roughness={0.8} /></mesh>
    <mesh position={[0, 0.89, -0.19]} rotation={[-0.1, 0, 0]} castShadow><boxGeometry args={[0.54, 0.67, 0.08]} /><meshStandardMaterial color="#315d78" roughness={0.8} /></mesh>
    <mesh position={[0, 1.15, -0.03]} castShadow><capsuleGeometry args={[0.18, 0.35, 6, 12]} /><meshStandardMaterial color="#e0a946" roughness={0.82} /></mesh>
    <mesh position={[0, 1.52, -0.04]} castShadow><sphereGeometry args={[0.145, 16, 12]} /><meshStandardMaterial color="#c98767" roughness={0.88} /></mesh>
  </group>;
}

function GuidancePath({ path, active, cutaway }: { path: readonly Point3[]; active: boolean; cutaway: boolean }) {
  const invalidate = useThree((state) => state.invalidate);
  const marker = useRef<THREE.Mesh>(null);
  const geometry = useMemo(() => new THREE.BufferGeometry().setFromPoints(path.map((point) => new THREE.Vector3(point[0], point[1] + 0.032, point[2]))), [path]);
  const material = useMemo(() => new THREE.LineBasicMaterial({ color: '#38e0a1', transparent: true, opacity: 0.76, depthWrite: false }), []);
  const line = useMemo(() => {
    const next = new THREE.Line(geometry, material);
    next.renderOrder = 4;
    return next;
  }, [geometry, material]);

  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => () => material.dispose(), [material]);
  useFrame(({ clock }) => {
    if (!active) return;
    material.opacity = (cutaway ? 0.82 : 0.62) + Math.sin(clock.elapsedTime * 4.5) * 0.14;
    const sample = samplePassengerPath(path, (clock.elapsedTime * 0.18) % 1);
    marker.current?.position.set(sample.position[0], sample.position[1] + 0.055, sample.position[2]);
    invalidate();
  });

  if (!active) return null;
  return <group name="PassengerGuidancePath">
    <primitive object={line} />
    <mesh ref={marker} renderOrder={5}>
      <sphereGeometry args={[0.055, 12, 8]} />
      <meshBasicMaterial color="#6bffd0" transparent opacity={0.92} depthWrite={false} />
    </mesh>
  </group>;
}

/** Presentation-only passenger motion driven by the optional telemetry state. */
export const PassengerJourneyActor = memo(function PassengerJourneyActor({ journey, cutaway }: { journey?: PassengerJourneyState | null; cutaway: boolean }) {
  const actor = useRef<THREE.Group>(null);
  const invalidate = useThree((state) => state.invalidate);
  const progress = useRef(0);
  const previousJourney = useRef<string>();
  const path = useMemo(() => journey ? buildPassengerPath(journey.destination) : null, [journey?.journeyId, journey?.destination.type, journey?.destination.id]);

  useEffect(() => {
    if (!journey) return;
    if (previousJourney.current !== journey.journeyId) {
      previousJourney.current = journey.journeyId;
      // A new preview always begins outside the bus instead of jumping to the
      // host's first target. Later frames keep the current interpolated value.
      progress.current = journey.stage === 'boarding' ? 0 : journey.progress ?? 0;
    }
    invalidate();
  }, [journey, invalidate]);

  const seatHandoff = journey?.destination.type === 'SEAT' && (journey.stage === 'seated' || journey.stage === 'secured');
  const visible = !!journey && journey.stage !== 'hidden' && !seatHandoff;
  const guiding = !!journey && (journey.stage === 'boarding' || journey.stage === 'navigating');

  useFrame((_, delta) => {
    if (!journey || !path || !actor.current) return;
    const target = journey.progress ?? journeyStageTarget(journey.stage);
    const difference = target - progress.current;
    // Normalised path units per second. These intentionally favour legibility
    // over realism so judges can follow the route and seat hand-off.
    const speed = journey.aid === 'wheelchair' ? 0.1 : 0.12;
    if (Math.abs(difference) > 0.0005) {
      progress.current += Math.sign(difference) * Math.min(Math.abs(difference), speed * Math.min(delta, 0.1));
      invalidate();
    }
    const sample = samplePassengerPath(path, progress.current);
    actor.current.position.set(...sample.position);
    actor.current.rotation.y = Math.atan2(sample.tangent[0], sample.tangent[2]);
    actor.current.visible = visible;
    if (guiding) invalidate();
  });

  if (!journey || !path) return null;
  return <group name="PassengerJourney">
    <GuidancePath path={path} active={guiding} cutaway={cutaway} />
    <group ref={actor} visible={visible} userData={{ simulated: true, journeyId: journey.journeyId, destination: journey.destination }}>
      {journey.aid === 'wheelchair'
        ? <WheelchairPassenger moving={guiding} />
        : <WalkingPassenger aid={journey.aid} moving={guiding} />}
    </group>
  </group>;
});
