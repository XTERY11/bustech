"""Second opinion for the aid detector, plus a separate PERSON overlay.

best.pt was trained on four classes whose boxes each contain "a person together
with a device" and saw no person-only images, so outside its training room it
labels a person without any device as stroller / wheelchair with high confidence,
and it mixes the classes up. This module does not touch those weights. It adds an
open-vocabulary detector (YOLO-World) that knows the objects themselves:

  * AidVerifier.persons(frame)   -> person boxes for the preview overlay
  * AidVerifier.evidence(frame, box, detector_label) -> which object accompanies
    the person in one aid box (run on a zoomed crop of that box) and therefore
    which label to report, or None for a bare person
  * ConfirmedTracks              -> an aid box only counts after the same answer
    was given `hits` times within the last `window` checks; the confirmation
    then stays with that box while it keeps being detected.

The rule is deliberately loose about which object it is and strict about there
being one: a person alone is never reported as an aid. Everyday objects are
accepted as rehearsal stand-ins (office chair -> wheelchair, trolley -> stroller,
umbrella / stick / tripod -> cane).

Weights. The small model (yolov8s-world-aids.pt, ~26 MB) is in the repository.
The extra-large one sees thin objects such as canes far better but is ~140 MB,
too big for git, so build it locally once; it is used automatically when present:

    .venv/bin/python aid_verifier.py x      # downloads yolov8x-worldv2.pt and the CLIP text encoder
    .venv/bin/python aid_verifier.py s      # rebuild the small one after editing PROMPTS
"""
from __future__ import annotations

import sys
from collections import Counter, deque
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SMALL = ROOT / 'weights/yolov8s-world-aids.pt'
LARGE = ROOT / 'weights/yolov8x-world-aids.pt'
WEIGHTS = LARGE if LARGE.is_file() else SMALL
# Index 0 must stay "person". The groups below refer to positions in this list.
PROMPTS = ['person', 'wheelchair', 'stroller', 'baby carriage', 'walking cane', 'crutch', 'white cane',
           'office chair', 'chair', 'trolley', 'suitcase', 'umbrella', 'stick', 'tripod stand']
WHEELED = {1: 'WHEELCHAIR', 2: 'STROLLER', 3: 'STROLLER'}   # real wheeled aids
CANES = {4, 5, 6}                                            # real walking aids
SEATS = {7, 8}                                               # stand-in for a wheelchair, only when the person is on it
CARTS = {9, 10}                                              # stand-in for a stroller
STICKS = {11, 12, 13}                                        # stand-in for a cane


def _overlap(a, b):
    w = min(a[2], b[2]) - max(a[0], b[0]); h = min(a[3], b[3]) - max(a[1], b[1])
    return w * h if w > 0 and h > 0 else 0.0


def _area(a):
    return (a[2] - a[0]) * (a[3] - a[1])


def iou(a, b):
    inter = _overlap(a, b)
    return inter / (_area(a) + _area(b) - inter) if inter else 0.0


def _key(found):
    return found[0] if isinstance(found, tuple) else found


class ConfirmedTracks:
    """Frame-to-frame box association with a verification latch (no model inside)."""

    def __init__(self, hits=2, window=30, max_misses=15, match_iou=0.3, interval=1):
        self.hits, self.window, self.max_misses, self.match_iou = hits, window, max_misses, match_iou
        self.interval = interval  # check an unconfirmed box only every Nth frame it is seen
        self.tracks = []
        self.evidence = []

    def reset(self):
        self.tracks = []

    def step(self, boxes, check):
        """Return one bool per box. `check(box)` is only called for boxes not confirmed yet.
        A box is confirmed once `check` gave the same answer `hits` times; for a tuple answer
        its first item (the label) is what has to repeat."""
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
                track['checks'].append(check(box) or None)
                votes = Counter(_key(found) for found in track['checks'] if found)
                if votes and votes.most_common(1)[0][1] >= self.hits:
                    winner = votes.most_common(1)[0][0]
                    track['confirmed'] = True
                    track['evidence'] = next(found for found in reversed(track['checks']) if found and _key(found) == winner)
            alive.append(track); result.append(track['confirmed'])
        for track in free:  # not detected in this frame: keep briefly so flicker does not drop the latch
            track['misses'] += 1
            if track['misses'] <= self.max_misses:
                alive.append(track)
        self.tracks = alive
        self.evidence = [t.get('evidence') for t in alive[:len(result)]]  # the confirming answer, per box
        return result


class AidVerifier:
    def __init__(self, weights=WEIGHTS, device='cpu', conf=0.15, person_conf=0.35, imgsz=480, pad=0.15,
                 stand_ins=True, stand_in_conf=0.3, bulky_share=0.15, person_weights=None):
        from ultralytics import YOLO
        self.model = YOLO(str(weights))
        # Person boxes are display-only: use the small model for them when the large one does the checks.
        if person_weights is None and Path(weights) != SMALL and SMALL.is_file():
            person_weights = SMALL
        self.person_model = YOLO(str(person_weights)) if person_weights else self.model
        self.device, self.conf, self.person_conf, self.imgsz, self.pad = device, conf, person_conf, imgsz, pad
        self.stand_ins, self.stand_in_conf, self.bulky_share = stand_ins, stand_in_conf, bulky_share

    def persons(self, frame, imgsz=640):
        result = self.person_model.predict(frame, imgsz=imgsz, conf=self.person_conf, classes=[0], device=self.device, verbose=False)[0]
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

    def evidence(self, frame, box, detector_label=None):
        """(label, score) for the object that accompanies the person, or None for a bare person.

        Wheeled aids win over canes. Between wheelchair and stroller the detector's own class is
        kept when it names one of them (it was trained on that distinction); otherwise, and for
        canes and stand-ins, the object decides the label."""
        rows = [(row[:4], row[4], int(row[5])) for row in self._objects(frame, box)]

        def best(group, floor):
            return max(((score, cls) for _, score, cls in rows if cls in group and score >= floor), default=None)

        wheeled = best(WHEELED, self.conf)
        if wheeled:
            label = detector_label if detector_label in ('WHEELCHAIR', 'STROLLER') else WHEELED[wheeled[1]]
            return label, wheeled[0]
        if self.stand_ins:
            area = _area(box)
            people = [xyxy for xyxy, score, cls in rows if cls == 0 and score >= self.person_conf]
            # A seat only counts when a person is on it; a chair next to a standing person does not.
            seats = [score for xyxy, score, cls in rows if cls in SEATS and score >= self.stand_in_conf
                     and _area(xyxy) >= self.bulky_share * area
                     and any(_overlap(xyxy, p) >= 0.3 * _area(xyxy) for p in people)]
            if seats:
                return 'WHEELCHAIR', max(seats)
            carts = [score for xyxy, score, cls in rows if cls in CARTS and score >= self.stand_in_conf
                     and _area(xyxy) >= self.bulky_share * area]
            if carts:
                return 'STROLLER', max(carts)
        cane = best(CANES, self.conf)
        if cane:
            return 'CANE', cane[0]
        if self.stand_ins:
            stick = best(STICKS, self.stand_in_conf)
            if stick:
                return 'CANE', stick[0]
        return None


def build_weights(size='s'):
    from ultralytics import YOLO
    output = ROOT / f'weights/yolov8{size}-world-aids.pt'
    model = YOLO(str(ROOT / f'weights/yolov8{size}-worldv2.pt'))  # downloaded on first use
    model.set_classes(PROMPTS)
    model.model.clip_model = None  # text features are already baked in; no text encoder needed at run time
    model.save(str(output))
    return output


if __name__ == '__main__':
    print(f'Saved {build_weights(sys.argv[1] if len(sys.argv) > 1 else "s")}')
