"""Second opinion for the aid detector, plus a separate PERSON overlay.

best.pt was trained on four classes whose boxes each contain "a person together
with a device" and saw no person-only images, so it can label a person without
any device as stroller / wheelchair with high confidence. This module does not
touch those weights. It adds an open-vocabulary detector (YOLO-World) that knows
the devices themselves:

  * AidVerifier.persons(frame)       -> person boxes for the preview overlay
  * AidVerifier.evidence(frame, box) -> what object accompanies the person in one
    aid box (run on a zoomed crop of that box): a real device, a stand-in such as
    an office chair used as a wheelchair in rehearsals, or nothing (a bare person)
  * ConfirmedTracks                  -> an aid box only counts after an object
    was seen in it `hits` times within the last `window` checks; the confirmation
    then stays with that box while it keeps being detected.

The rule is deliberately loose about which object it is and strict about there
being one: a person alone is never reported as an aid.

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
# Index 0 must stay "person". DEVICES are real aids: the detector's own class is kept.
# STAND_INS are everyday objects accepted in place of an aid; they decide the reported label.
# With stand-ins switched off the chair prompts still act as decoys, so a person on a wheeled
# office chair is not scored as a wheelchair.
PROMPTS = ['person', 'wheelchair', 'stroller', 'baby carriage', 'walking cane', 'crutch',
           'office chair', 'chair', 'trolley', 'suitcase', 'umbrella', 'stick']
DEVICES = {1, 2, 3, 4, 5}
STAND_INS = {6: 'WHEELCHAIR', 7: 'WHEELCHAIR', 8: 'STROLLER', 9: 'STROLLER', 10: 'CANE', 11: 'CANE'}
BULKY = {6, 7, 8, 9}  # must fill a real share of the box, so a chair in the background does not count


def iou(a, b):
    w = min(a[2], b[2]) - max(a[0], b[0]); h = min(a[3], b[3]) - max(a[1], b[1])
    if w <= 0 or h <= 0:
        return 0.0
    inter = w * h
    return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter)


class ConfirmedTracks:
    """Frame-to-frame box association with a verification latch (no model inside)."""

    def __init__(self, hits=2, window=30, max_misses=15, match_iou=0.3, interval=1):
        self.hits, self.window, self.max_misses, self.match_iou = hits, window, max_misses, match_iou
        self.interval = interval  # check an unconfirmed box only every Nth frame it is seen
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
                track = {'checks': deque(maxlen=self.window), 'confirmed': False, 'seen': 0}
            track['box'], track['misses'] = list(box), 0
            track['seen'] += 1
            if not track['confirmed'] and (track['seen'] - 1) % self.interval == 0:
                found = check(box)
                track['checks'].append(bool(found))
                if found:
                    track['evidence'] = found
                track['confirmed'] = sum(track['checks']) >= self.hits
            alive.append(track); result.append(track['confirmed'])
        for track in free:  # not detected in this frame: keep briefly so flicker does not drop the latch
            track['misses'] += 1
            if track['misses'] <= self.max_misses:
                alive.append(track)
        self.tracks = alive
        self.evidence = [t.get('evidence') for t in alive[:len(result)]]  # what `check` returned, per box
        return result


class AidVerifier:
    def __init__(self, weights=WEIGHTS, device='cpu', conf=0.15, person_conf=0.35, imgsz=480, pad=0.15,
                 stand_ins=True, stand_in_conf=0.3, bulky_share=0.15):
        from ultralytics import YOLO
        self.model = YOLO(str(weights))
        self.device, self.conf, self.person_conf, self.imgsz, self.pad = device, conf, person_conf, imgsz, pad
        self.stand_ins, self.stand_in_conf, self.bulky_share = stand_ins, stand_in_conf, bulky_share

    def persons(self, frame, imgsz=640):
        result = self.model.predict(frame, imgsz=imgsz, conf=self.person_conf, classes=[0], device=self.device, verbose=False)[0]
        return [box[:5] for box in result.boxes.data.cpu().tolist()]

    def _objects(self, frame, box):
        height, width = frame.shape[:2]
        dx, dy = self.pad * (box[2] - box[0]), self.pad * (box[3] - box[1])
        x1, y1 = int(max(0, box[0] - dx)), int(max(0, box[1] - dy))
        x2, y2 = int(min(width, box[2] + dx)), int(min(height, box[3] + dy))
        if x2 - x1 < 8 or y2 - y1 < 8:
            return []
        result = self.model.predict(frame[y1:y2, x1:x2], imgsz=self.imgsz, conf=0.03, device=self.device, verbose=False)[0]
        return result.boxes.data.cpu().tolist()

    def device_score(self, frame, box):
        return max((row[4] for row in self._objects(frame, box) if int(row[5]) in DEVICES), default=0.0)

    def evidence(self, frame, box):
        """(kind, score): kind is 'DEVICE' for a real aid or a hub label for a stand-in object.
        None for a bare person."""
        rows = self._objects(frame, box)
        device = max((row[4] for row in rows if int(row[5]) in DEVICES), default=0.0)
        if device >= self.conf:
            return 'DEVICE', device
        if not self.stand_ins:
            return None
        area = (box[2] - box[0]) * (box[3] - box[1])
        best = None
        for x1, y1, x2, y2, score, cls in rows:
            cls = int(cls)
            if cls not in STAND_INS or score < self.stand_in_conf:
                continue
            if cls in BULKY and (x2 - x1) * (y2 - y1) < self.bulky_share * area:
                continue
            if best is None or score > best[0]:
                best = (score, STAND_INS[cls])
        return (best[1], best[0]) if best else None

    def has_device(self, frame, box):
        return self.evidence(frame, box) is not None


def build_weights(base=BASE_WEIGHTS, output=WEIGHTS):
    from ultralytics import YOLO
    model = YOLO(str(base))
    model.set_classes(PROMPTS)
    model.model.clip_model = None  # text features are already baked in; keeps the file small
    model.save(str(output))
    return output


if __name__ == '__main__':
    print(f'Saved {build_weights()}')
