import unittest

import numpy as np

from aid_verifier import Scene, iou

PERSON, WHEELCHAIR, STROLLER, CARRIAGE, CANE, STICK = 0, 1, 2, 3, 4, 12


def person(x, y=100, w=100, h=300, score=.9):
    return [x, y, x + w, y + h, score, PERSON]


def device(x, cls=WHEELCHAIR, y=250, w=120, h=150, score=.7):
    return [x, y, x + w, y + h, score, cls]


def run(scene, frames, **kwargs):
    aids = []
    for rows in frames:
        _, aids = scene.update(rows, **kwargs)
    return aids


class SceneTest(unittest.TestCase):
    def test_parked_device_is_ignored_even_with_people_around(self):
        aids = run(Scene(), [[device(300), person(240), person(400)]] * 40)
        self.assertEqual(aids, [])

    def test_wobbling_box_of_a_parked_device_is_not_movement(self):
        frames = [[device(300 + (12 if i % 2 else -12), w=120 - (20 if i % 3 == 0 else 0)), person(240)] for i in range(40)]
        self.assertEqual(run(Scene(), frames), [])

    def test_parked_device_counts_once_someone_takes_it_away(self):
        scene = Scene()
        self.assertEqual(run(scene, [[device(300)]] * 10 + [[device(300), person(240)]] * 10), [])
        pushed = [[device(300 + 10 * i), person(240 + 10 * i)] for i in range(1, 12)]
        self.assertEqual([a['label'] for a in run(scene, pushed)], ['WHEELCHAIR'])

    def test_device_moving_with_a_person_counts_once(self):
        frames = [[device(300 + 6 * i), person(240 + 6 * i), person(430 + 6 * i)] for i in range(20)]
        aids = run(Scene(), frames)
        self.assertEqual([a['label'] for a in aids], ['WHEELCHAIR'])  # two people beside it, still one aid

    def test_it_stays_while_the_person_holds_it_and_is_dropped_when_they_leave(self):
        scene = Scene(release=5)
        moving = [[device(300 + 6 * i), person(240 + 6 * i)] for i in range(20)]
        stopped = [[device(414), person(354)]] * 40
        self.assertEqual(len(run(scene, moving + stopped)), 1)
        left = [[device(414), person(900)]] * 6
        self.assertEqual(run(scene, left), [])

    def test_seated_adult_makes_it_a_wheelchair_without_moving(self):
        rows = [device(300, STROLLER), person(310, y=200, w=100, h=200)]
        aids = run(Scene(), [rows] * 6, seated=lambda box: True)
        self.assertEqual([a['label'] for a in aids], ['WHEELCHAIR'])
        self.assertEqual(run(Scene(), [rows] * 6, seated=lambda box: False), [])

    def test_label_is_the_devices_own_tally(self):
        pushed = lambda cls: [[device(300 + 6 * i, cls), person(240 + 6 * i)] for i in range(20)]
        self.assertEqual(run(Scene(), pushed(STROLLER))[0]['label'], 'STROLLER')
        self.assertEqual(run(Scene(), pushed(CARRIAGE))[0]['label'], 'WHEELCHAIR')
        votes = [([280, 100, 480, 400], {'WHEELCHAIR': .9})]
        self.assertEqual(run(Scene(), pushed(STROLLER), detector=votes)[0]['label'], 'WHEELCHAIR')

    def test_device_behind_a_person_is_not_theirs(self):
        frames = [[device(300 + 6 * i, y=100, h=150), person(260 + 6 * i, y=150, h=400)] for i in range(20)]
        self.assertEqual(run(Scene(), frames), [])  # its base is far above their feet

    def test_cane_is_seen_when_held_and_forgotten_when_put_down(self):
        scene = Scene(cane_window=4)
        held = [person(300), [380, 250, 400, 410, .4, CANE]]
        self.assertEqual(run(scene, [held] * 1), [])
        self.assertEqual([a['label'] for a in run(scene, [held] * 2)], ['CANE'])
        self.assertEqual(run(scene, [[person(300)]] * 4), [])

    def test_pole_in_the_background_is_not_a_cane(self):
        far = [person(300), [600, 100, 620, 400, .6, CANE]]
        high = [person(300), [380, 100, 400, 200, .6, CANE]]
        self.assertEqual(run(Scene(), [far] * 5), [])
        self.assertEqual(run(Scene(), [high] * 5), [])

    def test_stick_stand_in_can_be_switched_off(self):
        held = [person(300), [380, 250, 400, 410, .5, STICK]]
        self.assertEqual(len(run(Scene(), [held] * 3)), 1)
        self.assertEqual(run(Scene(sticks=False), [held] * 3), [])

    def test_iou(self):
        self.assertEqual(iou([0, 0, 10, 10], [20, 20, 30, 30]), 0.0)
        self.assertAlmostEqual(iou([0, 0, 10, 10], [0, 0, 10, 10]), 1.0)


class BoardingIntentTest(unittest.TestCase):
    """Region along the bottom of the picture; the bus is deeper in (up)."""
    REGION = [(0.35, 0.98), (0.82, 0.97), (0.75, 0.84), (0.37, 0.84)]

    def setUp(self):
        from yolo_bridge import boarding_intent
        self.intent = lambda trail, dwell=5.0: boarding_intent(trail, self.REGION, 'up', dwell)

    def test_waits_then_walks_deeper(self):
        trail = [(t, 0.6, 0.92) for t in range(5)] + [(5.5, 0.6, 0.80), (6.0, 0.6, 0.70)]
        self.assertEqual(self.intent(trail), (True, 'past_far_edge'))

    def test_still_moving_deeper_when_lost(self):
        trail = [(t, 0.6, 0.93) for t in range(5)] + [(5.0, 0.6, 0.92), (5.5, 0.6, 0.90), (6.0, 0.6, 0.88)]
        self.assertEqual(self.intent(trail), (True, 'moving_towards_bus'))

    def test_passing_through_is_not_boarding(self):
        self.assertEqual(self.intent([(0, 0.4, 0.9), (0.5, 0.7, 0.9)], dwell=0.6), (False, 'short_stay'))

    def test_walking_off_sideways_or_towards_the_camera_is_not_boarding(self):
        sideways = [(t, 0.6, 0.92) for t in range(5)] + [(5.5, 0.85, 0.93), (6.0, 0.95, 0.93)]
        self.assertEqual(self.intent(sideways), (False, 'left_another_way'))
        towards_camera = [(t, 0.6, 0.90) for t in range(5)] + [(5.5, 0.6, 0.96), (6.0, 0.6, 0.99)]
        self.assertEqual(self.intent(towards_camera), (False, 'left_another_way'))

    def test_aid_never_tracked_is_unknown(self):
        self.assertEqual(self.intent([]), (None, 'not_tracked'))

    def test_lost_while_still_in_the_region_counts_as_unknown(self):
        self.assertEqual(self.intent([(t, 0.6, 0.92) for t in range(6)]), (None, 'lost_in_region'))

    def test_moving_away_from_the_bus_is_not_boarding(self):
        trail = [(t, 0.6, 0.88) for t in range(5)] + [(5.5, 0.6, 0.92), (6.0, 0.6, 0.96)]
        self.assertEqual(self.intent(trail), (False, 'left_another_way'))


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
