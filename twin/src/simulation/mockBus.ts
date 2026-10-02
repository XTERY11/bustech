import { createSeatOccupancy, SEATS, type SeatOccupancy, type OccupancyPreset } from '../data/cabinLayout';
import type { TelemetryMessage, TelemetrySource } from '../adapters/telemetryAdapter';
import type { BoardingStatus, DoorState, RampState } from '../types/vehicle';

/**
 * Mock bus (stand-in for the real vehicle)
 * ----------------------------------------
 * Accepts *commands* the way a vehicle controller would, simulates the
 * mechanical transitions (opening → open) and publishes full-state telemetry
 * frames. It plugs into the app through the same `TelemetrySource` interface a
 * WebSocket would, so the demo exercises the real data path:
 *
 *   button → MockBus command → telemetry frame → normalizeTelemetry → store → 3D twin
 *
 * All timing lives in this one scheduler — never inside 3D components.
 */

export const MECHANICAL_MS = { door: 1200, ramp: 2000 };

interface BusSnapshot {
  seatOccupancy: SeatOccupancy;
  door: DoorState;
  ramp: RampState;
  kneeling: boolean;
  boardingStatus: BoardingStatus;
  destination: string;
  announcement: { active: boolean; text: string };
  passengerInfo: { title?: string; message?: string } | null;
}

export interface ScenarioStep {
  at: number; // seconds from start
  label: string;
  frame: Partial<TelemetryMessage>;
}

export interface BusEvent {
  time: number;
  text: string;
  kind: 'command' | 'telemetry' | 'scenario' | 'interlock';
}

class Scheduler {
  private timers = new Map<number, { tag: string }>();
  after(ms: number, tag: string, fn: () => void) {
    const id = window.setTimeout(() => {
      this.timers.delete(id);
      fn();
    }, ms);
    this.timers.set(id, { tag });
  }
  cancel(tag?: string) {
    for (const [id, t] of this.timers) {
      if (!tag || t.tag === tag) {
        window.clearTimeout(id);
        this.timers.delete(id);
      }
    }
  }
  has(tag: string) {
    for (const t of this.timers.values()) if (t.tag === tag) return true;
    return false;
  }
}

export class MockBusSimulator implements TelemetrySource {
  interlocks = true;
  private s: BusSnapshot;
  private sink?: (m: TelemetryMessage) => void;
  private sched = new Scheduler();
  private eventListeners = new Set<(e: BusEvent) => void>();
  private scenarioListeners = new Set<(p: { running: boolean; step: number; elapsed: number }) => void>();
  private scenarioStart = 0;

  constructor(private readonly vehicleId = 'bus-01', destination = '400 Punggol Coast') {
    this.s = {
      door: 'closed',
      ramp: 'retracted',
      kneeling: false,
      boardingStatus: 'idle',
      destination,
      announcement: { active: false, text: '' },
      passengerInfo: null,
      seatOccupancy: createSeatOccupancy(),
    };
  }

  // ── TelemetrySource ────────────────────────────────────────────────
  start(onMessage: (m: TelemetryMessage) => void) {
    this.sink = onMessage;
    this.publish();
  }
  stop() {
    this.sched.cancel();
    this.sink = undefined;
  }

  onEvent(fn: (e: BusEvent) => void) {
    this.eventListeners.add(fn);
    return () => this.eventListeners.delete(fn);
  }
  onScenario(fn: (p: { running: boolean; step: number; elapsed: number }) => void) {
    this.scenarioListeners.add(fn);
    return () => this.scenarioListeners.delete(fn);
  }

  // ── Commands ───────────────────────────────────────────────────────
  openDoor() {
    this.log('command', 'Open door');
    this.doOpenDoor();
  }

  closeDoor() {
    this.log('command', 'Close door');
    if (this.interlocks && this.s.ramp !== 'retracted') {
      this.log('interlock', 'Ramp deployed → retracting ramp before closing door');
      this.doRetractRamp(() => this.doCloseDoor());
      return;
    }
    this.doCloseDoor();
  }

  extendRamp() {
    this.log('command', 'Extend ramp');
    if (this.interlocks && this.s.door !== 'open') {
      this.log('interlock', 'Door not open → opening door first');
      this.doOpenDoor(() => this.doExtendRamp());
      return;
    }
    this.doExtendRamp();
  }

  retractRamp() {
    this.log('command', 'Retract ramp');
    this.doRetractRamp();
  }

  setKneeling(on: boolean) {
    this.log('command', on ? 'Kneel' : 'Raise suspension');
    this.update({ kneeling: on });
  }

  requestBoarding() {
    this.log('command', 'Boarding assistance requested');
    this.update({
      boardingStatus: 'request_received',
      passengerInfo: { title: 'Boarding assistance', message: 'Wheelchair boarding requested at this stop.' },
    });
  }

  /** Prepares the vehicle (kneel → door → ramp) then reports "ready". */
  readyForBoarding() {
    this.log('command', 'Ready for boarding');
    const finish = () => {
      const text = 'Ramp deployed. Please board.';
      this.update({
        boardingStatus: 'ready',
        passengerInfo: { title: 'Ready to board', message: text },
        announcement: { active: true, text },
      });
      this.autoEndAnnouncement(text);
    };

    if (!this.interlocks || (this.s.ramp === 'extended' && this.s.door === 'open')) return finish();
    this.update({ boardingStatus: 'preparing', kneeling: true });
    this.sched.after(900, 'prepare', () => this.doOpenDoor(() => this.doExtendRamp(finish)));
  }

  boardingComplete() {
    this.log('command', 'Boarding complete');
    this.update({
      boardingStatus: 'complete',
      passengerInfo: { title: 'Boarding complete', message: 'Thank you. The ramp will now retract.' },
    });
  }

  playAnnouncement(text: string) {
    const t = text.trim() || 'Wheelchair boarding in progress.';
    this.log('command', `Announcement: "${t}"`);
    this.update({ announcement: { active: true, text: t } });
    this.autoEndAnnouncement(t);
  }

  stopAnnouncement() {
    this.sched.cancel('announcement');
    this.update({ announcement: { active: false, text: this.s.announcement.text } });
  }

  setDestination(dest: string) {
    this.log('command', `Destination → ${dest}`);
    this.update({ destination: dest });
  }

  setSeatOccupied(seatId: string, occupied: boolean) {
    if (!SEATS.some((s) => s.id === seatId) || typeof occupied !== 'boolean') return;
    this.log('command', `${seatId} → ${occupied ? 'occupied' : 'empty'}`);
    this.update({ seatOccupancy: { ...this.s.seatOccupancy, [seatId]: occupied } });
  }

  setOccupancyPreset(preset: OccupancyPreset) {
    this.log('command', `Passenger scene → ${preset}`);
    this.update({ seatOccupancy: createSeatOccupancy(preset) });
  }

  reset() {
    this.stopScenario(false);
    this.sched.cancel();
    this.log('command', 'Reset');
    this.update({
      door: 'closed',
      ramp: 'retracted',
      kneeling: false,
      boardingStatus: 'idle',
      announcement: { active: false, text: '' },
      passengerInfo: null,
      seatOccupancy: createSeatOccupancy(),
    });
  }

  // ── Scenario playback (a recorded telemetry stream) ─────────────────
  runScenario(steps: ScenarioStep[]) {
    this.stopScenario(false);
    this.sched.cancel();
    this.scenarioStart = performance.now();
    this.log('scenario', 'Boarding demo started');
    steps.forEach((step, i) => {
      this.sched.after(step.at * 1000, 'scenario', () => {
        this.log('scenario', `t=${step.at}s  ${step.label}`);
        this.update(step.frame as Partial<BusSnapshot>);
        this.emitScenario(true, i);
        if (i === steps.length - 1) this.sched.after(400, 'scenario', () => this.emitScenario(false, i));
      });
    });
    this.emitScenario(true, -1);
  }

  stopScenario(log = true) {
    if (this.sched.has('scenario')) {
      this.sched.cancel('scenario');
      if (log) this.log('scenario', 'Boarding demo stopped');
    }
    this.emitScenario(false, -1);
  }

  get snapshot(): Readonly<BusSnapshot> {
    return this.s;
  }

  // ── Mechanics ──────────────────────────────────────────────────────
  private doOpenDoor(then?: () => void) {
    this.sched.cancel('door');
    if (this.s.door === 'open') return then?.();
    this.update({ door: 'opening' });
    this.sched.after(MECHANICAL_MS.door, 'door', () => {
      this.update({ door: 'open' });
      then?.();
    });
  }

  private doCloseDoor(then?: () => void) {
    this.sched.cancel('door');
    if (this.s.door === 'closed') return then?.();
    this.update({ door: 'closing' });
    this.sched.after(MECHANICAL_MS.door, 'door', () => {
      this.update({ door: 'closed' });
      then?.();
    });
  }

  private doExtendRamp(then?: () => void) {
    this.sched.cancel('ramp');
    if (this.s.ramp === 'extended') return then?.();
    this.update({ ramp: 'extending' });
    this.sched.after(MECHANICAL_MS.ramp, 'ramp', () => {
      this.update({ ramp: 'extended' });
      then?.();
    });
  }

  private doRetractRamp(then?: () => void) {
    this.sched.cancel('ramp');
    if (this.s.ramp === 'retracted') return then?.();
    this.update({ ramp: 'retracting' });
    this.sched.after(MECHANICAL_MS.ramp, 'ramp', () => {
      this.update({ ramp: 'retracted' });
      then?.();
    });
  }

  private autoEndAnnouncement(text: string) {
    this.sched.cancel('announcement');
    const ms = Math.max(3500, text.length * 90);
    this.sched.after(ms, 'announcement', () => this.update({ announcement: { active: false, text } }));
  }

  private update(p: Partial<BusSnapshot>): void {
    this.s = { ...this.s, ...p };
    this.publish();
  }

  private publish() {
    const frame: TelemetryMessage = {
      vehicleId: this.vehicleId,
      timestamp: Date.now(),
      ...this.s,
    };
    this.sink?.(frame);
  }

  private log(kind: BusEvent['kind'], text: string) {
    const e = { time: Date.now(), text, kind };
    this.eventListeners.forEach((l) => l(e));
  }

  private emitScenario(running: boolean, step: number) {
    const elapsed = (performance.now() - this.scenarioStart) / 1000;
    this.scenarioListeners.forEach((l) => l({ running, step, elapsed }));
  }
}
