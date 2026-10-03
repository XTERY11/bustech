import { memo, useEffect, useRef, useState } from 'react';
import type { VehicleState } from '../../types/vehicle';
import type { Presentation } from '../../state/presentation';
import { IconAccessible, IconSpeaker } from './icons';

function AutoScrollMessage({ text }: { text: string }) {
  const viewport = useRef<HTMLSpanElement>(null);
  const manual = useRef(false);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const node = viewport.current;
    if (!node) return;
    node.scrollTop = 0;
    manual.current = false;
    const measure = () => setOverflowing(node.scrollHeight > node.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [text]);

  useEffect(() => {
    const node = viewport.current;
    if (!node || !overflowing || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    let frame = 0;
    let direction = 1;
    let last = performance.now();
    let holdUntil = last + 1400;
    const tick = (now: number) => {
      const elapsed = Math.min(64, now - last);
      last = now;
      const maximum = Math.max(0, node.scrollHeight - node.clientHeight);
      if (!manual.current && maximum > 1 && now >= holdUntil) {
        node.scrollTop += direction * elapsed * 0.022;
        if (node.scrollTop >= maximum - 0.5) {
          node.scrollTop = maximum;
          direction = -1;
          holdUntil = now + 1600;
        } else if (node.scrollTop <= 0.5 && direction < 0) {
          node.scrollTop = 0;
          direction = 1;
          holdUntil = now + 1400;
        }
      }
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [overflowing, text]);

  const stopAutoScroll = () => { manual.current = true; };

  return <span
    ref={viewport}
    className={`m twin-message-scroll ${overflowing ? 'isOverflowing' : ''}`}
    tabIndex={overflowing ? 0 : undefined}
    aria-label="Scrollable external display message"
    title={overflowing ? 'Scroll to read the full message' : undefined}
    onPointerEnter={stopAutoScroll}
    onPointerDown={stopAutoScroll}
    onWheel={stopAutoScroll}
    onTouchStart={stopAutoScroll}
    onFocus={stopAutoScroll}
  >{text}</span>;
}

/**
 * Restrained DOM overlay inside the viewer:
 *   top-left   compact status chips + boarding sequence (only while assisting)
 *   bottom     passenger information / announcement bar
 */
export const TwinHud = memo(function TwinHud({ state, presentation }: { state: VehicleState; presentation: Presentation }) {
  const assisting = state.boardingStatus !== 'idle';
  const ann = state.announcement;
  const info = state.passengerInfo;
  const showDisplay = !!info?.title || !!info?.message;
  const liveText = [...new Set([
    showDisplay ? info?.message?.trim() : undefined,
    ann?.active ? ann.text?.trim() : undefined,
  ].filter((value): value is string => !!value))].join(' ');

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

      <div className={`twin-bar twin-bar--display ${showDisplay ? 'show' : ''}`} aria-hidden={!showDisplay}>
        <span className="twin-bar-icon">
          <IconAccessible size={16} />
        </span>
        <span className="twin-bar-text">
          <span className="t">External display{info?.title ? ` · ${info.title}` : ''}</span>
          <AutoScrollMessage text={info?.message ?? ''} />
        </span>
      </div>

      <div className={`twin-bar twin-bar--announcement ${ann?.active ? 'show' : ''}`} aria-hidden={!ann?.active}>
        <span className="twin-bar-icon speaking"><IconSpeaker size={16} /></span>
        <span className="twin-bar-text">
          <span className="t">Announcement</span>
          <span className="m">“{ann?.text}”</span>
        </span>
        {ann?.active && (
          <span className="twin-wave inline">
            <i /><i /><i /><i /><i />
          </span>
        )}
      </div>
      <span className="twin-sr-status" role="status" aria-live="polite" aria-atomic="true">{liveText}</span>
    </>
  );
});

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
