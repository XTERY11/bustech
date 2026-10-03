import { randomUUID, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { plan, MODES, revalidateForSimulation } from './planner/agent.mjs';
import { advance, guidance, navigation, reconcile, presenceLost, confirmedLabels, visibleMatch, DOCK_MS } from './journey.mjs';
import { normalizeInput, buildPolicy } from './planner/policy.mjs';

const KEYS = { booking: 'request', perception: 'perception' };
// The camera bridge repeats an occupied region every 2 s ('present'); older than this, the report is not current.
export const PRESENCE_MS = 5000;
// While AT_STOP, the journey's visit counts as gone once the hub (its own receive clock, not the camera's) has heard
// nothing about it for this long, about 4 missed heartbeats: see presenceLost in journey.mjs. Only visit-bound
// journeys (zone.visit_id, i.e. senders that send heartbeats) are timed; a manual enter without visit_id is not.
export const PRESENCE_LOST_MS = 8000;
export const BOOKING_TTL_MS = 300000;
// Finished bookings (boarded, cancelled, expired) stay in snapshot.journeys this long, so their phone can show the end.
export const FINISHED_RETAIN_MS = 120000;
const IDLE_JOURNEY = Object.freeze({ stage: 'IDLE', revision: 0 });
const fixture = JSON.parse(readFileSync(new URL('./examples/input.json', import.meta.url), 'utf8'));
const withoutAge = value => Array.isArray(value) ? value.map(withoutAge).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).filter(([k]) => !['observation_age_ms', 'request_id', 'confidence'].includes(k)).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, withoutAge(v)])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const isBoarding = request => request?.active === true && request?.intent === 'BOARDING';
const ID = /^[A-Za-z0-9_.:-]{1,80}$/;

// --- The waiting list ------------------------------------------------------------------------------------------------
// The supported demo is ONE phone booking one passenger after another; the list is a safety net for several phones.
// Every booking is a record with its own journey (the shape the single journey always had), its own planner result
// and its age (seq). At most one live booking per need. One journey at a time is IN PROGRESS (this.currentId): the
// booking bound to the stop region (matched at the stop, or a lone booking shown as unmatched), until it walks off
// (back to the list, keeping its age) or boards (ON_BOARD: it leaves the list at once, its animation plays on).
// The camera releases the next one: the oldest waiting booking whose aid it reports in the region. With one booking
// in the list everything behaves exactly as before the list.
/** A plan not known yet, or READY: the camera may release it. NEEDS_CONFIRMATION / CANNOT_EXECUTE wait for the operator. */
const boardable = rec => !rec.result || rec.result.plan_status === 'READY';
const noPlace = rec => Boolean(rec.result) && rec.result.plan_status !== 'READY' && (rec.result.safety_flags ?? []).includes('NO_ACCESSIBLE_PLACE_AVAILABLE');
/** Holds the stop (others wait): matched at the stop, or an exit held until the arrival is over. */
const holdsStop = journey => Boolean(journey.matched || journey.pending_exit);
/** Boarded and still shown as ON_BOARD (not yet reset by the phone). */
const boarded = rec => Boolean(rec?.journey.completed) && rec.journey.stage === 'ON_BOARD';

export class SignalHub extends EventEmitter {
  constructor({ planner = plan, now = Date.now, autoRun = true, debounceMs = 250 } = {}) {
    super(); this.planner = planner; this.now = now; this.autoRun = autoRun; this.debounceMs = debounceMs;
    this.mode = 'single'; this.source = 'external'; this.channels = {}; this.demoContext = null; this.sequence = 0;
    this.revision = 0; this.active = null; this.activeTarget = null;
    this.seen = new Map(); this.pendingCalls = 0; this.timer = null; this.journeyTimers = []; this.navigationKey = null;
    // Planner state that belongs to no live booking: demo presets, camera-only input, a cancelled booking on screen.
    this.loose = { result: null, summary: null, lastKey: null, rulesNext: false };
    this.bookings = []; this.bookingSeq = 0; this.journeyRevision = 0; this.currentId = null; this.lastEnded = null;
    this.presence = null;
    // The simulated bus all bookings of one list board. cabin holds who has boarded it; places planned for waiting
    // bookings are added per planning context (cabinFor).
    this.cabin = structuredClone(fixture.vehicle_context.cabin); this.busId = 1; this.busUsed = false; this.busDocked = false;
  }

  // --- views -------------------------------------------------------------------------------------------------------
  live() { return this.bookings.filter(rec => rec.endedAt === null); }
  current() { return this.currentId === null ? null : this.bookings.find(rec => rec.id === this.currentId) ?? null; }
  /** Live bookings the camera may release (or that are in progress and not yet boarded). */
  pool() { return this.live().filter(rec => !rec.journey.completed && boardable(rec)); }
  /** What the top-level journey/result describe: in progress, else the oldest waiting booking, else the last finished one
   *  (the boarded journey stays on screen until the phone resets it or the next booking arrives). */
  focus() { return this.current() ?? this.live()[0] ?? this.lastEnded; }
  /** The planner slot shown at the top level: a live or boarded booking's own, otherwise the loose one. */
  topSlot() {
    if (this.source !== 'external') return this.loose;
    const focus = this.focus();
    return focus && (focus.endedAt === null || boarded(focus)) ? focus : this.loose;
  }
  get journey() { return this.focus()?.journey ?? IDLE_JOURNEY; }
  get result() { return this.topSlot().result; }
  get summary() { return this.topSlot().summary; }
  positionOf(rec) {
    if (!rec || rec.endedAt !== null || rec.id === this.currentId) return 0;
    return this.live().filter(other => other !== rec && (other.id === this.currentId || other.seq < rec.seq)).length;
  }
  queueInfo(rec) { return rec && rec.endedAt === null && rec.id !== this.currentId ? { ahead: this.positionOf(rec) } : {}; }

  /** Places promised to the OTHER bookings of this bus count as taken, so two bookings never share a place. */
  cabinFor(rec) {
    const cabin = structuredClone(this.cabin);
    for (const other of this.live()) {
      const r = other.result;
      if (other === rec || other.bus !== this.busId || r?.plan_status !== 'READY' || !r.boarding_target) continue;
      if (r.boarding_target.type === 'SEAT') cabin.occupied_seat_ids = [...new Set([...cabin.occupied_seat_ids, r.boarding_target.id])];
      else cabin.wheelchair_bay_occupied = true;
      if (r.equipment_target?.type === 'WHEELCHAIR_BAY') cabin.wheelchair_bay_occupied = true;
    }
    return cabin;
  }
  /** The planner input for one booking (rec), or for no booking (camera only / after a cancel). */
  contextFor(rec) {
    if (this.source === 'demo') return structuredClone(this.demoContext);
    // Presentation snapshots stay on screen until the next signal. Vehicle and
    // geometry values belong to the simulator; no vehicle telemetry is required.
    const context = { request_id: 'snapshot', presentation_mode: 'WEB_DEMO' };
    // An ended booking (cancelled, expired, reset) leaves an idle request: inactive, without its need.
    const idle = rec?.endedAt != null && rec.journey.stage === 'IDLE';
    const booking = idle ? { payload: { active: false }, observedAt: rec.observedAt, eventId: null }
      : rec ? { payload: rec.payload, observedAt: rec.observedAt, eventId: rec.id } : this.channels.booking;
    // A live booking is within its TTL by definition (frozen while matched at the stop), so its age never exceeds it:
    // otherwise a passenger who waited more than 5 minutes at the stop would lose the plan when leaving to board.
    const age = booking ? Math.max(0, this.now() - booking.observedAt) : 0;
    if (booking) context.request = { ...structuredClone(booking.payload), observation_age_ms: rec?.endedAt === null ? Math.min(age, BOOKING_TTL_MS) : age };
    if (this.channels.perception) context.perception = { ...structuredClone(this.channels.perception.payload), observation_age_ms: 0 };
    if (booking?.eventId) context.booking_event_id = booking.eventId;
    context.vehicle_context = { ...structuredClone(fixture.vehicle_context), observation_age_ms: 0,
      cabin: this.cabinFor(rec),
      route_id: context.request?.route_id ?? 'DEMO_ROUTE', stop_id: context.request?.stop_id ?? 'DEMO_STOP' };
    context.perception = { ...context.perception, observation_age_ms: 0, geometry: structuredClone(fixture.perception.geometry) };
    return context;
  }
  context() { return this.contextFor(this.source === 'external' ? this.focus() : null); }
  /** One entry of snapshot.journeys: the booking's journey, guidance and navigation, plus its place in the list. */
  entry(rec) {
    const context = this.contextFor(rec), queue = this.queueInfo(rec), now = this.now();
    return { ...structuredClone(rec.journey), guidance: guidance(rec.journey, context, rec.result, now, queue),
      queued: rec.endedAt === null && rec.id !== this.currentId, position: this.positionOf(rec),
      plan_status: rec.result?.plan_status ?? null, planning: Boolean(this.active) && this.activeTarget === rec,
      navigation: navigation(rec.journey, context, rec.result, now, queue) };
  }
  snapshot() {
    // The journey belongs to live App + camera input; demo presets show their plan directly.
    const external = this.source === 'external', focus = external ? this.focus() : null, context = this.contextFor(focus);
    const result = this.result, now = this.now(), shown = focus?.journey ?? IDLE_JOURNEY, queue = this.queueInfo(focus);
    const journey = external ? { ...structuredClone(shown), guidance: guidance(shown, context, result, now, queue) } : null;
    return { journey, navigation: journey ? navigation(shown, context, result, now, queue) : null, source: this.source, mode: this.mode, presentation_mode: 'WEB_DEMO', simulated_vehicle: true, context,
      channels: Object.fromEntries(Object.entries(this.channels).map(([k, e]) => [k, { received_at: e.receivedAt, observed_at: e.observedAt, event_id: e.eventId }])),
      running: this.active && this.activeTarget === this.topSlot() ? this.active : null, summary: this.summary, result,
      journeys: external ? this.bookings.map(rec => this.entry(rec)) : [] };
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

  // --- journeys ------------------------------------------------------------------------------------------------------
  applyJourney(rec, next) {
    const comparable = j => Object.fromEntries(Object.entries(j).filter(([key]) => !['revision', 'updated_at'].includes(key)));
    if (JSON.stringify(comparable(next)) === JSON.stringify(comparable(rec.journey))) return false;
    const wasComplete = rec.journey.completed;
    rec.journey = { ...next, revision: ++this.journeyRevision, updated_at: this.now() };
    if (!wasComplete && next.completed && next.boarding_target) {
      // Simulated reservation, NOT physical occupancy or an authorization to depart.
      if (next.boarding_target.type === 'SEAT') this.cabin.occupied_seat_ids = [...new Set([...this.cabin.occupied_seat_ids, next.boarding_target.id])];
      else this.cabin.wheelchair_bay_occupied = true;
      // A stroller consumes both its parking space and the accompanying person's nearby seat.
      if (next.equipment_target?.type === 'WHEELCHAIR_BAY') this.cabin.wheelchair_bay_occupied = true;
      // The bus has boarded somebody and stays at the stop: later passengers of this list get the short arrival.
      this.busUsed = true; this.busDocked = true;
    }
    return true;
  }
  /** Back in the list as a waiting booking (keeps its age); no longer bound to the stop region. */
  unbind(rec, reason) {
    const changed = this.applyJourney(rec, { ...rec.journey, stage: 'BOOKED', labels: [], matched: false, pending_exit: false, visit_id: null, animation: null, reason });
    if (rec.id === this.currentId) { this.currentId = null; this.presence = null; }
    return changed;
  }
  /**
   * The booking leaves the list: boarded (reason null: the ON_BOARD journey and its animation stay as they are),
   * cancelled, expired, or completed (the phone reset a boarded journey: IDLE, still completed:true).
   */
  finish(rec, reason) {
    if (reason) {
      this.applyJourney(rec, { ...rec.journey, stage: 'IDLE', reason, need: null, matched: false, pending_exit: false, animation: null, boarding_target: null, equipment_target: null, seat: null });
      rec.result = null; rec.summary = null; this.loose.result = null; this.loose.summary = null;
    }
    rec.endedAt = this.now(); rec.planRevision++; rec.needsPlan = false;
    if (this.activeTarget === rec) this.dropActiveRun();
    if (rec.id === this.currentId) { this.currentId = null; this.presence = null; }
    this.lastEnded = rec;
    if (reason && !this.live().length) this.idleScreen();
  }
  /**
   * The last booking ended and nobody waits: a clean idle screen between passengers. No plan is shown and the end
   * itself does not replan; a later camera report of an aid is planned by the rules as camera-only input.
   */
  idleScreen() {
    this.loose.result = null; this.loose.summary = null; this.loose.rulesNext = false;
    this.loose.lastKey = this.looseOpen() ? this.looseKey() : null;
  }
  /** Feed one camera report to one booking (the state machine of journey.mjs); AT_STOP binds it to the stop. */
  feed(rec, report) {
    const changed = this.applyJourney(rec, advance(rec.journey, 'perception', report.payload, null, { now: this.now() }));
    if (rec.journey.stage === 'AT_STOP') this.currentId = rec.id;
    const zone = report.payload.zone;
    // The journey's visit was just reported (by this signal, or by the camera report a booking took over).
    if (rec.id === this.currentId && zone?.visit_id && zone.visit_id === rec.journey.visit_id) this.presence = { visit_id: zone.visit_id, at: report.receivedAt };
    return changed;
  }
  /** The camera's latest report if it is a recent occupied-region report (enter or heartbeat). */
  freshReport() {
    const seen = this.channels.perception;
    return seen?.payload.zone?.triggered === true && this.now() - seen.receivedAt <= PRESENCE_MS ? seen : null;
  }
  /**
   * Which waiting booking a report concerns while nobody is in progress. One booking: that one, whatever the aid
   * (an unmatched aid shows as unmatched, as before the list). Several: the oldest whose visible aid is reported;
   * a need without a visible aid (e.g. HEARING_ASSISTANCE) is served when it is the only booking waiting.
   */
  pick(labels) {
    const pool = this.pool();
    if (pool.length === 1) return pool[0];
    return pool.find(rec => rec.journey.stage === 'BOOKED' && visibleMatch(rec.need, labels)) ?? null;
  }
  /** Hub receive time of the last signal about the visit an AT_STOP journey waits on, or null when not timed. */
  presenceAt() {
    const j = this.current()?.journey;
    if (!j || j.stage !== 'AT_STOP' || j.pending_exit || j.completed || !j.visit_id || this.presence?.visit_id !== j.visit_id) return null;
    return this.presence.at;
  }
  /** Nobody on the way and nobody boardable waiting: the next passenger is met by a fresh simulated bus. */
  freshBus() {
    this.busId++; this.busUsed = false; this.busDocked = false; this.cabin = structuredClone(fixture.vehicle_context.cabin);
    // Bookings that found no place on the previous bus are planned again for this one (one more planner call each).
    for (const rec of this.live()) {
      rec.bus = this.busId;
      if (!noPlace(rec)) continue;
      rec.result = null; rec.summary = null; rec.needsPlan = true; rec.rulesNext = false; rec.planRevision++;
      this.applyJourney(rec, { ...rec.journey, reason: 'booked' });
    }
  }
  /** Apply the list rules after anything changed. Returns true when a journey changed. */
  evaluate() {
    if (this.source !== 'external') return false;
    let changed = false;
    const now = this.now(), cur = this.current();
    if (cur) {
      if (cur.journey.completed) {
        this.finish(cur, null); changed = true; // boarded: the stop is free for the next passenger at once
      } else if (cur.journey.stage !== 'AT_STOP') {
        this.currentId = null; this.presence = null; // walked off or presence lost: waiting again, keeping its age
      } else if (!boardable(cur)) {
        changed = this.unbind(cur, noPlace(cur) ? 'no_place' : 'booked') || changed; // its plan offers no place: the operator decides
      } else if (!holdsStop(cur.journey) && this.pool().length > 1) {
        changed = this.unbind(cur, 'booked') || changed; // an unmatched aid at the stop must not keep the others waiting
      }
    }
    if (!this.current() && this.busUsed && !this.pool().length && this.live().some(noPlace)) { this.freshBus(); changed = true; }
    if (!this.current()) {
      // Nobody in progress: the camera's latest report (a recent heartbeat) may already show the next passenger.
      const report = this.freshReport(), pick = report && this.pick(confirmedLabels(report.payload));
      if (pick?.journey.stage === 'BOOKED') changed = this.feed(pick, report) || changed;
    }
    // Waiting bookings: tell a passenger seen at the stop that another passenger is boarding; flag no place.
    const holder = this.current(), seen = holder && holdsStop(holder.journey) ? this.freshReport() : null;
    const labels = seen ? confirmedLabels(seen.payload) : [];
    for (const rec of this.live()) {
      if (rec === holder || rec.journey.stage !== 'BOOKED') continue;
      const reason = noPlace(rec) ? 'no_place' : visibleMatch(rec.need, labels) ? 'waiting_turn'
        : ['no_place', 'waiting_turn'].includes(rec.journey.reason) ? 'booked' : rec.journey.reason;
      if (reason !== rec.journey.reason) changed = this.applyJourney(rec, { ...rec.journey, reason }) || changed;
    }
    const kept = this.bookings.filter(rec => rec.endedAt === null || now - rec.endedAt < FINISHED_RETAIN_MS);
    if (kept.length !== this.bookings.length) { this.bookings = kept; changed = true; }
    return changed;
  }
  /** TTL and plan/arrival/boarding progress of every live booking. */
  progress() {
    let changed = false;
    const now = this.now();
    for (const rec of this.live()) {
      // The TTL is frozen while a matched passenger is at the stop; back in BOOKED it counts from the booking again.
      const atStop = rec.id === this.currentId && rec.journey.stage === 'AT_STOP' && rec.journey.matched;
      if (!rec.journey.completed && !atStop && now - rec.observedAt >= BOOKING_TTL_MS) { this.finish(rec, 'expired'); changed = true; }
      else changed = this.applyJourney(rec, reconcile(rec.journey, rec.result, now, { docked: this.busDocked && rec.bus === this.busId })) || changed;
    }
    return changed;
  }
  armJourneyTimers() {
    this.journeyTimers.forEach(clearTimeout); this.journeyTimers = [];
    if (this.source !== 'external') return;
    const times = [], animation = this.current()?.journey.animation;
    for (const rec of this.live()) if (!rec.journey.completed) times.push(rec.observedAt + BOOKING_TTL_MS);
    const seenAt = this.presenceAt();
    if (seenAt !== null) times.push(seenAt + PRESENCE_LOST_MS);
    if (animation?.phase === 'arrival') {
      if (!animation.docked) times.push(animation.started_at + DOCK_MS);
      times.push(animation.started_at + animation.duration_ms);
    }
    if (this.channels.perception && this.bookings.some(rec => rec.journey.reason === 'waiting_turn')) times.push(this.channels.perception.receivedAt + PRESENCE_MS);
    for (const rec of this.bookings) if (rec.endedAt !== null) times.push(rec.endedAt + FINISHED_RETAIN_MS);
    for (const at of new Set(times.filter(at => at > this.now()))) {
      const timer = setTimeout(() => { this.tick(); this.publishState(); }, at - this.now());
      timer.unref?.(); this.journeyTimers.push(timer);
    }
  }
  tick() {
    if (this.source !== 'external') return;
    const cur = this.current(), seenAt = this.presenceAt();
    let changed = seenAt !== null && this.now() - seenAt >= PRESENCE_LOST_MS && this.applyJourney(cur, presenceLost(cur.journey, seenAt + PRESENCE_LOST_MS));
    changed = this.progress() || changed;
    // The list rules can end the journey in progress and release the next one, whose arrival then starts.
    for (let pass = 0; pass < 3 && this.evaluate(); pass++) { changed = true; this.progress(); }
    if (changed) this.publishState();
    this.armJourneyTimers();
  }

  // --- planning ------------------------------------------------------------------------------------------------------
  decisionKey(rec = null) {
    const c = this.contextFor(rec), policy = buildPolicy(c);
    return hash({ context: withoutAge(c), status: policy.plan_status, flags: policy.safety_flags, actions: policy.required_actions });
  }
  /** The loose slot plans for demo presets and when no live or boarded booking is on screen (camera only, cancelled). */
  looseOpen() {
    if (this.source !== 'external') return true;
    const focus = this.focus();
    return !focus || focus.endedAt !== null && focus.journey.stage === 'IDLE' && focus.journey.reason !== 'expired';
  }
  looseKey() { return `${this.mode}:${this.decisionKey(this.source === 'external' ? this.focus() : null)}`; }
  /** The next planner run: the oldest booking that needs its plan, else the loose slot when its input changed. */
  nextTarget(force) {
    if (this.source === 'external') {
      const focus = this.focus();
      const rec = this.live().find(r => r.needsPlan && !r.journey.completed)
        ?? (force && focus?.endedAt === null && !focus.journey.completed ? focus : null); // the operator's rerun of the booking on screen
      if (rec) return { rec, mode: rec.rulesNext ? 'rules' : this.mode };
      if (boarded(focus)) return null;
    }
    if (!this.looseOpen() || !force && this.looseKey() === this.loose.lastKey) return null;
    return { rec: null, mode: this.loose.rulesNext ? 'rules' : this.mode };
  }
  planNeeded() { return Boolean(this.nextTarget(false)); }
  /** Abandon the planner call in flight; its result will not overwrite the current state. */
  dropActiveRun() {
    if (!this.active) return;
    const target = this.activeTarget, shown = target === this.topSlot();
    this.publish(shown ? 'cancelled' : 'journey_cancelled', { run_id: this.active, message: 'Inputs changed. The previous result will not overwrite the current state.', ...(target !== this.loose ? { journey_id: target.id } : {}) });
    if (target !== this.loose && target.endedAt === null && !target.result) target.needsPlan = true;
    this.active = null; this.activeTarget = null;
  }
  receive(channel, envelope) {
    if (!KEYS[channel] || !envelope || typeof envelope !== 'object') throw new Error('INVALID_SIGNAL');
    const eventId = envelope.event_id;
    if (typeof eventId !== 'string' || !ID.test(eventId)) throw new Error('INVALID_EVENT_ID');
    const observedAt = typeof envelope.observed_at === 'string' ? Date.parse(envelope.observed_at) : NaN;
    if (!Number.isFinite(observedAt) || observedAt > this.now() + 5000) throw new Error('INVALID_OBSERVED_AT');
    const normalized = normalizeInput({ request_id: eventId, [KEYS[channel]]: envelope.payload });
    const payload = normalized[KEYS[channel]];
    if (!payload) throw new Error('PAYLOAD_REQUIRED');
    const contentHash = hash({ channel, envelope });
    const duplicate = this.seen.get(eventId);
    if (duplicate) {
      if (duplicate !== contentHash) throw new Error('EVENT_ID_CONFLICT');
      return { accepted: true, duplicate: true, changed: false, ...this.bookingInfo(eventId) };
    }
    const external = this.source === 'external';
    let cancelled = null;
    if (channel === 'perception' && external && this.channels.perception && observedAt < this.channels.perception.observedAt) throw new Error('OUT_OF_ORDER_SIGNAL');
    if (channel === 'booking' && external && isBoarding(payload)) {
      // One live booking per need: on site the aid category identifies the passenger to the camera.
      const need = payload.accessibility_need ?? 'UNKNOWN', existing = this.live().find(rec => rec.need === need);
      if (existing) throw Object.assign(new Error('NEED_ALREADY_BOOKED'), { need, existing_journey_id: existing.id });
    } else if (channel === 'booking' && external) {
      cancelled = this.cancelTarget(payload, envelope);
      if (cancelled && observedAt < cancelled.observedAt) throw new Error('OUT_OF_ORDER_SIGNAL');
    }
    this.seen.set(eventId, contentHash);
    if (this.seen.size > 512) this.seen.delete(this.seen.keys().next().value);
    const before = this.looseOpen() ? this.looseKey() : null, seenBefore = hash(withoutAge(this.channels.perception?.payload ?? null));
    // External App/YOLO events replace preset inputs; the simulator remains local.
    if (this.source === 'demo') { this.channels = {}; this.demoContext = null; this.loose = { result: null, summary: null, lastKey: null, rulesNext: false }; }
    this.source = 'external';
    const entry = { payload, observedAt, receivedAt: this.now(), eventId };
    this.channels[channel] = entry;
    let changed = true, rec = null;
    if (channel === 'booking' && isBoarding(payload)) rec = this.addBooking(entry);
    else if (channel === 'booking') {
      changed = Boolean(cancelled) || !this.live().length && !this.lastEnded;
      if (cancelled) this.endBooking(cancelled);
      if (changed && !this.live().length) this.idleScreen();
    } else changed = this.perceive(entry, before, seenBefore !== hash(withoutAge(payload)));
    this.tick();
    this.publish('signal', { channel, event_id: eventId, changed, snapshot: this.snapshot() });
    this.publishState();
    if (this.autoRun && this.planNeeded()) this.schedule();
    if (rec) return { accepted: true, duplicate: false, changed: true, ...this.bookingInfo(rec.id) };
    return { accepted: true, duplicate: false, changed, ...(channel === 'booking' ? { journey_id: cancelled?.id ?? null } : {}) };
  }
  bookingInfo(id) {
    const rec = this.bookings.find(r => r.id === id);
    return rec ? { journey_id: rec.id, queued: rec.endedAt === null && rec.id !== this.currentId, position: this.positionOf(rec) } : {};
  }
  /**
   * Which booking an `active:false` booking ends: the one named by `cancels` (payload or envelope); else the live one
   * with the payload's accessibility_need if exactly one; else the journey in progress, the only live booking, or the
   * boarded journey on screen. An unknown or already ended booking: none (accepted, nothing changes).
   */
  cancelTarget(request, envelope) {
    const live = this.live(), focus = this.focus();
    const cancels = request.cancels ?? (typeof envelope.cancels === 'string' && ID.test(envelope.cancels) ? envelope.cancels : null);
    if (cancels) return [...live, ...this.bookings.filter(boarded), ...(boarded(this.lastEnded) ? [this.lastEnded] : [])].find(rec => rec.id === cancels) ?? null;
    const same = request.accessibility_need ? live.filter(rec => rec.need === request.accessibility_need) : [];
    if (same.length === 1) return same[0];
    return this.current() ?? (live.length === 1 ? live[0] : null) ?? (boarded(focus) ? focus : null);
  }
  /**
   * The phone's cancel. Before boarding: an ordinary cancel ('cancelled'). After boarding it is the phone's reset
   * ("next passenger"): the journey ends at once as 'completed' and, if nobody waits, the simulated bus is fresh.
   */
  endBooking(rec) {
    if (!boarded(rec)) return this.finish(rec, 'cancelled');
    this.finish(rec, 'completed');
    if (!this.live().length) this.freshBus();
  }
  addBooking(entry) {
    // The list is empty and nobody is in progress: after a bus was used, the passenger is met by a fresh one.
    if (!this.current() && this.busUsed && !this.pool().length) this.freshBus();
    const rec = { id: entry.eventId, seq: ++this.bookingSeq, need: entry.payload.accessibility_need ?? 'UNKNOWN', payload: entry.payload,
      observedAt: entry.observedAt, receivedAt: entry.receivedAt, bus: this.busId, journey: null, result: null, summary: null,
      needsPlan: true, rulesNext: false, planRevision: 0, endedAt: null };
    rec.journey = { ...advance(IDLE_JOURNEY, 'booking', entry.payload, null, { eventId: entry.eventId, now: this.now() }), revision: ++this.journeyRevision };
    this.bookings.push(rec);
    // A live camera runs before any booking: the passenger may already be standing in the region, so its enter
    // was ignored. evaluate() takes over that visit from the camera's latest report, if it is a recent heartbeat.
    this.evaluate();
    return rec;
  }
  /** A camera report: the journey in progress gets it; while nobody is in progress it may release a waiting booking. */
  perceive(entry, before, news) {
    const cur = this.current();
    if (cur && (holdsStop(cur.journey) || this.pool().length <= 1)) this.feed(cur, entry);
    else {
      if (cur) this.unbind(cur, 'booked');
      const pick = this.pick(confirmedLabels(entry.payload));
      if (pick) this.feed(pick, entry);
    }
    // The plan is made when the booking arrives. What the camera sees afterwards is only checked
    // against it by the local rules: if the plan still holds it stays (nothing to wait for when the
    // passenger reaches the stop); if not, the rules replan at once, without a model call.
    // Heartbeats that repeat the same observation (ages and confidences aside) change nothing.
    let changed = false;
    for (const rec of news ? this.live() : []) {
      if (rec.journey.completed || !rec.result || this.activeTarget === rec) continue;
      if (!revalidateForSimulation(rec.result, { ...this.contextFor(rec), request_id: rec.result.request_id }).valid) {
        rec.result = null; rec.summary = null; rec.needsPlan = true; rec.rulesNext = true; changed = true;
      }
    }
    if (this.looseOpen()) {
      const key = this.looseKey();
      if (key !== before) {
        const loose = this.loose;
        if (this.activeTarget === loose || loose.result && revalidateForSimulation(loose.result, { ...this.contextFor(this.focus()), request_id: loose.result.request_id }).valid) loose.lastKey = key;
        else { loose.rulesNext = true; loose.result = null; loose.summary = null; changed = true; }
      }
    }
    return changed;
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
      this.mode = mode; this.loose.rulesNext = false; this.loose.lastKey = null;
      const focus = this.source === 'external' ? this.focus() : null;
      if (!boarded(focus)) {
        // A new mode replans the plan on screen (on the next run); a boarded journey keeps its plan.
        this.revision++; this.dropActiveRun();
        if (focus?.endedAt === null) { focus.result = null; focus.summary = null; focus.needsPlan = true; focus.rulesNext = false; }
        else { this.loose.result = null; this.loose.summary = null; }
        this.tick();
      }
      this.publish('settings', { mode }); this.publishState();
    }
  }
  loadDemo(raw, mode) {
    const c = normalizeInput({ ...raw, presentation_mode: 'WEB_DEMO' });
    this.setMode(mode); clearTimeout(this.timer); this.revision++; this.dropActiveRun();
    this.source = 'demo'; this.demoContext = c; this.channels = {}; this.loose = { result: null, summary: null, lastKey: null, rulesNext: false };
    this.bookings = []; this.currentId = null; this.lastEnded = null; this.presence = null;
    this.armJourneyTimers();
    for (const [name, key] of Object.entries(KEYS)) if (c[key]) this.channels[name] = { payload: c[key], observedAt: this.now(), receivedAt: this.now(), eventId: c.request_id };
    this.publishState();
    return this.run({ force: true });
  }
  async run({ force = false } = {}) {
    clearTimeout(this.timer); this.tick();
    const target = this.nextTarget(force);
    if (!target) return { skipped: true };
    if (this.active) throw new Error('RUN_IN_PROGRESS');
    const { rec, mode } = target, slot = rec ?? this.loose;
    const c = this.contextFor(rec), policy = buildPolicy(c);
    const localOnly = mode === 'rules' || ['emergency', 'wait'].includes(policy.scenario);
    if (!localOnly && this.pendingCalls >= 2) throw new Error('PLANNER_BUSY');
    if (rec) { rec.needsPlan = false; rec.rulesNext = false; } else { this.loose.rulesNext = false; this.loose.lastKey = this.looseKey(); }
    const runId = `run-${randomUUID()}`, revision = this.revision, planRevision = rec?.planRevision;
    const about = rec ? { journey_id: rec.id } : {};
    // Events of the top-level plan keep their names; a plan for another booking of the list uses journey_* events.
    const name = type => slot === this.topSlot() ? type : `journey_${type}`;
    const stale = () => this.active !== runId || revision !== this.revision || (rec && rec.planRevision !== planRevision);
    c.request_id = runId; this.active = runId; this.activeTarget = slot; slot.summary = null; slot.result = null;
    this.publish(name('planning'), { run_id: runId, mode, source: this.source, context: c, ...about });
    this.pendingCalls++;
    try {
      let result = await this.planner(c, { mode, onSummary: summary => {
        if (stale()) return;
        slot.summary = summary; this.publish(name('summary'), { run_id: runId, summary, ...about });
      } });
      this.tick();
      if (stale()) return { discarded: true };
      // A CV observation during the model call must not cancel that first call. Check the
      // completed output against the newest trusted snapshot before publishing navigation.
      const fresh = { ...this.contextFor(rec), request_id: runId };
      if (mode !== 'rules' && result.plan_status === 'READY' && !revalidateForSimulation(result, fresh).valid) {
        const original = result.meta;
        result = await plan(fresh, { mode: 'rules' });
        result.meta = { ...result.meta, source: 'runtime_safe_revalidation', original_model: original };
      }
      this.tick();
      if (stale()) return { discarded: true };
      this.active = null; this.activeTarget = null; slot.result = result;
      if (!rec) this.loose.lastKey = this.looseKey();
      this.tick();
      slot.summary ??= { request_id: runId, decision_summary: result.decision_summary };
      this.publish(name('result'), { run_id: runId, result, snapshot: this.snapshot(), ...about });
      this.publishState();
      return result;
    } catch {
      if (this.active === runId) {
        this.active = null; this.activeTarget = null; slot.result = null;
        if (rec) rec.needsPlan = rec.endedAt === null; else this.loose.lastKey = null;
        this.tick(); this.publish(name('failure'), { run_id: runId, message: 'Planning did not complete. Please retry or ask the safety operator.', ...about }); this.publishState();
      }
      throw new Error('PLANNING_FAILED');
    } finally {
      this.pendingCalls--;
      if (this.autoRun && !this.active && this.planNeeded()) this.schedule();
    }
  }
  close() { clearTimeout(this.timer); this.journeyTimers.forEach(clearTimeout); this.removeAllListeners(); }
}
