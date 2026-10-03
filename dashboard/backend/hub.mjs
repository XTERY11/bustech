import { randomUUID, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { plan, MODES, revalidateForSimulation } from './planner/agent.mjs';
import { advance, guidance, navigation, reconcile, DOCK_MS, ARRIVAL_MS } from './journey.mjs';
import { normalizeInput, buildPolicy } from './planner/policy.mjs';

const KEYS = { booking: 'request', perception: 'perception' };
const fixture = JSON.parse(readFileSync(new URL('./examples/input.json', import.meta.url), 'utf8'));
const withoutAge = value => Array.isArray(value) ? value.map(withoutAge).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).filter(([k]) => !['observation_age_ms', 'request_id', 'confidence'].includes(k)).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, withoutAge(v)])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export class SignalHub extends EventEmitter {
  constructor({ planner = plan, now = Date.now, autoRun = true, debounceMs = 250 } = {}) {
    super(); this.planner = planner; this.now = now; this.autoRun = autoRun; this.debounceMs = debounceMs;
    this.mode = 'single'; this.source = 'external'; this.channels = {}; this.demoContext = null; this.sequence = 0;
    this.revision = 0; this.active = null; this.result = null; this.summary = null;
    this.seen = new Map(); this.lastKey = null; this.pendingCalls = 0; this.timer = null;
    this.journey = { stage: 'IDLE', revision: 0 }; this.localNext = false;
    this.cabin = structuredClone(fixture.vehicle_context.cabin); this.journeyTimers = []; this.navigationKey = null;
  }
  context() {
    if (this.source === 'demo') return structuredClone(this.demoContext);
    // Presentation snapshots stay on screen until the next signal. Vehicle and
    // geometry values belong to the simulator; no vehicle telemetry is required.
    const context = { request_id: 'snapshot', presentation_mode: 'WEB_DEMO' };
    for (const [channel, entry] of Object.entries(this.channels)) {
      context[KEYS[channel]] = { ...structuredClone(entry.payload), observation_age_ms: channel === 'booking' ? Math.max(0, this.now() - entry.observedAt) : 0 };
    }
    if (this.channels.booking) context.booking_event_id = this.channels.booking.eventId;
    if (context.request && this.journey.reason === 'expired') context.request.active = false;
    context.vehicle_context = { ...structuredClone(fixture.vehicle_context), observation_age_ms: 0,
      cabin: structuredClone(this.cabin),
      route_id: context.request?.route_id ?? 'DEMO_ROUTE', stop_id: context.request?.stop_id ?? 'DEMO_STOP' };
    context.perception = { ...context.perception, observation_age_ms: 0, geometry: structuredClone(fixture.perception.geometry) };
    return context;
  }
  snapshot() {
    // The journey belongs to live App + camera input; demo presets show their plan directly.
    const context = this.context();
    const journey = this.source === 'external' ? { ...structuredClone(this.journey), guidance: guidance(this.journey, context, this.result, this.now()) } : null;
    return { journey, navigation: journey ? navigation(this.journey, context, this.result, this.now()) : null, source: this.source, mode: this.mode, presentation_mode: 'WEB_DEMO', simulated_vehicle: true, context, channels: Object.fromEntries(Object.entries(this.channels).map(([k, e]) => [k, { received_at: e.receivedAt, observed_at: e.observedAt, event_id: e.eventId }])), running: this.active, summary: this.summary, result: this.result };
  }
  publish(type, data) { const event = { id: ++this.sequence, type, at: this.now(), data }; this.emit('event', event); return event; }
  publishState() {
    const snapshot = this.snapshot();
    this.publish('snapshot', snapshot);
    const key = JSON.stringify(snapshot.navigation);
    if (key !== this.navigationKey) {
      this.navigationKey = key; this.publish('navigation', { navigation: snapshot.navigation, snapshot });
    }
  }
  applyJourney(next) {
    const comparable = j => Object.fromEntries(Object.entries(j).filter(([key]) => !['revision', 'updated_at'].includes(key)));
    if (JSON.stringify(comparable(next)) === JSON.stringify(comparable(this.journey))) return false;
    const wasComplete = this.journey.completed;
    this.journey = { ...next, revision: (this.journey.revision ?? 0) + 1, updated_at: this.now() };
    if (!wasComplete && next.completed && next.boarding_target) {
      // Simulated reservation, NOT physical occupancy or an authorization to depart.
      if (next.boarding_target.type === 'SEAT') this.cabin.occupied_seat_ids = [...new Set([...this.cabin.occupied_seat_ids, next.boarding_target.id])];
      else this.cabin.wheelchair_bay_occupied = true;
      // A stroller consumes both its parking space and the accompanying person's nearby seat.
      if (next.equipment_target?.type === 'WHEELCHAIR_BAY') this.cabin.wheelchair_bay_occupied = true;
    }
    return true;
  }
  armJourneyTimers() {
    this.journeyTimers.forEach(clearTimeout); this.journeyTimers = [];
    if (this.source !== 'external') return;
    const times = [];
    if (this.channels.booking?.payload.active && this.journey.stage !== 'IDLE' && !this.journey.completed) times.push(this.channels.booking.observedAt + 300000);
    if (this.journey.animation?.phase === 'arrival') {
      times.push(this.journey.animation.started_at + DOCK_MS, this.journey.animation.started_at + ARRIVAL_MS);
    }
    for (const at of times.filter(at => at > this.now())) {
      const timer = setTimeout(() => { this.tick(); this.publishState(); }, at - this.now());
      timer.unref?.(); this.journeyTimers.push(timer);
    }
  }
  tick() {
    if (this.source !== 'external') return;
    const booking = this.channels.booking;
    if (booking?.payload.active && this.journey.stage !== 'IDLE' && !this.journey.completed && this.now() - booking.observedAt >= 300000) {
      this.invalidate();
      this.applyJourney({ ...this.journey, stage: 'IDLE', reason: 'expired', need: null, matched: false, pending_exit: false, animation: null, boarding_target: null, equipment_target: null, seat: null });
      clearTimeout(this.timer); this.lastKey = `${this.mode}:${this.decisionKey()}`;
      this.publishState();
    } else if (this.applyJourney(reconcile(this.journey, this.result, this.now()))) this.publishState();
    this.armJourneyTimers();
  }
  decisionKey() {
    const c = this.context(), policy = buildPolicy(c);
    return hash({ context: withoutAge(c), status: policy.plan_status, flags: policy.safety_flags, actions: policy.required_actions });
  }
  invalidate() {
    this.revision++;
    if (this.active) this.publish('cancelled', { run_id: this.active, message: 'Inputs changed. The previous result will not overwrite the current state.' });
    this.active = null; this.summary = null; this.result = null;
  }
  receive(channel, envelope) {
    if (!KEYS[channel] || !envelope || typeof envelope !== 'object') throw new Error('INVALID_SIGNAL');
    const eventId = envelope.event_id;
    if (typeof eventId !== 'string' || !/^[A-Za-z0-9_.:-]{1,80}$/.test(eventId)) throw new Error('INVALID_EVENT_ID');
    const observedAt = typeof envelope.observed_at === 'string' ? Date.parse(envelope.observed_at) : NaN;
    if (!Number.isFinite(observedAt) || observedAt > this.now() + 5000) throw new Error('INVALID_OBSERVED_AT');
    const normalized = normalizeInput({ request_id: eventId, [KEYS[channel]]: envelope.payload });
    if (!normalized[KEYS[channel]]) throw new Error('PAYLOAD_REQUIRED');
    const contentHash = hash({ channel, envelope });
    const duplicate = this.seen.get(eventId);
    if (duplicate) {
      if (duplicate !== contentHash) throw new Error('EVENT_ID_CONFLICT');
      return { accepted: true, duplicate: true };
    }
    const previous = this.channels[channel];
    if (this.source === 'external' && previous && observedAt < previous.observedAt) throw new Error('OUT_OF_ORDER_SIGNAL');
    this.seen.set(eventId, contentHash);
    if (this.seen.size > 512) this.seen.delete(this.seen.keys().next().value);
    const before = this.decisionKey();
    // External App/YOLO events replace preset inputs; the simulator remains local.
    if (this.source === 'demo') { this.channels = {}; this.demoContext = null; this.lastKey = null; }
    this.source = 'external';
    this.channels[channel] = { payload: normalized[KEYS[channel]], observedAt, receivedAt: this.now(), eventId };
    // The demo serves one passenger per bus: once a journey has completed, the next booking is met by a
    // fresh simulated bus, so the place the previous passenger used is free again.
    if (channel === 'booking' && this.journey.completed) this.cabin = structuredClone(fixture.vehicle_context.cabin);
    this.applyJourney(advance(this.journey, channel, normalized[KEYS[channel]], this.result?.plan_status, { eventId, now: this.now() }));
    let changed = channel === 'booking' || before !== this.decisionKey();
    if (channel === 'booking') this.localNext = normalized.request.active !== true || normalized.request.intent !== 'BOARDING';
    if (changed && channel === 'perception') {
      // The plan is made when the booking arrives. What the camera sees afterwards is only checked
      // against it by the local rules: if the plan still holds it stays (nothing to wait for when the
      // passenger reaches the stop); if not, the rules replan at once, without a model call.
      const context = this.context();
      if (this.active || this.journey.completed || this.result && revalidateForSimulation(this.result, { ...context, request_id: this.result.request_id }).valid) {
        this.lastKey = `${this.mode}:${this.decisionKey()}`; changed = false;
      } else this.localNext = true;
    }
    if (changed) this.invalidate();
    this.tick();
    this.publish('signal', { channel, event_id: eventId, changed, snapshot: this.snapshot() });
    this.publishState();
    if (this.autoRun && changed && this.journey.reason !== 'expired') this.schedule();
    return { accepted: true, duplicate: false, changed };
  }
  schedule() {
    clearTimeout(this.timer);
    const emergency = this.context().vehicle_context?.emergency_stop_active === true;
    if (emergency) { void this.run().catch(() => {}); return; }
    this.timer = setTimeout(() => void this.run().catch(() => {}), this.debounceMs);
  }
  setMode(mode) {
    if (!MODES.includes(mode)) throw new Error('INVALID_MODE');
    if (mode !== this.mode) {
      this.mode = mode; this.localNext = false; this.lastKey = null;
      if (!this.journey.completed || this.source !== 'external') { this.invalidate(); this.tick(); }
      this.publish('settings', { mode }); this.publishState();
    }
  }
  loadDemo(raw, mode) {
    const c = normalizeInput({ ...raw, presentation_mode: 'WEB_DEMO' });
    this.setMode(mode); clearTimeout(this.timer); this.invalidate();
    this.source = 'demo'; this.demoContext = c; this.channels = {}; this.lastKey = null; this.journey = { stage: 'IDLE', revision: 0 }; this.localNext = false;
    this.armJourneyTimers();
    for (const [name, key] of Object.entries(KEYS)) if (c[key]) this.channels[name] = { payload: c[key], observedAt: this.now(), receivedAt: this.now(), eventId: c.request_id };
    this.publishState();
    return this.run({ force: true });
  }
  async run({ force = false } = {}) {
    clearTimeout(this.timer); this.tick();
    if (this.source === 'external' && this.journey.completed) return { skipped: true };
    const c = this.context(), policy = buildPolicy(c), key = `${this.mode}:${this.decisionKey()}`;
    if (!force && key === this.lastKey) return { skipped: true };
    if (this.active) throw new Error('RUN_IN_PROGRESS');
    const mode = this.localNext ? 'rules' : this.mode; this.localNext = false;
    const localOnly = mode === 'rules' || ['emergency', 'wait'].includes(policy.scenario);
    if (!localOnly && this.pendingCalls >= 2) throw new Error('PLANNER_BUSY');
    const runId = `run-${randomUUID()}`, revision = this.revision;
    c.request_id = runId; this.active = runId; this.summary = null; this.result = null; this.lastKey = key;
    this.publish('planning', { run_id: runId, mode, source: this.source, context: c });
    this.pendingCalls++;
    try {
      let result = await this.planner(c, { mode, onSummary: summary => {
        if (this.active !== runId || revision !== this.revision) return;
        this.summary = summary; this.publish('summary', { run_id: runId, summary });
      } });
      this.tick();
      if (this.active !== runId || revision !== this.revision) return { discarded: true };
      // A CV observation during the model call must not cancel that first call. Check the
      // completed output against the newest trusted snapshot before publishing navigation.
      const fresh = { ...this.context(), request_id: runId };
      if (mode !== 'rules' && result.plan_status === 'READY' && !revalidateForSimulation(result, fresh).valid) {
        const original = result.meta;
        result = await plan(fresh, { mode: 'rules' });
        result.meta = { ...result.meta, source: 'runtime_safe_revalidation', original_model: original };
      }
      this.tick();
      if (this.active !== runId || revision !== this.revision) return { discarded: true };
      this.active = null; this.result = result;
      this.lastKey = `${this.mode}:${this.decisionKey()}`; this.tick();
      this.summary ??= { request_id: runId, decision_summary: result.decision_summary };
      this.publish('result', { run_id: runId, result, snapshot: this.snapshot() });
      this.publishState();
      return result;
    } catch {
      if (this.active === runId) {
        this.active = null; this.result = null; this.lastKey = null;
        this.tick(); this.publish('failure', { run_id: runId, message: 'Planning did not complete. Please retry or ask the safety operator.' }); this.publishState();
      }
      throw new Error('PLANNING_FAILED');
    } finally {
      this.pendingCalls--;
      if (this.autoRun && !this.active && this.lastKey !== `${this.mode}:${this.decisionKey()}`) this.schedule();
    }
  }
  close() { clearTimeout(this.timer); this.journeyTimers.forEach(clearTimeout); this.removeAllListeners(); }
}
