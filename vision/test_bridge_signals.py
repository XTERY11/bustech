"""What the Sense bridge posts and how replay_bridge.py renews visits; no camera, model or hub."""
import itertools
import unittest

from replay_bridge import fresh_visits
from ride_signal_client import OrderedSignalQueue
from yolo_bridge import perception_payload

CANE = [{'label': 'CANE', 'confidence': .91}]


def signal(t, event, visit=None):
    detections = [] if event == 'exit' else CANE
    zone = {'triggered': bool(detections), 'roi_id': 'stop', 'event': event}
    if visit:
        zone['visit_id'] = visit
    return {'t': t, 'channel': 'perception', 'payload': {'yolo_detections': detections, 'target_match_confirmed': bool(detections), 'zone': zone}}


class PayloadTest(unittest.TestCase):
    def test_enter_and_heartbeat_carry_the_visit(self):
        enter = perception_payload(CANE, 'enter', 'stop', 'a1b2c3d4e5f6')
        self.assertEqual(enter, {'yolo_detections': CANE, 'target_match_confirmed': True,
                                 'zone': {'triggered': True, 'roi_id': 'stop', 'visit_id': 'a1b2c3d4e5f6', 'event': 'enter'}})
        present = perception_payload(CANE, 'heartbeat', 'stop', 'a1b2c3d4e5f6')
        self.assertEqual(present['zone']['event'], 'present')
        self.assertEqual(present['zone']['visit_id'], 'a1b2c3d4e5f6')

    def test_exit_carries_visit_left_and_boarding_intent(self):
        exit_ = perception_payload([], 'exit', 'stop', 'a1b2c3d4e5f6', ['CANE'], {'boarding': True, 'dwell_seconds': 12.7})
        self.assertEqual(exit_, {'yolo_detections': [], 'target_match_confirmed': False,
                                 'zone': {'triggered': False, 'roi_id': 'stop', 'visit_id': 'a1b2c3d4e5f6', 'event': 'exit',
                                          'left': ['CANE'], 'boarding': True, 'dwell_seconds': 12.7}})
        unknown = perception_payload([], 'exit', 'stop', 'a1b2c3d4e5f6', ['CANE'], {'boarding': None, 'dwell_seconds': 3.0})
        self.assertNotIn('boarding', unknown['zone'])  # unknown intent is left out, the hub treats it as boarding
        self.assertFalse(perception_payload([], 'exit', 'stop', 'v', ['CANE'], {'boarding': False, 'dwell_seconds': .4})['zone']['boarding'])

    def test_detections_are_capped(self):
        self.assertEqual(len(perception_payload(CANE * 30, 'enter', 'stop', 'v')['yolo_detections']), 20)

    def test_queue_coalesces_heartbeats_of_one_visit_only(self):
        class Silent:
            def post(self, *_):
                return {'accepted': True}
        queue = OrderedSignalQueue(Silent())
        for reason, visit in [('enter', 'v1'), ('heartbeat', 'v1'), ('heartbeat', 'v1'), ('exit', 'v1'), ('enter', 'v2'), ('heartbeat', 'v2')]:
            queue.enqueue('perception', perception_payload([] if reason == 'exit' else CANE, reason, 'stop', visit, ['CANE'] if reason == 'exit' else None))
        self.assertEqual(queue.diagnostics()['pending_signals'], 5)


class ReplayVisitTest(unittest.TestCase):
    def ids(self):
        counter = itertools.count(1)
        return lambda: f'new{next(counter):09d}'

    def test_each_recorded_visit_maps_to_one_new_id(self):
        recorded = [signal(1, 'enter', 'aaaaaaaaaaaa'), signal(2, 'present', 'aaaaaaaaaaaa'), signal(3, 'exit', 'aaaaaaaaaaaa'),
                    signal(4, 'enter', 'bbbbbbbbbbbb'), signal(5, 'exit', 'bbbbbbbbbbbb')]
        replayed = fresh_visits(recorded, self.ids())
        self.assertEqual([s['payload']['zone']['visit_id'] for s in replayed],
                         ['new000000001'] * 3 + ['new000000002'] * 2)
        self.assertEqual(recorded[0]['payload']['zone']['visit_id'], 'aaaaaaaaaaaa')  # the capture is not changed
        self.assertEqual([s['t'] for s in replayed], [1, 2, 3, 4, 5])

    def test_every_pass_gets_fresh_twelve_char_ids(self):
        recorded = [signal(1, 'enter', 'aaaaaaaaaaaa'), signal(2, 'exit', 'aaaaaaaaaaaa')]
        first, second = fresh_visits(recorded), fresh_visits(recorded)
        a, b = first[0]['payload']['zone']['visit_id'], second[0]['payload']['zone']['visit_id']
        self.assertEqual(len(a), 12)
        self.assertNotIn(a, (b, 'aaaaaaaaaaaa'))
        self.assertEqual(first[1]['payload']['zone']['visit_id'], a)

    def test_old_captures_get_one_id_per_enter_to_exit(self):
        recorded = [signal(1, 'present'), signal(2, 'exit'), signal(3, 'enter'), signal(4, 'present'), signal(5, 'exit'), signal(6, 'enter')]
        visits = [s['payload']['zone']['visit_id'] for s in fresh_visits(recorded, self.ids())]
        self.assertEqual(visits, ['new000000001', 'new000000001', 'new000000002', 'new000000002', 'new000000002', 'new000000003'])


if __name__ == '__main__':
    unittest.main()
