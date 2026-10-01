"""Second opinion for the aid detector, plus a separate PERSON overlay.

best.pt was trained on four classes whose boxes each contain "a person together
with a device" and saw no person-only images, so it can label a person without
any device as stroller / wheelchair with high confidence. This module does not
touch those weights. It adds an open-vocabulary detector (YOLO-World) that knows
the devices themselves:

  * AidVerifier.persons(frame)       -> person boxes for the preview overlay
  * AidVerifier.device_score(frame, box) -> best "wheelchair / stroller / cane"
    score inside one aid box (run on a zoomed crop of that box)
  * ConfirmedTracks                  -> an aid box only counts after the device
    was seen in it `hits` times within the last `window` checks; the confirmation
    then stays with that box while it keeps being detected.

Build the verifier weights once (downloads the CLIP text encoder, ~340 MB, only
for this step; the saved file is ~26 MB and needs no text encoder at run time):

    .venv/bin/python aid_verifier.py
"""
from __future__ import annotations

from collections import deque
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WEIGHTS = ROOT / 'weights/yolov8s-world-aids.pt'
BASE_WEIGHTS = ROOT / 'weights/yolov8s-worldv2.pt'
# Index 0 must stay "person"; every other prompt counts as evidence of a device.
PROMPTS = ['person', 'wheelchair', 'stroller', 'baby carriage', 'walking cane', 'crutch']


def iou(a, b):
    w = min(a[2], b[2]) - max(a[0], b[0]); h = min(a[3], b[3]) - max(a[1], b[1])
    if w <= 0 or h <= 0:
        return 0.0
    inter = w * h
    return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter)


class ConfirmedTracks:
    """Frame-to-frame box association with a verification latch (no model inside)."""

    def __init__(self, hits=2, window=30, max_misses=15, match_iou=0.3):
        self.hits, self.window, self.max_misses, self.match_iou = hits, window, max_misses, match_iou
        self.tracks = []

    def reset(self):
        self.tracks = []

    def step(self, boxes, check):
        """Return one bool per box. `check(box)` is only called for boxes not confirmed yet."""
        free = list(self.tracks)
        result, alive = [], []
        for box in boxes:
            track = max(free, key=lambda t: iou(t['box'], box), default=None)
            if track is not None and iou(track['box'], box) >= self.match_iou:
                free.remove(track)
            else:
                track = {'checks': deque(maxlen=self.window), 'confirmed': False}
            track['box'], track['misses'] = list(box), 0
            if not track['confirmed']:
                track['checks'].append(bool(check(box)))
                track['confirmed'] = sum(track['checks']) >= self.hits
            alive.append(track); result.append(track['confirmed'])
        for track in free:  # not detected in this frame: keep briefly so flicker does not drop the latch
            track['misses'] += 1
            if track['misses'] <= self.max_misses:
                alive.append(track)
        self.tracks = alive
        return result


class AidVerifier:
    def __init__(self, weights=WEIGHTS, device='cpu', conf=0.15, person_conf=0.35, imgsz=480, pad=0.15):
        from ultralytics import YOLO
        self.model = YOLO(str(weights))
        self.device, self.conf, self.person_conf, self.imgsz, self.pad = device, conf, person_conf, imgsz, pad

    def persons(self, frame, imgsz=640):
        result = self.model.predict(frame, imgsz=imgsz, conf=self.person_conf, classes=[0], device=self.device, verbose=False)[0]
        return [box[:5] for box in result.boxes.data.cpu().tolist()]

    def device_score(self, frame, box):
        height, width = frame.shape[:2]
        dx, dy = self.pad * (box[2] - box[0]), self.pad * (box[3] - box[1])
        x1, y1 = int(max(0, box[0] - dx)), int(max(0, box[1] - dy))
        x2, y2 = int(min(width, box[2] + dx)), int(min(height, box[3] + dy))
        if x2 - x1 < 8 or y2 - y1 < 8:
            return 0.0
        result = self.model.predict(frame[y1:y2, x1:x2], imgsz=self.imgsz, conf=0.03, device=self.device, verbose=False)[0]
        return max((row[4] for row in result.boxes.data.cpu().tolist() if int(row[5]) != 0), default=0.0)

    def has_device(self, frame, box):
        return self.device_score(frame, box) >= self.conf


def build_weights(base=BASE_WEIGHTS, output=WEIGHTS):
    from ultralytics import YOLO
    model = YOLO(str(base))
    model.set_classes(PROMPTS)
    model.model.clip_model = None  # text features are already baked in; keeps the file small
    model.save(str(output))
    return output


if __name__ == '__main__':
    print(f'Saved {build_weights()}')
