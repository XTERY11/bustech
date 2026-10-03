import { randomUUID, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { plan, MODES, revalidateForSimulation } from './planner/agent.mjs';
import { advance, guidance } from './journey.mjs';
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
    this.journey = { stage: 'IDLE' }; this.localNext = false;
  }
  context() {
    if (this.source === 'demo') return structuredClone(this.demoContext);
    // Presentation snapshots stay on screen until the next signal. Vehicle and
    // geometry values belong to the simulator; no vehicle telemetry is required.
    const context = { request_id: 'snapshot', presentation_mode: 'WEB_DEMO' };
    for (const [channel, entry] of Object.entries(this.channels)) {
      context[KEYS[channel]] = { ...structuredClone(entry.payload), observation_age_ms: 0 };
    }
    context.vehicle_context = { ...structuredClone(fixture.vehicle_context), observation_age_ms: 0,
      route_id: context.request?.route_id ?? 'DEMO_ROUTE', stop_id: context.request?.stop_id ?? 'DEMO_STOP' };
    context.perception = { ...context.perception, observation_age_ms: 0, geometry: structuredClone(fixture.perception.geometry) };
    return context;
  }
  snapshot() {
    // The journey belongs to live App + camera input; demo presets show their plan directly.
    const context = this.context();
    const journey = this.source === 'external' ? { ...this.journey, guidance: guidance(this.journey, context, this.result) } : null;
    return { journey, source: this.source, mode: this.mode, presentation_mode: 'WEB_DEMO', simulated_vehicle: true, context, channels: Object.fromEntries(Object.entries(this.channels).map(([k, e]) => [k, { received_at: e.receivedAt, observed_at: e.observedAt, event_id: e.eventId }])), running: this.active, summary: this.summary, result: this.result };
  }
  publish(type, data) { const event = { id: ++this.sequence, type, at: this.now(), data }; this.emit('event', event); return event; }
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
    this.journey = advance(this.journey, channel, normalized[KEYS[channel]], this.result?.plan_status, this.result?.boarding_target);
    let changed = before !== this.decisionKey();
    if (changed && channel === 'perception') {
      // The plan is made when the booking arrives. What the camera sees afterwards is only checked
      // against it by the local rules: if the plan still holds it stays (nothing to wait for when the
      // passenger reaches the stop); if not, the rules replan at once, without a model call.
      const context = this.context();
      if (this.result && !this.active && revalidateForSimulation(this.result, { ...context, request_id: this.result.request_id }).valid) {
        this.lastKey = `${this.mode}:${this.decisionKey()}`; changed = false;
      } else this.localNext = true;
    }
    if (changed) this.invalidate();
    this.publish('signal', { channel, event_id: eventId, changed, snapshot: this.snapshot() });
    if (this.autoRun && changed) this.schedule();
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
    if (mode !== this.mode) { this.mode = mode; this.lastKey = null; this.invalidate(); this.publish('settings', { mode }); }
  }
  loadDemo(raw, mode) {
    const c = normalizeInput({ ...raw, presentation_mode: 'WEB_DEMO' });
    this.setMode(mode); clearTimeout(this.timer); this.invalidate();
    this.source = 'demo'; this.demoContext = c; this.channels = {}; this.lastKey = null; this.journey = { stage: 'IDLE' };
    for (const [name, key] of Object.entries(KEYS)) if (c[key]) this.channels[name] = { payload: c[key], observedAt: this.now(), receivedAt: this.now(), eventId: c.request_id };
    this.publish('snapshot', this.snapshot());
    return this.run({ force: true });
  }
  async run({ force = false } = {}) {
    clearTimeout(this.timer);
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
      const result = await this.planner(c, { mode, onSummary: summary => {
        if (this.active !== runId || revision !== this.revision) return;
        this.summary = summary; this.publish('summary', { run_id: runId, summary });
      } });
      if (this.active !== runId || revision !== this.revision) return { discarded: true };
      this.active = null; this.result = result;
      this.summary ??= { request_id: runId, decision_summary: result.decision_summary };
      this.publish('result', { run_id: runId, result });
      return result;
    } catch {
      if (this.active === runId) {
        this.active = null; this.result = null; this.lastKey = null;
        this.publish('failure', { run_id: runId, message: 'Planning did not complete. Try again or select Offline rules.' });
      }
      throw new Error('PLANNING_FAILED');
    } finally {
      this.pendingCalls--;
      if (this.autoRun && !this.active && this.lastKey !== `${this.mode}:${this.decisionKey()}`) this.schedule();
    }
  }
  close() { clearTimeout(this.timer); this.removeAllListeners(); }
}
