"""Run in the team's existing Ultralytics environment with their own weights."""
import argparse
from datetime import datetime, timezone
from ride_signal_client import RideSignalClient, YoloSignalPublisher, detections_from_ultralytics

parser = argparse.ArgumentParser()
parser.add_argument("--weights", required=True, help="Your wheelchair/crutch detector weights")
parser.add_argument("--source", default="0", help="Camera index or video path")
args = parser.parse_args()

from ultralytics import YOLO  # Installed only in the existing vision environment.
import cv2

model = YOLO(args.weights)
source = int(args.source) if args.source.isdigit() else args.source
publisher = YoloSignalPublisher(RideSignalClient())
capture = cv2.VideoCapture(source)
try:
    while capture.isOpened():
        ok, frame = capture.read()
        if not ok:
            break
        # Frame acquisition time is captured BEFORE inference, so slow inference ages the data.
        # For buffered/network cameras use the camera's original timestamp when available.
        observed_at = datetime.now(timezone.utc).isoformat()
        result = model.predict(source=frame, verbose=False)[0]
        publisher.observe(
            detections_from_ultralytics(result), observed_at=observed_at,
            matched=False,  # Set only after real booking/track association.
            # The web simulator supplies its own scene geometry; YOLO need not measure it.
        )
finally:
    capture.release()
