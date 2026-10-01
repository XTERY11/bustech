"""Send synthetic App and YOLO signals through the actual HTTP endpoints.

The default rules mode costs nothing. --mode single/two_turn makes real API calls
if the bridge has a DeepSeek key. Values below are demo fixtures, not sensors.
"""
import argparse
import json
import time
from pathlib import Path
from ride_signal_client import RideSignalClient

parser = argparse.ArgumentParser()
parser.add_argument("--scenario", choices=["wheelchair_auto", "crutch", "visual", "hearing"], default="wheelchair_auto")
parser.add_argument("--mode", choices=["rules", "single", "two_turn"], default="rules")
parser.add_argument("--seconds", type=float, default=6)
args = parser.parse_args()
cases = json.loads((Path(__file__).resolve().parents[1] / "backend/examples/demo_cases.json").read_text(encoding="utf-8"))
context = next(c["input"] for c in cases if c["name"] == args.scenario)
client = RideSignalClient()
client.post("/api/settings", {"mode": args.mode})
if "request" in context:
    client.signal("booking", context["request"])
deadline = time.monotonic() + args.seconds
print("Sending SYNTHETIC App + YOLO signals. Vehicle conditions are supplied by the web simulator.")
while time.monotonic() < deadline:
    client.signal("perception", {"yolo_detections": context["perception"].get("yolo_detections", [])})
    time.sleep(0.3)
print("Signal stream stopped. The last demo snapshot stays visible for presentation.")
