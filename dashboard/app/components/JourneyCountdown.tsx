"use client";
import { useEffect, useState } from 'react';
import type { Journey } from '../live-types';

/**
 * The hub's clock for the stage the passenger is in, made visible: how long until the bus is ready
 * (the 10 s arrival after signal 1), and how long the boarding animation still runs. People on site
 * read this to know when to leave the stop region. Times come from journey.animation
 * (started_at + duration_ms, hub epoch ms), so it shows the same instant the hub acts on.
 */
export function JourneyCountdown({ journey }: { journey: Journey }) {
  const animation = journey.animation ?? null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!animation) return;
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [animation?.id]);  // eslint-disable-line react-hooks/exhaustive-deps -- one ticker per animation
  if (!animation || !(animation.duration_ms > 0)) return null;
  const total = animation.duration_ms, elapsed = Math.min(total, Math.max(0, now - animation.started_at));
  const seconds = Math.ceil((total - elapsed) / 1000), done = elapsed >= total;
  const arrival = animation.phase === 'arrival', left = Boolean(journey.pending_exit);
  const tone = arrival ? (done ? 'ready' : left ? 'left' : 'waiting') : 'boarding';
  const title = arrival
    ? done ? 'Ready to board' : left ? 'Left the stop · boarding starts in' : 'Bus ready in'
    : done ? 'Boarding guidance shown' : 'Boarding';
  const hint = arrival
    ? done ? 'Leave the stop region towards the bus now' : left ? 'The bus is still preparing; boarding follows automatically' : 'Stay in the stop region until this reaches 0'
    : done ? 'Reset for the next passenger' : 'Cabin guidance is playing';
  return <div className={`journeyCountdown is-${tone}`} role="timer" aria-label={`${title}${done ? '' : ` ${seconds} seconds`}`}>
    <span className="journeyCountdownText"><small>{title}</small><strong>{done ? (arrival ? 'GO' : '✓') : `${seconds}s`}</strong></span>
    <span className="journeyCountdownBar" aria-hidden="true"><i style={{ width: `${(elapsed / total) * 100}%` }} /></span>
    <em>{hint}</em>
  </div>;
}
