"""Deterministic HTTP fixture for the passenger-status rounds; no real booking.

Serves a v0.5-shaped /api/state with `journey` and `navigation` (dashboard/backend/journey.mjs) plus
the legacy fields, and the waiting list `journeys` (one entry per booking, with its own `navigation`).
POST /test/stage {"stage": n} selects this booking's journey:
  1 BOOKED (go to the stop)            2 AT_STOP matched, "Bus arriving"
  3 AT_STOP matched, "Ready to board"  4 ON_BOARD, seat S03 with step-by-step guidance
  5 AT_STOP unmatched (stroller)       6 legacy hub: no journey/navigation/journeys keys at all
  7 waiting list: queued behind another passenger ("ahead", default 2)
  8 waiting list: recognised at the stop while another passenger boards (reason waiting_turn)
  9 waiting list: no accessible place left (reason no_place)
 10 waiting list: the hub no longer lists this booking (dropped)
Optional keys: "ahead": n (stage 7), "journeys": false (stages 1-5 as a single-journey hub, without `journeys`).
POST /test/reject {"need_booked": true} answers the next booking with 409 NEED_ALREADY_BOOKED.
Cancel (`active: false`, `cancels: <event id>`) after ON_BOARD (stage 4) is the finish/reset: the journey ends with
reason `completed`; before that it is reason `cancelled`. The ended booking stays listed in `journeys` (as the hub
keeps finished entries for ~2 minutes) after the next booking arrives, so a phone must pick its new event id.
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
ahead = 2
list_journeys = True
reject_next = False
finished = False
history = []  # Ended bookings still listed by the hub, oldest first.
OTHER_ID = 'app-booking-fixture-other'

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
    if not request['active'] and finished:
        return ({**base, 'stage': 'IDLE', 'completed': True, 'reason': 'completed',
                 'guidance': say('Journey finished', 'The passenger is on board. The bus is ready for the next passenger.')}, None)
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
    if stage == 7:
        people = 'One passenger is' if ahead == 1 else f'{ahead} passengers are'
        text = f'{people} ahead of you. Please wait near the stop; the bus serves one passenger at a time.'
        return ({**base, 'stage': 'BOOKED', 'reason': 'booked', 'seat': None, 'boarding_target': None,
                 'queued': True, 'position': ahead, 'guidance': say('Booking received', text)}, None)
    if stage == 8:
        text = 'Another passenger is boarding. Please wait at the stop; you are next.'
        return ({**base, 'stage': 'BOOKED', 'reason': 'waiting_turn', 'seat': None, 'boarding_target': None,
                 'queued': True, 'position': 0, 'guidance': say('Please wait at the stop', text)}, None)
    if stage == 9:
        text = 'No accessible place is left on this bus. Please wait for the safety operator.'
        return ({**base, 'stage': 'BOOKED', 'reason': 'no_place', 'seat': None, 'boarding_target': None,
                 'queued': True, 'position': 0, 'guidance': say('Please wait for the operator', text)}, None)
    return ({**base, 'stage': 'BOOKED', 'reason': 'booked', 'guidance': say('Go to the bus stop', BOOKED_TEXT)}, nav)


def other_passenger():
    """Another phone's booking, boarding now, for the waiting-list stages."""
    text = 'We have recognised you at the bus stop. The bus is arriving; please stay behind the marked boarding line.'
    return {'journey_id': OTHER_ID, 'revision': 3, 'stage': 'AT_STOP', 'need': 'CANE', 'labels': ['CANE'], 'matched': True,
            'seat': 'S02', 'boarding_target': {'type': 'SEAT', 'id': 'S02'}, 'completed': False, 'pending_exit': False,
            'animation': None, 'reason': 'entered', 'queued': False, 'position': 0, 'plan_status': 'READY',
            'updated_at': time.time() * 1000, 'guidance': say('Bus arriving', text),
            'navigation': {'id': OTHER_ID, 'revision': 3, 'phase': 'WAIT_AT_STOP', 'destination': {'type': 'BUS_STOP', 'id': 'DEMO_STOP'},
                           'instruction': text, 'simulated': True, 'steps': [], 'cabin_route': None}}


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
        global booking, stage, revision, started_at, ahead, list_journeys, reject_next, finished
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        with lock:
            if self.path == '/test/stage':
                if body['stage'] != stage:
                    revision += 1
                if body['stage'] in (2, 3) and stage not in (2, 3):
                    started_at = time.time() * 1000
                stage = body['stage']
                ahead = max(1, int(body.get('ahead', ahead)))
                list_journeys = body.get('journeys', True) is not False
                self.reply(200, {})
            elif self.path == '/test/reject':
                reject_next = bool(body.get('need_booked'))
                self.reply(200, {})
            elif self.path == '/api/booking' and reject_next and body['payload']['active']:
                reject_next = False
                self.reply(409, {'error': 'NEED_ALREADY_BOOKED', 'need': body['payload']['accessibility_need'],
                                 'existing_journey_id': OTHER_ID})
            elif self.path == '/api/booking':
                if body['payload']['active']:
                    if booking is not None:
                        ended, _ = journey_and_navigation(booking['payload'], booking['event_id'])
                        history.append({**ended, 'queued': False, 'position': 0, 'navigation': None})
                        del history[:-3]
                    booking, finished, stage = body, False, 1
                else:
                    # The cancellation names the booking it ends; the journey keeps that booking's id.
                    finished = stage == 4
                    booking = {**body, 'event_id': body['payload'].get('cancels') or body['event_id']}
                revision += 1
                # A waiting-list hub adds journey_id/queued/position; a single-journey hub sends accepted only.
                self.reply(202, {'accepted': True, 'journey_id': body['event_id'], 'queued': False, 'position': 0}
                           if list_journeys else {'accepted': True})
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
                journey, navigation = journey_and_navigation(request, booking['event_id'])
                waiting = stage in (7, 8, 9, 10)
                # Top level: the journey in progress, which is the other passenger's while this one waits.
                other = other_passenger()
                if waiting:
                    state['journey'] = {key: value for key, value in other.items() if key != 'navigation'}
                    state['navigation'] = other['navigation']
                else:
                    state['journey'], state['navigation'] = journey, navigation
                if waiting or list_journeys:
                    own = {'queued': False, 'position': 0, 'plan_status': 'READY', **journey, 'navigation': navigation}
                    state['journeys'] = history + ([other] if stage == 10 else [other, own] if waiting else [own])
            self.reply(200, state)


if __name__ == '__main__':
    ThreadingHTTPServer(('127.0.0.1', 18789), Handler).serve_forever()
