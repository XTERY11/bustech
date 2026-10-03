import { memo, useEffect, useMemo } from 'react';
import { RoundedBox } from '@react-three/drei';
import * as THREE from 'three';
import { CABIN, SEATS, type SeatDefinition, type SeatOccupancy } from '../../../data/cabinLayout';
import { BUS } from '../dimensions';
import { getMaterials } from '../materials';
import { useTwin } from '../twinContext';

type Point = [number, number, number];
const COLORS = { blue: '#17617d', red: '#b53949', shell: '#333c43', floor: '#526775', wall: '#d2d7d8', metal: '#aebbc2', yellow: '#efc53e' };

function Block({ at, size, color, radius = 0.025, rotation }: { at: Point; size: Point; color: string; radius?: number; rotation?: Point }) {
  return <RoundedBox position={at} args={size} radius={radius} smoothness={2} rotation={rotation}>
    <meshStandardMaterial color={color} roughness={0.72} />
  </RoundedBox>;
}

function Rail({ from, to, radius = 0.016, color = COLORS.metal }: { from: Point; to: Point; radius?: number; color?: string }) {
  const { middle, quaternion, length } = useMemo(() => {
    const a = new THREE.Vector3(...from), b = new THREE.Vector3(...to);
    return { middle: a.clone().add(b).multiplyScalar(0.5), length: a.distanceTo(b), quaternion: new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.sub(a).normalize()) };
  }, [from.join(','), to.join(',')]);
  return <mesh position={middle} quaternion={quaternion}><cylinderGeometry args={[radius, radius, length, 10]} /><meshStandardMaterial color={color} metalness={0.55} roughness={0.32} /></mesh>;
}

/** Canvas labels keep the model self-contained/offline, including single-file builds. */
function Plaque({ text, at, width = 0.3, height = 0.12, rotation = [0, 0, 0], color = '#f3f6f6', background = '#25333d' }: { text: string; at: Point; width?: number; height?: number; rotation?: Point; color?: string; background?: string }) {
  const texture = useMemo(() => {
    const c = document.createElement('canvas'); c.width = 512; c.height = 192;
    const g = c.getContext('2d')!;
    g.fillStyle = background; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = color; g.font = 'bold 66px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, 256, 98, 490);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }, [text, color, background]);
  useEffect(() => () => texture.dispose(), [texture]);
  return <mesh position={at} rotation={rotation}><planeGeometry args={[width, height]} /><meshBasicMaterial map={texture} side={THREE.DoubleSide} /></mesh>;
}

function Passenger({ index }: { index: number }) {
  const shirt = ['#dba14d', '#507d8d', '#987aa1', '#dde1df', '#63876d'][index % 5];
  const skin = ['#bd8d71', '#e0b998', '#92664e'][index % 3];
  return <group name="SimulatedPassenger" userData={{ simulated: true }}>
    <Block at={[0.015, 0.79, 0]} size={[0.25, 0.43, 0.31]} color={shirt} radius={0.09} />
    <group name="PassengerHead" position={[0, 1.14, 0]} scale={[0.94, 1.1, 0.92]}>
      <mesh><sphereGeometry args={[0.117, 24, 16]} /><meshStandardMaterial color={skin} roughness={0.9} /></mesh>
      {/* A concentric cap follows the scalp; tilt raises the hairline toward the face (-X). */}
      <mesh name="PassengerHair" rotation={[0, 0, -0.20]}>
        <sphereGeometry args={[0.124, 24, 12, 0, Math.PI * 2, 0, 1.5]} />
        <meshStandardMaterial color="#343332" roughness={1} />
      </mesh>
    </group>
    <Rail from={[0, 0.96, 0]} to={[0, 1.07, 0]} radius={0.045} color={skin} />
    {[-1, 1].map((side) => <group key={side}>
      <Rail from={[-0.01, 0.51, side * 0.09]} to={[-0.31, 0.49, side * 0.10]} radius={0.075} color="#334658" />
      <Rail from={[-0.31, 0.49, side * 0.10]} to={[-0.35, 0.10, side * 0.10]} radius={0.054} color="#334658" />
      <Block at={[-0.41, 0.065, side * 0.10]} size={[0.22, 0.10, 0.13]} color="#30353c" radius={0.035} />
      <Rail from={[0.01, 0.92, side * 0.19]} to={[-0.09, 0.67, side * 0.20]} radius={0.052} color={shirt} />
      <Rail from={[-0.09, 0.67, side * 0.20]} to={[-0.26, 0.57, side * 0.12]} radius={0.038} color={skin} />
    </group>)}
    <Block at={[-0.14, 0.59, 0]} size={[0.025, 0.035, 0.33]} color="#20252c" radius={0.008} />
  </group>;
}

const Seat = memo(function Seat({ seat, occupied, selected, labels, index }: { seat: SeatDefinition; occupied: boolean; selected: boolean; labels: boolean; index: number }) {
  const ctx = useTwin();
  const color = seat.kind === 'priority' || seat.kind === 'foldable' ? COLORS.red : COLORS.blue;
  const folded = seat.kind === 'foldable' && !occupied;
  return <group name={`Seat_${seat.id}`} position={seat.position} rotation={[0, seat.rotation, 0]}
    userData={{ seatId: seat.id, occupied, kind: seat.kind, zone: seat.zone }}
    onClick={(event) => { event.stopPropagation(); ctx.emit({ type: 'seatClicked', seatId: seat.id }); }}>
    <Block at={[0.08, 0.22, 0]} size={[0.09, 0.40, 0.29]} color={COLORS.shell} />
    <Block at={[0.04, 0.025, 0]} size={[0.39, 0.045, 0.36]} color={COLORS.shell} radius={0.014} />
    <Block at={[0.19, 0.77, 0]} size={[0.095, 0.65, 0.44]} color={COLORS.shell} radius={0.04} rotation={[0, 0, -0.08]} />
    <Block at={[0.129, 0.78, 0]} size={[0.06, 0.56, 0.395]} color={color} radius={0.029} rotation={[0, 0, -0.08]} />
    <Block at={folded ? [0.07, 0.68, 0] : [-0.03, 0.43, 0]} size={folded ? [0.08, 0.40, 0.42] : [0.44, 0.085, 0.42]} color={color} radius={0.036} />
    <Rail from={[0.20, 1.08, -0.18]} to={[0.20, 1.16, -0.14]} radius={0.019} color={COLORS.shell} />
    <Rail from={[0.20, 1.16, -0.14]} to={[0.20, 1.16, 0.14]} radius={0.019} color={COLORS.shell} />
    <Rail from={[0.20, 1.16, 0.14]} to={[0.20, 1.08, 0.18]} radius={0.019} color={COLORS.shell} />
    {!folded && <Block at={[-0.035, 0.481, 0.05]} size={[0.045, 0.012, 0.32]} color="#262b31" radius={0.005} />}
    <Block at={[-0.01, 0.49, 0.18]} size={[0.055, 0.035, 0.046]} color="#ce5552" radius={0.007} />
    {occupied && <Passenger index={index} />}
    {labels && <Plaque text={seat.id} at={[0.26, 1.20, 0]} rotation={[-Math.PI / 2, 0, -Math.PI / 2]} width={0.25} height={0.14} background={occupied ? '#9b5926' : '#17695e'} />}
    {selected && <mesh position={[-0.02, 0.016, 0]} rotation={[-Math.PI / 2, 0, 0]}><ringGeometry args={[0.30, 0.335, 40]} /><meshBasicMaterial color="#f9c74f" side={THREE.DoubleSide} /></mesh>}
  </group>;
});

export const Interior = memo(function Interior({ occupancy, cutaway, selectedSeatId, destination }: { destination?: string; occupancy?: SeatOccupancy; cutaway: boolean; selectedSeatId?: string }) {
  const m = getMaterials();
  return <group name="CabinInterior">
    <Block at={[0, CABIN.floorY - 0.027, 0]} size={[BUS.length - 0.26, 0.07, BUS.width - 0.24]} color={COLORS.floor} radius={0.012} />
    {/* Two shallow wheel housings at the front; rear housings sit beneath the high deck. */}
    {[-1, 1].map((side) => <group key={side}>
      <Block at={[-2.62, 0.72, side * 0.88]} size={[1.18, 0.72, 0.32]} color={COLORS.wall} radius={0.12} />
      <Block at={[1.55, 0.75, side * 0.87]} size={[1.14, 0.66, 0.36]} color={COLORS.wall} radius={0.06} />
    </group>)}
    <Block at={[(CABIN.rearStartX + BUS.rearX - 0.12) / 2, (CABIN.rearFloorY + CABIN.floorY) / 2, 0]} size={[BUS.rearX - 0.12 - CABIN.rearStartX, CABIN.rearFloorY - CABIN.floorY, 2.04]} color={COLORS.floor} />
    {CABIN.steps.map((x, i) => {
      const height = (i + 1) * 0.21;
      return <group key={x}>
        <Block at={[x + 0.14, CABIN.floorY + height / 2, 0.26]} size={[0.28, height, 0.66]} color={COLORS.floor} radius={0.008} />
        <Block at={[x + 0.027, CABIN.floorY + height + 0.007, 0.26]} size={[0.045, 0.012, 0.66]} color={COLORS.yellow} radius={0.004} />
      </group>;
    })}
    <Plaque text="WATCH YOUR STEP" at={[1.126, 0.48, 0.26]} rotation={[0, -Math.PI / 2, 0]} width={0.49} height={0.09} />
    {/* Rear partitions, stair rails and low-level cabin side panels. */}
    {[-0.48, 0.83].map((z) => <group key={z}>
      <Block at={[1.74, 1.32, z]} size={[0.055, 0.55, 0.37]} color={COLORS.wall} />
      <Rail from={[1.1, 0.70, z > 0 ? 0.63 : -0.1]} to={[1.1, 1.45, z > 0 ? 0.63 : -0.1]} />
      <Rail from={[1.1, 1.45, z > 0 ? 0.63 : -0.1]} to={[1.98, 1.90, z > 0 ? 0.63 : -0.1]} />
    </group>)}
    <Block at={[0, 0.91, -1.025]} size={[3.80, 1.07, 0.035]} color={COLORS.wall} radius={0.012} />
    {!cutaway && <Block at={[1.49, 0.86, 1.025]} size={[4.24, 0.96, 0.035]} color={COLORS.wall} radius={0.012} />}
    {/* Wheelchair bay opposite the entrance, with a rear-facing fold-up seat. */}
    <Plaque text="♿" at={[-1.45, CABIN.floorY + 0.01, -0.53]} rotation={[-Math.PI / 2, 0, -Math.PI / 2]} width={0.69} height={0.66} color={COLORS.yellow} background={COLORS.floor} />
    <Block at={[-0.98, 0.79, -0.59]} size={[0.045, 0.80, 0.88]} color={COLORS.wall} />
    <Rail from={[-0.98, 1.22, -1.0]} to={[-0.98, 1.22, -0.14]} />
    <Rail from={[-2.05, 1.18, -0.99]} to={[-1.03, 1.18, -0.99]} />
    <Block at={[-1.53, 1.06, -1.005]} size={[0.17, 0.21, 0.045]} color="#34393c" />
    {/* Stanchions: brushed metal with yellow grip sleeves, as in the reference. */}
    {[-0.98, 0.54, 1.91].flatMap((x) => [-0.08, 0.60].map((z) => <group key={`${x}:${z}`}>
      <Rail from={[x, x > 1 ? CABIN.rearFloorY : CABIN.floorY, z]} to={[x, 2.52, z]} />
      <Rail from={[x, 1.22, z]} to={[x, 1.59, z]} radius={0.023} color={COLORS.yellow} />
      <Block at={[x - 0.027, 1.22, z]} size={[0.045, 0.09, 0.064]} color={COLORS.yellow} radius={0.017} />
    </group>))}
    {[-0.08, 0.60].map((z) => <group key={z}>
      <Rail from={[-2.05, 2.52, z]} to={[3.40, 2.52, z]} />
      {[-1.7, -0.48, 0.20, 0.90].map((x) => <group key={x}>
        <Rail from={[x, 2.50, z]} to={[x, 2.28, z]} radius={0.012} color="#444c50" />
        <Rail from={[x, 2.28, z]} to={[x - 0.09, 2.13, z]} color="#444c50" />
        <Rail from={[x - 0.09, 2.13, z]} to={[x + 0.09, 2.13, z]} color="#444c50" />
        <Rail from={[x + 0.09, 2.13, z]} to={[x, 2.28, z]} color="#444c50" />
      </group>)}
    </group>)}
    {!cutaway && <group name="Ceiling">
      <Block at={[0, 2.706, 0]} size={[7.22, 0.045, 2.02]} color="#e2e5e4" />
      {[-0.70, 0.70].map((z) => <mesh key={z} position={[0.20, 2.667, z]} material={m.interiorLight}><boxGeometry args={[5.90, 0.02, 0.07]} /></mesh>)}
    </group>}
    {/* Simplified right-hand-drive safety operator cabin and fare reader. */}
    <group name="DriverCabin">
      <Block at={[-3.27, 1.06, -0.43]} size={[0.66, 0.27, 1.12]} color="#424b53" radius={0.075} />
      <Block at={[-2.61, 0.75, -0.61]} size={[0.44, 0.12, 0.47]} color="#313a42" />
      <Block at={[-2.37, 1.05, -0.61]} size={[0.10, 0.62, 0.47]} color="#313a42" />
      <Rail from={[-3.05, 0.66, -0.60]} to={[-2.99, 1.22, -0.60]} radius={0.036} color="#242c32" />
      <mesh position={[-2.98, 1.26, -0.60]} rotation={[0, 0, Math.PI / 3]}><torusGeometry args={[0.16, 0.021, 10, 28]} /><meshStandardMaterial color="#1b2328" /></mesh>
      <Block at={[-2.20, 0.88, -0.56]} size={[0.055, 0.98, 1.0]} color={COLORS.wall} />
      <Plaque text={(destination ?? "NOT IN SERVICE").toUpperCase()} at={[-2.16, 2.16, -0.30]} rotation={[0, Math.PI / 2, 0]} width={1.12} height={0.29} color="#b3e8dd" />
      <Rail from={[-2.09, CABIN.floorY, 0.10]} to={[-2.09, 1.45, 0.10]} />
      <Block at={[-2.07, 1.28, 0.13]} size={[0.20, 0.28, 0.19]} color="#228b9b" />
      <Plaque text="TAP" at={[-1.962, 1.31, 0.13]} rotation={[0, Math.PI / 2, 0]} width={0.14} height={0.13} />
    </group>
    {SEATS.map((seat, index) => <Seat key={seat.id} seat={seat} index={index} occupied={occupancy?.[seat.id] ?? false} selected={selectedSeatId === seat.id} labels={cutaway} />)}
  </group>;
});
