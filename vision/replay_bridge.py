"""Stand-in for yolo_bridge.py: replays a captured session, with no camera and no YOLO.

A capture is what `yolo_bridge.py --capture DIR` saved during a real run: annotated.mp4 (the
frames the dashboard showed, boxes and region included) and signals.jsonl (every hub post with
its time in that video). This script serves the video on the same /stream.mjpg, /snapshot.jpg
and /health endpoints and posts the same perception payloads at the same moments, so the
dashboard, the App and the hub cannot tell it from the live bridge.

    .venv/bin/python replay_bridge.py --capture ../demos/captures/venue_wheelchair --loop

Only OpenCV and NumPy are needed (no torch, no weights), which makes it the CV module for
anybody working on the App or the dashboard.

Every pass posts with fresh event ids and maps each recorded zone.visit_id to a fresh one (a
capture made before visit ids existed gets one per enter..exit), so the hub treats a looped pass
as new visits instead of duplicates. Posts go through the same ordered background queue as the
live bridge (retry unchanged, never drop enter/exit), so /health reports the same delivery fields.
"""
from __future__ import annotations

import argparse
import json
import os
import threading
import time
import uuid
from copy import deepcopy
from datetime import datetime, timezone
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib import request

import cv2

from ride_signal_client import OrderedSignalQueue, RideSignalClient
from yolo_bridge import SharedFrame, make_handler


def fresh_visits(signals, new_id=lambda: uuid.uuid4().hex[:12]):
    """Copy of one pass of signals in which every recorded zone.visit_id is replaced by a new 12-char id
    (the same new id for all signals of that visit). Signals without a visit_id (older captures) get one
    per enter..exit run. Recorded signals are not changed."""
    mapping, current, out = {}, None, []
    for signal in signals:
        signal = deepcopy(signal)
        zone = signal.get('payload', {}).get('zone')
        if isinstance(zone, dict):
            recorded = zone.get('visit_id')
            if recorded:
                if recorded not in mapping:
                    mapping[recorded] = new_id()
                zone['visit_id'] = mapping[recorded]
            else:
                if zone.get('event') == 'enter' or current is None:
                    current = new_id()
                zone['visit_id'] = current
                if zone.get('event') == 'exit':
                    current = None
        out.append(signal)
    return out


# Which recorded aid shows a booked need. Needs without a visible aid are played with the cane clip.
NEED_CLIP = {'WHEELCHAIR': 'wheelchair', 'STROLLER': 'stroller', 'CANE': 'cane', 'CRUTCH': 'cane', 'WALKER': 'cane', 'VISUAL_ASSISTANCE': 'cane'}


def load_clips(folder):
    """{name: (video path, signals)} for one capture folder or a folder of capture folders."""
    folders = [folder] if (folder / 'annotated.mp4').is_file() else sorted(d for d in folder.iterdir() if (d / 'annotated.mp4').is_file())
    if not folders:
        raise FileNotFoundError(f'No annotated.mp4 in {folder}')
    return {d.name: (d / 'annotated.mp4', [json.loads(line) for line in (d / 'signals.jsonl').read_text(encoding='utf-8').splitlines() if line.strip()])
            for d in folders}


def clip_for(need, clips):
    name = NEED_CLIP.get(need)
    return name if name in clips else ('wheelchair' if 'wheelchair' in clips else next(iter(clips)))


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--capture', type=Path, required=True,
                   help='Folder with annotated.mp4 and signals.jsonl, or a folder of such folders named after the aid '
                        '(wheelchair/, stroller/, cane/): with --after-booking the one matching the booked need is played')
    p.add_argument('--loop', action='store_true', help='Start again when the video ends')
    p.add_argument('--after-booking', action='store_true',
                   help='Hold the first frame until the hub has a booking (journey stage BOOKED), then play; with --loop, wait again after every pass')
    p.add_argument('--start', type=float, default=0.0, help='Skip this many seconds at the start of the video')
    p.add_argument('--mjpeg-host', default='0.0.0.0')
    p.add_argument('--mjpeg-port', type=int, default=8790)
    p.add_argument('--bridge-url', default=os.getenv('RIDE_BRIDGE_URL', 'http://127.0.0.1:8787'), help='Signal hub base URL')
    p.add_argument('--bridge-token', default=os.getenv('BRIDGE_TOKEN', ''))
    p.add_argument('--no-signal', action='store_true', help='Stream only, do not post to the hub')
    p.add_argument('--jpeg-quality', type=int, default=80)
    args = p.parse_args()
    clips = load_clips(args.capture)
    video, signals = clips[next(iter(clips))]

    shared = SharedFrame()
    info = {'source': f'replay:{args.capture.name}', 'device': 'replay', 'roi': 'recorded',
            'bridge_url': None if args.no_signal else args.bridge_url}
    client = None if args.no_signal else RideSignalClient(args.bridge_url, args.bridge_token)
    delivery = OrderedSignalQueue(client) if client else None
    server = ThreadingHTTPServer((args.mjpeg_host, args.mjpeg_port), make_handler(shared, info, delivery))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    if delivery:
        delivery.start()
    print(f'Replaying {args.capture}: {", ".join(clips)}', flush=True)
    print(f'Preview: http://127.0.0.1:{args.mjpeg_port}/stream.mjpg  Health: http://127.0.0.1:{args.mjpeg_port}/health', flush=True)

    def send(signal):
        payload = signal['payload']
        line = {'event': 'SIGNAL', 'second': signal['t'], 'reason': payload['zone'].get('event'),
                'visit_id': payload['zone'].get('visit_id'),
                'labels': [d['label'] for d in payload['yolo_detections']] or payload['zone'].get('left', [])}
        if delivery is not None:  # fresh event_id and observed_at; the queue retries it unchanged
            envelope = delivery.enqueue(signal['channel'], payload, observed_at=datetime.now(timezone.utc).isoformat())
            line = {**line, 'event': 'SIGNAL_QUEUED', 'event_id': envelope['event_id']}
        print(json.dumps(line), flush=True)
        shared.status.update({'triggered': payload['zone']['triggered'], 'held': payload['yolo_detections']})

    def booked():
        """The booked need once the hub has a booking, else None."""
        try:
            with request.urlopen(request.Request(f"{args.bridge_url.rstrip('/')}/api/state", headers=headers), timeout=2) as reply:
                journey = json.load(reply).get('journey') or {}
                return (journey.get('need') or 'UNKNOWN') if journey.get('stage') == 'BOOKED' else None
        except (OSError, ValueError):
            return None

    headers = {'Authorization': f'Bearer {args.bridge_token}'} if args.bridge_token else {}
    shown = 0  # frames served since start; never goes back, or the dashboard takes it for a bridge restart and reconnects
    still = b''  # what the stream shows while waiting: the last frame of the pass before, else the first frame
    try:
        while True:
            cap = cv2.VideoCapture(str(video))
            fps = cap.get(cv2.CAP_PROP_FPS) or 15
            first = round(args.start * fps)
            cap.set(cv2.CAP_PROP_POS_FRAMES, first)
            shared.status.update({'triggered': False, 'held': []})
            if args.after_booking:
                ok, frame = cap.read()
                cap.set(cv2.CAP_PROP_POS_FRAMES, first)
                if not still and ok:
                    still = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, args.jpeg_quality])[1].tobytes()
                print('Waiting for a booking (journey stage BOOKED) ...', flush=True)
                shared.fps = 2
                need = None
                while not need:
                    if still:  # keep sending the frame: a browser only draws an MJPEG part once the next one arrives
                        shown += 1; shared.set(still, {'frames': shown})
                    time.sleep(0.5)
                    need = booked()
                name = clip_for(need, clips)
                if clips[name][0] != video:
                    cap.release(); video, signals = clips[name]
                    cap = cv2.VideoCapture(str(video)); fps = cap.get(cv2.CAP_PROP_FPS) or 15
                    first = round(args.start * fps); cap.set(cv2.CAP_PROP_POS_FRAMES, first)
                print(f'Booking seen ({need}), playing {name}.', flush=True)
            start, frame_index = time.monotonic(), first
            upcoming = fresh_visits([signal for signal in signals if signal['t'] >= first / fps])
            while True:
                ok, frame = cap.read()
                if not ok:
                    break
                second = frame_index / fps
                while upcoming and upcoming[0]['t'] <= second:
                    send(upcoming.pop(0))
                ok_jpeg, buf = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, args.jpeg_quality])
                if ok_jpeg:
                    still = buf.tobytes()
                    shown += 1; shared.set(still, {'frames': shown})
                shared.fps = fps
                frame_index += 1
                time.sleep(max(0.0, start + (frame_index - first) / fps - time.monotonic()))
            cap.release()
            for signal in upcoming:  # a post recorded on the very last frame
                send(signal)
            if not args.loop:
                print('Replay finished.', flush=True)
                break
    finally:
        if delivery:  # let the last exit reach the hub; the queue is not persisted
            deadline = time.monotonic() + 3
            while delivery.diagnostics()['pending_signals'] and time.monotonic() < deadline:
                time.sleep(0.05)
            unsent = delivery.close()
            if unsent:
                print(json.dumps({'event': 'SIGNALS_PENDING_ON_STOP', 'pending_signals': unsent}), flush=True)
        server.shutdown()


if __name__ == '__main__':
    main()
