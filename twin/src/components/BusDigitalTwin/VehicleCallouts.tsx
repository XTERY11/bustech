import { memo, useEffect, useRef, useState } from 'react';
import { Html } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { Callout, CalloutAnchor } from '../../state/presentation';
import { ANCHORS } from './dimensions';
import { CALLOUT_ICONS, IconSpeaker } from './icons';

/**
 * Anchored glass callouts and the announcement indicator.
 * Rendered as DOM (crisp text, cheap) and pinned to body-space anchors so they
 * follow the kneeling body. Cards hide when their component faces away.
 */

const NORMALS: Record<CalloutAnchor | 'speaker', THREE.Vector3> = {
  door: new THREE.Vector3(0, 0, 1),
  ramp: new THREE.Vector3(0, 0, 1),
  display: new THREE.Vector3(-1, 0, 0.25).normalize(),
  speaker: new THREE.Vector3(0, 0.3, 1).normalize(),
};

const tmp = new THREE.Vector3();

/** Fades a DOM node out when the camera is behind the anchor's surface. */
function useFacing(anchor: CalloutAnchor | 'speaker', pos: readonly number[]) {
  const node = useRef<HTMLDivElement>(null);
  const grp = useRef<THREE.Group>(null);
  useFrame(({ camera }) => {
    if (!node.current || !grp.current) return;
    grp.current.getWorldPosition(tmp);
    tmp.subVectors(camera.position, tmp).normalize();
    const facing = tmp.dot(NORMALS[anchor]);
    const o = THREE.MathUtils.clamp((facing + 0.05) / 0.25, 0, 1);
    node.current.style.opacity = String(o);
    node.current.style.visibility = o < 0.02 ? 'hidden' : 'visible';
  });
  return { node, grp, pos };
}

/** Keeps the last callout mounted briefly so it can fade out. */
function useLingering<T extends { key: string; subtitle?: string } | null>(value: T, ms = 320) {
  const [shown, setShown] = useState<{ v: NonNullable<T>; leaving: boolean } | null>(value ? { v: value as NonNullable<T>, leaving: false } : null);
  useEffect(() => {
    if (value) {
      setShown({ v: value as NonNullable<T>, leaving: false });
      return;
    }
    setShown((s) => (s ? { ...s, leaving: true } : s));
    const id = window.setTimeout(() => setShown(null), ms);
    return () => window.clearTimeout(id);
  }, [value?.key, value?.subtitle, ms]); // eslint-disable-line react-hooks/exhaustive-deps
  return shown;
}

function AnchoredCard({ callout, leaving }: { callout: Callout; leaving: boolean }) {
  const pos = ANCHORS[callout.anchor];
  const { node, grp } = useFacing(callout.anchor, pos);
  const Icon = CALLOUT_ICONS[callout.icon];
  return (
    <group ref={grp} position={pos as unknown as [number, number, number]}>
      <Html zIndexRange={[20, 10]} style={{ pointerEvents: 'none' }}>
        <div ref={node} className="twin-anchor">
          <span className={`twin-dot tone-${callout.tone}`} />
          <span className="twin-leader" />
          <div key={callout.key} className={`twin-callout tone-${callout.tone} ${leaving ? 'leaving' : ''}`}>
            <span className="twin-callout-icon">
              <Icon size={15} />
            </span>
            <span className="twin-callout-text">
              <span className="twin-callout-title">{callout.title}</span>
              <span className="twin-callout-sub">{callout.subtitle}</span>
            </span>
          </div>
        </div>
      </Html>
    </group>
  );
}

export const VehicleCallouts = memo(function VehicleCallouts({ primary, secondary }: { primary: Callout | null; secondary: Callout | null }) {
  const a = useLingering(primary);
  const b = useLingering(secondary);
  return (
    <group name="VehicleCallouts">
      {a && <AnchoredCard key={`p-${a.v.anchor}`} callout={a.v} leaving={a.leaving} />}
      {b && <AnchoredCard key={`s-${b.v.anchor}`} callout={b.v} leaving={b.leaving} />}
    </group>
  );
});

export const AnnouncementIndicator = memo(function AnnouncementIndicator({ active }: { active: boolean }) {
  const { node, grp } = useFacing('speaker', ANCHORS.speaker);
  const shown = useLingering(active ? { key: 'ann' } : null, 400);
  if (!shown) return null;
  return (
    <group ref={grp} position={ANCHORS.speaker as unknown as [number, number, number]}>
      <Html center zIndexRange={[20, 10]} style={{ pointerEvents: 'none' }}>
        <div ref={node}>
          <div className={`twin-speaker ${shown.leaving ? 'leaving' : ''}`}>
            <IconSpeaker size={14} />
            <span className="twin-wave">
              <i />
              <i />
              <i />
              <i />
              <i />
            </span>
          </div>
        </div>
      </Html>
    </group>
  );
});
