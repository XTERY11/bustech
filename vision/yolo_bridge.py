"""Camera -> YOLO -> ROI trigger -> AccessRide signal hub, plus an MJPEG preview stream.

This is the "Sense" bridge for the integrated demo. It reuses the region logic of
monitor_zone.py (same ROI file, same anchor rule, same enter/exit debouncing) and
adds two outputs that monitor_zone.py does not have:

  1. POST /api/perception to the signal hub, only when the region trigger changes
     (enter -> detections inside the region; exit -> empty list) plus a slow
     heartbeat while the region stays occupied.
  2. An HTTP server with /stream.mjpg (annotated frames) and /health, so the
     dashboard can show the live camera view.

Draw the region first with monitor_zone.py (ENTER saves monitor_roi.json); this
script only reads it. Vehicle state is never produced here (open loop).
"""
from __future__ import annotations

import argparse
import json
import os
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import cv2
import numpy as np

from aid_verifier import WEIGHTS as VERIFY_WEIGHTS, AidVerifier, ConfirmedTracks, iou
from monitor_zone import Trigger, anchor_point, load_roi
from ride_signal_client import RideSignalClient

ROOT = Path(__file__).resolve().parent
# Model class name -> hub label (backend/planner/contracts.mjs perception enum).
CLASS_MAP = {
    'cane': 'CANE',
    'stroller': 'STROLLER',
    'wheelchair_with': 'WHEELCHAIR',
    'wheelchair_without': 'WHEELCHAIR',
    'crutch': 'CRUTCH', 'crutches': 'CRUTCH', 'walker': 'WALKER',
}


class SharedFrame:
    """Latest annotated JPEG plus a few counters, shared with the HTTP threads."""
    def __init__(self):
        self.lock = threading.Lock()
        self.jpeg = b''
        self.stamp = 0.0
        self.fps = 0.0
        self.status = {'triggered': False, 'inside': 0, 'detections': [], 'frames': 0, 'last_signal': None}

    def set(self, jpeg, status):
        with self.lock:
            self.jpeg = jpeg
            self.stamp = time.monotonic()
            self.status.update(status)

    def get(self):
        with self.lock:
            return self.jpeg, self.stamp, dict(self.status)


def make_handler(shared, info):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):  # keep the console for trigger events only
            pass

        def _cors(self):
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Cache-Control', 'no-store')

        def do_GET(self):
            if self.path.startswith('/health'):
                _, stamp, status = shared.get()
                body = json.dumps({'ok': True, 'source': info['source'], 'device': info['device'], 'roi': info['roi'],
                                   'fps': round(shared.fps, 1), 'frame_age_ms': round((time.monotonic() - stamp) * 1000) if stamp else None,
                                   'bridge_url': info['bridge_url'], **status}).encode()
                self.send_response(200); self._cors(); self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body); return
            if self.path.startswith('/snapshot.jpg'):
                jpeg, _, _ = shared.get()
                self.send_response(200 if jpeg else 503); self._cors(); self.send_header('Content-Type', 'image/jpeg')
                self.send_header('Content-Length', str(len(jpeg))); self.end_headers(); self.wfile.write(jpeg); return
            if not self.path.startswith('/stream.mjpg'):
                self.send_response(404); self.end_headers(); return
            self.send_response(200); self._cors()
            self.send_header('Content-Type', 'multipart/x-mixed-replace; boundary=frame'); self.end_headers()
            last = -1.0
            try:
                while True:
                    jpeg, stamp, _ = shared.get()
                    if jpeg and stamp != last:
                        last = stamp
                        self.wfile.write(b'--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ' + str(len(jpeg)).encode() + b'\r\n\r\n' + jpeg + b'\r\n')
                        self.wfile.flush()
                    time.sleep(0.02)
            except (BrokenPipeError, ConnectionResetError, OSError):
                return
    return Handler


def parse_args():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--source', default='0', help='Camera index, video file, RTSP or HTTP video stream')
    p.add_argument('--loop', action='store_true', help='Restart a video file when it ends (demo playback)')
    p.add_argument('--model', type=Path, default=ROOT / 'runs/bustech_yolov8n/weights/best.pt')
    p.add_argument('--roi', type=Path, default=ROOT / 'monitor_roi.json')
    p.add_argument('--anchor', choices=['bottom-center', 'center'], default=None)
    p.add_argument('--conf', type=float, default=None, help='Detector confidence; default 0.25 with the device check on, 0.4 with --no-verify')
    p.add_argument('--classes', type=int, nargs='+', help='Class IDs; default is all four classes')
    p.add_argument('--device', default='auto', help='auto, cpu, mps, or GPU index such as 0')
    p.add_argument('--imgsz', type=int, default=640)
    p.add_argument('--verify-model', type=Path, default=VERIFY_WEIGHTS, help='Open-vocabulary weights that must see the device inside an aid box (see aid_verifier.py)')
    p.add_argument('--no-verify', action='store_true', help='Report raw detections without the device check and without person boxes')
    p.add_argument('--verify-conf', type=float, default=0.15, help='Minimum device score inside an aid box')
    p.add_argument('--verify-hits', type=int, default=2, help='Device sightings needed before an aid box counts')
    p.add_argument('--strict-verify', action='store_true', help='Only real aids count; no stand-ins at all (by default an umbrella, stick or tripod counts as a cane)')
    p.add_argument('--chair-stand-ins', action='store_true', help='Rehearsal without real aids: a person on a chair counts as a wheelchair, a trolley or suitcase as a stroller')
    p.add_argument('--enter-frames', type=int, default=8, help='Frames a target must stay in the region before the trigger (about 0.3 s), so the label has settled')
    p.add_argument('--exit-frames', type=int, default=60, help='Frames with nobody in the region before it clears (about 2 s)')
    p.add_argument('--width', type=int, default=1280, help='Maximum processed/streamed frame width')
    p.add_argument('--rotate', choices=['none', 'cw', 'ccw', '180'], default='none')
    p.add_argument('--jpeg-quality', type=int, default=80)
    p.add_argument('--mjpeg-host', default='0.0.0.0')
    p.add_argument('--mjpeg-port', type=int, default=8790)
    p.add_argument('--bridge-url', default=os.getenv('RIDE_BRIDGE_URL', 'http://127.0.0.1:8787'), help='Signal hub base URL')
    p.add_argument('--bridge-token', default=os.getenv('BRIDGE_TOKEN', ''))
    p.add_argument('--no-signal', action='store_true', help='Do not POST to the hub (stream only)')
    p.add_argument('--heartbeat', type=float, default=2.0, help='Seconds between repeated reports while the region stays occupied')
    p.add_argument('--no-window', action='store_true', help='No local OpenCV window (server/headless use)')
    p.add_argument('--max-frames', type=int, default=0, help='0 means run until stopped')
    p.add_argument('--events', type=Path, help='Optional JSONL log of trigger transitions and hub posts')
    return p.parse_args()


class LatestFrame:
    """Reader thread for live sources: always hand out the newest frame, so inference that is
    slower than the camera never builds up a backlog (which shows up as growing delay)."""
    def __init__(self, cap):
        self.cap, self.frame, self.ok = cap, None, True
        self.fresh = threading.Event()
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self):
        while self.ok:
            ok, frame = self.cap.read()
            self.ok, self.frame = ok, frame
            self.fresh.set()

    def read(self):
        if not self.fresh.wait(10):
            return False, None
        self.fresh.clear()
        return self.ok, self.frame

    def get(self, prop):
        return self.cap.get(prop)

    def release(self):
        self.ok = False
        self.cap.release()


def in_region(box, mask, anchor):
    """A target counts as in the region when its anchor point is inside, or when the lower part of
    its box (where the wheels / feet are) overlaps the region: the overlap has to cover a quarter of
    that lower part or a quarter of the region, whichever is smaller. A single point alone misses a
    target whose box runs past the region edge or the bottom of the frame, and a share of the box
    alone misses a large target standing on a small region."""
    height, width = mask.shape
    x, y = anchor_point(box, anchor)
    if 0 <= int(y) < height and 0 <= int(x) < width and mask[int(y), int(x)]:
        return True
    x1, x2 = max(0, int(box[0])), min(width, int(box[2]))
    y2 = min(height, int(box[3])); y1 = max(0, int(box[3] - 0.3 * (box[3] - box[1])))
    if x2 <= x1 or y2 <= y1:
        return False
    overlap = int(mask[y1:y2, x1:x2].sum())
    return overlap >= 0.25 * min((y2 - y1) * (x2 - x1), int(mask.sum()))


def open_capture(source):
    cap = cv2.VideoCapture(source, cv2.CAP_DSHOW) if isinstance(source, int) and os.name == 'nt' else cv2.VideoCapture(source)
    if not cap.isOpened() and isinstance(source, int) and os.name == 'nt':
        cap.release(); cap = cv2.VideoCapture(source)
    if not cap.isOpened():
        cap.release(); raise RuntimeError('Cannot open source. Check camera index, video path, permissions, or stream connection.')
    cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
    return cap


def main():
    args = parse_args()
    source = int(args.source) if args.source.isdecimal() else args.source
    is_file = isinstance(source, str) and '://' not in source and Path(source).is_file()
    if not args.model.is_file():
        raise FileNotFoundError(f'Model not found: {args.model}')
    points = load_roi(args.roi)
    if not points:
        raise ValueError(f'No region in {args.roi}. Draw one first: python monitor_zone.py --source {args.source} --roi {args.roi}')
    if args.anchor is None:
        args.anchor = json.loads(args.roi.read_text(encoding='utf-8')).get('anchor', 'bottom-center')
    os.environ.setdefault('YOLO_CONFIG_DIR', str(ROOT / '.yolo'))
    import torch
    from ultralytics import YOLO
    if args.device == 'auto':
        device = '0' if torch.cuda.is_available() else ('mps' if getattr(torch.backends, 'mps', None) and torch.backends.mps.is_available() else 'cpu')
    else:
        device = args.device
    model = YOLO(str(args.model))
    names = model.names
    if args.classes and any(c not in names for c in args.classes):
        raise ValueError(f'Available classes: {names}')
    verifier = None
    if not args.no_verify:
        if args.verify_model.is_file():
            verifier = AidVerifier(args.verify_model, device, conf=args.verify_conf, stick_stand_ins=not args.strict_verify, bulky_stand_ins=args.chair_stand_ins)
        else:
            print(f'Verifier weights not found: {args.verify_model}. Running unverified; build them with: python aid_verifier.py', flush=True)
    if args.conf is None:  # with the device check on, the check filters false alarms, so the detector can be more sensitive
        args.conf = 0.25 if verifier else 0.4
    tracks = ConfirmedTracks(hits=args.verify_hits, interval=3, refresh=15)
    region_mask = None
    persons, held = [], []

    shared = SharedFrame()
    info = {'source': str(args.source), 'device': device, 'roi': str(args.roi), 'bridge_url': None if args.no_signal else args.bridge_url}
    server = ThreadingHTTPServer((args.mjpeg_host, args.mjpeg_port), make_handler(shared, info))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    print(f'Device: {device}; classes: {names}; anchor: {args.anchor}; device check: {"on" if verifier else "off"}', flush=True)
    print(f'Preview: http://127.0.0.1:{args.mjpeg_port}/stream.mjpg  Health: http://127.0.0.1:{args.mjpeg_port}/health', flush=True)

    client = None if args.no_signal else RideSignalClient(args.bridge_url, args.bridge_token)
    roi_id = args.roi.stem
    trigger = Trigger(args.enter_frames, args.exit_frames)
    log = args.events.open('a', encoding='utf-8') if args.events else None
    if args.events:
        args.events.parent.mkdir(parents=True, exist_ok=True)

    def record(event):
        print(json.dumps(event), flush=True)
        if log:
            log.write(json.dumps(event) + '\n'); log.flush()

    def post(detections, reason):
        if client is None:
            return
        try:
            # Same envelope as integrations/ride_signal_client.py; zone is informational for the dashboard.
            # target_match_confirmed: a verified aid is standing in the drawn boarding region. The hub ignores
            # camera detections without it; it still never authorises a ramp without a booking.
            client.signal('perception', {'yolo_detections': detections[:20], 'target_match_confirmed': bool(detections),
                                         'zone': {'triggered': bool(detections), 'roi_id': roi_id}},
                          observed_at=datetime.now(timezone.utc).isoformat())
            shared.status['last_signal'] = {'at': time.time(), 'reason': reason, 'labels': [d['label'] for d in detections]}
            record({'event': 'SIGNAL', 'reason': reason, 'detections': detections})
        except Exception as failure:  # keep streaming even if the hub is down
            record({'event': 'SIGNAL_FAILED', 'reason': reason, 'error': str(failure)[:200]})

    cap = open_capture(source)
    if not is_file:
        cap = LatestFrame(cap)
    fps_src = cap.get(cv2.CAP_PROP_FPS)
    fps_src = fps_src if np.isfinite(fps_src) and 0 < fps_src <= 240 else 30
    processed = 0
    last_heartbeat = 0.0
    tick_fps = time.monotonic(); fps_count = 0
    window = 'Bustech | Sense bridge'
    if not args.no_window:
        cv2.namedWindow(window, cv2.WINDOW_AUTOSIZE)
    try:
        while True:
            tick = time.monotonic()
            ok, frame = cap.read()
            if not ok:
                if is_file and args.loop:
                    cap.release(); cap = open_capture(source); trigger.reset(); tracks.reset(); continue
                if is_file:
                    print('Video finished.', flush=True); break
                raise RuntimeError('Camera/stream stopped delivering frames.')
            if args.rotate != 'none':
                frame = cv2.rotate(frame, {'cw': cv2.ROTATE_90_CLOCKWISE, 'ccw': cv2.ROTATE_90_COUNTERCLOCKWISE, '180': cv2.ROTATE_180}[args.rotate])
            if frame.shape[1] > args.width:
                frame = cv2.resize(frame, (args.width, round(frame.shape[0] * args.width / frame.shape[1])))
            height, width = frame.shape[:2]
            view = frame.copy()
            result = model.predict(frame, imgsz=args.imgsz, conf=args.conf, classes=args.classes, device=device, verbose=False)[0]
            if region_mask is None or region_mask.shape != (height, width):
                region_mask = np.zeros((height, width), np.uint8)
                cv2.fillPoly(region_mask, [np.round(np.asarray(points) * [width - 1, height - 1]).astype(np.int32)], 1)
            inside_detections, all_detections = [], []
            # The detector often gives one target two boxes with different classes (wheelchair and
            # stroller). Keep the strongest box per target and remember what every class scored.
            boxes, votes = [], []
            for box in sorted(result.boxes.data.cpu().tolist(), key=lambda box: -box[4]):
                label = CLASS_MAP.get(str(names[int(box[5])]).lower())
                same = next((i for i, kept in enumerate(boxes) if iou(box[:4], kept[:4]) >= 0.5), None)
                if same is None:
                    boxes.append(box); votes.append({label: box[4]})
                else:
                    votes[same][label] = max(votes[same].get(label, 0.0), box[4])
            if verifier:
                persons = verifier.persons(frame)
                # The detector misses people in some poses, so everybody standing in the region is a
                # candidate too (class -1: no detector box, the verifier alone decides).
                for person in persons:
                    if in_region(person[:4], region_mask, args.anchor) and not any(iou(person[:4], box[:4]) >= 0.3 for box in boxes):
                        boxes.append([*person[:4], 0.0, -1]); votes.append({})
                # A candidate only counts once the verifier has seen an object with the person.
                from_person = {tuple(box[:4]) for box in boxes if box[5] == -1}
                verified = tracks.step([box[:4] for box in boxes], lambda b: verifier.evidence(frame, b, wide=tuple(b) in from_person),
                                       votes, [box[4] for box in boxes])
                evidence, tallies, peaks = tracks.evidence, tracks.votes, tracks.peaks
            else:
                verified, evidence, tallies, peaks = [True] * len(boxes), [None] * len(boxes), votes, [box[4] for box in boxes]
            someone_inside = any(in_region(person[:4], region_mask, args.anchor) for person in persons)
            for x1, y1, x2, y2, confidence in persons:
                cv2.rectangle(view, (int(x1), int(y1)), (int(x2), int(y2)), (170, 170, 170), 1)
                cv2.putText(view, f'person {confidence:.2f}', (max(0, int(x1)), max(20, int(y1) - 6)), cv2.FONT_HERSHEY_SIMPLEX, .45, (170, 170, 170), 1)
            shown = []
            for box, confirmed, found, tally, peak in zip(boxes, verified, evidence, tallies, peaks):
                x1, y1, x2, y2, confidence, cls = box
                own = names[int(cls)] if cls >= 0 else 'person'
                kind, seen, label = (found or (None, 0.0, CLASS_MAP.get(str(own).lower())))[:3]
                if kind == 'WHEELED':
                    # Wheelchair or stroller: go by the tally over the whole track (detector class scores
                    # plus the verifier's own opinion), not by a single frame.
                    wheeled = {name: tally.get(name, 0.0) for name in ('WHEELCHAIR', 'STROLLER')}
                    if any(wheeled.values()):
                        label = max(wheeled, key=wheeled.get)
                # Combine the evidence (noisy-OR): the verifier saw the object on `verify_hits` checks, and
                # the detector's best frame on this track counts too, so the value does not dip between frames.
                detector_confidence = max(confidence, peak)
                confidence = 1 - (1 - detector_confidence) * (1 - seen) ** (args.verify_hits if found else 1)
                inside = in_region(box[:4], region_mask, args.anchor)
                if not confirmed:
                    continue
                if any(other == label and iou(box[:4], kept) >= 0.4 for kept, other in shown):
                    continue  # two boxes for one target
                shown.append((box[:4], label))
                all_detections.append({'label': label or 'UNKNOWN', 'confidence': round(float(confidence), 3), 'detector_confidence': round(float(detector_confidence), 3), 'model_class': own})
                if inside and label:
                    inside_detections.append({'label': label, 'confidence': round(float(confidence), 3)})
                color = (0, 100, 255) if inside else (220, 180, 70)
                cv2.rectangle(view, (int(x1), int(y1)), (int(x2), int(y2)), color, 2)
                cv2.putText(view, f'{(label or own).lower()} {confidence:.2f}', (max(0, int(x1)), max(20, int(y1) - 8)), cv2.FONT_HERSHEY_SIMPLEX, .6, color, 2)
                cv2.circle(view, tuple(round(v) for v in anchor_point(box[:4], args.anchor)), 5, color, -1)
            # Occupancy: an aid in the region starts the trigger and fixes what is reported. After that
            # the region stays occupied for as long as anybody is in it (people are detected far more
            # steadily than aids), and clears only once it has been empty for `exit_frames`.
            was_active = trigger.active
            active, entered = trigger.update(bool(inside_detections) or (was_active and someone_inside))
            if inside_detections:
                held = inside_detections
            processed += 1
            if entered:
                record({'event': 'TRIGGER', 'frame': processed, 'targets_in_region': len(held)})
                post(held, 'enter'); last_heartbeat = time.monotonic()
            elif active and time.monotonic() - last_heartbeat >= args.heartbeat:
                post(held, 'heartbeat'); last_heartbeat = time.monotonic()
            elif was_active and not active:  # exit transition
                record({'event': 'CLEAR', 'frame': processed})
                post([], 'exit'); held = []
            # overlay: region, state bar
            contour = np.round(np.asarray(points) * [width - 1, height - 1]).astype(np.int32)
            color = (0, 0, 255) if active else (60, 210, 60)
            overlay = view.copy(); cv2.fillPoly(overlay, [contour], color); view = cv2.addWeighted(overlay, .15, view, .85, 0)
            cv2.polylines(view, [contour], True, color, 2)
            cv2.rectangle(view, (0, 0), (width, 54), (24, 24, 24), -1)
            state = 'TRIGGER  ' + ' + '.join(sorted({d['label'].lower() for d in held})) if active else 'MONITORING'
            cv2.putText(view, state, (12, 36), cv2.FONT_HERSHEY_SIMPLEX, .95, (0, 70, 255) if active else (255, 255, 255), 2)
            cv2.putText(view, f'inside {len(inside_detections)} | {device} | {shared.fps:.0f} fps', (width - 290, 36), cv2.FONT_HERSHEY_SIMPLEX, .55, (200, 200, 200), 1)
            ok_jpeg, buf = cv2.imencode('.jpg', view, [cv2.IMWRITE_JPEG_QUALITY, args.jpeg_quality])
            if ok_jpeg:
                shared.set(buf.tobytes(), {'triggered': active, 'inside': len(inside_detections), 'held': held if active else [], 'detections': all_detections[:20], 'rejected': len(verified) - sum(verified), 'persons': len(persons), 'frames': processed})
            fps_count += 1
            if time.monotonic() - tick_fps >= 1:
                shared.fps = fps_count / (time.monotonic() - tick_fps); tick_fps = time.monotonic(); fps_count = 0
            if args.max_frames and processed >= args.max_frames:
                break
            if not args.no_window:
                cv2.imshow(window, view)
                if cv2.waitKey(1) & 0xff == ord('q'):
                    break
            if is_file:  # pace file playback at the source frame rate
                time.sleep(max(0.0, 1 / fps_src - (time.monotonic() - tick)))
    finally:
        cap.release(); server.shutdown()
        if log:
            log.close()
        if not args.no_window:
            cv2.destroyAllWindows()
        print(json.dumps({'processed_frames': processed, 'triggered_final': trigger.active}), flush=True)


if __name__ == '__main__':
    main()
