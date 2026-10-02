import unittest

import numpy as np

from aid_verifier import ConfirmedTracks, iou

BOX = [100, 100, 200, 300]
NEAR = [104, 102, 204, 302]
FAR = [600, 100, 700, 300]


class ConfirmedTracksTest(unittest.TestCase):
    def test_box_without_device_is_never_confirmed(self):
        tracks = ConfirmedTracks(hits=2, window=30)
        for _ in range(200):
            self.assertEqual(tracks.step([BOX], lambda b: False), [False])

    def test_confirms_after_enough_hits_and_stays_latched(self):
        tracks = ConfirmedTracks(hits=2, window=30)
        self.assertEqual(tracks.step([BOX], lambda b: True), [False])
        self.assertEqual(tracks.step([NEAR], lambda b: True), [True])
        calls = []
        self.assertEqual(tracks.step([BOX], lambda b: calls.append(b) or False), [True])
        self.assertEqual(calls, [])  # confirmed boxes are not re-checked

    def test_hits_outside_window_do_not_count(self):
        tracks = ConfirmedTracks(hits=2, window=5)
        answers = iter([True] + [False] * 5 + [True])
        for _ in range(7):
            confirmed = tracks.step([BOX], lambda b: next(answers))
        self.assertEqual(confirmed, [False])

    def test_latch_survives_short_gap_but_not_long_absence(self):
        tracks = ConfirmedTracks(hits=1, max_misses=3)
        self.assertEqual(tracks.step([BOX], lambda b: True), [True])
        for _ in range(3):
            tracks.step([], lambda b: False)
        self.assertEqual(tracks.step([BOX], lambda b: False), [True])
        for _ in range(4):
            tracks.step([], lambda b: False)
        self.assertEqual(tracks.step([BOX], lambda b: False), [False])

    def test_boxes_are_tracked_independently(self):
        tracks = ConfirmedTracks(hits=1)
        self.assertEqual(tracks.step([BOX, FAR], lambda b: b == BOX), [True, False])
        self.assertEqual(tracks.step([FAR, NEAR], lambda b: False), [False, True])

    def test_votes_and_peak_accumulate_over_the_track(self):
        tracks = ConfirmedTracks(hits=1)
        tracks.step([BOX], lambda b: True, [{'STROLLER': .9}], [.9])
        tracks.step([NEAR], lambda b: True, [{'WHEELCHAIR': .6}], [.6])
        tracks.step([BOX], lambda b: True, [{'WHEELCHAIR': .7, 'STROLLER': .2}], [.7])
        self.assertEqual(max(tracks.votes[0], key=tracks.votes[0].get), 'WHEELCHAIR')
        self.assertEqual(tracks.peaks, [.9])

    def test_confirmed_track_keeps_collecting_votes_on_refresh(self):
        tracks = ConfirmedTracks(hits=1, refresh=3)
        calls = []
        def check(box):
            calls.append(1)
            return ('WHEELED', .8, 'STROLLER', {'WHEELCHAIR': 1000.0} if len(calls) > 1 else {'STROLLER': .5})
        for _ in range(5):
            confirmed = tracks.step([BOX], check, [{'STROLLER': .9}], [.9])
        self.assertEqual(confirmed, [True])
        self.assertEqual(len(calls), 2)  # once to confirm, once on refresh
        self.assertEqual(max(tracks.votes[0], key=tracks.votes[0].get), 'WHEELCHAIR')

    def test_failing_box_is_checked_less_often(self):
        tracks = ConfirmedTracks(hits=2, interval=1)
        calls = []
        for _ in range(23):
            tracks.step([BOX], lambda b: calls.append(1) and None)
        self.assertEqual(len(calls), 9)  # frames 1-6 every frame, then every fifth

    def test_confirmation_is_withdrawn_when_rechecks_keep_failing(self):
        tracks = ConfirmedTracks(hits=1, refresh=2, revoke=2)
        answers = iter([('WHEELED', .8, 'STROLLER', {})] + [None] * 20)
        results = [tracks.step([BOX], lambda b: next(answers))[0] for _ in range(7)]
        self.assertEqual(results, [True, True, True, True, False, False, False])

    def test_higher_ranked_answer_wins_and_takes_over(self):
        tracks = ConfirmedTracks(hits=2, rank={'WHEELED': 1})
        answers = iter([('CANE', .3), ('WHEELED', .6), ('CANE', .3), ('WHEELED', .7)])
        results = [tracks.step([BOX], lambda b: next(answers))[0] for _ in range(4)]
        self.assertEqual(results, [False, False, False, True])  # two canes do not confirm while a wheeled answer is around
        self.assertEqual(tracks.evidence[0][0], 'WHEELED')
        tracks = ConfirmedTracks(hits=2, refresh=1, rank={'WHEELED': 1})
        answers = iter([('CANE', .3), ('CANE', .3), ('WHEELED', .6), ('WHEELED', .7)])
        for _ in range(4):
            tracks.step([BOX], lambda b: next(answers))
        self.assertEqual(tracks.evidence[0][0], 'WHEELED')  # confirmed as cane, then switched

    def test_interval_skips_checks_between_frames(self):
        tracks = ConfirmedTracks(hits=2, interval=3)
        calls = []
        results = [tracks.step([BOX], lambda b: calls.append(1) or True) for _ in range(4)]
        self.assertEqual(results, [[False], [False], [False], [True]])
        self.assertEqual(len(calls), 2)

    def test_evidence_is_kept_per_box(self):
        tracks = ConfirmedTracks(hits=1)
        tracks.step([BOX, FAR], lambda b: 'WHEELCHAIR' if b == BOX else None)
        self.assertEqual(tracks.evidence, ['WHEELCHAIR', None])

    def test_label_must_repeat_before_it_confirms(self):
        tracks = ConfirmedTracks(hits=2)
        answers = iter([('WHEELCHAIR', .5), ('CANE', .4), ('CANE', .6)])
        results = [tracks.step([BOX], lambda b: next(answers)) for _ in range(3)]
        self.assertEqual(results, [[False], [False], [True]])
        self.assertEqual(tracks.evidence, [('CANE', .6)])

    def test_iou(self):
        self.assertEqual(iou(BOX, FAR), 0.0)
        self.assertAlmostEqual(iou(BOX, BOX), 1.0)


class InRegionTest(unittest.TestCase):
    def setUp(self):
        from yolo_bridge import in_region
        self.in_region = in_region
        self.mask = np.zeros((100, 100), np.uint8)
        self.mask[60:80, 40:70] = 1

    def test_anchor_inside(self):
        self.assertTrue(self.in_region([45, 20, 60, 70], self.mask, 'bottom-center'))

    def test_box_running_past_the_region_edge_still_counts(self):
        # bottom-centre falls below the region, but the lower part of the box covers it
        self.assertTrue(self.in_region([40, 10, 70, 99], self.mask, 'bottom-center'))

    def test_large_box_on_a_small_region_counts(self):
        mask = np.zeros((720, 1280), np.uint8)
        mask[630:690, 510:1045] = 1  # thin strip near the bottom of the frame
        self.assertTrue(self.in_region([318, 195, 777, 720], mask, 'bottom-center'))  # wheelchair running out of frame
        self.assertFalse(self.in_region([318, 100, 777, 500], mask, 'bottom-center'))  # same box, well above the strip

    def test_box_elsewhere_does_not_count(self):
        self.assertFalse(self.in_region([0, 0, 20, 50], self.mask, 'bottom-center'))
        self.assertFalse(self.in_region([75, 10, 95, 99], self.mask, 'bottom-center'))


if __name__ == '__main__':
    unittest.main()
