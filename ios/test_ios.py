"""Offline tests for the iOS engine's image and report code (no simulator needed).
Run: python3 -m unittest ios/test_ios.py   (needs Pillow)"""
import json
import os
import sys
import tempfile
import unittest

from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import simulator as ios  # noqa: E402


def keyboard_frames(folder, n=30, start=10, end=18):
    """Frames of a fake phone screen where a grey 'keyboard' slides up between frames start..end."""
    out = []
    for i in range(n):
        im = Image.new("RGB", (390, 844), "white")
        d = ImageDraw.Draw(im)
        d.rectangle((0, 0, 390, 50), fill="#1d3557")
        progress = 0 if i < start else 1 if i >= end else (i - start) / (end - start)
        top = int(844 - 336 * progress)
        d.rectangle((0, top, 390, 844), fill="#d1d3d9")
        p = os.path.join(folder, f"f-{i:04d}.jpg")
        im.save(p)
        out.append((i * 1000 / 30, p))
    return out


class Filmstrip(unittest.TestCase):
    def test_finds_keyboard_motion_window(self):
        with tempfile.TemporaryDirectory() as d:
            ios.OUT = d
            frames = keyboard_frames(d)
            t_action = frames[8][0]
            facts = ios.filmstrip(frames, t_action, os.path.join(d, "filmstrip.jpg"))
            self.assertEqual(facts["frames"], 30)
            self.assertEqual(facts["fps"], 30)
            # motion spans frames 11..18 (first changed frame .. last changed frame), relative to frame 8
            self.assertAlmostEqual(facts["motionStartMs"], (11 - 8) * 1000 / 30, delta=1)
            self.assertAlmostEqual(facts["motionEndMs"], (18 - 8) * 1000 / 30, delta=1)
            self.assertLessEqual(len(facts["picked"]), 12)
            self.assertTrue(os.path.exists(os.path.join(d, "filmstrip.jpg")))

    def test_still_video(self):
        with tempfile.TemporaryDirectory() as d:
            ios.OUT = d
            frames = keyboard_frames(d, n=6, start=99, end=100)
            facts = ios.filmstrip(frames, 0, os.path.join(d, "filmstrip.jpg"))
            self.assertNotIn("motionStartMs", facts)
            self.assertEqual(facts["picked"], [0, round(frames[-1][0])])


class ElementRefs(unittest.TestCase):
    def test_w3c_and_legacy_keys(self):
        self.assertEqual(ios.element_id({ios.ELEM: "a"}), "a")
        self.assertEqual(ios.element_id({"ELEMENT": "b"}), "b")
        self.assertEqual(ios.element_id({"some-other-key": "c"}), "c")
        with self.assertRaises(ios.WebDriverError):
            ios.element_id(None)


class ElementPassBack(unittest.TestCase):
    def test_reference_reused_as_returned(self):
        wd = ios.WD()
        raw = {"some-safari-key": "node-7"}
        wd.js = lambda *a, **k: raw
        eid = wd.find(selector="#x")
        self.assertEqual(eid, "node-7")
        self.assertIs(wd.ref(eid), raw)
        self.assertEqual(wd.ref("unknown"), {ios.ELEM: "unknown"})


class DevicePick(unittest.TestCase):
    def setUp(self):
        self.devices = {"devices": {
            "com.apple.CoreSimulator.SimRuntime.iOS-18-6": [{"name": "iPhone 16", "udid": "A", "state": "Shutdown"}],
            "com.apple.CoreSimulator.SimRuntime.iOS-26-2": [{"name": "iPhone Air", "udid": "B", "state": "Shutdown"}],
        }}
        self.real_sh = ios.sh

    def tearDown(self):
        ios.sh = self.real_sh

    def fake(self, xcode):
        ios.sh = lambda cmd, **k: json.dumps(self.devices) if "simctl" in cmd else f"Xcode {xcode}\nBuild version X"

    def test_matching_runtime_first(self):
        self.assertEqual(ios.matching_ios(16), 18)
        self.assertEqual(ios.matching_ios(26), 26)
        self.fake("16.4")
        self.assertEqual([d["ios"] for d in ios.pick_devices(None)], ["18.6", "26.2"])
        self.fake("26.3")
        self.assertEqual([d["ios"] for d in ios.pick_devices(None)], ["26.2", "18.6"])

    def test_explicit_ios(self):
        self.fake("16.4")
        self.assertEqual(ios.pick_devices(None, "26")[0]["udid"], "B")
        with self.assertRaises(RuntimeError):
            ios.pick_devices(None, "17")


class Report(unittest.TestCase):
    def test_summary_and_manifest(self):
        with tempfile.TemporaryDirectory() as d:
            ios.OUT = d
            br = ios.IOSBridge({})
            br.dev = {"udid": "X", "name": "iPhone 16", "ios": "18.5", "state": "Booted"}
            br.caps = {"browserVersion": "18.5"}
            state = {"screen": {"width": 393, "height": 852}, "dpr": 3, "innerWidth": 393, "innerHeight": 659,
                     "visualViewport": {"width": 393, "height": 659}, "safeArea": {"top": 59, "bottom": 34, "left": 0, "right": 0}}
            br.steps = [
                {"action": "screenshot", "name": "loaded", "state": state, "shot": "shots/01-loaded.jpg", "keyboardOpen": False},
                {"action": "keyboard", "name": "keyboard-number", "selector": "#price", "keyboardOpen": True,
                 "strategy": "webdriver-tap", "keyboardHeightCss": 291, "shot": "shots/02-k.jpg",
                 "attempts": [{"strategy": "webdriver-tap", "keyboardOpen": True, "focused": {"id": "price"},
                               "visualViewportBefore": 659, "visualViewportAfter": 368, "shot": "shots/02-k.jpg",
                               "motion": {"motionStartMs": 40, "motionEndMs": 420, "filmstrip": "keyboard-02-1/filmstrip.jpg"},
                               "fixedElements": [{"tag": "div", "id": "bar", "text": "Total", "visibleInVisualViewport": False,
                                                  "coveredBelowVisualViewport": 48}]}]},
                {"action": "swipe", "name": "swipe-up", "method": "webdriver-touch", "innerHeightBefore": 659,
                 "innerHeightAfter": 739, "addressBarCollapsed": True, "scrolled": 300, "shot": "shots/03.jpg"},
            ]
            m = ios.write_report(br, {"label": "t1"}, "ok")
            summary = open(os.path.join(d, "summary.md")).read()
            self.assertIn("iPhone 16", summary)
            self.assertIn("keyboard **appeared** via webdriver-tap, 291 CSS px", summary)
            self.assertIn("hidden 48 CSS px behind the keyboard", summary)
            self.assertIn("address bar collapsed", summary)
            self.assertEqual(m["keyboard"][0]["heightCss"], 291)
            self.assertEqual(json.load(open(os.path.join(d, "steps.json")))[2]["innerHeightAfter"], 739)


if __name__ == "__main__":
    unittest.main()
