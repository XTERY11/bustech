"""Second opinion for the aid detector, plus a separate PERSON overlay.

best.pt was trained on four classes whose boxes each contain "a person together
with a device" and saw no person-only images, so outside its training room it
labels a person without any device as stroller / wheelchair with high confidence,
and it mixes the classes up. This module does not touch those weights. It adds an
open-vocabulary detector (YOLO-World) that knows the objects themselves:

  * AidVerifier.persons(frame)   -> person boxes for the preview overlay
  * AidVerifier.evidence(frame, box) -> which object accompanies the person in
    one aid box (run on a zoomed crop of that box), or None for a bare person
  * ConfirmedTracks              -> an aid box only counts after the same answer
    was given `hits` times within the last `window` checks; the confirmation
    then stays with that box while it keeps being detected.

The rule is deliberately loose about which object it is and strict about there
being one: a person alone is never reported as an aid, and neither is a device
nobody is with (a parked stroller, or one standing in the background behind a
passer-by). Umbrellas, sticks and tripods are accepted as rehearsal stand-ins for
a cane; chairs and trolleys can be switched on as stand-ins for wheelchair and
stroller when no real ones are at hand.

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
POSE = ROOT / 'weights/yolov8n-pose.pt'
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

    def __init__(self, hits=2, window=30, max_misses=15, match_iou=0.3, interval=1, refresh=0):
        self.hits, self.window, self.max_misses, self.match_iou = hits, window, max_misses, match_iou
        self.interval = interval  # check an unconfirmed box only every Nth frame it is seen
        self.refresh = refresh    # re-check a confirmed box every Nth frame to keep collecting votes (0 = never)
        self.tracks = []
        self.evidence, self.votes, self.peaks = [], [], []

    def reset(self):
        self.tracks = []

    def step(self, boxes, check, votes=None, confidences=None):
        """Return one bool per box. `check(box)` is only called for boxes not confirmed yet.
        A box is confirmed once `check` gave the same answer `hits` times; for a tuple answer
        its first item is what has to repeat.

        `votes` (one {label: weight} per box) and `confidences` are accumulated per track, so the
        caller can report the label the detector preferred over the whole track rather than in one
        frame, and the best confidence seen. Results are in .evidence, .votes and .peaks."""
        free = list(self.tracks)
        result, alive = [], []
        for box in boxes:
            track = max(free, key=lambda t: iou(t['box'], box), default=None)
            if track is not None and iou(track['box'], box) >= self.match_iou:
                free.remove(track)
            else:
                track = {'checks': deque(maxlen=self.window), 'confirmed': False, 'seen': 0, 'votes': Counter(), 'peak': 0.0}
            track['box'], track['misses'] = list(box), 0
            track['seen'] += 1
            index = len(result)
            if votes:
                track['votes'].update(votes[index])
            if confidences:
                track['peak'] = max(track['peak'], confidences[index])
            if not track['confirmed'] and (track['seen'] - 1) % self.interval == 0:
                found = check(box) or None
                track['checks'].append(found)
                if isinstance(found, tuple) and len(found) > 3:
                    track['votes'].update(found[3])  # the checker's own opinion on the label
                    track['since'] = track['seen']
                answers = Counter(_key(found) for found in track['checks'] if found)
                if answers and answers.most_common(1)[0][1] >= self.hits:
                    winner = answers.most_common(1)[0][0]
                    track['confirmed'] = True
                    track['evidence'] = next(found for found in reversed(track['checks']) if found and _key(found) == winner)
            elif track['confirmed'] and self.refresh and track['seen'] - track.get('since', 0) >= self.refresh:
                found = check(box)  # the latch stays; only the label tally keeps learning
                track['since'] = track['seen']
                if isinstance(found, tuple) and len(found) > 3:
                    track['votes'].update(found[3])
            alive.append(track); result.append(track['confirmed'])
        for track in free:  # not detected in this frame: keep briefly so flicker does not drop the latch
            track['misses'] += 1
            if track['misses'] <= self.max_misses:
                alive.append(track)
        self.tracks = alive
        current = alive[:len(result)]
        self.evidence = [t.get('evidence') for t in current]  # the confirming answer, per box
        self.votes = [t['votes'] for t in current]
        self.peaks = [t['peak'] for t in current]
        return result


class AidVerifier:
    def __init__(self, weights=WEIGHTS, device='cpu', conf=0.15, person_conf=0.35, imgsz=480, pad=0.15,
                 stick_stand_ins=True, bulky_stand_ins=False, stand_in_conf=0.3, bulky_share=0.15, person_weights=None,
                 pose_weights=POSE):
        from ultralytics import YOLO
        self.model = YOLO(str(weights))
        # Person boxes are needed every frame: use the small model for them when the large one does the checks.
        if person_weights is None and Path(weights) != SMALL and SMALL.is_file():
            person_weights = SMALL
        self.person_model = YOLO(str(person_weights)) if person_weights else self.model
        self.pose_model = YOLO(str(pose_weights)) if pose_weights and Path(pose_weights).is_file() else None
        self.device, self.conf, self.person_conf, self.imgsz, self.pad = device, conf, person_conf, imgsz, pad
        self.stick_stand_ins, self.bulky_stand_ins = stick_stand_ins, bulky_stand_ins
        self.stand_in_conf, self.bulky_share = stand_in_conf, bulky_share

    def persons(self, frame, imgsz=640):
        result = self.person_model.predict(frame, imgsz=imgsz, conf=self.person_conf, classes=[0], device=self.device, verbose=False)[0]
        return [box[:5] for box in result.boxes.data.cpu().tolist()]

    def _crop(self, frame, box, wide=False):
        height, width = frame.shape[:2]
        # A box drawn around the person only needs room to the sides, where a pushed device would be.
        dx, dy = (0.8 if wide else self.pad) * (box[2] - box[0]), self.pad * (box[3] - box[1])
        x1, y1 = int(max(0, box[0] - dx)), int(max(0, box[1] - dy))
        x2, y2 = int(min(width, box[2] + dx)), int(min(height, box[3] + dy))
        return frame[y1:y2, x1:x2] if x2 - x1 >= 8 and y2 - y1 >= 8 else None

    def _objects(self, frame, box, wide=False):
        crop = self._crop(frame, box, wide)
        if crop is None:
            return []
        result = self.model.predict(crop, imgsz=self.imgsz, conf=0.03, device=self.device, verbose=False)[0]
        return result.boxes.data.cpu().tolist()

    def _seated(self, crop):
        """Boxes of people who are sitting: their thighs are short on screen compared with the torso
        (hip-to-knee drop under 0.6 of the shoulder-to-hip drop; standing people measure 0.65-0.85)."""
        if self.pose_model is None or crop is None:
            return []
        result = self.pose_model.predict(crop, imgsz=self.imgsz, conf=0.4, device=self.device, verbose=False)[0]
        seated = []
        for xyxy, points in zip(result.boxes.xyxy.cpu().tolist(), result.keypoints.data.cpu().tolist()):
            rows = [[points[i][1] for i in pair if points[i][2] > 0.5] for pair in ((5, 6), (11, 12), (13, 14))]
            if not all(rows):
                continue
            shoulder, hip, knee = (sum(row) / len(row) for row in rows)
            if hip - shoulder > 8 and 0 <= (knee - hip) / (hip - shoulder) < 0.6:
                seated.append(xyxy)
        return seated

    def evidence(self, frame, box, wide=False):
        """(kind, score, label, votes) for the object that accompanies the person, or None.

        None means a bare person, or a device nobody is with. Wheeled aids win over canes.
        kind is 'WHEELED' for a real wheelchair or stroller. This model cannot tell those two apart
        reliably, so `label` is only its guess and `votes` its weight in the caller's tally: an adult
        sitting in the device makes it a wheelchair, otherwise the detector's vote should decide.
        For every other kind, kind == label."""
        crop = self._crop(frame, box, wide)
        if crop is None:
            return None
        result = self.model.predict(crop, imgsz=self.imgsz, conf=0.03, device=self.device, verbose=False)[0]
        rows = [(row[:4], row[4], int(row[5])) for row in result.boxes.data.cpu().tolist()]
        people = [xyxy for xyxy, score, cls in rows if cls == 0 and score >= self.person_conf]

        def with_person(xyxy):
            """People who are with this object: beside or over it, and about as far from the camera
            (an object whose base is well above the person's feet stands behind them)."""
            return [p for p in people
                    if max(p[0] - xyxy[2], xyxy[0] - p[2], 0) <= 0.3 * (p[2] - p[0])
                    and xyxy[3] >= p[3] - 0.2 * (p[3] - p[1])]

        def best(group, floor):
            return max(((score, cls) for _, score, cls in rows if cls in group and score >= floor), default=None)

        for xyxy, score, cls in sorted((r for r in rows if r[2] in WHEELED and r[1] >= self.conf), key=lambda r: -r[1]):
            owners = with_person(xyxy)
            if not owners:
                continue
            # An adult sitting in the device settles it: strollers carry no adults. This covers the
            # wheelchair user on their own, a case the detector never saw in training and flips on.
            sitters = [p for p in owners if (p[3] - p[1]) < 2.1 * (p[2] - p[0])] + self._seated(crop)
            if any(_overlap(xyxy, p) >= 0.4 * _area(p) for p in sitters):
                return 'WHEELED', score, 'WHEELCHAIR', {'WHEELCHAIR': 1000.0}
            return 'WHEELED', score, WHEELED[cls], {WHEELED[cls]: 0.5}
        if self.bulky_stand_ins:
            area = _area(box)
            # A seat only counts when a person is on it; a chair next to a standing person does not.
            seats = [score for xyxy, score, cls in rows if cls in SEATS and score >= self.stand_in_conf
                     and _area(xyxy) >= self.bulky_share * area
                     and any(_overlap(xyxy, p) >= 0.3 * _area(xyxy) for p in people)]
            if seats:
                return 'WHEELCHAIR', max(seats), 'WHEELCHAIR', {}
            carts = [score for xyxy, score, cls in rows if cls in CARTS and score >= self.stand_in_conf
                     and _area(xyxy) >= self.bulky_share * area and with_person(xyxy)]
            if carts:
                return 'STROLLER', max(carts), 'STROLLER', {}
        if wide:  # a cane is held close: look again in a tight crop, where a thin object is not lost
            rows = [(row[:4], row[4], int(row[5])) for row in self._objects(frame, box)]
            people = [xyxy for xyxy, score, cls in rows if cls == 0 and score >= self.person_conf]
        if not people:
            return None
        cane = best(CANES, self.conf)
        if cane:
            return 'CANE', cane[0], 'CANE', {}
        if self.stick_stand_ins:
            stick = best(STICKS, self.stand_in_conf)
            if stick:
                return 'CANE', stick[0], 'CANE', {}
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
