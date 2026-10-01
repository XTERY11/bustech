"""Python -> AccessRide JSON signals. Standard library only; no DeepSeek key here."""
from __future__ import annotations

import json
import os
import time
import uuid
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
            except error.URLError:
                if attempt:
                    raise
                time.sleep(0.2)

    def signal(self, channel, payload, *, observed_at=None, event_id=None):
        if channel not in {"booking", "perception"}:
            raise ValueError("Unknown signal channel")
        return self.post(f"/api/{channel}", {
            "event_id": event_id or f"{channel}-{uuid.uuid4()}",
            "observed_at": observed_at or datetime.now(timezone.utc).isoformat(),
            "payload": payload,
        })


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
