import * as THREE from 'three';

/**
 * Shared PBR materials. Created once and reused by every part, which keeps
 * draw-state switches low and makes a later GLB swap trivial (the GLB would
 * bring its own materials; the highlight logic only touches the accent ones).
 */

let cache: ReturnType<typeof build> | null = null;

function build() {
  const paint = new THREE.MeshPhysicalMaterial({
    name: 'LimePaint',
    color: '#8bd722',
    roughness: 0.34,
    metalness: 0.0,
    clearcoat: 1,
    clearcoatRoughness: 0.07,
    envMapIntensity: 1.0,
  });

  const gloss = new THREE.MeshPhysicalMaterial({
    name: 'GlossBlack',
    color: '#0c0e11',
    roughness: 0.22,
    metalness: 0.1,
    clearcoat: 1,
    clearcoatRoughness: 0.05,
  });

  const glass = new THREE.MeshPhysicalMaterial({
    name: 'TintedGlass',
    transparent: true, opacity: 0.24, depthWrite: false, side: THREE.DoubleSide,
    color: '#1b2530',
    roughness: 0.04,
    metalness: 0.2,
    clearcoat: 1,
    clearcoatRoughness: 0.02,
    envMapIntensity: 1.4,
  });

  const doorGlass = new THREE.MeshPhysicalMaterial({
    name: 'DoorGlass',
    color: '#2a3642',
    roughness: 0.05,
    metalness: 0.1,
    transparent: true,
    opacity: 0.55,
    envMapIntensity: 1.5,
    depthWrite: false,
  });

  const frame = new THREE.MeshStandardMaterial({ name: 'Frame', color: '#23262b', roughness: 0.45, metalness: 0.5 });
  const trim = new THREE.MeshStandardMaterial({ name: 'Trim', color: '#d9dcdf', roughness: 0.35, metalness: 0.2 });
  const darkPlastic = new THREE.MeshStandardMaterial({ name: 'DarkPlastic', color: '#1d2024', roughness: 0.7 });
  const rubber = new THREE.MeshStandardMaterial({ name: 'Rubber', color: '#141516', roughness: 0.92 });
  const rim = new THREE.MeshStandardMaterial({ name: 'Rim', color: '#c9ccd0', roughness: 0.28, metalness: 0.85 });
  const hub = new THREE.MeshStandardMaterial({ name: 'Hub', color: '#8a8f96', roughness: 0.4, metalness: 0.7 });
  const interior = new THREE.MeshStandardMaterial({ name: 'Interior', color: '#b9bec4', roughness: 0.75, side: THREE.DoubleSide });
  const floor = new THREE.MeshStandardMaterial({ name: 'Floor', color: '#50555c', roughness: 0.85 });
  const wheelWell = new THREE.MeshStandardMaterial({ name: 'WheelWell', color: '#16181b', roughness: 0.95, side: THREE.DoubleSide });
  const safetyYellow = new THREE.MeshStandardMaterial({ name: 'SafetyYellow', color: '#f2c200', roughness: 0.5 });
  const handrail = new THREE.MeshStandardMaterial({ name: 'Handrail', color: '#f2b705', roughness: 0.35, metalness: 0.2 });

  const headlight = new THREE.MeshStandardMaterial({ name: 'Headlight', color: '#f4f6f8', emissive: '#ffffff', emissiveIntensity: 1.2, roughness: 0.15 });
  const tailLight = new THREE.MeshStandardMaterial({ name: 'TailLight', color: '#7a0d0d', emissive: '#ff2a2a', emissiveIntensity: 0.9, roughness: 0.3 });
  const markerAmber = new THREE.MeshStandardMaterial({ name: 'Marker', color: '#a86400', emissive: '#ff9f1a', emissiveIntensity: 0.35, roughness: 0.3 });
  const interiorLight = new THREE.MeshBasicMaterial({ name: 'InteriorLight', color: '#fff6e8', toneMapped: false });

  return {
    paint, gloss, glass, doorGlass, frame, trim, darkPlastic, rubber, rim, hub, interior, floor, wheelWell,
    safetyYellow, handrail, headlight, tailLight, markerAmber, interiorLight,
  };
}

export type BusMaterials = ReturnType<typeof build>;

export function getMaterials(): BusMaterials {
  if (!cache) cache = build();
  return cache;
}

/** Semantic accent colours used for highlights (restrained, HMI-like). */
export const TONE_COLORS = {
  neutral: new THREE.Color('#dfe8f2'),
  progress: new THREE.Color('#ffb03a'),
  ready: new THREE.Color('#34d399'),
  success: new THREE.Color('#7dd87a'),
  access: new THREE.Color('#2f7bf6'),
} as const;
