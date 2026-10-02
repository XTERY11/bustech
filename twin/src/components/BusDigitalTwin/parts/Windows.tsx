import { memo } from 'react';
import { BUS } from '../dimensions';
import { getMaterials } from '../materials';

/** Glazing with open centres: no opaque panels behind the glass. */
export const Windows = memo(function Windows() {
  const m = getMaterials();
  const { windows: w, band, door } = BUS;
  const paneRows = [
    { side: 1, panes: [[-3.56, -2.0], [-0.66, 0.56], [0.62, 1.86], [1.92, 3.10], [3.16, 3.58]] },
    { side: -1, panes: [[-3.56, -2.4], [-2.34, -1.1], [-1.04, 0.2], [0.26, 1.5], [1.56, 2.8], [2.86, 3.58]] },
  ];
  return <group name="Windows">
    {paneRows.map(({ side, panes }) => <group key={side}>
      {panes.map(([a, b]) => <group key={a}>
        <mesh position={[(a + b) / 2, (w.y0 + w.y1) / 2, side * (BUS.sideZ + 0.008)]} material={m.glass}>
          <boxGeometry args={[b - a, w.y1 - w.y0, 0.009]} />
        </mesh>
        {[a - 0.025, b + 0.025].map((x) => <mesh key={x} position={[x, (w.y0 + w.y1) / 2, side * (BUS.sideZ - 0.035)]} material={m.gloss}>
          <boxGeometry args={[0.055, w.y1 - w.y0, 0.10]} />
        </mesh>)}
      </group>)}
      {(side === 1 ? [[BUS.frontX + 0.12, door.x0], [door.x1, BUS.rearX - 0.12]] : [[BUS.frontX + 0.12, BUS.rearX - 0.12]]).map(([a, b]) => <group key={a}>
        {[[band.y0, w.y0], [w.y1, band.y1]].map(([y0, y1]) => <mesh key={y0} position={[(a + b) / 2, (y0 + y1) / 2, side * BUS.sideZ]} material={m.gloss}>
          <boxGeometry args={[b - a, y1 - y0, 0.016]} />
        </mesh>)}
        <mesh position={[(a + b) / 2, 1.235, side * (BUS.sideZ + 0.003)]} material={m.trim}><boxGeometry args={[b - a, 0.07, 0.012]} /></mesh>
      </group>)}
    </group>)}
    {[{ x: BUS.frontX, y0: 1.2, y1: 2.38, width: 1.9 }, { x: BUS.rearX, y0: 1.62, y1: 2.44, width: 1.6 }].map(({ x, y0, y1, width }) => <group key={x}>
      <mesh position={[x, (y0 + y1) / 2, 0]} material={m.glass}><boxGeometry args={[0.014, y1 - y0, width]} /></mesh>
      {[y0 - 0.045, y1 + 0.045].map((y) => <mesh key={y} position={[x, y, 0]} material={m.gloss}><boxGeometry args={[0.022, 0.09, width + 0.12]} /></mesh>)}
      {[-1, 1].map((side) => <mesh key={side} position={[x, (y0 + y1) / 2, side * (width / 2 + 0.04)]} material={m.gloss}><boxGeometry args={[0.025, y1 - y0 + 0.18, 0.08]} /></mesh>)}
    </group>)}
  </group>;
});
