import tempfile
import unittest
from pathlib import Path
import cv2
from monitor_zone import Editor, Trigger, anchor_point, is_inside, load_roi, save_roi, valid_polygon


class RegionTests(unittest.TestCase):
    def test_geometry_and_boundary(self):
        roi = [(0.2,0.2),(0.8,0.2),(0.8,0.8),(0.2,0.8)]
        self.assertTrue(is_inside([40,10,60,50],roi,101,101))
        self.assertFalse(is_inside([0,0,10,10],roi,101,101))
        self.assertTrue(is_inside([10,10,30,20],roi,101,101))
        self.assertFalse(is_inside([40,30,60,90],roi,101,101,'bottom-center'))
        self.assertTrue(is_inside([40,30,60,90],roi,101,101,'center'))

    def test_concave_region(self):
        roi = [(0,0),(1,0),(1,.3),(.3,.3),(.3,1),(0,1)]
        self.assertTrue(valid_polygon(roi))
        self.assertFalse(is_inside([60,60,80,80],roi,101,101))
        self.assertTrue(is_inside([0,60,20,80],roi,101,101))

    def test_invalid_shapes(self):
        for roi in ([],[1,2,3],[[0,0],[1,1]],[[0,0],[.5,.5],[1,1]],
                    [[0,0],[1,1],[0,1],[1,0]],[[0,0],[1,0],[1,1],[.5,0],[0,1]],
                    [[0,0],[1,0],[1,1],[float('nan'),1]]):
            self.assertFalse(valid_polygon(roi))

    def test_debounce_and_reentry(self):
        trigger = Trigger(2,3)
        self.assertEqual(trigger.update(True),(False,False))
        self.assertEqual(trigger.update(False),(False,False))
        trigger.update(True)
        self.assertEqual(trigger.update(True),(True,True))
        self.assertEqual(trigger.update(True),(True,False))
        trigger.update(False)
        self.assertEqual(trigger.update(False),(True,False))
        self.assertEqual(trigger.update(False),(False,False))
        trigger.update(True)
        self.assertEqual(trigger.update(True),(True,True))

    def test_edit_and_save_normalized(self):
        editor = Editor([])
        editor.width,editor.height = 101,101
        for x,y in ((10,10),(90,10),(90,90),(50,50)):
            editor.mouse(cv2.EVENT_LBUTTONDOWN,x,y,0,None)
        editor.mouse(cv2.EVENT_RBUTTONDOWN,0,0,0,None)
        self.assertTrue(valid_polygon(editor.draft))
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/'roi.json'
            save_roi(path,editor.draft,0,'bottom-center')
            self.assertEqual(load_roi(path),editor.draft)
            self.assertTrue(is_inside([90,0,110,80],load_roi(path),201,201))


if __name__ == '__main__':
    unittest.main()
