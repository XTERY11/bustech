"""Pre-rehearsal check: drive a running hub exactly like the LIVE camera bridge would, with no camera and no YOLO.

replay_bridge.py starts a pre-cut clip after the booking, which is the easy case. A real camera runs all the
time and knows nothing about bookings: the passenger may already be standing in the region when the booking
arrives, strangers pass through before and after, people walk off sideways, the bridge restarts, clocks differ.
This script plays those situations against a hub, one scenario at a time, with the payloads of
yolo_bridge.perception_payload sent through the same ordered queue (ride_signal_client.OrderedSignalQueue):
'enter', a 'present' heartbeat every 2 s while the region is occupied, and 'exit' 2 s after the last person left
(with zone.left / boarding / dwell_seconds as the bridge computes them). It prints a timeline of the journey and
PASS/FAIL per scenario; the exit code is non-zero when one fails. It starts nothing itself and posts real
bookings, so point it at a hub nobody is presenting from:

    cd dashboard && BRIDGE_PORT=8887 node backend/server.mjs        # a spare hub (rules or LLM mode)
    cd vision && .venv/bin/python rehearse_live.py --bridge-url http://127.0.0.1:8887
    .venv/bin/python rehearse_live.py --bridge-url ... --only already_in_region walked_off_sideways

Waits are real (bus arrival 10 s, empty region 2 s); the whole run takes about 3 minutes.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from urllib import request

from ride_signal_client import OrderedSignalQueue, RideSignalClient
from yolo_bridge import perception_payload

HEARTBEAT, EXIT_SECONDS, MIN_DWELL = 2.0, 2.0, 2.0  # yolo_bridge.py defaults
ARRIVAL = 10.0                                     # journey.mjs ARRIVAL_MS


def booking(need):
    return {'active': True, 'intent': 'BOARDING', 'route_id': 'DEMO_ROUTE', 'stop_id': 'DEMO_STOP', 'accessibility_need': need,
            'ramp_preference': 'REQUESTED' if need == 'WHEELCHAIR' else 'UNSPECIFIED',
            'assistance_requested': ['WHEELCHAIR_RAMP'] if need == 'WHEELCHAIR' else ['ADDITIONAL_BOARDING_TIME'],
            'preferred_interaction': 'BOTH', 'language': 'en-SG'}


class Timeline:
    """Polls GET /api/state and prints every change of the fields the App and dashboard act on."""
    FIELDS = ('stage', 'matched', 'pending_exit', 'reason', 'seat', 'phase', 'visit')

    def __init__(self, base, token):
        self.base, self.headers = base.rstrip('/'), ({'Authorization': f'Bearer {token}'} if token else {})
        self.start, self.row, self.snapshot, self.lock = time.monotonic(), None, {}, threading.Lock()
        threading.Thread(target=self._run, daemon=True).start()

    def t(self):
        return f'{time.monotonic() - self.start:6.1f}s'

    def say(self, text):
        print(f'  {self.t()}  {text}', flush=True)

    def fetch(self):
        with request.urlopen(request.Request(self.base + '/api/state', headers=self.headers), timeout=3) as reply:
            return json.load(reply)

    def _run(self):
        while True:
            try:
                snapshot = self.fetch()
            except OSError as failure:
                self.say(f'hub unreachable: {failure}'); time.sleep(1); continue
            j, n = snapshot.get('journey') or {}, snapshot.get('navigation') or {}
            row = dict(zip(self.FIELDS, (j.get('stage'), j.get('matched'), j.get('pending_exit'), j.get('reason'), j.get('seat'), n.get('phase'), j.get('visit_id'))))
            with self.lock:
                self.snapshot = snapshot
                if row != self.row:
                    self.row = row
                    self.say('HUB    ' + '  '.join(f'{k}={v}' for k, v in row.items()))
            time.sleep(0.2)

    def now(self):
        with self.lock:
            return self.snapshot, dict(self.row or {})


class Camera:
    """What yolo_bridge.py posts for one region, without frames. `skew` shifts this camera's clock."""

    def __init__(self, base, token, timeline, roi_id='monitor_roi', skew=0.0):
        self.base, self.token, self.timeline, self.roi_id, self.skew = base, token, timeline, roi_id, skew
        self.lock = threading.Lock()
        self.held, self.visit, self.entered_at, self.last_beat, self.leaving = [], None, None, 0.0, False
        self.queue = self._new_queue()
        self.alive = True
        threading.Thread(target=self._heartbeats, daemon=True).start()

    def _new_queue(self):
        queue = OrderedSignalQueue(RideSignalClient(self.base, self.token), on_drop=lambda failure: self.timeline.say(f'CAMERA signal dropped by the queue: {failure}'))
        queue.start()
        return queue

    def _post(self, reason, left=None, intent=None):
        payload = perception_payload([] if reason == 'exit' else self.held, reason, self.roi_id, self.visit, left, intent)
        observed = (datetime.now(timezone.utc) + timedelta(seconds=self.skew)).isoformat()
        self.queue.enqueue('perception', payload, observed_at=observed)
        labels = [(d['label'], d['confidence']) for d in self.held] if reason != 'exit' else left
        self.timeline.say(f'CAMERA {payload["zone"]["event"]:7s} visit={self.visit} {labels} {intent or ""}')
        self.last_beat = time.monotonic()

    def _heartbeats(self):
        while self.alive:
            with self.lock:
                if self.visit and time.monotonic() - self.last_beat >= HEARTBEAT:
                    self._post('heartbeat')
            time.sleep(0.05)

    def enter(self, label, confidence=0.92):
        """An aid reaches the region (the bridge triggers after 0.3 s): a new visit and its 'enter'."""
        with self.lock:
            assert not self.visit, 'the region is already occupied; use see() for a second aid'
            self.visit, self.entered_at = uuid.uuid4().hex[:12], time.monotonic()
            self.held = [{'label': label, 'confidence': confidence}]
            self._post('enter')

    def see(self, label, confidence=0.92, replace=False):
        """What is detected in the occupied region changes (no new post: the next heartbeat carries it).
        Like the bridge, each label keeps the best confidence seen in this visit."""
        with self.lock:
            best = {d['label']: d['confidence'] for d in self.held}
            current = [] if replace else [d for d in self.held if d['label'] != label]
            self.held = sorted(current + [{'label': label, 'confidence': max(confidence, best.get(label, 0))}], key=lambda d: d['label'])

    def leave(self, boarding=True):
        """Everybody leaves the region now; the bridge posts 'exit' once it has been empty for 2 s (heartbeats go on
        meanwhile). boarding: what boarding_intent() would say from the trail; a stay under 2 s is always False."""
        left_at = time.monotonic()
        time.sleep(EXIT_SECONDS)
        with self.lock:
            dwell = left_at - self.entered_at
            intent = {'boarding': False if dwell < MIN_DWELL else boarding, 'dwell_seconds': round(dwell, 1)}
            self._post('exit', sorted({d['label'] for d in self.held}), intent)
            self.held, self.visit = [], None

    def restart(self, startup=2.0):
        """The bridge process is restarted: unsent signals and the current visit are lost (no exit)."""
        with self.lock:
            unsent = self.queue.close()
            self.timeline.say(f'CAMERA bridge restarted ({unsent} unsent signals lost, visit {self.visit} forgotten)')
            self.held, self.visit = [], None
        time.sleep(startup)
        self.queue = self._new_queue()

    def drain(self, timeout=5):
        deadline = time.monotonic() + timeout
        while self.queue.diagnostics()['pending_signals'] and time.monotonic() < deadline:
            time.sleep(0.05)
        return self.queue.diagnostics()

    def close(self):
        self.alive = False
        self.queue.close()


class Rehearsal:
    def __init__(self, base, token):
        self.base, self.token = base.rstrip('/'), token
        self.app = RideSignalClient(self.base, token)
        self.timeline = Timeline(self.base, token)
        self.camera = None

    # -- App side ---------------------------------------------------------------------------------------------
    def book(self, need):
        self.timeline.say(f'APP    booking {need}')
        return self.app.signal('booking', booking(need))

    def cancel(self):
        return self.app.signal('booking', {'active': False})

    # -- checks -----------------------------------------------------------------------------------------------
    def expect(self, what, check, timeout=4.0):
        """Wait until check(journey row, snapshot) is true; fail the scenario otherwise."""
        deadline = time.monotonic() + timeout
        while True:
            snapshot, row = self.timeline.now()
            if row and check(row, snapshot):
                self.timeline.say(f'ok     {what}')
                return snapshot
            if time.monotonic() > deadline:
                raise AssertionError(f'{what} (journey: {row})')
            time.sleep(0.1)

    def hold(self, what, check, seconds):
        """check must stay true for `seconds`."""
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            snapshot, row = self.timeline.now()
            if not check(row, snapshot):
                raise AssertionError(f'{what} (journey: {row})')
            time.sleep(0.1)
        self.timeline.say(f'ok     {what} for {seconds:.0f} s')

    def ready(self, timeout=60):
        return self.expect('plan READY', lambda r, s: (s.get('result') or {}).get('plan_status') == 'READY'
                           and (s.get('journey') or {}).get('journey_id') == (s.get('channels', {}).get('booking') or {}).get('event_id'), timeout)

    def at_stop(self, matched=True, timeout=4.0):
        return self.expect(f'AT_STOP matched={matched}', lambda r, _: r['stage'] == 'AT_STOP' and r['matched'] is matched
                           and r['visit'] == self.camera.visit, timeout)

    def boarded(self, timeout=ARRIVAL + 3, seat_type=None):
        snapshot = self.expect('ON_BOARD with a seat', lambda r, _: r['stage'] == 'ON_BOARD' and r['seat'] and r['phase'] in ('TO_SEAT', 'TO_WHEELCHAIR_BAY'), timeout)
        if seat_type:
            assert snapshot['journey']['boarding_target']['type'] == seat_type, snapshot['journey']['boarding_target']
        return snapshot

    def booked(self, reason=None, timeout=4.0):
        return self.expect(f'back to BOOKED{f" ({reason})" if reason else ""}', lambda r, _: r['stage'] == 'BOOKED' and not r['matched']
                           and r['phase'] == 'TO_STOP' and (reason is None or r['reason'] == reason), timeout)

    # -- scenarios ---------------------------------------------------------------------------------------------
    def baseline(self):
        """Replay-like order: booking, then one visit of the booked aid; leaves before the bus has arrived."""
        self.book('WHEELCHAIR'); self.ready()
        self.camera.enter('WHEELCHAIR'); self.at_stop()
        time.sleep(3); self.camera.leave()
        self.expect('pending_exit while the bus is still arriving', lambda r, _: r['pending_exit'] is True and r['phase'] == 'WAIT_AT_STOP')
        self.boarded(seat_type='WHEELCHAIR_BAY')

    def already_in_region(self):
        """The passenger is standing in the region before the booking is sent: only heartbeats follow it."""
        self.camera.enter('CANE')
        time.sleep(2.5)
        self.expect('the enter before any booking is ignored', lambda r, _: r['stage'] in ('IDLE', None))
        self.book('CANE'); self.ready()
        self.at_stop(timeout=HEARTBEAT + 2)  # picked up from the next 'present'
        time.sleep(2); self.camera.leave()
        self.boarded(seat_type='SEAT')

    def booked_while_leaving(self):
        """The booking arrives while the passenger is already walking to the bus: the exit is the next signal, no
        heartbeat in between (seen on real footage)."""
        self.camera.enter('WHEELCHAIR'); time.sleep(2.5)       # heartbeat at 2.0 s
        leaving = threading.Thread(target=self.camera.leave)   # heartbeat at 4.0 s, exit at 4.5 s
        leaving.start(); time.sleep(1.7)
        self.book('WHEELCHAIR')                                # at 4.2 s
        self.expect('AT_STOP from the camera report before the booking', lambda r, _: r['stage'] == 'AT_STOP' and r['matched'])
        leaving.join()
        self.boarded(seat_type='WHEELCHAIR_BAY')

    def occupied_by_other_aid(self):
        """Booking while a stroller occupies the region; it leaves, then the wheelchair arrives and boards."""
        self.camera.enter('STROLLER')
        time.sleep(1)
        self.book('WHEELCHAIR'); self.ready()
        self.at_stop(matched=False, timeout=HEARTBEAT + 2)
        self.camera.leave()  # a 3 s stay towards the bus, but it is not the booked aid
        self.booked()
        self.camera.enter('WHEELCHAIR'); self.at_stop()
        time.sleep(2.5); self.camera.leave()
        self.boarded(seat_type='WHEELCHAIR_BAY')

    def handover_in_one_visit(self):
        """A stroller is waiting; the wheelchair arrives before the region was ever empty: one visit, label change."""
        self.book('WHEELCHAIR'); self.ready()
        self.camera.enter('STROLLER'); self.at_stop(matched=False)
        time.sleep(1); self.camera.see('WHEELCHAIR')
        self.at_stop(matched=True, timeout=HEARTBEAT + 1.5)
        time.sleep(1); self.camera.leave()
        self.boarded(seat_type='WHEELCHAIR_BAY')

    def passers_by(self):
        """Somebody with another aid passes by first; after boarding, the next passenger does not touch the journey."""
        self.book('CANE'); self.ready()
        self.camera.enter('STROLLER'); time.sleep(0.8); self.camera.leave()  # short stay: boarding False
        self.booked()
        self.camera.enter('CANE'); self.at_stop(); time.sleep(2.5); self.camera.leave()
        snapshot = self.boarded(seat_type='SEAT')
        revision, animation = snapshot['journey']['revision'], snapshot['journey']['animation']['id']
        self.camera.enter('WHEELCHAIR'); time.sleep(2.5)
        self.hold('next passenger leaves the completed journey alone', lambda r, s: r['stage'] == 'ON_BOARD'
                  and s['journey']['revision'] == revision and s['journey']['animation']['id'] == animation, 1)
        self.camera.leave()

    def walked_off_sideways(self):
        """Waited, then left another way (boarding false): wait again; comes back and boards."""
        self.book('STROLLER'); self.ready()
        self.camera.enter('STROLLER'); self.at_stop(); time.sleep(3)
        self.camera.leave(boarding=False)
        self.booked('not_boarding')
        self.camera.enter('STROLLER'); self.at_stop(); time.sleep(2.5); self.camera.leave()
        self.boarded(seat_type='SEAT')

    def too_short_stay(self):
        """Steps in and out in under 2 s (the bridge reports boarding false): not boarded."""
        self.book('CANE'); self.ready()
        self.camera.enter('CANE'); self.at_stop(); time.sleep(1); self.camera.leave()
        self.booked('not_boarding')

    def back_during_pending_exit(self):
        """Left towards the bus before it arrived, then came back into the region before the 10 s were over."""
        self.book('CANE'); self.ready()
        self.camera.enter('CANE'); self.at_stop(); time.sleep(2.2); self.camera.leave()
        self.expect('pending_exit', lambda r, _: r['pending_exit'] is True)
        self.camera.enter('CANE')
        # Product decision (see report): today the re-entry is ignored and the journey boards anyway.
        self.boarded()
        self.camera.leave()

    def low_confidence(self):
        """The aid is first seen below the hub's 0.75 gate; a better view later in the same visit matches."""
        self.book('WHEELCHAIR'); self.ready()
        self.camera.enter('WHEELCHAIR', confidence=0.6); self.at_stop(matched=False)
        self.expect('phone says "confirming", not "does not match"', lambda r, s: 'confirming' in s['journey']['guidance']['display_text'])
        self.camera.see('WHEELCHAIR', confidence=0.83)
        self.at_stop(matched=True, timeout=HEARTBEAT + 1.5)
        self.camera.see('WHEELCHAIR', confidence=0.5)  # half hidden again: the visit keeps its best score
        time.sleep(2.5); self.camera.leave()
        self.boarded(seat_type='WHEELCHAIR_BAY')

    def bridge_restart_mid_visit(self):
        """The bridge restarts while the passenger waits: a new visit id for the same person; its exit boards."""
        self.book('CANE'); self.ready()
        self.camera.enter('CANE'); self.at_stop()
        self.camera.restart()
        self.camera.enter('CANE'); self.at_stop()
        time.sleep(2.5); self.camera.leave()
        self.boarded()

    def lost_exit(self):
        """The bridge restarts after the passenger has left, so no exit ever comes; the next visit takes over."""
        self.book('WHEELCHAIR'); self.ready()
        self.camera.enter('WHEELCHAIR'); self.at_stop(); time.sleep(1)
        self.camera.restart(startup=0.5)
        # Product decision (see report): without heartbeats the journey stays AT_STOP (until the next visit or the
        # 5 min booking TTL); the bus is shown as arrived and waiting.
        self.hold('no heartbeats: still AT_STOP', lambda r, _: r['stage'] == 'AT_STOP', 5)
        self.camera.enter('WHEELCHAIR'); self.at_stop(); time.sleep(2.5); self.camera.leave()
        self.boarded()

    def camera_clock_skew(self):
        """Camera clock 6 s ahead of the hub: rejected, but must not block the queue; 3 s ahead works."""
        self.book('CANE'); self.ready()
        fast = Camera(self.base, self.token, self.timeline, skew=6.0)
        try:
            fast.enter('CANE')
            diagnostics = fast.drain()
            assert diagnostics['pending_signals'] == 0, f'a rejected signal blocks the queue: {diagnostics}'
            assert (diagnostics['signal_error'] or {}).get('code') == 'INVALID_OBSERVED_AT', diagnostics
            self.timeline.say(f'ok     6 s ahead: dropped, visible in /health signal_error {diagnostics["signal_error"]}')
            self.hold('6 s ahead: the journey did not move', lambda r, _: r['stage'] == 'BOOKED', 1)
        finally:
            fast.close()
        self.camera.skew = 3.0
        self.camera.enter('CANE'); self.at_stop(); time.sleep(2.5); self.camera.leave()
        self.boarded()

    SCENARIOS = ['baseline', 'already_in_region', 'booked_while_leaving', 'occupied_by_other_aid', 'handover_in_one_visit', 'passers_by',
                 'walked_off_sideways', 'too_short_stay', 'back_during_pending_exit', 'low_confidence',
                 'bridge_restart_mid_visit', 'lost_exit', 'camera_clock_skew']

    def reset(self):
        """No booking and an empty region before each scenario."""
        if self.camera:
            self.camera.close()
        self.cancel()
        self.expect('reset: no booking', lambda r, _: r['stage'] == 'IDLE', 10)
        self.camera = Camera(self.base, self.token, self.timeline)

    def run(self, names):
        results = []
        for name in names:
            doc = getattr(self, name).__doc__.split('\n')[0]
            print(f'\n=== {name}: {doc}', flush=True)
            self.timeline.start = time.monotonic()
            try:
                self.reset()
                getattr(self, name)()
                ok, why = True, ''
            except Exception as failure:  # AssertionError, or a hub error from a booking
                ok, why = False, f'{type(failure).__name__}: {failure}'
            if self.camera and self.camera.visit:
                self.camera.restart(startup=0)
            print(f'--- {"PASS" if ok else "FAIL"} {name} {why}', flush=True)
            results.append((name, ok, why))
        if self.camera:
            self.camera.close()
        self.cancel()
        return results


def clock_offset(base, token):
    """Hub clock minus this machine's clock, from the Date header of /api/health (1 s resolution)."""
    sent = time.time()
    with request.urlopen(request.Request(base.rstrip('/') + '/api/health', headers={'Authorization': f'Bearer {token}'} if token else {}), timeout=3) as reply:
        hub = parsedate_to_datetime(reply.headers['Date']).timestamp()
    return hub - (sent + time.time()) / 2


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--bridge-url', default=os.getenv('RIDE_BRIDGE_URL', 'http://127.0.0.1:8787'), help='Signal hub base URL')
    p.add_argument('--bridge-token', default=os.getenv('BRIDGE_TOKEN', ''))
    p.add_argument('--only', nargs='+', choices=Rehearsal.SCENARIOS, help='Run these scenarios only')
    args = p.parse_args()
    offset = clock_offset(args.bridge_url, args.bridge_token)
    print(f'Hub {args.bridge_url}: its clock is {offset:+.1f} s from this machine (the hub rejects camera times more than 5 s ahead)', flush=True)
    rehearsal = Rehearsal(args.bridge_url, args.bridge_token)
    started = time.monotonic()
    results = rehearsal.run(args.only or Rehearsal.SCENARIOS)
    print(f'\nSummary ({time.monotonic() - started:.0f} s):')
    for name, ok, why in results:
        print(f'  {"PASS" if ok else "FAIL"}  {name}  {why}')
    sys.exit(0 if all(ok for _, ok, _ in results) else 1)


if __name__ == '__main__':
    main()
