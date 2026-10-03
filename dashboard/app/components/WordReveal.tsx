"use client";

import { useEffect, useMemo, useState } from 'react';

type Line = { words: string[]; start: number };

/** Client-side word reveal for a complete reasoning summary received over SSE. */
export function WordReveal({ lines, running }: { lines: string[]; running: boolean }) {
  // Heartbeat snapshots deserialize a new array without changing the summary.
  // Keep the reveal timeline stable until the actual text changes.
  const contents = JSON.stringify(lines);
  const prepared = useMemo<Line[]>(() => {
    const stableLines = JSON.parse(contents) as string[];
    return stableLines.reduce<Line[]>((items, line) => {
      const words = line.trim().split(/\s+/).filter(Boolean);
      const start = items.reduce((count, item) => count + item.words.length, 0);
      return [...items, { words, start }];
    }, []);
  }, [contents]);
  const total = prepared.reduce((count, line) => count + line.words.length, 0);
  const [shown, setShown] = useState(0);

  useEffect(() => {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!total) return;
    let current = 0;
    let cleanupTimer: number | undefined;
    const start = window.setTimeout(() => {
      if (reduceMotion) {
        setShown(total);
        return;
      }
      current = 1;
      setShown(1);
      const timer = window.setInterval(() => {
        current += 1;
        setShown(Math.min(current, total));
        if (current >= total) window.clearInterval(timer);
      }, 58);
      cleanupTimer = timer;
    }, reduceMotion ? 0 : 120);
    return () => {
      window.clearTimeout(start);
      if (cleanupTimer) window.clearInterval(cleanupTimer);
    };
  }, [prepared, total]);

  if (!lines.length) {
    return <p className="thinkingWaiting">{running ? 'Reading the latest signals and checking safety constraints…' : 'Run a demo preset, or wait for camera and app signals.'}</p>;
  }

  return <div className="thinkingReveal">
    <div className="srOnly" aria-live="polite">{lines.join(' ')}</div>
    <ol aria-hidden="true">
      {prepared.map((line, lineIndex) => <li className={shown <= line.start && lineIndex > 0 ? 'isPending' : ''} key={`${lineIndex}-${lines[lineIndex]}`}>
        {line.words.map((word, wordIndex) => {
          const index = line.start + wordIndex;
          return index < shown ? <span className="thinkingWord" key={`${word}-${wordIndex}`}>{word}{wordIndex < line.words.length - 1 ? ' ' : ''}</span> : null;
        })}
        {shown >= line.start && shown < line.start + line.words.length && <span className="thinkingCursor" />}
      </li>)}
    </ol>
  </div>;
}
