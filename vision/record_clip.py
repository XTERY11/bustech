"""Record raw frames from a camera or stream to an MP4, with no detection and no overlay.

A recording of a rehearsal is a repeatable test: yolo_bridge.py can replay it with
--source <file>, so a change can be checked against the same footage instead of asking
people to walk through the scenarios again.

    .venv/bin/python record_clip.py --source "http://172.20.10.4:4747/video" --seconds 180
"""
from __future__ import annotations

import argparse
import time
from datetime import datetime
from pathlib import Path

import cv2

ROOT = Path(__file__).resolve().parent


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--source', default='0', help='Camera index, RTSP or HTTP video stream')
    p.add_argument('--seconds', type=float, default=180)
    p.add_argument('--out', type=Path, help='Default: recordings/<date>_<time>.mp4')
    p.add_argument('--fps', type=float, default=30, help='Frame rate written to the file')
    args = p.parse_args()
    out = args.out or ROOT / 'recordings' / f"{datetime.now().strftime('%Y%m%d_%H%M%S')}.mp4"
    out.parent.mkdir(parents=True, exist_ok=True)
    cap = cv2.VideoCapture(int(args.source) if args.source.isdecimal() else args.source)
    if not cap.isOpened():
        raise RuntimeError('Cannot open source. Check camera index, permissions, or stream connection.')
    writer, frames, started = None, 0, time.monotonic()
    print(f'Recording {args.seconds:.0f} s to {out}', flush=True)
    try:
        while time.monotonic() - started < args.seconds:
            ok, frame = cap.read()
            if not ok:
                print('Stream stopped delivering frames.', flush=True)
                break
            if writer is None:
                writer = cv2.VideoWriter(str(out), cv2.VideoWriter_fourcc(*'mp4v'), args.fps, (frame.shape[1], frame.shape[0]))
            writer.write(frame)
            frames += 1
            if frames % 300 == 0:
                print(f'{time.monotonic() - started:.0f} s, {frames} frames', flush=True)
    finally:
        cap.release()
        if writer is not None:
            writer.release()
    elapsed = time.monotonic() - started
    print(f'Saved {frames} frames in {elapsed:.0f} s ({frames / max(elapsed, 1e-6):.1f} fps received): {out}', flush=True)


if __name__ == '__main__':
    main()
