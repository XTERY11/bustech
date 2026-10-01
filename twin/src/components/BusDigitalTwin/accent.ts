import * as THREE from 'three';
import { TONE_COLORS } from './materials';
import type { Tone } from '../../state/presentation';
import { pulse } from './twinContext';

/**
 * Accent light helper: eases a basic material's colour and opacity toward a
 * semantic tone. `null` fades it out. Progress tones breathe; steady tones don't.
 */
export function driveAccent(
  mat: THREE.MeshBasicMaterial,
  tone: Tone | null,
  time: number,
  dt: number,
  maxOpacity = 0.95,
) {
  const k = 1 - Math.exp(-dt * 6);
  if (tone) mat.color.lerp(TONE_COLORS[tone], k);
  const breathe = tone === 'progress' ? 0.55 + 0.45 * pulse(time, 1.1) : 1;
  const target = tone ? maxOpacity * breathe : 0;
  mat.opacity += (target - mat.opacity) * k;
  mat.visible = mat.opacity > 0.01;
}

export function makeAccentMaterial(color = '#ffffff') {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0,
    toneMapped: false,
    depthWrite: false,
  });
}
