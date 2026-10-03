"""Python -> AccessRide JSON signals. Standard library only; no DeepSeek key here."""
from __future__ import annotations

import json
import os
import threading
import time
import uuid
from collections import deque
from copy import deepcopy
from datetime import datetime, timezone
from urllib import error, request


class RideSignalClient:
    def __init__(self, base_url=None, token=None):
        self.base_url = (base_url or os.getenv("RIDE_BRIDGE_URL", "http://127.0.0.1:8787")).rstrip("/")
        self.token = token if token is not None else os.getenv("BRIDGE_TOKEN", "")

    def post(self, path, payload):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        # One retry with the SAME event ID/body makes signal retries idempotent.
        for attempt in range(2):
            try:
                req = request.Request(self.base_url + path, data=data, headers=headers, method="POST")
                with request.urlopen(req, timeout=5) as response:
                    return json.load(response)
            except error.HTTPError:
                raise
            except (error.URLError, TimeoutError):
                if attempt:
                    raise
                time.sleep(0.2)

    @staticmethod
    def envelope(channel, payload, *, observed_at=None, event_id=None):
        if channel not in {"booking", "perception"}:
            raise ValueError("Unknown signal channel")
        return {
            "event_id": event_id or f"{channel}-{uuid.uuid4()}",
            "observed_at": observed_at or datetime.now(timezone.utc).isoformat(),
            "payload": deepcopy(payload),
        }

    def signal(self, channel, payload, *, observed_at=None, event_id=None):
        return self.post(f"/api/{channel}", self.envelope(channel, payload, observed_at=observed_at, event_id=event_id))


def hub_error_code(failure):
    """The hub's error code from an HTTPError body ({"error": "INVALID_OBSERVED_AT"}), else None. Only a short
    upper-case code is kept, never free text."""
    try:
        code = json.loads(failure.read().decode("utf-8")).get("error")
    except Exception:
        return None
    return code if isinstance(code, str) and code.isascii() and code.replace("_", "").isalnum() and code.isupper() and len(code) <= 40 else None


def is_permanent(failure):
    """A rejection that an unchanged retry can never fix: the hub refused this envelope itself (HTTP 4xx such as
    INVALID_OBSERVED_AT, INVALID_SIGNAL, OUT_OF_ORDER_SIGNAL, EVENT_ID_CONFLICT). Not 401/403 (the token, fixed on
    the hub without touching the envelope), 408 or 429; never connection errors, timeouts or 5xx."""
    return isinstance(failure, error.HTTPError) and 400 <= failure.code < 500 and failure.code not in (401, 403, 408, 429)


class OrderedSignalQueue:
    """Retry in capture order without blocking inference or losing an enter/exit.

    Only adjacent, unsent region heartbeats for the same visit may be replaced. An
    in-flight or failed envelope stays unchanged, including its ID and timestamp.
    A transient failure (hub unreachable, timeout, 5xx, 401/403) is retried before anything
    newer; an envelope the hub rejects for good (other 4xx) is dropped, so it cannot block
    every later signal: on_drop(error) is called and diagnostics keep it as signal_error
    (with the hub's code) until a later signal is accepted, and count it in dropped_signals.
    The outbox is in memory; stopping the process does not persist pending events.
    """
    def __init__(self, client, retry_seconds=1.0, on_drop=None):
        self.client, self.retry_seconds, self.on_drop = client, retry_seconds, on_drop
        self._queue = deque()
        self._lock = threading.Lock()
        self._sending = None
        self._wake, self._stop = threading.Event(), threading.Event()
        self._worker = None
        self._last_signal = self._last_error = None
        self._dropped = 0

    @staticmethod
    def _heartbeat_key(item):
        zone = item['envelope']['payload'].get('zone', {})
        return (item['channel'], zone.get('roi_id'), zone.get('visit_id')) if zone.get('event') == 'present' else None

    def enqueue(self, channel, payload, *, observed_at=None, event_id=None):
        item = {'channel': channel, 'envelope': RideSignalClient.envelope(channel, payload, observed_at=observed_at, event_id=event_id), 'attempted': False}
        with self._lock:
            key = self._heartbeat_key(item)
            tail = self._queue[-1] if self._queue else None
            if key is not None and tail is not None and not tail['attempted'] and self._heartbeat_key(tail) == key:
                self._queue[-1] = item
            else:
                self._queue.append(item)
        self._wake.set()
        return deepcopy(item['envelope'])

    def deliver_once(self):
        """Attempt the oldest event once; useful in memory-only tests, too."""
        with self._lock:
            if not self._queue or self._sending is not None:
                return False
            item = self._queue[0]
            item['attempted'] = True
            self._sending = item
        envelope = item['envelope']
        try:
            result = self.client.post(f"/api/{item['channel']}", deepcopy(envelope))
            if not isinstance(result, dict) or result.get('accepted') is not True:
                raise ValueError('Signal acknowledgement did not confirm acceptance')
        except Exception as failure:
            with self._lock:
                self._last_error = {'event_id': envelope['event_id'], 'error': type(failure).__name__}
                if isinstance(failure, error.HTTPError):
                    self._last_error['status'] = failure.code
                    code = hub_error_code(failure)
                    if code:
                        self._last_error['code'] = code
                dropped = is_permanent(failure)
                if dropped:
                    zone = envelope['payload'].get('zone', {})
                    self._queue.popleft()
                    self._dropped += 1
                    self._last_error.update({'dropped': True, 'reason': zone.get('event'), 'visit_id': zone.get('visit_id')})
                report = deepcopy(self._last_error)
                self._sending = None
            if dropped and self.on_drop:
                self.on_drop(report)
            return False
        with self._lock:
            self._queue.popleft()
            zone = envelope['payload'].get('zone', {})
            self._last_signal = {'at': time.time(), 'event_id': envelope['event_id'], 'observed_at': envelope['observed_at'],
                                 'reason': zone.get('event'), 'visit_id': zone.get('visit_id'),
                                 'labels': [d['label'] for d in envelope['payload'].get('yolo_detections', [])]}
            self._last_error = None
            self._sending = None
        return True

    def diagnostics(self):
        with self._lock:
            return {'pending_signals': len(self._queue), 'last_signal': deepcopy(self._last_signal), 'signal_error': deepcopy(self._last_error),
                    'dropped_signals': self._dropped}

    def start(self):
        if self._worker is None:
            self._worker = threading.Thread(target=self._run, daemon=True)
            self._worker.start()

    def _run(self):
        while not self._stop.is_set():
            if self.diagnostics()['pending_signals']:
                if not self.deliver_once():
                    self._stop.wait(self.retry_seconds)
            else:
                self._wake.wait(0.5)
                self._wake.clear()

    def close(self, timeout=1.0):
        self._stop.set(); self._wake.set()
        if self._worker is not None:
            self._worker.join(timeout)
        return self.diagnostics()['pending_signals']


class YoloSignalPublisher:
    """Confirm 3 matching frames; refresh at <=2.5 Hz, not one API call per frame.

    This is label stability, not passenger identity matching. Pass matched=True only
    when your own association logic confirms that this track is the booked rider.
    """
    def __init__(self, client, stable_frames=3, heartbeat_seconds=0.4, confidence=0.75):
        self.client = client
        self.stable_frames = stable_frames
        self.heartbeat_seconds = heartbeat_seconds
        self.confidence = confidence
        self.candidate = None
        self.count = 0
        self.last_sent = None
        self.last_time = 0.0

    def observe(self, detections, *, geometry=None, matched=False, observed_at=None):
        detections = [d for d in detections if d["label"] in {"WHEELCHAIR", "CRUTCH", "CANE", "WALKER"} and d["confidence"] >= self.confidence]
        detections = sorted(detections, key=lambda d: (d["label"], d.get("track_id", "")))[:20]
        signature = tuple((d["label"], d.get("track_id")) for d in detections)
        self.count = self.count + 1 if signature == self.candidate else 1
        self.candidate = signature
        now = time.monotonic()
        if self.count < self.stable_frames:
            return None
        if signature == self.last_sent and now - self.last_time < self.heartbeat_seconds:
            return None
        payload = {"yolo_detections": detections, "target_match_confirmed": matched}
        if geometry is not None:
            payload["geometry"] = geometry
        result = self.client.signal("perception", payload, observed_at=observed_at)
        self.last_sent, self.last_time = signature, now
        return result


def detections_from_ultralytics(result, class_map=None):
    """Use your trained model's labels; no position or disability is inferred."""
    mapping = class_map or {"wheelchair": "WHEELCHAIR", "crutch": "CRUTCH", "crutches": "CRUTCH", "cane": "CANE", "walker": "WALKER"}
    detections = []
    if result.boxes is None:
        return detections
    for box in result.boxes:
        name = str(result.names[int(box.cls.item())]).lower()
        if name not in mapping:
            continue
        item = {"label": mapping[name], "confidence": float(box.conf.item())}
        if box.id is not None:
            item["track_id"] = str(int(box.id.item()))
        detections.append(item)
    return detections
