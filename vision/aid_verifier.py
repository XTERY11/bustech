"""Who is in the picture, and which mobility aid is with them.

best.pt was trained on four classes whose boxes each contain "a person together with a
device", on one room and a few people. Elsewhere it labels people without any device as
stroller or wheelchair, misses people it has not seen, and mixes the classes up, so its
boxes are not used. It only votes on wheelchair-versus-stroller for a device that has
already been found.

The devices are found by an open-vocabulary detector (YOLO-World) on the whole frame:

  * AidVerifier.detect(frame)  -> people, wheeled devices and cane-like objects
  * AidVerifier.seated(frame, person_box) -> pose check: is this person sitting?
  * Scene.update(...)          -> people, and the aids that count right now

Scene keeps one track per *device*, because the device is what has an identity: its
wheelchair/stroller votes add up on the device itself, including while it is parked, and
one device can only ever give one box and one label. A device counts when someone is
with it: an adult is sitting in it, or it has been moving along with a person beside it.
A parked device is ignored however many people stand around it, and a person who lets go
of one carries nothing away. A cane is judged per person from the last few frames only.

Weights. The small model (yolov8s-world-aids.pt, ~26 MB) is in the repository. The
extra-large one sees devices and canes far better but is ~140 MB, too big for git, so
build it locally once; it is used automatically when present:

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
# Index 0 must stay "person". The groups below refer to positions in this list; prompts in no
# group (chairs, trolley, suitcase, tripod stand) are decoys that keep furniture out of the groups.
PROMPTS = ['person', 'wheelchair', 'stroller', 'baby carriage', 'walking cane', 'crutch', 'white cane',
           'office chair', 'chair', 'trolley', 'suitcase', 'umbrella', 'stick', 'tripod stand']
# Wheeled devices and what each prompt says about the label. "baby carriage" fires on an empty
# wheelchair being pushed and not on the strollers tested, so it is a weak vote for wheelchair.
WHEELED = {1: ('WHEELCHAIR', 1.0), 2: ('STROLLER', 1.0), 3: ('WHEELCHAIR', 0.6)}
CANES = {4, 5, 6}
STICKS = {11, 12}  # rehearsal stand-ins for a cane


def _overlap(a, b):
    w = min(a[2], b[2]) - max(a[0], b[0]); h = min(a[3], b[3]) - max(a[1], b[1])
    return w * h if w > 0 and h > 0 else 0.0


def _area(a):
    return (a[2] - a[0]) * (a[3] - a[1])


def iou(a, b):
    inter = _overlap(a, b)
    return inter / (_area(a) + _area(b) - inter) if inter else 0.0


def _gap(a, b):
    return max(a[0] - b[2], b[0] - a[2], 0)


def _same(a, b):
    """Two boxes on one object: they overlap well, or one's centre lies inside the other
    (a part and the whole, or the same object seen from a changed angle)."""
    inside = lambda p, q: q[0] <= (p[0] + p[2]) / 2 <= q[2] and q[1] <= (p[1] + p[3]) / 2 <= q[3]
    return iou(a, b) >= 0.3 or inside(a, b) or inside(b, a)


def _both(scores):
    """Two sightings combined (noisy-OR)."""
    top = sorted(scores, reverse=True)[:2]
    return 1 - (1 - top[0]) * (1 - (top[1] if len(top) > 1 else 0.0)) if top else 0.0


class Scene:
    """Tracks devices and people over successive detections (no model inside). One `update` is
    one step; with detection on every other frame that is roughly 7-10 steps a second."""

    def __init__(self, conf=0.15, person_conf=0.35, stick_conf=0.3, sticks=True, min_seen=4, moved=0.15,
                 release=10, max_misses=10, cane_hits=2, cane_window=8):
        self.conf, self.person_conf, self.stick_conf, self.sticks = conf, person_conf, stick_conf, sticks
        self.min_seen = min_seen      # sightings before a new device is believed
        self.moved = moved            # share of its width a device must travel to count as moving
        self.release = release        # steps without anyone beside it before a device is parked again
        self.max_misses = max_misses  # steps a track survives without being detected
        self.cane_hits, self.cane_window = cane_hits, cane_window
        self.devices, self.people, self.step = [], [], 0

    def reset(self):
        self.devices, self.people, self.step = [], [], 0

    @staticmethod
    def _beside(person, device):
        """The person is at the device: touching it sideways and about as far from the camera
        (a device whose base is well above the person's feet stands behind them)."""
        return (_gap(person, device) <= 0.2 * (person[2] - person[0])
                and device[3] >= person[3] - 0.2 * (person[3] - person[1]))

    def _moving(self, track):
        """Has the device travelled since some point 3 to 15 steps ago (roughly the last 2 s)?"""
        _, x, y = track['trail'][-1]
        reach = self.moved * (track['box'][2] - track['box'][0])
        return any(3 <= self.step - step <= 15 and ((x - px) ** 2 + (y - py) ** 2) ** 0.5 >= reach
                   for step, px, py in track['trail'])

    def update(self, rows, detector=(), seated=None):
        """rows: [x1, y1, x2, y2, score, class] from AidVerifier.detect. detector: (box, {label: score})
        pairs from best.pt, used as votes only. seated(person_box) -> bool, called sparingly.
        Returns (people, aids); an aid is {'label', 'confidence', 'box', 'owners'}."""
        self.step += 1
        people = [row[:5] for row in rows if int(row[5]) == 0 and row[4] >= self.person_conf]

        # Wheeled devices: several prompts fire on one object, so merge them and keep each one's say.
        found = []
        for row in sorted((r for r in rows if int(r[5]) in WHEELED and r[4] >= self.conf), key=lambda r: -r[4]):
            label, weight = WHEELED[int(row[5])]
            same = next((d for d in found if _same(row[:4], d['box'])), None)
            if same is None:
                found.append({'box': list(row[:4]), 'score': row[4], 'votes': Counter({label: row[4] * weight})})
            else:
                same['votes'][label] += row[4] * weight

        free, alive = list(self.devices), []
        for det in found:
            track = max((t for t in free if _same(t['box'], det['box'])), key=lambda t: iou(t['box'], det['box']), default=None)
            if track is not None:
                free.remove(track)
            else:
                track = {'votes': Counter(), 'trail': deque(maxlen=40), 'scores': deque(maxlen=5), 'seen': 0,
                         'attended': False, 'alone': 0, 'sitting': 0, 'label': None}
            box = track['box'] = det['box']
            track['misses'] = 0
            track['seen'] += 1
            track['votes'].update(det['votes'])
            track['scores'].append(det['score'])
            track['trail'].append((self.step, (box[0] + box[2]) / 2, box[3]))
            centre = ((box[0] + box[2]) / 2, (box[1] + box[3]) / 2)
            for theirs, votes in detector:
                if iou(theirs, box) >= 0.2 or (theirs[0] <= centre[0] <= theirs[2] and theirs[1] <= centre[1] <= theirs[3]):
                    track['votes'].update({k: v for k, v in votes.items() if k in ('WHEELCHAIR', 'STROLLER')})
            owners = track['owners'] = [p for p in people if self._beside(p, box)]
            riders = [p for p in owners if _overlap(box, p) >= 0.4 * _area(p)]
            if not riders:
                track['sitting'] = max(track['sitting'] - 1, 0)
            elif seated and track['seen'] % 3 == 1:  # a pose check on every third sighting is enough
                track['sitting'] = min(track['sitting'] + 2, 6) if any(seated(p) for p in riders) else max(track['sitting'] - 2, 0)
            if track['sitting']:
                track['votes']['WHEELCHAIR'] += 5.0  # an adult sitting in it: strollers carry no adults
            if track['sitting'] or (owners and self._moving(track)):
                track['attended'], track['alone'] = True, 0
            elif track['attended'] and owners:
                track['alone'] = 0  # stopped, but the person is still holding it
            elif track['attended']:
                track['alone'] += 1
                track['attended'] = track['alone'] <= self.release
            alive.append(track)
        for track in free:  # not detected this step: keep briefly so one missed frame does not break the track
            track['misses'] += 1
            if track['misses'] <= self.max_misses:
                alive.append(track)
        self.devices = alive

        aids, taken = [], []
        for track in sorted(self.devices, key=lambda t: -t['seen']):
            votes = track['votes']
            leader = 'STROLLER' if votes['STROLLER'] > votes['WHEELCHAIR'] else 'WHEELCHAIR'
            # The label is sticky: it only changes once the other one is clearly ahead.
            if track['label'] is None or votes[leader] > 1.3 * votes[track['label']] + 2:
                track['label'] = leader
            if (track['attended'] and track['seen'] >= self.min_seen and track['misses'] <= 3
                    and not any(_same(track['box'], aid['box']) for aid in aids)):
                aids.append({'label': track['label'], 'confidence': _both(track['scores']), 'box': track['box'], 'owners': track['owners']})
                taken.extend(track['owners'])

        # Canes: per person, from the last few steps only, so one is seen when it is picked up and
        # forgotten when it is put down. Someone with a wheeled device is not also given a cane.
        canes = [row for row in rows if (int(row[5]) in CANES and row[4] >= self.conf)
                 or (self.sticks and int(row[5]) in STICKS and row[4] >= self.stick_conf)]
        free, alive = list(self.people), []
        for person in people:
            track = max(free, key=lambda t: iou(t['box'], person[:4]), default=None)
            if track is not None and iou(track['box'], person[:4]) >= 0.3:
                free.remove(track)
            else:
                track = {'hits': deque(maxlen=self.cane_window)}
            track['box'], track['misses'] = list(person[:4]), 0
            tall = person[3] - person[1]
            # Held: it touches the person, starts around hand height and reaches down to their feet.
            held = [c[4] for c in canes if _gap(person, c) <= 0.15 * (person[2] - person[0]) and c[3] >= person[3] - 0.15 * tall
                    and c[1] >= person[1] + 0.3 * tall and c[3] - c[1] >= 0.25 * tall]
            busy = any(list(person[:4]) == list(other[:4]) for other in taken)
            track['hits'].append(0.0 if busy else max(held, default=0.0))
            seen = [score for score in track['hits'] if score]
            if len(seen) >= self.cane_hits:
                aids.append({'label': 'CANE', 'confidence': _both(seen), 'box': track['box'], 'owners': [person]})
            alive.append(track)
        for track in free:
            track['misses'] += 1
            if track['misses'] <= 5:
                alive.append(track)
        self.people = alive
        return people, aids


class AidVerifier:
    def __init__(self, weights=WEIGHTS, device='cpu', pose_weights=POSE, imgsz=640):
        from ultralytics import YOLO
        self.model = YOLO(str(weights))
        self.pose_model = YOLO(str(pose_weights)) if pose_weights and Path(pose_weights).is_file() else None
        self.device, self.imgsz = device, imgsz

    def detect(self, frame):
        result = self.model.predict(frame, imgsz=self.imgsz, conf=0.15, device=self.device, verbose=False)[0]
        return result.boxes.data.cpu().tolist()

    def seated(self, frame, box):
        """Sitting: the thighs are short on screen compared with the torso (hip-to-knee drop under
        0.6 of the shoulder-to-hip drop; standing people measure 0.65-0.85). Without a pose model,
        fall back on the shape of the person's box."""
        height, width = frame.shape[:2]
        dx, dy = 0.15 * (box[2] - box[0]), 0.15 * (box[3] - box[1])
        x1, y1 = int(max(0, box[0] - dx)), int(max(0, box[1] - dy))
        x2, y2 = int(min(width, box[2] + dx)), int(min(height, box[3] + dy))
        if self.pose_model is None or x2 - x1 < 8 or y2 - y1 < 8:
            return (box[3] - box[1]) < 2.1 * (box[2] - box[0])
        result = self.pose_model.predict(frame[y1:y2, x1:x2], imgsz=480, conf=0.4, device=self.device, verbose=False)[0]
        for points in result.keypoints.data.cpu().tolist():
            rows = [[points[i][1] for i in pair if points[i][2] > 0.5] for pair in ((5, 6), (11, 12), (13, 14))]
            if all(rows):
                shoulder, hip, knee = (sum(row) / len(row) for row in rows)
                if hip - shoulder > 8 and 0 <= (knee - hip) / (hip - shoulder) < 0.6:
                    return True
        return False


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
