#!/usr/bin/env python3
"""Minimal LAN receiver for testing BusPulse assistance requests."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


MAX_BODY_BYTES = 1_000_000


class AssistanceRequestHandler(BaseHTTPRequestHandler):
    server_version = "BusPulseTestReceiver/1.0"

    def do_GET(self) -> None:
        if self.path == "/health":
            self._send_json(200, {"status": "ok"})
            return
        self._send_json(404, {"error": "not_found"})

    def do_POST(self) -> None:
        if self.path != "/assistance":
            self._send_json(404, {"error": "not_found"})
            return

        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._send_json(400, {"error": "invalid_content_length"})
            return

        if content_length <= 0 or content_length > MAX_BODY_BYTES:
            self._send_json(400, {"error": "invalid_body_size"})
            return

        try:
            payload = json.loads(self.rfile.read(content_length))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._send_json(400, {"error": "invalid_json"})
            return

        request_id = str(payload.get("requestID", "unknown"))
        received_at = datetime.now(timezone.utc).isoformat()
        print(f"\n[{received_at}] Assistance request from {self.client_address[0]}")
        print(json.dumps(payload, indent=2, ensure_ascii=False), flush=True)

        self._send_json(
            200,
            {
                "providerReference": f"MAC-{request_id[:8].upper()}",
                "receivedAt": received_at,
            },
        )

    def log_message(self, format: str, *args: object) -> None:
        print(f"HTTP: {format % args}", flush=True)

    def _send_json(self, status: int, payload: dict[str, str]) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8080)
    args = parser.parse_args()

    server = ThreadingHTTPServer(("0.0.0.0", args.port), AssistanceRequestHandler)
    print(f"BusPulse test receiver listening on 0.0.0.0:{args.port}", flush=True)
    print("POST endpoint: /assistance", flush=True)
    print("Health check: /health", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping receiver.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
