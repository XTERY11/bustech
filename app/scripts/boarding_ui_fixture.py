"""Deterministic HTTP fixture for the passenger-status stages, including explicit CV exit; no real booking."""
import json
import threading
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

lock = threading.Lock()
booking = None
stage = 1


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        global booking, stage
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        with lock:
            if self.path == '/test/stage':
                stage = body['stage']
                self.reply(200, {})
            elif self.path == '/api/booking':
                booking = body
                if body['payload']['active']:
                    stage = 1
                self.reply(202, {'accepted': True})
            else:
                self.reply(404, {})

    def do_GET(self):
        with lock:
            if self.path != '/api/state' or booking is None:
                self.reply(404, {})
                return
            request = booking['payload']
            result = {
                'request_id': 'boarding-fixture', 'plan_status': 'READY',
                'simulated': True, 'execution_authorized': False,
                'boarding_target': {'type': 'SEAT', 'id': 'S03'},
                'passenger_communication': {'channel': 'BOTH', 'language': 'en-SG',
                    'display_text': 'Please board through the open entrance and take seat S03 on your left.',
                    'audio_text': None}}
            self.reply(200, {'source': 'external', 'running': None, 'result': result,
                'channels': {
                    'booking': {'event_id': booking['event_id'], 'observed_at': datetime.fromisoformat(booking['observed_at']).timestamp() * 1000},
                    'perception': {'event_id': 'fixture-trigger', 'observed_at': time.time() * 1000}},
                'context': {'request': request, 'perception': {'zone': {'triggered': stage in (2, 3), 'roi_id': 'fixture-stop',
                    'event': 'exit' if stage == 4 else 'enter' if stage >= 2 else 'present'}},
                    'vehicle_context': {'route_id': request['route_id'], 'stop_id': request['stop_id'],
                        'motion_state': 'STOPPED' if stage >= 3 else 'MOVING',
                        'parking_brake_engaged': stage >= 3, 'observation_age_ms': 0}}})


if __name__ == '__main__':
    ThreadingHTTPServer(('127.0.0.1', 18789), Handler).serve_forever()
