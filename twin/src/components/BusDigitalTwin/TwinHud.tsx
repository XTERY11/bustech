import { memo } from 'react';
import type { VehicleState } from '../../types/vehicle';
import type { Presentation } from '../../state/presentation';
import { IconAccessible, IconSpeaker } from './icons';

/**
 * Restrained DOM overlay inside the viewer:
 *   top-left   compact status chips + boarding sequence (only while assisting)
 *   bottom     passenger information / announcement bar
 */
export const TwinHud = memo(function TwinHud({ state, presentation }: { state: VehicleState; presentation: Presentation }) {
  const assisting = state.boardingStatus !== 'idle';
  const ann = state.announcement;
  const info = state.passengerInfo;
  const showBar = !!ann?.active || !!info?.title || !!info?.message;

  const chip = (label: string, value: string, live: boolean) => (
    <span className={`twin-chip ${live ? 'live' : ''}`}>
      <span className="k">{label}</span>
      <span className="v">{value}</span>
    </span>
  );

  return (
    <>
      <div className="twin-hud-tl">
        <div className="twin-chips">
          {chip('Door', cap(state.door), state.door !== 'closed')}
          {chip('Ramp', cap(state.ramp), state.ramp !== 'retracted')}
          {chip('Suspension', state.kneeling ? 'Kneeling' : 'Normal', state.kneeling)}
        </div>
        <ol className={`twin-seq ${assisting ? 'show' : ''}`} aria-label="Boarding sequence">
          {presentation.sequence.map((s) => (
            <li key={s.id} className={s.status}>
              <span className="mark" />
              {s.label}
            </li>
          ))}
        </ol>
      </div>

      <div className={`twin-bar ${showBar ? 'show' : ''}`} aria-live="polite">
        <span className={`twin-bar-icon ${ann?.active ? 'speaking' : ''}`}>
          {ann?.active ? <IconSpeaker size={16} /> : <IconAccessible size={16} />}
        </span>
        <span className="twin-bar-text">
          {ann?.active ? (
            <>
              <span className="t">Announcement</span>
              <span className="m">“{ann.text}”</span>
            </>
          ) : (
            <>
              <span className="t">{info?.title}</span>
              <span className="m">{info?.message}</span>
            </>
          )}
        </span>
        {ann?.active && (
          <span className="twin-wave inline">
            <i /><i /><i /><i /><i />
          </span>
        )}
      </div>
    </>
  );
});

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
