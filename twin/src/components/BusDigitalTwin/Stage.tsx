import { memo } from 'react';
import { ContactShadows, Environment, Lightformer } from '@react-three/drei';
import { useMemo } from 'react';
import * as THREE from 'three';

/**
 * Studio: procedural softbox environment (no HDR download), one key light,
 * baked-feel contact shadow and a faded floor disc. No shadow maps.
 */
export const Stage = memo(function Stage({ theme }: { theme: 'light' | 'dark' }) {
  const floorMat = useMemo(() => {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d')!;
    // alphaMap reads luminance, so paint an opaque white → black falloff.
    g.fillStyle = '#000';
    g.fillRect(0, 0, 256, 256);
    const grd = g.createRadialGradient(128, 128, 0, 128, 128, 128);
    grd.addColorStop(0, '#fff');
    grd.addColorStop(0.5, '#bbb');
    grd.addColorStop(1, '#000');
    g.fillStyle = grd;
    g.fillRect(0, 0, 256, 256);
    const t = new THREE.CanvasTexture(c);
    return new THREE.MeshBasicMaterial({ alphaMap: t, transparent: true, depthWrite: false, toneMapped: false });
  }, []);
  floorMat.color.set(theme === 'light' ? '#d9dde2' : '#20242a');

  return (
    <>
      <Environment resolution={256} frames={1}>
        <color attach="background" args={['#5c636c']} />
        <Lightformer form="rect" intensity={1.25} position={[0, 7, 0]} rotation-x={Math.PI / 2} scale={[14, 7, 1]} />
        <Lightformer form="rect" intensity={1.6} position={[-9, 2.5, 5]} rotation-y={Math.PI / 2.6} scale={[10, 3, 1]} />
        <Lightformer form="rect" intensity={1.1} position={[9, 2.5, -5]} rotation-y={-Math.PI / 2.6} scale={[10, 3, 1]} />
        <Lightformer form="rect" intensity={0.9} position={[0, 1.5, 10]} scale={[14, 1.4, 1]} />
        <Lightformer form="rect" intensity={0.6} position={[0, 1.5, -10]} rotation-y={Math.PI} scale={[14, 1.4, 1]} />
      </Environment>

      <hemisphereLight args={['#ffffff', theme === 'light' ? '#b9bec5' : '#30343a', 0.55]} />
      <directionalLight position={[-6, 9, 7]} intensity={1.5} color="#fffaf2" />
      <directionalLight position={[7, 4, -6]} intensity={0.35} color="#dfe9ff" />

      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.002, 0.4]} material={floorMat} renderOrder={-1}>
        <circleGeometry args={[13, 64]} />
      </mesh>
      <ContactShadows
        position={[0, 0.012, 0]}
        scale={[13, 8]}
        resolution={512}
        blur={2.2}
        far={3.2}
        opacity={theme === 'light' ? 0.62 : 0.8}
        color="#15181c"
      />
    </>
  );
});
