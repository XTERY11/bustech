"""Deterministic HTTP fixture for the passenger-status rounds; no real booking.

Serves a v0.5-shaped /api/state with `journey` and `navigation` (dashboard/backend/journey.mjs) plus
the legacy fields. POST /test/stage {"stage": n} selects the journey:
  1 BOOKED (go to the stop)            2 AT_STOP matched, "Bus arriving"
  3 AT_STOP matched, "Ready to board"  4 ON_BOARD, seat S03 with step-by-step guidance
  5 AT_STOP unmatched (stroller)       6 legacy hub: no journey/navigation keys at all
"""
import json
import threading
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

lock = threading.Lock()
booking = None
stage = 1
revision = 1
started_at = time.time() * 1000

SEAT = {'type': 'SEAT', 'id': 'S03'}
STEPS = [
    {'step': 1, 'maneuver': 'START', 'distance_m': None, 'text': 'From the entrance, face into the bus.'},
    {'step': 2, 'maneuver': 'STRAIGHT', 'distance_m': 0.9, 'text': 'Continue straight for 0.9 metres.'},
    {'step': 3, 'maneuver': 'TURN_LEFT', 'distance_m': None, 'text': 'Turn left.'},
    {'step': 4, 'maneuver': 'ARRIVE', 'distance_m': None, 'text': 'Arrive at seat S03 and wait for the safety operator.'},
]
BOOKED_TEXT = 'Please go to the marked boarding point at the demo bus stop for route 400. Your assistance plan is ready.'


def say(title, text):
    return {'title': title, 'display_text': text, 'audio_text': text}


def journey_and_navigation(request, event_id):
    """Mirrors the hub's journey for each fixture stage."""
    stop = {'type': 'BUS_STOP', 'id': request['stop_id']}
    cabin = {'steps': STEPS, 'simulated': True}
    base = {'journey_id': event_id, 'revision': revision, 'need': request['accessibility_need'],
            'seat': 'S03', 'boarding_target': SEAT, 'completed': False, 'pending_exit': False,
            'labels': [], 'matched': False, 'animation': None, 'visit_id': None, 'roi_id': 'fixture-stop'}
    nav = {'id': event_id, 'revision': revision, 'phase': 'TO_STOP', 'destination': stop,
           'instruction': BOOKED_TEXT, 'simulated': True, 'steps': [], 'cabin_route': cabin}
    if not request['active']:
        return ({**base, 'stage': 'IDLE', 'need': None, 'seat': None, 'boarding_target': None, 'reason': 'cancelled',
                 'guidance': say('Booking cancelled', 'Your assistance request has been cancelled.')}, None)
    arrival = {'id': f'{event_id}:legacy:{revision}:arrival', 'phase': 'arrival', 'aid': 'wheelchair',
               'started_at': started_at, 'duration_ms': 10000, 'target': SEAT}
    if stage == 2:
        text = 'We have recognised you at the bus stop. The bus is arriving; please stay behind the marked boarding line.'
        return ({**base, 'stage': 'AT_STOP', 'matched': True, 'labels': ['WHEELCHAIR'], 'reason': 'entered',
                 'animation': arrival, 'guidance': say('Bus arriving', text)},
                {**nav, 'phase': 'WAIT_AT_STOP', 'instruction': text})
    if stage == 3:
        text = 'Please board through the open entrance and take seat S03 on your left.'
        return ({**base, 'stage': 'AT_STOP', 'matched': True, 'labels': ['WHEELCHAIR'], 'reason': 'entered',
                 'animation': arrival, 'guidance': say('Ready to board', text)},
                {**nav, 'phase': 'BOARD_BUS', 'instruction': text})
    if stage == 4:
        text = ' '.join(step['text'] for step in STEPS)
        boarding = {**arrival, 'id': f'{event_id}:boarding', 'phase': 'boarding', 'duration_ms': 16000}
        return ({**base, 'stage': 'ON_BOARD', 'matched': True, 'labels': ['WHEELCHAIR'], 'completed': True,
                 'reason': 'boarding_preview', 'animation': boarding, 'guidance': say('Follow guidance to seat S03', text)},
                {**nav, 'phase': 'TO_SEAT', 'destination': SEAT, 'instruction': text, 'steps': STEPS})
    if stage == 5:
        text = 'The detected assistance does not match the booking. Please wait for the safety operator.'
        return ({**base, 'stage': 'AT_STOP', 'labels': ['STROLLER'], 'reason': 'unmatched',
                 'guidance': say('Please wait at the stop', text)},
                {**nav, 'phase': 'WAIT_AT_STOP', 'instruction': text})
    return ({**base, 'stage': 'BOOKED', 'reason': 'booked', 'guidance': say('Go to the bus stop', BOOKED_TEXT)}, nav)


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
        global booking, stage, revision, started_at
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        with lock:
            if self.path == '/test/stage':
                if body['stage'] != stage:
                    revision += 1
                if body['stage'] in (2, 3) and stage not in (2, 3):
                    started_at = time.time() * 1000
                stage = body['stage']
                self.reply(200, {})
            elif self.path == '/api/booking':
                booking = body
                revision += 1
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
                'boarding_target': SEAT,
                'passenger_communication': {'channel': 'BOTH', 'language': 'en-SG',
                    'display_text': 'Please board through the open entrance and take seat S03 on your left.',
                    'audio_text': None}}
            state = {'source': 'external', 'running': None, 'result': result,
                'channels': {
                    'booking': {'event_id': booking['event_id'], 'observed_at': datetime.fromisoformat(booking['observed_at'].replace('Z', '+00:00')).timestamp() * 1000},
                    'perception': {'event_id': 'fixture-trigger', 'observed_at': time.time() * 1000}},
                'context': {'request': request, 'perception': {'zone': {'triggered': stage in (2, 3, 5), 'roi_id': 'fixture-stop',
                    'event': 'exit' if stage == 4 else 'enter' if stage >= 2 else 'present'}},
                    'vehicle_context': {'route_id': request['route_id'], 'stop_id': request['stop_id'],
                        'motion_state': 'STOPPED' if stage >= 3 else 'MOVING',
                        'parking_brake_engaged': stage >= 3, 'observation_age_ms': 0}}}
            if stage != 6:
                state['journey'], state['navigation'] = journey_and_navigation(request, booking['event_id'])
            self.reply(200, state)


if __name__ == '__main__':
    ThreadingHTTPServer(('127.0.0.1', 18789), Handler).serve_forever()
