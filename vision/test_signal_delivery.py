import io
import json
import unittest
from copy import deepcopy
from urllib import error
from unittest.mock import patch

from ride_signal_client import OrderedSignalQueue, RideSignalClient


class MemoryClient:
    def __init__(self):
        self.sent = []
        self.failures = 0
        self.ack = {'accepted': True}
        self.during_send = None

    def post(self, path, envelope):
        self.sent.append((path, deepcopy(envelope)))
        if self.during_send:
            self.during_send()
        if self.failures:
            self.failures -= 1
            raise error.URLError('offline')
        return self.ack


def perception(event, visit='visit-1'):
    present = event != 'exit'
    return {'yolo_detections': [{'label': 'CANE', 'confidence': .95}] if present else [],
            'target_match_confirmed': present,
            'zone': {'triggered': present, 'roi_id': 'stop', 'event': event, 'visit_id': visit,
                     **({'left': ['CANE']} if not present else {})}}


class DeliveryTest(unittest.TestCase):
    def setUp(self):
        self.client = MemoryClient()
        self.queue = OrderedSignalQueue(self.client)

    def enqueue(self, event, event_id, second, visit='visit-1'):
        return self.queue.enqueue('perception', perception(event, visit), event_id=event_id,
                                  observed_at=f'2026-10-03T10:00:{second:02d}Z')

    def test_failed_exit_is_retried_unchanged_before_the_next_visit(self):
        self.enqueue('enter', 'enter-1', 1)
        self.assertTrue(self.queue.deliver_once())
        exit_envelope = self.enqueue('exit', 'exit-1', 2)
        self.enqueue('enter', 'enter-2', 3, 'visit-2')
        self.client.failures = 2
        self.assertFalse(self.queue.deliver_once())
        self.assertFalse(self.queue.deliver_once())
        self.assertEqual(self.queue.diagnostics()['pending_signals'], 2)
        self.assertTrue(self.queue.deliver_once())
        self.assertTrue(self.queue.deliver_once())
        self.assertEqual([envelope['event_id'] for _, envelope in self.client.sent],
                         ['enter-1', 'exit-1', 'exit-1', 'exit-1', 'enter-2'])
        self.assertTrue(all(envelope == exit_envelope for _, envelope in self.client.sent[1:4]))
        self.assertEqual(self.queue.diagnostics()['pending_signals'], 0)

    def test_only_adjacent_unsent_heartbeats_are_coalesced(self):
        self.enqueue('enter', 'enter-1', 1)
        self.enqueue('present', 'present-1', 2)
        self.enqueue('present', 'present-2', 3)
        self.enqueue('exit', 'exit-1', 4)
        self.enqueue('enter', 'enter-2', 5, 'visit-2')
        while self.queue.deliver_once():
            pass
        self.assertEqual([envelope['event_id'] for _, envelope in self.client.sent],
                         ['enter-1', 'present-2', 'exit-1', 'enter-2'])

    def test_failed_heartbeat_is_not_replaced_by_newer_data(self):
        first = self.enqueue('present', 'present-1', 1)
        self.client.failures = 1
        self.assertFalse(self.queue.deliver_once())
        self.enqueue('present', 'present-2', 2)
        self.enqueue('present', 'present-3', 3)
        self.assertEqual(self.queue.diagnostics()['pending_signals'], 2)
        self.assertTrue(self.queue.deliver_once())
        self.assertEqual(self.client.sent[0][1], first)
        self.assertEqual(self.client.sent[1][1], first)
        self.assertTrue(self.queue.deliver_once())
        self.assertEqual(self.client.sent[-1][1]['event_id'], 'present-3')

    def test_in_flight_heartbeat_is_not_replaced(self):
        self.enqueue('present', 'present-1', 1)
        self.client.during_send = lambda: self.enqueue('present', 'present-2', 2)
        self.assertTrue(self.queue.deliver_once())
        self.client.during_send = None
        self.assertEqual(self.queue.diagnostics()['pending_signals'], 1)
        self.assertTrue(self.queue.deliver_once())
        self.assertEqual([envelope['event_id'] for _, envelope in self.client.sent], ['present-1', 'present-2'])

    def test_heartbeats_for_different_visits_are_not_coalesced(self):
        self.enqueue('present', 'present-1', 1)
        self.enqueue('present', 'present-2', 2, 'visit-2')
        self.assertEqual(self.queue.diagnostics()['pending_signals'], 2)

    def test_payload_and_returned_envelope_cannot_mutate_pending_event(self):
        payload = perception('enter')
        envelope = self.queue.enqueue('perception', payload, event_id='enter-1')
        payload['zone']['event'] = 'exit'
        envelope['payload']['zone']['visit_id'] = 'changed'
        self.assertTrue(self.queue.deliver_once())
        self.assertEqual(self.client.sent[0][1]['payload'], perception('enter'))

    def test_an_unaccepted_ack_stays_pending_and_duplicate_ack_completes(self):
        self.enqueue('exit', 'exit-1', 1)
        self.client.ack = {'accepted': False}
        self.assertFalse(self.queue.deliver_once())
        self.assertEqual(self.queue.diagnostics()['pending_signals'], 1)
        self.client.ack = {'accepted': True, 'duplicate': True}
        self.assertTrue(self.queue.deliver_once())
        self.assertEqual(self.queue.diagnostics()['pending_signals'], 0)

    def test_diagnostics_and_stop_report_pending_without_exposing_failure_text(self):
        self.enqueue('exit', 'exit-1', 1)
        self.client.post = lambda *_: (_ for _ in ()).throw(error.HTTPError('http://hub', 401, 'secret-token', None, None))
        self.assertFalse(self.queue.deliver_once())
        self.assertEqual(self.queue.diagnostics()['signal_error'], {'event_id': 'exit-1', 'error': 'HTTPError', 'status': 401})
        self.assertEqual(self.queue.close(), 1)

    def reject(self, status, code):
        def post(path, envelope):
            self.client.sent.append((path, deepcopy(envelope)))
            raise error.HTTPError('http://hub', status, 'Bad Request', {}, io.BytesIO(json.dumps({'error': code}).encode()))
        return post

    def test_a_permanent_rejection_is_dropped_logged_and_does_not_block_later_signals(self):
        dropped = []
        self.queue = OrderedSignalQueue(self.client, on_drop=dropped.append)
        self.enqueue('enter', 'enter-1', 1)
        self.enqueue('exit', 'exit-1', 2)
        self.enqueue('enter', 'enter-2', 3, 'visit-2')
        accept, self.client.post = self.client.post, self.reject(400, 'INVALID_SIGNAL')
        self.assertFalse(self.queue.deliver_once())  # enter-1 refused for good: dropped, exit-1 is next
        self.assertEqual(dropped, [{'event_id': 'enter-1', 'error': 'HTTPError', 'status': 400, 'code': 'INVALID_SIGNAL',
                                    'dropped': True, 'reason': 'enter', 'visit_id': 'visit-1'}])
        diagnostics = self.queue.diagnostics()
        self.assertEqual((diagnostics['pending_signals'], diagnostics['dropped_signals']), (2, 1))
        self.assertEqual(diagnostics['signal_error']['code'], 'INVALID_SIGNAL')
        self.client.post = accept
        self.assertTrue(self.queue.deliver_once())
        self.assertEqual(self.client.sent[-1][1]['event_id'], 'exit-1')
        self.assertIsNone(self.queue.diagnostics()['signal_error'])
        self.assertEqual(self.queue.diagnostics()['dropped_signals'], 1)

    def test_each_4xx_code_drops_but_auth_rate_limit_and_server_errors_are_retried(self):
        for status, code, dropped in [(400, 'INVALID_OBSERVED_AT', True), (400, 'OUT_OF_ORDER_SIGNAL', True), (409, 'EVENT_ID_CONFLICT', True),
                                      (413, 'PAYLOAD_TOO_LARGE', True), (401, 'BRIDGE_TOKEN_REQUIRED', False), (403, 'ORIGIN_NOT_ALLOWED', False),
                                      (429, 'TOO_MANY', False), (500, 'X', False), (503, 'X', False)]:
            with self.subTest(status=status, code=code):
                queue = OrderedSignalQueue(self.client)
                self.client.post = self.reject(status, code)
                queue.enqueue('perception', perception('exit'), event_id='exit-1')
                self.assertFalse(queue.deliver_once())
                self.assertEqual(queue.diagnostics()['pending_signals'], 0 if dropped else 1)
                self.assertEqual(queue.diagnostics()['signal_error']['code'], code)
                self.assertEqual(queue.diagnostics()['signal_error'].get('dropped', False), dropped)
        self.client.post = MemoryClient.post.__get__(self.client)
        self.client.failures = 1  # hub not running: connection refused stays pending
        self.enqueue('exit', 'exit-2', 3)
        self.assertFalse(self.queue.deliver_once())
        self.assertEqual(self.queue.diagnostics()['pending_signals'], 1)

    def test_success_diagnostics_use_the_same_visit_and_clear_prior_error(self):
        self.enqueue('exit', 'exit-1', 1)
        self.client.failures = 1
        self.queue.deliver_once()
        self.assertTrue(self.queue.deliver_once())
        diagnostics = self.queue.diagnostics()
        self.assertIsNone(diagnostics['signal_error'])
        self.assertEqual(diagnostics['last_signal']['visit_id'], 'visit-1')
        self.assertEqual(diagnostics['last_signal']['reason'], 'exit')

    def test_client_timeout_retry_reuses_the_same_serialized_envelope(self):
        requests = []

        class Response:
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def read(self): return b'{"accepted":true}'

        def open_request(req, timeout):
            requests.append(req)
            if len(requests) == 1:
                raise TimeoutError('read timed out')
            return Response()

        with patch('ride_signal_client.request.urlopen', side_effect=open_request), patch('ride_signal_client.time.sleep'):
            result = RideSignalClient('http://hub', token='test-token').signal(
                'perception', perception('exit'), event_id='exit-1', observed_at='2026-10-03T10:00:01Z')
        self.assertTrue(result['accepted'])
        self.assertEqual(requests[0].data, requests[1].data)


if __name__ == '__main__':
    unittest.main()
