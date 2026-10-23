"""Unit tests for the client's command parsing (no network). Run: python3 -m unittest client/test_bridge.py"""
import argparse
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bridge  # noqa: E402


def args(**kw):
    base = dict(json=None, submit=False, css_file=None, css=None, html_file=None, no_shot=False)
    base.update(kw)
    return argparse.Namespace(**base)


def build(*tokens, **kw):
    return bridge.build_command(list(tokens), args(**kw))


class WatchParsing(unittest.TestCase):
    def test_hold_still_with_duration(self):
        self.assertEqual(build("watch", "3s"), {"action": "watch", "ms": 3000})
        self.assertEqual(build("watch", "800ms"), {"action": "watch", "ms": 800})
        self.assertEqual(build("watch", "2.5"), {"action": "watch", "ms": 2500})

    def test_page_load(self):
        self.assertEqual(build("watch", "load", "4s"), {"action": "watch", "fresh": 1, "ms": 4000})
        self.assertEqual(build("watch", "fresh=1", "reduced=1"), {"action": "watch", "fresh": 1, "reduced": 1})

    def test_action_trigger(self):
        c = build("watch", "hover", "7", "2s")
        self.assertEqual(c["after"], {"action": "hover", "ref": 7})
        self.assertEqual(c["ms"], 2000)
        self.assertEqual(build("watch", "press", "Escape")["after"], {"action": "press", "key": "Escape"})
        self.assertEqual(build("watch", "scroll", "600")["after"], {"action": "scroll", "dy": 600})

    def test_text_target_with_spaces_stays_one_action(self):
        c = build("watch", "tap", "Open menu", "slowmo=0.25")
        self.assertEqual(c["action"], "watch")
        self.assertEqual(c["after"], {"action": "tap", "text": "Open menu"})
        self.assertEqual(c["slowmo"], "0.25")

    def test_options(self):
        c = build("watch", "load", "network=4g", "cpu=4", "max=16")
        self.assertEqual((c["network"], c["cpu"], c["max"], c["fresh"]), ("4g", 4, 16, 1))

    def test_unknown_trigger(self):
        with self.assertRaises(bridge.BridgeError):
            build("watch", "zoom", "3")


class Batching(unittest.TestCase):
    def test_quoted_groups(self):
        c = build("tap 4", "swipe left", "zoom 7")
        self.assertEqual(c["action"], "batch")
        self.assertEqual([a["action"] for a in c["actions"]], ["tap", "swipe", "zoom"])

    def test_semicolons(self):
        c = build("tap", "4", ";", "swipe", "left")
        self.assertEqual([a["action"] for a in c["actions"]], ["tap", "swipe"])

    def test_quoted_text_target_is_not_a_batch(self):
        self.assertEqual(build("tap", "Donate now"), {"action": "tap", "text": "Donate now"})

    def test_batch_of_watches(self):
        c = build("watch load 3s", "watch load 3s reduced=1")
        self.assertEqual([a.get("reduced") for a in c["actions"]], [None, 1])

    def test_single_word_first_group(self):
        c = build("observe", "tap 3")
        self.assertEqual([a["action"] for a in c["actions"]], ["observe", "tap"])


class Describe(unittest.TestCase):
    def test_keyframes_listed_when_more_than_two(self):
        line = bridge.describe_animation({"type": "CSSAnimation", "name": "pulse", "target": "div.dot", "duration": 1200, "easing": "ease-in-out",
                                          "iterations": "infinite", "changes": [{"property": "transform", "from": "scale(1)", "to": "scale(1)",
                                                                                 "values": ["scale(1)", "scale(1.4)", "scale(1)"]}]})
        self.assertEqual(line, "animation pulse on div.dot: 1200ms ease-in-out, loops | transform scale(1) -> scale(1.4) -> scale(1)")

    def test_animation_line(self):
        line = bridge.describe_animation({
            "type": "CSSAnimation", "name": "rise", "target": "h1#title", "text": "Motion fixture", "duration": 600, "delay": 200,
            "easing": "ease-out", "iterations": 1, "direction": "normal", "startedAt": 21, "timeline": "DocumentTimeline",
            "changes": [{"property": "opacity", "from": "0", "to": "1"}],
        })
        self.assertEqual(line, 'animation rise on h1#title "Motion fixture": 600ms ease-out, delay 200ms, starts +0.02s | opacity 0 -> 1')


def ios_args(**kw):
    base = dict(url=None, device=None, steps=None, keyboard=None, probe=False, idb=False)
    base.update(kw)
    return argparse.Namespace(**base)


class IOSJob(unittest.TestCase):
    def test_no_url_runs_probe(self):
        self.assertEqual(bridge.build_ios_job(ios_args()), {"probe": True})

    def test_keyboard_shortcut(self):
        job = bridge.build_ios_job(ios_args(url="https://example.org", keyboard="#email"))
        self.assertEqual(job["url"], "https://example.org")
        self.assertNotIn("probe", job)
        self.assertEqual(job["steps"][-1], {"action": "keyboard", "selector": "#email", "name": "keyboard"})

    def test_steps_validated(self):
        ok = bridge.build_ios_job(ios_args(url="https://x.org", steps='[{"action":"swipe","direction":"up"}]'))
        self.assertEqual(ok["steps"], [{"action": "swipe", "direction": "up"}])
        with self.assertRaises(bridge.BridgeError):
            bridge.build_ios_job(ios_args(url="https://x.org", steps='[{"action":"hover"}]'))


if __name__ == "__main__":
    unittest.main()
