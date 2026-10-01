import { memo, useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { BUS } from './dimensions';
import { parseDestination } from '../../state/presentation';
import { useTwin } from './twinContext';

/**
 * Destination sign (front + kerb side), rendered to one shared CanvasTexture.
 * The texture is redrawn only when `destination` changes; a short brightness
 * flash marks the update.
 */

const CW = 1024;
const CH = 128;

function drawSign(canvas: HTMLCanvasElement, destination?: string) {
  const g = canvas.getContext('2d')!;
  const { route, text } = parseDestination(destination);
  g.fillStyle = '#050607';
  g.fillRect(0, 0, CW, CH);

  const amber = '#ffb21e';
  g.fillStyle = amber;
  g.shadowColor = 'rgba(255,160,20,0.85)';
  g.shadowBlur = 10;
  g.textBaseline = 'middle';

  let x = 28;
  if (route) {
    g.font = '800 92px "Helvetica Neue", Arial, sans-serif';
    const rw = g.measureText(route).width;
    g.fillText(route, x, CH / 2 + 4);
    x += rw + 34;
    g.fillRect(x - 17, 18, 4, CH - 36);
    x += 6;
  }
  // Fit destination text in the remaining width.
  let size = 78;
  const maxW = CW - x - 24;
  do {
    g.font = `700 ${size}px "Helvetica Neue", Arial, sans-serif`;
    size -= 2;
  } while (g.measureText(text).width > maxW && size > 30);
  g.fillText(text, x, CH / 2 + 4);

  // LED dot-matrix mask.
  g.shadowBlur = 0;
  g.fillStyle = 'rgba(5,6,7,0.55)';
  for (let yy = 0; yy < CH; yy += 5) g.fillRect(0, yy, CW, 1.6);
  for (let xx = 0; xx < CW; xx += 5) g.fillRect(xx, 0, 1.6, CH);
}

export const DestinationDisplay = memo(function DestinationDisplay({ destination }: { destination?: string }) {
  const ctx = useTwin();
  const invalidate = useThree((s) => s.invalidate);
  const { texture, canvas } = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = CW;
    canvas.height = CH;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
    return { texture, canvas };
  }, []);
  const mat = useMemo(() => new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }), [texture]);

  useEffect(() => {
    drawSign(canvas, destination);
    texture.needsUpdate = true;
    invalidate();
  }, [destination, canvas, texture, invalidate]);

  useFrame(() => {
    const since = (performance.now() - ctx.destinationChangedAt.current) / 1000;
    const flash = since < 3 ? Math.max(0, 1 - since / 3) * (0.6 + 0.4 * Math.cos(since * 9)) : 0;
    mat.color.setScalar(0.92 + flash * 0.9);
  });

  const onClick = (e: { stopPropagation(): void }) => {
    e.stopPropagation();
    ctx.emit({ type: 'componentClicked', component: 'destinationDisplay' });
  };

  return (
    <group name="DestinationDisplay" onClick={onClick}>
      <mesh position={[BUS.frontX - 0.011, 2.535, 0]} rotation={[0, -Math.PI / 2, 0]} material={mat}>
        <planeGeometry args={[1.56, 0.19]} />
      </mesh>
      <mesh position={[-2.75, 2.355, BUS.sideZ + 0.011]} material={mat}>
        <planeGeometry args={[1.4, 0.17]} />
      </mesh>
    </group>
  );
});
