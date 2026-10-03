import type { VehicleComponent, VehicleState } from '../types/vehicle';

/**
 * Presentation model
 * ------------------
 * Pure mapping from semantic VehicleState to *what should be communicated*:
 * which callout, which component highlights, which ground cue. The 3D layer
 * renders this; it never inspects raw state to invent its own UI logic.
 */

export type Tone = 'neutral' | 'progress' | 'ready' | 'success';

export type CalloutAnchor = 'door' | 'ramp' | 'display';

export interface Callout {
  key: string;
  anchor: CalloutAnchor;
  icon: 'accessible' | 'door' | 'check' | 'bell' | 'route';
  title: string;
  subtitle: string;
  tone: Tone;
}

export type PathMode = 'off' | 'ready' | 'boarding';

export interface Presentation {
  callout: Callout | null;
  highlights: Partial<Record<VehicleComponent, Tone>>;
  /** Ground cue in front of the ramp. */
  path: PathMode;
  /** Soft halo on the ground at the doorway. */
  entranceHalo: Tone | null;
  /** Accessibility pictogram next to the door. */
  accessibilityIndicator: boolean;
  sequence: SequenceStep[];
}

export interface SequenceStep {
  id: 'request' | 'preparing' | 'door' | 'ramp' | 'ready' | 'complete';
  label: string;
  status: 'done' | 'active' | 'pending';
}

const ASSIST = 'Boarding assistance';

export function derivePresentation(s: VehicleState): Presentation {
  const assisting = s.boardingStatus !== 'idle';
  const highlights: Presentation['highlights'] = {};
  let callout: Callout | null = null;

  // Mechanical motion first: it is what a bystander must notice right now.
  if (s.ramp === 'extending' || s.ramp === 'retracting') {
    highlights.ramp = 'progress';
    callout = {
      key: `ramp-${s.ramp}`,
      anchor: 'ramp',
      icon: 'accessible',
      title: ASSIST,
      subtitle: s.ramp === 'extending' ? 'Ramp extending' : 'Ramp retracting',
      tone: 'progress',
    };
  } else if (s.door === 'opening' || s.door === 'closing') {
    highlights.door = 'progress';
    callout = {
      key: `door-${s.door}`,
      anchor: 'door',
      icon: 'door',
      title: 'Front door',
      subtitle: s.door === 'opening' ? 'Opening' : 'Closing — please stand clear',
      tone: 'progress',
    };
  } else {
    switch (s.boardingStatus) {
      case 'request_received':
        callout = { key: 'req', anchor: 'door', icon: 'bell', title: ASSIST, subtitle: 'Request received', tone: 'neutral' };
        highlights.door = 'neutral';
        break;
      case 'preparing':
        callout = {
          key: 'prep',
          anchor: 'door',
          icon: 'accessible',
          title: ASSIST,
          subtitle: s.kneeling ? 'Vehicle lowering' : 'Vehicle preparing',
          tone: 'progress',
        };
        break;
      case 'ready':
        callout = { key: 'ready', anchor: 'ramp', icon: 'accessible', title: 'Ready to board', subtitle: 'Entrance prepared · await operator signal', tone: 'ready' };
        highlights.ramp = 'ready';
        break;
      case 'boarding':
        callout = { key: 'boarding', anchor: 'ramp', icon: 'accessible', title: ASSIST, subtitle: 'Boarding in progress', tone: 'ready' };
        highlights.ramp = 'ready';
        break;
      case 'complete':
        callout = { key: 'complete', anchor: 'door', icon: 'check', title: 'Boarding complete', subtitle: 'Securing vehicle', tone: 'success' };
        break;
    }
  }

  const rampDown = s.ramp === 'extended';
  const path: PathMode =
    rampDown && s.boardingStatus === 'boarding' ? 'boarding' : rampDown && (s.boardingStatus === 'ready' || !assisting) ? 'ready' : 'off';

  let entranceHalo: Tone | null = null;
  if (s.door === 'opening' || s.door === 'closing') entranceHalo = 'progress';
  else if (assisting) {
    entranceHalo =
      s.boardingStatus === 'ready' || s.boardingStatus === 'boarding'
        ? 'ready'
        : s.boardingStatus === 'complete'
          ? 'success'
          : 'neutral';
  } else if (s.door === 'open') entranceHalo = 'neutral';

  return {
    callout,
    highlights,
    path,
    entranceHalo,
    accessibilityIndicator: assisting || s.ramp !== 'retracted',
    sequence: deriveSequence(s),
  };
}

function deriveSequence(s: VehicleState): SequenceStep[] {
  type BoardingPhase = VehicleState['boardingStatus'];
  const order: BoardingPhase[] = ['idle', 'request_received', 'preparing', 'ready', 'boarding', 'complete'];
  const phase = order.indexOf(s.boardingStatus);
  const reached = (p: BoardingPhase) => phase >= order.indexOf(p);

  const done: Record<SequenceStep['id'], boolean> = {
    request: reached('request_received'),
    preparing: reached('preparing') && (s.kneeling || reached('ready')),
    door: s.door === 'open' || (reached('ready') && s.door !== 'closed') || reached('complete'),
    ramp: s.ramp === 'extended' || reached('complete'),
    ready: reached('ready'),
    complete: reached('complete'),
  };
  const labels: Record<SequenceStep['id'], string> = {
    request: 'Request received',
    preparing: 'Vehicle preparing',
    door: 'Door open',
    ramp: 'Ramp extended',
    ready: 'Ready to board',
    complete: 'Boarding complete',
  };
  if (s.boardingStatus === 'boarding') labels.complete = 'Boarding in progress';
  const ids = Object.keys(labels) as SequenceStep['id'][];
  let activeAssigned = s.boardingStatus === 'idle';
  return ids.map((id) => {
    if (done[id]) return { id, label: labels[id], status: 'done' as const };
    if (!activeAssigned) {
      activeAssigned = true;
      return { id, label: labels[id], status: 'active' as const };
    }
    return { id, label: labels[id], status: 'pending' as const };
  });
}

/** Split "400 Punggol Coast" into route + destination for the LED sign. */
export function parseDestination(dest?: string): { route: string; text: string } {
  const d = (dest ?? '').trim();
  const m = d.match(/^([A-Za-z]?\d{1,4}[A-Za-z]?)\s+(.+)$/);
  if (m) return { route: m[1], text: m[2] };
  return { route: '', text: d || 'Not in service' };
}
