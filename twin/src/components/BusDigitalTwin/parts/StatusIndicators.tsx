import { memo, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { BUS, DOOR_CENTER_X } from '../dimensions';
import { TONE_COLORS } from '../materials';
import { pulse, useTwin } from '../twinContext';
import { driveAccent } from '../accent';

/**
 * Non-mechanical status cues:
 *  • AccessibilityIndicator — lit ISA pictogram beside the door (on the body)
 *  • GroundCues — entrance halo + boarding path projected on the ground (world)
 */

function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function drawISA(g: CanvasRenderingContext2D) {
  const s = 128;
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.roundRect(0, 0, s, s, 18);
  g.fill();
  g.fillStyle = '#1f6fe5';
  g.beginPath();
  g.roundRect(6, 6, s - 12, s - 12, 14);
  g.fill();
  g.strokeStyle = '#fff';
  g.fillStyle = '#fff';
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.lineWidth = 9;
  g.beginPath();
  g.arc(56, 26, 9, 0, Math.PI * 2);
  g.fill();
  g.beginPath();
  g.moveTo(54, 42);
  g.lineTo(56, 70);
  g.lineTo(80, 70);
  g.lineTo(92, 96);
  g.stroke();
  g.beginPath();
  g.moveTo(55, 54);
  g.lineTo(74, 54);
  g.stroke();
  g.beginPath();
  g.arc(56, 82, 23, Math.PI * 0.2, Math.PI * 1.45);
  g.stroke();
}

export const AccessibilityIndicator = memo(function AccessibilityIndicator() {
  const ctx = useTwin();
  const mat = useMemo(
    () => new THREE.MeshBasicMaterial({ map: canvasTexture(128, 128, drawISA), toneMapped: false }),
    [],
  );
  const level = useRef(0);
  useFrame((_, dt) => {
    const on = ctx.presentation.current.accessibilityIndicator;
    level.current += ((on ? 1 : 0) - level.current) * (1 - Math.exp(-dt * 5));
    const b = 0.42 + level.current * (0.75 + 0.25 * pulse(ctx.time.current, 0.5));
    mat.color.setScalar(b);
  });
  return (
    <mesh name="AccessibilityIndicator" position={[DOOR_CENTER_X, (BUS.door.y1 + BUS.band.y1) / 2 + 0.012, BUS.sideZ + 0.008]} material={mat}>
      <planeGeometry args={[0.15, 0.15]} />
    </mesh>
  );
});

export const GroundCues = memo(function GroundCues() {
  const ctx = useTwin();

  const halo = useMemo(() => {
    const tex = canvasTexture(256, 256, (g) => {
      const grd = g.createRadialGradient(128, 128, 0, 128, 128, 128);
      grd.addColorStop(0, 'rgba(255,255,255,0.9)');
      grd.addColorStop(0.45, 'rgba(255,255,255,0.35)');
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd;
      g.fillRect(0, 0, 256, 256);
    });
    return new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0, depthWrite: false, toneMapped: false });
  }, []);

  const path = useMemo(() => {
    const map = canvasTexture(128, 128, (g) => {
      g.clearRect(0, 0, 128, 128);
      g.strokeStyle = '#fff';
      g.lineWidth = 10;
      g.lineCap = 'round';
      g.lineJoin = 'round';
      g.beginPath();
      g.moveTo(34, 84);
      g.lineTo(64, 50);
      g.lineTo(94, 84);
      g.stroke();
      g.fillStyle = 'rgba(255,255,255,0.9)';
      g.fillRect(0, 0, 5, 128);
      g.fillRect(123, 0, 5, 128);
    });
    map.wrapT = THREE.RepeatWrapping;
    map.repeat.set(1, 3);
    const alpha = canvasTexture(8, 128, (g) => {
      const grd = g.createLinearGradient(0, 0, 0, 128);
      grd.addColorStop(0, '#fff');
      grd.addColorStop(0.55, '#aaa');
      grd.addColorStop(1, '#000');
      g.fillStyle = grd;
      g.fillRect(0, 0, 8, 128);
    });
    alpha.colorSpace = THREE.NoColorSpace;
    return new THREE.MeshBasicMaterial({
      map,
      alphaMap: alpha,
      color: TONE_COLORS.ready,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      toneMapped: false,
    });
  }, []);

  const pathLen = 1.7;

  useFrame((_, dt) => {
    const p = ctx.presentation.current;
    driveAccent(halo, p.entranceHalo, ctx.time.current, dt, 0.55);
    const mode = p.path;
    driveAccent(path, mode === 'off' ? null : 'ready', ctx.time.current, dt, mode === 'boarding' ? 0.85 : 0.6);
    // Chevrons drift toward the door while boarding.
    const map = path.map!;
    if (mode === 'boarding') map.offset.y = (map.offset.y - dt * 0.9) % 1;
  });

  const zRampEnd = BUS.sideZ + BUS.ramp.length + 0.02;
  return (
    <group name="GroundCues">
      <mesh position={[DOOR_CENTER_X, 0.004, BUS.sideZ + 0.55]} rotation={[-Math.PI / 2, 0, 0]} material={halo} renderOrder={1}>
        <planeGeometry args={[2.6, 1.6]} />
      </mesh>
      <mesh position={[DOOR_CENTER_X, 0.006, zRampEnd + pathLen / 2]} rotation={[-Math.PI / 2, 0, 0]} material={path} renderOrder={2}>
        <planeGeometry args={[BUS.ramp.width, pathLen]} />
      </mesh>
    </group>
  );
});
