"""Stand-in for yolo_bridge.py: replays a captured session, with no camera and no YOLO.

A capture is what `yolo_bridge.py --capture DIR` saved during a real run: annotated.mp4 (the
frames the dashboard showed, boxes and region included) and signals.jsonl (every hub post with
its time in that video). This script serves the video on the same /stream.mjpg, /snapshot.jpg
and /health endpoints and posts the same perception payloads at the same moments, so the
dashboard, the App and the hub cannot tell it from the live bridge.

    .venv/bin/python replay_bridge.py --capture ../demos/captures/venue_wheelchair --loop

Only OpenCV and NumPy are needed (no torch, no weights), which makes it the CV module for
anybody working on the App or the dashboard.
"""
from __future__ import annotations

import argparse
import json
import os
import threading
import time
from datetime import datetime, timezone
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib import request

import cv2

from ride_signal_client import RideSignalClient
from yolo_bridge import SharedFrame, make_handler


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--capture', type=Path, required=True, help='Folder with annotated.mp4 and signals.jsonl')
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
    video = args.capture / 'annotated.mp4'
    signals = [json.loads(line) for line in (args.capture / 'signals.jsonl').read_text(encoding='utf-8').splitlines() if line.strip()]
    if not video.is_file():
        raise FileNotFoundError(f'No annotated.mp4 in {args.capture}')

    shared = SharedFrame()
    info = {'source': f'replay:{args.capture.name}', 'device': 'replay', 'roi': 'recorded',
            'bridge_url': None if args.no_signal else args.bridge_url}
    server = ThreadingHTTPServer((args.mjpeg_host, args.mjpeg_port), make_handler(shared, info))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    client = None if args.no_signal else RideSignalClient(args.bridge_url, args.bridge_token)
    print(f'Replaying {video} with {len(signals)} signals', flush=True)
    print(f'Preview: http://127.0.0.1:{args.mjpeg_port}/stream.mjpg  Health: http://127.0.0.1:{args.mjpeg_port}/health', flush=True)

    def send(signal):
        payload = signal['payload']
        line = {'event': 'SIGNAL', 'second': signal['t'], 'reason': payload['zone'].get('event'),
                'labels': [d['label'] for d in payload['yolo_detections']] or payload['zone'].get('left', [])}
        if client is not None:
            try:
                client.signal(signal['channel'], payload, observed_at=datetime.now(timezone.utc).isoformat())
            except Exception as failure:  # keep streaming even if the hub is down
                line = {**line, 'event': 'SIGNAL_FAILED', 'error': str(failure)[:200]}
        print(json.dumps(line), flush=True)
        shared.status.update({'triggered': payload['zone']['triggered'], 'held': payload['yolo_detections'],
                              'last_signal': {'at': time.time(), 'reason': line['reason'], 'labels': line['labels']}})

    def booked():
        try:
            with request.urlopen(request.Request(f"{args.bridge_url.rstrip('/')}/api/state", headers=headers), timeout=2) as reply:
                return (json.load(reply).get('journey') or {}).get('stage') == 'BOOKED'
        except (OSError, ValueError):
            return False

    headers = {'Authorization': f'Bearer {args.bridge_token}'} if args.bridge_token else {}
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
                if ok:
                    shared.set(cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, args.jpeg_quality])[1].tobytes(), {'frames': first})
                print('Waiting for a booking (journey stage BOOKED) ...', flush=True)
                while not booked():
                    time.sleep(0.5)
                print('Booking seen, playing.', flush=True)
            start, frame_index = time.monotonic(), first
            upcoming = [signal for signal in signals if signal['t'] >= first / fps]
            while True:
                ok, frame = cap.read()
                if not ok:
                    break
                second = frame_index / fps
                while upcoming and upcoming[0]['t'] <= second:
                    send(upcoming.pop(0))
                ok_jpeg, buf = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, args.jpeg_quality])
                if ok_jpeg:
                    shared.set(buf.tobytes(), {'frames': frame_index})
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
        server.shutdown()


if __name__ == '__main__':
    main()
