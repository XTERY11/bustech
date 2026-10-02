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

from aid_verifier import WEIGHTS as VERIFY_WEIGHTS, AidVerifier, Scene, iou
from monitor_zone import anchor_point, load_roi
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
    p.add_argument('--realtime', action='store_true', help='Replay a video file like a live camera: frames that arrive while a frame is being processed are dropped')
    p.add_argument('--model', type=Path, default=ROOT / 'runs/bustech_yolov8n/weights/best.pt')
    p.add_argument('--roi', type=Path, default=ROOT / 'monitor_roi.json')
    p.add_argument('--anchor', choices=['bottom-center', 'center'], default=None)
    p.add_argument('--conf', type=float, default=None, help='Detector confidence; default 0.25 with the device check on, 0.4 with --no-verify')
    p.add_argument('--classes', type=int, nargs='+', help='Class IDs; default is all four classes')
    p.add_argument('--device', default='auto', help='auto, cpu, mps, or GPU index such as 0')
    p.add_argument('--imgsz', type=int, default=640)
    p.add_argument('--verify-model', type=Path, default=VERIFY_WEIGHTS, help='Open-vocabulary weights that find people and devices (see aid_verifier.py)')
    p.add_argument('--no-verify', action='store_true', help='Report the raw best.pt detections instead (no person boxes, no device tracking)')
    p.add_argument('--strict-verify', action='store_true', help='Only real canes count; by default an umbrella or stick held like a cane does too')
    p.add_argument('--detect-every', type=int, default=2, help='Run detection on every Nth frame and reuse the result in between')
    p.add_argument('--enter-seconds', type=float, default=0.3, help='How long an aid must be in the region before the trigger')
    p.add_argument('--exit-seconds', type=float, default=2.0, help='How long the region must be empty of people before it clears')
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
    p.add_argument('--record', type=Path, help='Also save the raw frames that were processed to this MP4, for replaying the session later')
    p.add_argument('--snapshots', type=Path, help='Folder for an annotated JPEG at every trigger, label change and clear (plus events.jsonl), for review afterwards')
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
            verifier = AidVerifier(args.verify_model, device)
        else:
            print(f'Verifier weights not found: {args.verify_model}. Running unverified; build them with: python aid_verifier.py', flush=True)
    if args.conf is None:
        args.conf = 0.25 if verifier else 0.4
    scene = Scene(sticks=not args.strict_verify)
    region_mask = None
    persons, aids, held = [], [], []

    shared = SharedFrame()
    info = {'source': str(args.source), 'device': device, 'roi': str(args.roi), 'bridge_url': None if args.no_signal else args.bridge_url}
    server = ThreadingHTTPServer((args.mjpeg_host, args.mjpeg_port), make_handler(shared, info))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    print(f'Device: {device}; classes: {names}; anchor: {args.anchor}; device check: {"on" if verifier else "off"}', flush=True)
    print(f'Preview: http://127.0.0.1:{args.mjpeg_port}/stream.mjpg  Health: http://127.0.0.1:{args.mjpeg_port}/health', flush=True)

    client = None if args.no_signal else RideSignalClient(args.bridge_url, args.bridge_token)
    roi_id = args.roi.stem
    active = False            # region occupied (the trigger)
    since = last_seen = None  # when the current aid entered / when somebody was last in the region
    if args.snapshots:
        args.snapshots.mkdir(parents=True, exist_ok=True)
        args.events = args.events or args.snapshots / 'events.jsonl'
    if args.events:
        args.events.parent.mkdir(parents=True, exist_ok=True)
    log = args.events.open('a', encoding='utf-8') if args.events else None
    pending = []  # snapshot names waiting for the frame to be fully drawn

    def record(event):
        if is_file:
            event['second'] = round(position / fps_src, 1)  # where in the recording this happened
        if args.snapshots and event.get('event') in ('TRIGGER', 'LABEL', 'CLEAR'):
            event['snapshot'] = f"{datetime.now().strftime('%H%M%S')}_{event['frame']:06d}_{event['event'].lower()}.jpg"
            pending.append(event['snapshot'])
        print(json.dumps(event), flush=True)
        if log:
            log.write(json.dumps(event) + '\n'); log.flush()

    def post(detections, reason, left=None):
        if client is None:
            return
        try:
            # Same envelope as integrations/ride_signal_client.py; zone is informational for the dashboard.
            # target_match_confirmed: a verified aid is standing in the drawn boarding region. The hub ignores
            # camera detections without it; it still never authorises a ramp without a booking.
            # zone.event tells the dashboard what happened at the stop: 'enter', 'present' (heartbeat) or
            # 'exit'. On exit, zone.left names what was there, so the twin can show that passenger boarding.
            zone = {'triggered': bool(detections), 'roi_id': roi_id, 'event': {'heartbeat': 'present'}.get(reason, reason)}
            if left:
                zone['left'] = left
            client.signal('perception', {'yolo_detections': detections[:20], 'target_match_confirmed': bool(detections), 'zone': zone},
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
    processed = position = 0
    writer = None
    last_heartbeat = 0.0
    tick_fps = time.monotonic(); fps_count = 0
    window = 'Bustech | Sense bridge'
    if not args.no_window:
        cv2.namedWindow(window, cv2.WINDOW_AUTOSIZE)
    try:
        while True:
            tick = time.monotonic()
            ok, frame = cap.read()
            position += 1
            if not ok:
                if is_file and args.loop:
                    cap.release(); cap = open_capture(source); scene.reset(); active, since, last_seen, position = False, None, None, 0; continue
                if is_file:
                    print('Video finished.', flush=True); break
                raise RuntimeError('Camera/stream stopped delivering frames.')
            if args.rotate != 'none':
                frame = cv2.rotate(frame, {'cw': cv2.ROTATE_90_CLOCKWISE, 'ccw': cv2.ROTATE_90_COUNTERCLOCKWISE, '180': cv2.ROTATE_180}[args.rotate])
            if frame.shape[1] > args.width:
                frame = cv2.resize(frame, (args.width, round(frame.shape[0] * args.width / frame.shape[1])))
            height, width = frame.shape[:2]
            if args.record:
                if writer is None:
                    args.record.parent.mkdir(parents=True, exist_ok=True)
                    writer = cv2.VideoWriter(str(args.record), cv2.VideoWriter_fourcc(*'mp4v'), 15, (width, height))
                writer.write(frame)
            view = frame.copy()
            if region_mask is None or region_mask.shape != (height, width):
                region_mask = np.zeros((height, width), np.uint8)
                cv2.fillPoly(region_mask, [np.round(np.asarray(points) * [width - 1, height - 1]).astype(np.int32)], 1)
            if processed % args.detect_every == 0 or not verifier:
                result = model.predict(frame, imgsz=args.imgsz, conf=args.conf, classes=args.classes, device=device, verbose=False)[0]
                raw = [(box[:4], {CLASS_MAP.get(str(names[int(box[5])]).lower()): box[4]}, box[4]) for box in result.boxes.data.cpu().tolist()]
                if verifier:
                    # People and devices come from the open-vocabulary model; best.pt only votes on the label.
                    persons, aids = scene.update(verifier.detect(frame), [(box, votes) for box, votes, _ in raw],
                                                 lambda person: verifier.seated(frame, person), (width, height))
                else:
                    aids = [{'label': next(iter(votes)), 'confidence': score, 'box': box, 'owners': []} for box, votes, score in raw]
            someone_inside = any(in_region(person[:4], region_mask, args.anchor) for person in persons)
            for x1, y1, x2, y2, confidence in persons:
                cv2.rectangle(view, (int(x1), int(y1)), (int(x2), int(y2)), (170, 170, 170), 1)
                cv2.putText(view, f'person {confidence:.2f}', (max(0, int(x1)), max(20, int(y1) - 6)), cv2.FONT_HERSHEY_SIMPLEX, .45, (170, 170, 170), 1)
            inside_detections, all_detections = [], []
            for aid in aids:
                label, confidence, (x1, y1, x2, y2) = aid['label'], aid['confidence'], aid['box']
                # In the region when the device is, or when a person with it is.
                inside = in_region(aid['box'], region_mask, args.anchor) or any(in_region(owner[:4], region_mask, args.anchor) for owner in aid['owners'])
                all_detections.append({'label': label or 'UNKNOWN', 'confidence': round(float(confidence), 3)})
                if inside and label:
                    inside_detections.append({'label': label, 'confidence': round(float(confidence), 3)})
                color = (0, 100, 255) if inside else (220, 180, 70)
                cv2.rectangle(view, (int(x1), int(y1)), (int(x2), int(y2)), color, 2)
                cv2.putText(view, f'{(label or "?").lower()} {confidence:.2f}', (max(0, int(x1)), max(20, int(y1) - 8)), cv2.FONT_HERSHEY_SIMPLEX, .6, color, 2)
                cv2.circle(view, tuple(round(v) for v in anchor_point(aid['box'], args.anchor)), 5, color, -1)
            # Occupancy: an aid in the region starts the trigger and fixes what is reported. After that
            # the region stays occupied for as long as anybody is in it (people are detected far more
            # steadily than aids), and clears only once it has been empty for `exit_frames`.
            now = position / fps_src if is_file else time.monotonic()  # recordings run on their own clock
            was_active = active
            if inside_detections or (active and someone_inside):
                last_seen = now
            since = (since if since is not None else now) if inside_detections else None
            if not active and since is not None and now - since >= args.enter_seconds:
                active = True
            elif active and now - last_seen >= args.exit_seconds:
                active = False
            entered = active and not was_active
            before = sorted(d['label'] for d in held)
            if inside_detections:
                held = inside_detections
            processed += 1
            if active and not entered and sorted(d['label'] for d in held) != before:
                record({'event': 'LABEL', 'frame': processed, 'labels': sorted(d['label'] for d in held), 'was': before})
            if entered:
                record({'event': 'TRIGGER', 'frame': processed, 'targets_in_region': len(held), 'labels': sorted(d['label'] for d in held)})
                post(held, 'enter'); last_heartbeat = time.monotonic()
            elif active and time.monotonic() - last_heartbeat >= args.heartbeat:
                post(held, 'heartbeat'); last_heartbeat = time.monotonic()
            elif was_active and not active:  # exit transition
                record({'event': 'CLEAR', 'frame': processed})
                post([], 'exit', sorted({d['label'] for d in held})); held = []
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
            while ok_jpeg and pending:
                (args.snapshots / pending.pop()).write_bytes(buf.tobytes())
            if ok_jpeg:
                shared.set(buf.tobytes(), {'triggered': active, 'inside': len(inside_detections), 'held': held if active else [], 'detections': all_detections[:20], 'persons': len(persons), 'frames': processed})
            fps_count += 1
            if time.monotonic() - tick_fps >= 1:
                shared.fps = fps_count / (time.monotonic() - tick_fps); tick_fps = time.monotonic(); fps_count = 0
            if args.max_frames and processed >= args.max_frames:
                break
            if not args.no_window:
                cv2.imshow(window, view)
                if cv2.waitKey(1) & 0xff == ord('q'):
                    break
            if is_file and args.realtime:  # a live camera would have moved on by this many frames
                for _ in range(max(0, round((time.monotonic() - tick) * fps_src) - 1)):
                    cap.grab(); position += 1
            elif is_file:  # pace file playback at the source frame rate
                time.sleep(max(0.0, 1 / fps_src - (time.monotonic() - tick)))
    finally:
        cap.release(); server.shutdown()
        if writer is not None:
            writer.release()
        if log:
            log.close()
        if not args.no_window:
            cv2.destroyAllWindows()
        print(json.dumps({'processed_frames': processed, 'triggered_final': active}), flush=True)


if __name__ == '__main__':
    main()
