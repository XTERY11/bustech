"use client";
import { useEffect, useState } from 'react';

type Health = { ok: boolean; fps?: number; triggered?: boolean; inside?: number; detections?: { label: string; confidence: number; model_class?: string }[]; device?: string; source?: string; frames?: number };
const KEY = 'accessride.videoBase';
const defaultBase = () => typeof window === 'undefined' ? 'http://127.0.0.1:8790' : `${window.location.protocol}//${window.location.hostname}:8790`;

/**
 * Live camera view from the Sense bridge (vision/yolo_bridge.py): an MJPEG
 * stream of annotated frames plus a small /health poll for fps and trigger state.
 * Frames never pass through the signal hub; only structured detections do.
 */
export function VideoPanel() {
  const [base, setBase] = useState(''), [draft, setDraft] = useState('');
  const [health, setHealth] = useState<Health | null>(null);
  const [epoch, setEpoch] = useState(0), [broken, setBroken] = useState(false);

  useEffect(() => {
    // Resolve the bridge URL after hydration (localStorage is per browser, not server-rendered).
    const id = window.setTimeout(() => {
      let saved = '';
      try { saved = window.localStorage.getItem(KEY) ?? ''; } catch { /* storage unavailable */ }
      const initial = saved || defaultBase(); setBase(initial); setDraft(initial);
    }, 0);
    return () => window.clearTimeout(id);
  }, []);
  useEffect(() => {
    if (!base) return;
    let alive = true;
    const poll = async () => {
      try { const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) }); if (alive) setHealth(r.ok ? await r.json() : null); }
      catch { if (alive) setHealth(null); }
    };
    void poll(); const timer = window.setInterval(poll, 2000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [base]);
  useEffect(() => { if (!broken) return; const t = window.setTimeout(() => { setBroken(false); setEpoch(e => e + 1); }, 3000); return () => window.clearTimeout(t); }, [broken]);

  function apply() { const next = draft.trim().replace(/\/$/, ''); setBase(next); setBroken(false); setEpoch(e => e + 1); try { window.localStorage.setItem(KEY, next); } catch { /* ignore */ } }
  const online = Boolean(health?.ok);
  const labels = [...new Set((health?.detections ?? []).map(d => d.label))];
  return <section className="panel stagePanel videoPanel" aria-label="Live camera">
    <div className="panelHeader"><div><p className="sectionKicker">Sense · Live camera</p><h2>YOLO region monitor</h2></div>
      <span className={`simBadge ${health?.triggered ? 'triggered' : online ? 'online' : ''}`}>{health?.triggered ? 'TRIGGER · in region' : online ? 'Monitoring' : 'Bridge offline'}</span></div>
    <div className="stageMedia">
      {online && !broken
        // eslint-disable-next-line @next/next/no-img-element -- MJPEG stream, not an optimisable image
        ? <img key={epoch} src={`${base}/stream.mjpg?e=${epoch}`} alt="Live annotated camera stream" onError={() => setBroken(true)} />
        : <div className="stagePlaceholder"><strong>No video stream</strong><p>Start the bridge on the vision computer:<br /><code>bash vision/start_bridge.sh 0</code><br />then check <code>{base || '…'}/health</code>.</p></div>}
    </div>
    <div className="stageFooter">
      <span>{online ? `${health?.fps ?? 0} fps · ${health?.device ?? ''} · inside ${health?.inside ?? 0}${labels.length ? ' · ' + labels.join(', ') : ''}` : 'Detections are sent to the signal hub only while a target is inside the region.'}</span>
      <details className="stageSettings"><summary>Stream URL</summary><div className="settingsFields"><label>Bridge base URL<input value={draft} onChange={e => setDraft(e.target.value)} placeholder="http://192.168.1.20:8790" /></label><button className="secondaryButton" onClick={apply}>Apply</button></div></details>
    </div>
  </section>;
}
