"use client";

import type { ReactNode } from 'react';

export type DashboardView = 'overview' | 'signal' | 'sense' | 'thinking' | 'twin';

type DashboardSidebarProps = {
  view: DashboardView;
  onViewChange: (view: DashboardView) => void;
  connected: boolean;
};

const icons: Record<DashboardView, ReactNode> = {
  overview: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
  signal: <><rect x="7" y="2.5" width="10" height="19" rx="2" /><path d="M10 6h4M11 18h2" /></>,
  sense: <><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" /><path d="M5.5 12s2.5-4 6.5-4 6.5 4 6.5 4-2.5 4-6.5 4-6.5-4-6.5-4Z" /><circle cx="12" cy="12" r="1.5" /></>,
  thinking: <><circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="8" r="2.5" /><circle cx="9" cy="18" r="2.5" /><path d="m8.5 6.4 7 1.2M6.6 8.5l1.8 7m3-1 4.9-4.6" /></>,
  twin: <><path d="m12 2.5 8.5 4.8v9.4L12 21.5l-8.5-4.8V7.3L12 2.5Z" /><path d="m3.5 7.3 8.5 4.9 8.5-4.9M12 12.2v9.3M7.8 5l8.5 4.8" /></>,
};

function SidebarIcon({ view }: { view: DashboardView }) {
  return <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{icons[view]}</svg>;
}

export function DashboardSidebar({ view, onViewChange, connected }: DashboardSidebarProps) {
  const item = (target: DashboardView, label: string) => {
    const active = target === view;
    return <button type="button" className={`sidebar-item${active ? ' is-active' : ''}`} aria-label={label} title={label} aria-pressed={active} aria-current={active ? 'page' : undefined} onClick={() => onViewChange(target)}>
      <span className="sidebar-item-icon"><SidebarIcon view={target} /></span>
      <span className="sidebar-item-text">{label}</span>
    </button>;
  };

  return <aside className="studio-sidebar">
    <div className="sidebar-brand">
      <span className="brand-mark" aria-hidden="true">NB</span>
      <span className="brand-name">NUSNextBus</span>
    </div>
    <nav className="sidebar-nav" aria-label="Workspaces">
      {item('overview', 'Overview')}
      <div className="sidebar-group sidebar-group-signal">
        <div className="sidebar-group-label"><span>Signal</span><span className="sidebar-group-meta">App-based</span></div>
        {item('signal', 'App booking')}
      </div>
      <div className="sidebar-group sidebar-group-sense">
        <div className="sidebar-group-label"><span>Sense</span><span className="sidebar-group-meta">CV</span></div>
        {item('sense', 'Live detection')}
      </div>
      <div className="sidebar-group sidebar-group-support">
        <div className="sidebar-group-label"><span>Support</span><span className="sidebar-group-meta">LLM · Actions · Comms</span></div>
        {item('thinking', 'LLM Agent')}
        {item('twin', 'Digital twin')}
      </div>
    </nav>
    <div className="sidebar-footer">
      <div className={`sidebar-connection ${connected ? 'is-connected' : 'is-disconnected'}`} title="Signal hub connection status. Phone connectivity is not independently verified." aria-label={`Signal hub ${connected ? 'connected' : 'disconnected'}. Phone connectivity is not independently verified.`}>
        <span className="sidebar-status-dot" aria-hidden="true" />
        <span>Bus App {connected ? 'Connected' : 'Disconnected'}</span>
      </div>
      <span className="sidebar-simulation">Simulation</span>
    </div>
  </aside>;
}
