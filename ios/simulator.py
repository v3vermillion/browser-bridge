#!/usr/bin/env python3
"""browser-bridge iOS engine: real iPhone Safari in the iOS Simulator on a GitHub macOS runner.

Unlike the Playwright "iphone" (desktop WebKit sized like a phone), this is Mobile Safari itself, so the
on-screen keyboard, the collapsing address bar, the notch / Dynamic Island, and native pickers are real,
and screenshots show the whole device screen the way a person sees it.

Driven by Apple's safaridriver (W3C WebDriver, plain HTTP from the standard library). Screenshots and video
come from `xcrun simctl io`. Pillow and an ffmpeg binary are used for images and video frames.

Env: JOB_JSON (see docs/ios.md), OUT_DIR (default ./out), FIXTURE_DIR (pages served on localhost:8765).
Writes OUT_DIR/manifest.json, summary.md, steps.json, page-log.json, shots/, keyboard-*/ folders.
"""
import base64
import datetime as dt
import functools
import http.server
import json
import os
import re
import shutil
import signal
import socketserver
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

from PIL import Image, ImageChops, ImageDraw, ImageStat

OUT = os.path.abspath(os.environ.get("OUT_DIR", "out"))
HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.environ.get("FIXTURE_DIR", os.path.join(HERE, "test-pages"))
FIXTURE_PORT = 8765
WD_PORT = 4444
ELEM = "element-6066-11e4-a52f-4f735466cecf"
T0 = time.time()


def log(*a):
    print(f"[{time.time() - T0:6.1f}s]", *a, flush=True)


def sh(cmd, check=True, timeout=300, **kw):
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, **kw)
    if check and r.returncode != 0:
        raise RuntimeError(f"{' '.join(cmd)} failed ({r.returncode}): {(r.stderr or r.stdout).strip()[:400]}")
    return r.stdout


def ffmpeg_exe():
    if shutil.which("ffmpeg"):
        return "ffmpeg"
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


# --------------------------------------------------------------------------- simulator
def pick_devices(want):
    """Available iPhones, best first: newest iOS runtime first, one device per runtime (fallbacks if the newest
    runtime won't connect). `want` matches the device name (e.g. "iPhone 16 Pro")."""
    data = json.loads(sh(["xcrun", "simctl", "list", "-j", "devices", "available"]))
    cands = []
    for runtime, devs in data["devices"].items():
        m = re.search(r"iOS-(\d+)-(\d+)", runtime)
        if not m:
            continue
        ver = (int(m.group(1)), int(m.group(2)))
        for d in devs:
            if d["name"].startswith("iPhone"):
                cands.append((ver, d, runtime))
    if not cands:
        raise RuntimeError("No iPhone simulators are installed on this runner.")
    if want:
        exact = [c for c in cands if c[1]["name"].lower() == want.lower()]
        loose = [c for c in cands if want.lower() in c[1]["name"].lower()]
        cands = exact or loose or cands
    # Prefer a plain current model (not SE/mini) for a typical modern screen, newest runtime first.
    cands.sort(key=lambda c: (c[0], "SE" not in c[1]["name"], "Pro" not in c[1]["name"]), reverse=True)
    out, seen = [], set()
    for ver, d, runtime in cands:
        if runtime in seen:
            continue
        seen.add(runtime)
        out.append({"udid": d["udid"], "name": d["name"], "ios": f"{ver[0]}.{ver[1]}", "state": d["state"]})
    return out


def prepare_keyboard_prefs(udid):
    """Ask for the software keyboard (not a 'connected hardware keyboard'), and skip first-use keyboard tips.
    These preferences are known to be unreliable on newer Xcode; the keyboard step verifies what happened."""
    for cmd in (
        ["defaults", "write", "com.apple.iphonesimulator", "ConnectHardwareKeyboard", "-bool", "false"],
        ["defaults", "write", "com.apple.iphonesimulator", "DevicePreferences", "-dict-add", udid,
         "{ ConnectHardwareKeyboard = 0; }"],
    ):
        sh(cmd, check=False)


def boot(dev):
    udid = dev["udid"]
    prepare_keyboard_prefs(udid)
    if dev["state"] != "Booted":
        sh(["xcrun", "simctl", "boot", udid], check=False)
    sh(["xcrun", "simctl", "bootstatus", udid, "-b"], timeout=600)
    for key in ("DidShowContinuousPathIntroduction", "KeyboardDidShowProductivityTutorial", "DidShowGestureKeyboardIntroduction"):
        sh(["xcrun", "simctl", "spawn", udid, "defaults", "write", "com.apple.keyboard.preferences", key, "-bool", "true"], check=False)
    # Same clean status bar on every run (9:41, full battery), so screenshots compare.
    sh(["xcrun", "simctl", "status_bar", udid, "override", "--time", "9:41", "--batteryState", "charged",
        "--batteryLevel", "100", "--wifiBars", "3", "--cellularBars", "4"], check=False)


def device_shot(udid, path):
    """The whole device screen: status bar, Safari's own UI, keyboard, pickers. PNG -> JPEG."""
    tmp = path + ".png"
    sh(["xcrun", "simctl", "io", udid, "screenshot", "--type=png", tmp], timeout=60)
    im = Image.open(tmp).convert("RGB")
    im.save(path, quality=85)
    os.remove(tmp)
    return im


class Recorder:
    """Screen video of the simulator (`simctl io recordVideo`), for motion such as the keyboard sliding up."""

    def __init__(self, udid, path):
        self.path = path
        self.proc = subprocess.Popen(["xcrun", "simctl", "io", udid, "recordVideo", "--codec=h264", "--force", path],
                                     stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        self.started = None
        deadline = time.time() + 20
        buf = ""
        while time.time() < deadline and self.proc.poll() is None:
            line = self.proc.stdout.readline()
            buf += line
            if "Recording started" in line:
                self.started = time.time()
                break
        if self.started is None:
            self.started = time.time()
            log("recordVideo did not report a start:", buf.strip()[:200])
        threading.Thread(target=self._drain, daemon=True).start()

    def _drain(self):
        for _ in self.proc.stdout:
            pass

    def stop(self):
        if self.proc.poll() is None:
            self.proc.send_signal(signal.SIGINT)
            try:
                self.proc.wait(timeout=20)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        return os.path.exists(self.path) and os.path.getsize(self.path) > 0


def extract_frames(video, folder, fps=30, width=390):
    exe = ffmpeg_exe()
    if not exe:
        return []
    os.makedirs(folder, exist_ok=True)
    subprocess.run([exe, "-loglevel", "error", "-i", video, "-vf", f"fps={fps},scale={width}:-2",
                    "-q:v", "3", os.path.join(folder, "f-%04d.jpg")], timeout=120)
    files = sorted(f for f in os.listdir(folder) if f.startswith("f-"))
    return [(i * 1000.0 / fps, os.path.join(folder, f)) for i, f in enumerate(files)]


def filmstrip(frames, t_action, out_path, max_cells=12):
    """Keep the frames where the picture changed, captioned with ms since the action. Returns motion facts."""
    if not frames:
        return None
    ims, diffs = [], [0.0]
    for _, p in frames:
        ims.append(Image.open(p).convert("L").resize((97, 210)))
    for a, b in zip(ims, ims[1:]):
        diffs.append(ImageStat.Stat(ImageChops.difference(a, b)).mean[0])
    moving = [i for i, d in enumerate(diffs) if d > 0.6]
    facts = {"frames": len(frames), "fps": round(1000 / (frames[1][0] - frames[0][0])) if len(frames) > 1 else None}
    if moving:
        facts["motionStartMs"] = round(frames[moving[0]][0] - t_action)
        facts["motionEndMs"] = round(frames[moving[-1]][0] - t_action)
        facts["motionMs"] = facts["motionEndMs"] - facts["motionStartMs"]
    pick = {0, len(frames) - 1}
    if moving:
        pick |= {max(0, moving[0] - 1), moving[-1]}
        step = max(1, len(moving) // max(1, max_cells - len(pick)))
        pick |= set(moving[::step])
    pick = sorted(pick)
    if len(pick) > max_cells:
        keep = [pick[0], pick[-1]]
        inner = pick[1:-1]
        step = len(inner) / (max_cells - 2)
        pick = sorted(set(keep + [inner[int(i * step)] for i in range(max_cells - 2)]))
    cells = [Image.open(frames[i][1]).convert("RGB") for i in pick]
    cw, ch = cells[0].size
    cols = min(6, len(cells))
    rows = (len(cells) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * cw, rows * (ch + 24)), "white")
    draw = ImageDraw.Draw(sheet)
    for n, (i, im) in enumerate(zip(pick, cells)):
        x, y = (n % cols) * cw, (n // cols) * (ch + 24)
        sheet.paste(im, (x, y + 24))
        draw.text((x + 6, y + 6), f"t={frames[i][0] - t_action:+.0f} ms", fill="black")
    sheet.save(out_path, quality=85)
    facts["filmstrip"] = os.path.relpath(out_path, OUT)
    facts["picked"] = [round(frames[i][0] - t_action) for i in pick]
    return facts


# --------------------------------------------------------------------------- webdriver
class WebDriverError(Exception):
    pass


def element_id(ref):
    """WebDriver element reference -> id. W3C uses a fixed key; Safari on iOS has been seen returning another."""
    if isinstance(ref, dict):
        for k in (ELEM, "ELEMENT"):
            if k in ref:
                return ref[k]
        if len(ref) == 1:
            return next(iter(ref.values()))
    raise WebDriverError(f"unexpected element reference from safaridriver: {str(ref)[:120]}")


class WD:
    def __init__(self, port=WD_PORT):
        self.base = f"http://127.0.0.1:{port}"
        self.sid = None

    def call(self, method, path, body=None, timeout=120):
        url = self.base + (f"/session/{self.sid}" if self.sid and not path.startswith("/session") else "") + path
        data = json.dumps(body if body is not None else {}).encode() if method == "POST" else None
        req = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read() or b"{}").get("value")
        except urllib.error.HTTPError as e:
            try:
                v = json.loads(e.read()).get("value", {})
                msg = f"{v.get('error')}: {v.get('message')}"
            except Exception:
                msg = str(e)
            raise WebDriverError(msg)

    def start(self, udid):
        caps = {"capabilities": {"alwaysMatch": {"browserName": "safari", "platformName": "iOS",
                                                 "safari:useSimulator": True, "safari:deviceUDID": udid}}}
        v = self.call("POST", "/session", caps, timeout=420)
        self.sid = v["sessionId"]
        return v.get("capabilities", {})

    def js(self, script, *args, timeout=60):
        return self.call("POST", "/execute/sync", {"script": script, "args": list(args)}, timeout=timeout)

    def goto(self, url):
        self.call("POST", "/url", {"url": url}, timeout=120)

    def find(self, selector=None, text=None):
        el = self.js("""
          const [sel, text] = arguments;
          if (sel) return document.querySelector(sel);
          const want = text.trim().toLowerCase();
          const all = [...document.querySelectorAll('a,button,input,select,textarea,label,[role=button],summary,[onclick]')];
          return all.find(e => (e.innerText || e.value || e.getAttribute('aria-label') || e.placeholder || '').trim().toLowerCase() === want)
              || all.find(e => (e.innerText || e.value || e.getAttribute('aria-label') || e.placeholder || '').toLowerCase().includes(want))
              || null;""", selector, text)
        if not el:
            raise WebDriverError(f"no element matches {selector or repr(text)}")
        return element_id(el)

    def click(self, eid):
        self.call("POST", f"/element/{eid}/click")

    def send_keys(self, eid, text):
        self.call("POST", f"/element/{eid}/value", {"text": text})

    def touch_swipe(self, x, y1, y2, ms=300):
        self.call("POST", "/actions", {"actions": [{"type": "pointer", "id": "finger", "parameters": {"pointerType": "touch"},
            "actions": [{"type": "pointerMove", "duration": 0, "x": int(x), "y": int(y1)}, {"type": "pointerDown", "button": 0},
                        {"type": "pointerMove", "duration": ms, "x": int(x), "y": int(y2)}, {"type": "pointerUp", "button": 0}]}]},
                  timeout=30)
        try:
            self.call("DELETE", "/actions", timeout=15)
        except Exception:
            pass

    def quit(self):
        if self.sid:
            try:
                self.call("DELETE", "", timeout=30)
            except Exception:
                pass


# Page state: everything that changes when the keyboard or Safari's bars move.
STATE_JS = """
  const vv = window.visualViewport, a = document.activeElement;
  const safe = {};
  for (const side of ['top', 'bottom', 'left', 'right']) {
    const p = document.createElement('div');
    p.style.cssText = 'position:absolute;visibility:hidden;width:env(safe-area-inset-' + side + ', 0px);height:1px';
    document.body.appendChild(p);
    safe[side] = Math.round(p.getBoundingClientRect().width);
    p.remove();
  }
  const fixed = [];
  for (const el of document.querySelectorAll('body *')) {
    const s = getComputedStyle(el);
    if ((s.position === 'fixed' || s.position === 'sticky') && el.offsetWidth > 40 && el.offsetHeight > 10) {
      const r = el.getBoundingClientRect();
      const vvTop = vv ? vv.offsetTop : 0, vvBottom = vv ? vv.offsetTop + vv.height : innerHeight;
      fixed.push({tag: el.tagName.toLowerCase(), id: el.id || null, text: (el.innerText || '').trim().slice(0, 40), position: s.position,
                  top: Math.round(r.top), bottom: Math.round(r.bottom),
                  visibleInVisualViewport: r.bottom > vvTop && r.top < vvBottom,
                  coveredBelowVisualViewport: Math.max(0, Math.round(r.bottom - vvBottom))});
      if (fixed.length >= 8) break;
    }
  }
  return {url: location.href, title: document.title, innerWidth, innerHeight, outerHeight,
          screen: {width: screen.width, height: screen.height}, dpr: devicePixelRatio,
          visualViewport: vv ? {width: Math.round(vv.width), height: Math.round(vv.height), offsetTop: Math.round(vv.offsetTop), scale: vv.scale} : null,
          scrollY: Math.round(scrollY), docHeight: document.documentElement.scrollHeight,
          focused: a && a !== document.body ? {tag: a.tagName.toLowerCase(), id: a.id || null, type: a.type || null, inputmode: a.inputMode || null} : null,
          safeArea: safe, fixedElements: fixed, userAgent: navigator.userAgent};
"""

# Installed on every page: a log of viewport changes with timestamps, and best-effort write blocking
# (Safari has no request interception, so form submits and non-GET fetch/XHR are stopped in the page).
INSTRUMENT_JS = """
  if (window.__bbInstrumented) return 'already';
  window.__bbInstrumented = true;
  window.__bbLog = window.__bbLog || [];
  const snap = (why) => { const vv = window.visualViewport;
    window.__bbLog.push({t: Math.round(performance.now()), why, innerHeight, vvHeight: vv ? Math.round(vv.height) : null,
      vvOffsetTop: vv ? Math.round(vv.offsetTop) : null, scrollY: Math.round(scrollY)}); };
  if (!window.__bbLog.length) snap('instrumented');
  if (window.visualViewport) { visualViewport.addEventListener('resize', () => snap('vv-resize')); }
  addEventListener('resize', () => snap('resize'));
  window.__bbBlocked = [];
  document.addEventListener('submit', (e) => { e.preventDefault(); window.__bbBlocked.push({kind: 'form submit', action: e.target.action}); }, true);
  const of = window.fetch;
  if (of) window.fetch = function (input, init) { const m = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    if (m !== 'GET' && m !== 'HEAD') { window.__bbBlocked.push({kind: 'fetch ' + m, url: String(input && input.url || input)}); return Promise.reject(new TypeError('blocked by browser-bridge')); }
    return of.apply(this, arguments); };
  const oo = XMLHttpRequest.prototype.open, os = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__bbM = String(m).toUpperCase(); this.__bbU = u; return oo.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function () { if (this.__bbM !== 'GET' && this.__bbM !== 'HEAD') { window.__bbBlocked.push({kind: 'xhr ' + this.__bbM, url: String(this.__bbU)}); return; } return os.apply(this, arguments); };
  navigator.sendBeacon && (navigator.sendBeacon = (u) => { window.__bbBlocked.push({kind: 'beacon', url: String(u)}); return true; });
  return 'ok';
"""


# --------------------------------------------------------------------------- bridge
class IOSBridge:
    def __init__(self, job):
        self.job = job
        self.dev = None
        self.wd = WD()
        self.n = 0
        self.steps = []
        self.notes = []
        self.baseline_vv = None
        self.viewport_top_px = None
        self.simulator_app = False
        self.idb = shutil.which("idb") is not None

    # ---- setup
    def start(self):
        host = {"macOS": sh(["sw_vers", "-productVersion"], check=False).strip(),
                "safaridriver": sh(["safaridriver", "--version"], check=False).strip()}
        log("host:", host)
        self.host = host
        self.driver = subprocess.Popen(["safaridriver", "-p", str(WD_PORT)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(50):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{WD_PORT}/status", timeout=2)
                break
            except Exception:
                time.sleep(0.2)
        devices = pick_devices(self.job.get("device"))[:3]
        log("candidates:", [f"{d['name']} iOS {d['ios']}" for d in devices])
        last = None
        for dev in devices:
            self.dev = dev
            log("device:", dev)
            boot(dev)
            log("booted")
            for attempt in (1, 2):
                # Open Safari first so safaridriver finds a running, inspectable Safari instead of cold-launching it.
                sh(["xcrun", "simctl", "launch", dev["udid"], "com.apple.mobilesafari"], check=False, timeout=120)
                time.sleep(8 if attempt == 1 else 15)
                try:
                    caps = self.wd.start(dev["udid"])
                    break
                except WebDriverError as e:
                    last = e
                    self.notes.append(f"safaridriver could not connect to Safari on {dev['name']} iOS {dev['ios']} "
                                      f"(attempt {attempt}): {str(e)[:200]}")
                    log("session attempt failed:", str(e)[:200])
                    sh(["xcrun", "simctl", "terminate", dev["udid"], "com.apple.mobilesafari"], check=False)
            else:
                sh(["xcrun", "simctl", "shutdown", dev["udid"]], check=False, timeout=120)
                continue
            break
        else:
            raise last or WebDriverError("no simulator could be driven")
        log("safaridriver session:", {k: v for k, v in caps.items() if k in ("browserVersion", "platformName", "safari:platformVersion")})
        self.caps = caps
        if self.idb:
            r = subprocess.run(["idb", "connect", self.dev["udid"]], capture_output=True, text=True, timeout=60)
            self.idb = r.returncode == 0
            log("idb (real HID touches):", "ready" if self.idb else f"unavailable: {r.stderr.strip()[:200]}")

    def open(self, url):
        self.wd.goto(url)
        time.sleep(float(self.job.get("waitMs", 1200)) / 1000)
        if not getattr(self, "tips_dismissed", False):
            # A fresh simulator's Safari shows a one-time tip bubble over the page; a tap elsewhere closes it.
            self.tips_dismissed = True
            try:
                self.wd.click(element_id(self.wd.js("return document.elementFromPoint(innerWidth / 2, 4) || document.body")))
                time.sleep(0.8)
            except Exception as e:
                self.notes.append(f"could not dismiss Safari's first-run tip: {str(e)[:120]}")
        self.wd.js(INSTRUMENT_JS)
        st = self.state()
        self.baseline_vv = (st.get("visualViewport") or {}).get("height") or st["innerHeight"]
        self.viewport_top_px = None
        return st

    def state(self):
        return self.wd.js(STATE_JS)

    def shot(self, name):
        self.n += 1
        os.makedirs(os.path.join(OUT, "shots"), exist_ok=True)
        rel = f"shots/{self.n:02d}-{re.sub(r'[^A-Za-z0-9_-]+', '-', name)[:40]}.jpg"
        device_shot(self.dev["udid"], os.path.join(OUT, rel))
        return rel

    def keyboard_open(self, st):
        """The real keyboard shrinks the visual viewport (window.innerHeight stays the same in iOS Safari)."""
        vv = (st.get("visualViewport") or {}).get("height")
        if vv is None or not self.baseline_vv:
            return None
        return self.baseline_vv - vv > 120

    def calibrate(self):
        """Find where the page sits on the screen (below the status bar / Safari's top UI) by drawing a marker
        strip at the top of the viewport and locating it in a device screenshot. Needed for real HID input."""
        if self.viewport_top_px is None:
            self.wd.js("const d=document.createElement('div');d.id='__bbmark';d.style.cssText='position:fixed;left:0;top:0;width:100%;height:8px;background:#ff00ff;z-index:2147483647';document.documentElement.appendChild(d);")
            tmp = os.path.join(OUT, "_mark.jpg")
            im = device_shot(self.dev["udid"], tmp)
            self.wd.js("document.getElementById('__bbmark')?.remove()")
            os.remove(tmp)
            px = im.load()
            x = im.width // 2
            top = next((y for y in range(im.height) if px[x, y][0] > 200 and px[x, y][1] < 80 and px[x, y][2] > 200), None)
            if top is None:
                raise WebDriverError("could not locate the page on screen for a real tap")
            self.viewport_top_px = top
            self.screen_scale = im.width / self.state()["screen"]["width"]   # pixels per point
        return self.viewport_top_px / self.screen_scale   # viewport top, in points

    def screen_point(self, eid):
        """Element centre in device points, for real HID taps (idb)."""
        top_pt = self.calibrate()
        r = self.wd.js("const r=arguments[0].getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,w:innerWidth,sw:screen.width}",
                       {ELEM: eid})
        css_to_pt = r["sw"] / r["w"]
        return (r["x"] * css_to_pt, top_pt + r["y"] * css_to_pt)

    def hid_tap(self, eid):
        x, y = self.screen_point(eid)
        sh(["idb", "ui", "tap", "--udid", self.dev["udid"], str(round(x)), str(round(y))], timeout=60)

    def ensure_simulator_app(self):
        """Fallback for the keyboard: run Simulator.app with the hardware keyboard disconnected."""
        if self.simulator_app:
            return False
        sh(["defaults", "write", "com.apple.iphonesimulator", "ConnectHardwareKeyboard", "-bool", "false"], check=False)
        sh(["open", "-a", "Simulator", "--args", "-CurrentDeviceUDID", self.dev["udid"]], check=False)
        time.sleep(6)
        self.simulator_app = True
        return True

    def blur(self):
        self.wd.js("document.activeElement && document.activeElement.blur()")
        time.sleep(0.8)

    # ---- steps
    def element(self, step):
        return self.wd.find(step.get("selector"), step.get("text"))

    def run_step(self, step):
        a = step["action"]
        res = {"action": a, "name": step.get("name") or a}
        for k in ("selector", "text", "value", "to", "direction", "url", "ms"):
            if k in step:
                res[k] = step[k]
        t = time.time()
        if a == "goto":
            res["state"] = self.open(step["url"])
        elif a == "screenshot":
            pass
        elif a == "tap":
            eid = self.element(step)
            if step.get("method") == "hid" and self.idb:
                self.hid_tap(eid)
                res["method"] = "hid"
            else:
                self.wd.click(eid)
                res["method"] = "webdriver"
        elif a == "type":
            eid = self.element(step)
            self.wd.send_keys(eid, step.get("value", ""))
        elif a == "blur":
            self.blur()
        elif a == "keyboard":
            res.update(self.keyboard(step))
        elif a == "swipe":
            res.update(self.swipe(step))
        elif a == "scroll":
            to = step.get("to", "bottom")
            named = {"top": "0", "bottom": "document.documentElement.scrollHeight"}
            y = named[str(to)] if str(to) in named else str(int(to))
            self.wd.js(f"window.scrollTo(0, {y})")
        elif a == "wait":
            time.sleep(min(float(step.get("ms", 1000)), 20000) / 1000)
        elif a == "evaluate":
            res["value"] = self.wd.js(step["script"])
        else:
            raise WebDriverError(f"unknown iOS action '{a}' (see docs/ios.md)")
        time.sleep(float(step.get("waitMs", 700)) / 1000)
        st = self.state()
        res["state"] = st
        res["keyboardOpen"] = self.keyboard_open(st)
        if not st.get("focused") and st.get("visualViewport"):
            self.baseline_vv = st["visualViewport"]["height"]   # nothing focused: no keyboard; track bar changes
        if step.get("screenshot", True) and a != "keyboard":
            res["shot"] = self.shot(res["name"])
        res["elapsedMs"] = round((time.time() - t) * 1000)
        return res

    def swipe(self, step):
        """A finger swipe on the page. Real touch scrolling is what collapses Safari's address bar."""
        d = step.get("direction", "up")
        before = self.state()
        h, w = before["innerHeight"], before["innerWidth"]
        y1, y2 = (h * 0.75, h * 0.25) if d == "up" else (h * 0.25, h * 0.75)
        method = None
        if self.idb:
            try:
                top = self.calibrate()
                sh(["idb", "ui", "swipe", "--udid", self.dev["udid"], "--duration", "0.3",
                    str(round(w / 2)), str(round(top + y1)), str(round(w / 2)), str(round(top + y2))], timeout=60)
                method = "hid"
            except Exception as e:
                self.notes.append(f"idb swipe failed: {e}")
        if not method:
            try:
                self.wd.touch_swipe(w / 2, y1, y2)
                method = "webdriver-touch"
            except (WebDriverError, TimeoutError, OSError) as e:
                self.notes.append(f"WebDriver touch actions unavailable ({str(e)[:120]}); swipe fell back to scrollBy (does not move Safari's bars)")
                self.wd.js(f"window.scrollBy(0, {int(y1 - y2)})")
                method = "scrollBy"
        time.sleep(1.2)
        after = self.state()
        return {"method": method, "innerHeightBefore": h, "innerHeightAfter": after["innerHeight"],
                "addressBarCollapsed": after["innerHeight"] > h + 20, "scrolled": after["scrollY"] - before["scrollY"]}

    def keyboard(self, step):
        """Focus a field like a person would and record the real keyboard: video of the slide, the viewport
        change, where fixed bars end up, and a device screenshot with the keyboard up. Tries several ways
        to bring the keyboard up and reports which one worked."""
        out = {"attempts": []}
        strategies = ["webdriver-tap", "send-keys"] + (["hid-tap"] if self.idb else []) + ["simulator-app+webdriver-tap"]
        if step.get("strategies"):
            strategies = step["strategies"]
        for strat in strategies:
            if strat == "hid-tap" and not self.idb:
                continue
            if strat.startswith("simulator-app") and not self.ensure_simulator_app():
                continue
            self.blur()
            base = self.state()
            mark = self.wd.js("return (window.__bbLog||[]).length") or 0
            k = len(out["attempts"]) + 1
            folder = os.path.join(OUT, f"keyboard-{self.n + 1:02d}-{k}")
            os.makedirs(folder, exist_ok=True)
            video = os.path.join(folder, "keyboard.mp4")
            rec = Recorder(self.dev["udid"], video)
            time.sleep(0.4)
            eid = self.element(step)
            t_action = time.time()
            att = {"strategy": strat}
            try:
                if strat == "send-keys":
                    self.wd.send_keys(eid, "")
                elif strat == "hid-tap":
                    self.hid_tap(eid)
                else:
                    self.wd.click(eid)
            except Exception as e:
                att["error"] = str(e)[:300]
            time.sleep(float(step.get("ms", 1500)) / 1000)
            rec.stop()
            st = self.state()
            att["focused"] = st.get("focused")
            att["visualViewportBefore"] = (base.get("visualViewport") or {}).get("height")
            att["visualViewportAfter"] = (st.get("visualViewport") or {}).get("height")
            att["innerHeightBefore"], att["innerHeightAfter"] = base["innerHeight"], st["innerHeight"]
            before, after = att["visualViewportBefore"], att["visualViewportAfter"]
            att["keyboardOpen"] = None if before is None or after is None else before - after > 120
            att["pageLog"] = (self.wd.js("return window.__bbLog||[]") or [])[mark:]
            frames = extract_frames(video, os.path.join(folder, "frames"))
            t_rel = (t_action - rec.started) * 1000
            fs = filmstrip(frames, t_rel, os.path.join(folder, "filmstrip.jpg"))
            if fs:
                att["motion"] = fs
            elif not ffmpeg_exe():
                att["motion"] = {"note": "no ffmpeg; video kept, frames not extracted"}
            att["video"] = os.path.relpath(video, OUT)
            att["shot"] = self.shot(f"keyboard-{strat}")
            att["fixedElements"] = st.get("fixedElements")
            out["attempts"].append(att)
            log(f"keyboard via {strat}: open={att['keyboardOpen']} vv {att['visualViewportBefore']} -> {att['visualViewportAfter']}")
            if att["keyboardOpen"]:
                out["keyboardOpen"] = True
                out["strategy"] = strat
                out["shot"] = att["shot"]
                out["keyboardHeightCss"] = att["visualViewportBefore"] - att["visualViewportAfter"]
                break
        else:
            out["keyboardOpen"] = False
        return out

    def finish(self):
        self.wd.quit()
        if getattr(self, "driver", None):
            self.driver.terminate()


# --------------------------------------------------------------------------- fixture server, probe, report
def serve_fixtures():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=FIXTURES)
    handler.log_message = lambda *a: None
    srv = socketserver.ThreadingTCPServer(("0.0.0.0", FIXTURE_PORT), handler)
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


PROBE_STEPS = [
    {"action": "screenshot", "name": "loaded"},
    {"action": "keyboard", "selector": "#price", "name": "keyboard-number"},
    {"action": "type", "selector": "#price", "value": "3.49", "name": "typed-price"},
    {"action": "blur", "name": "keyboard-dismissed"},
    {"action": "keyboard", "selector": "#name", "name": "keyboard-text", "strategies": ["webdriver-tap", "send-keys", "hid-tap"]},
    {"action": "blur", "name": "dismissed-2"},
    {"action": "tap", "selector": "#unit", "name": "picker-select", "waitMs": 1200},
    {"action": "blur", "name": "picker-closed"},
    {"action": "tap", "selector": "#when", "name": "picker-date", "waitMs": 1200},
    {"action": "blur", "name": "date-closed"},
    {"action": "scroll", "to": "top", "name": "top", "screenshot": False},
    {"action": "swipe", "direction": "up", "name": "swipe-up"},
]


def write_report(br, job, status, error=None):
    kb = [s for s in br.steps if s.get("action") == "keyboard"]
    first = br.steps[0]["state"] if br.steps and br.steps[0].get("state") else {}
    lines = [f"# iOS Safari run {job.get('label', '')}".rstrip(), ""]
    if br.dev:
        lines.append(f"Device: **{br.dev['name']}**, iOS {br.dev['ios']} Simulator (real Mobile Safari"
                     f"{', Safari ' + br.caps.get('browserVersion', '') if getattr(br, 'caps', None) else ''}). Status: **{status}**.")
    if error:
        lines += ["", f"Error: `{error}`"]
    if job.get("notes"):
        lines += ["", f"Notes: {job['notes']}"]
    if first:
        vv = first.get("visualViewport") or {}
        lines += ["", "## Page as loaded", "",
                  f"- Screen {first['screen']['width']}x{first['screen']['height']} pt at {first['dpr']}x; layout viewport "
                  f"{first['innerWidth']}x{first['innerHeight']} CSS px; visual viewport {vv.get('width')}x{vv.get('height')}.",
                  f"- Safe-area insets (notch / Dynamic Island / home indicator): {first.get('safeArea')} "
                  "(0 on edges Safari's own bars cover, and unless the page uses `viewport-fit=cover`).",
                  f"- JavaScript measurements: {'working' if first.get('innerWidth') else 'NOT working'}."]
    if kb:
        lines += ["", "## On-screen keyboard", ""]
        for s in kb:
            if s.get("error"):
                lines.append(f"- `{s.get('selector')}`: error: {s['error']}")
                continue
            lines.append(f"- `{s.get('selector') or s.get('text')}`: keyboard **{'appeared' if s.get('keyboardOpen') else 'did NOT appear'}**"
                         + (f" via {s['strategy']}, {s['keyboardHeightCss']} CSS px tall (visual viewport shrank by that much)." if s.get("keyboardOpen") else "."))
            for a in s.get("attempts", []):
                m = a.get("motion") or {}
                mtxt = f"; screen motion {m['motionStartMs']}..{m['motionEndMs']} ms after the action" if "motionStartMs" in m else ""
                lines.append(f"  - {a['strategy']}: open={a['keyboardOpen']}, focused={a.get('focused')}, visual viewport "
                             f"{a['visualViewportBefore']} -> {a['visualViewportAfter']}{mtxt}. Shot: `{a['shot']}`"
                             + (f", filmstrip: `{m['filmstrip']}`" if m.get("filmstrip") else "")
                             + (f". Error: {a['error']}" if a.get("error") else ""))
                for f in (a.get("fixedElements") or []) if a.get("keyboardOpen") else []:
                    where = "visible above the keyboard" if f["visibleInVisualViewport"] and not f["coveredBelowVisualViewport"] else \
                        f"hidden {f['coveredBelowVisualViewport']} CSS px behind the keyboard" if f["coveredBelowVisualViewport"] else "outside the visible area"
                    lines.append(f"    - fixed/sticky `{f['tag']}{'#' + f['id'] if f['id'] else ''}` \"{f['text']}\": {where}.")
    lines += ["", "## Steps", "", "| # | step | result | keyboard | shot |", "|---|---|---|---|---|"]
    for i, s in enumerate(br.steps, 1):
        extra = s.get("error") or ""
        if s.get("action") == "swipe" and not extra:
            extra = f"{s.get('method')}: innerHeight {s.get('innerHeightBefore')} -> {s.get('innerHeightAfter')}, " \
                    f"address bar {'collapsed' if s.get('addressBarCollapsed') else 'unchanged'}, scrolled {s.get('scrolled')} px"
        lines.append(f"| {i} | {s.get('name')} | {'error: ' if s.get('error') else ''}{extra or 'ok'} | "
                     f"{s.get('keyboardOpen')} | `{s.get('shot', '')}` |")
    if br.notes:
        lines += ["", "## Notes", ""] + [f"- {n}" for n in br.notes]
    lines += ["", "Shots are the whole device screen (Safari's bars, keyboard, pickers included). `steps.json` has every "
              "measurement; `keyboard-*/` has the video, frames, and filmstrip of each keyboard attempt."]
    open(os.path.join(OUT, "summary.md"), "w").write("\n".join(lines) + "\n")
    files = []
    for root, _, names in os.walk(OUT):
        for n in names:
            p = os.path.join(root, n)
            files.append({"path": os.path.relpath(p, OUT), "bytes": os.path.getsize(p)})
    manifest = {"label": job.get("label"), "kind": "ios", "status": status, "error": error, "device": br.dev,
                "host": getattr(br, "host", None),
                "safari": (getattr(br, "caps", None) or {}).get("browserVersion"), "idb": br.idb,
                "keyboard": [{"selector": s.get("selector"), "open": s.get("keyboardOpen"), "strategy": s.get("strategy"),
                              "heightCss": s.get("keyboardHeightCss")} for s in kb],
                "createdAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
                "seconds": round(time.time() - T0), "files": sorted(files, key=lambda f: f["path"])}
    json.dump(manifest, open(os.path.join(OUT, "manifest.json"), "w"), indent=2)
    json.dump(br.steps, open(os.path.join(OUT, "steps.json"), "w"), indent=2)
    return manifest


def main():
    os.makedirs(OUT, exist_ok=True)
    job = json.loads(os.environ.get("JOB_JSON") or "{}")
    job.setdefault("label", os.environ.get("RUN_LABEL", "ios"))
    if job.get("brief"):
        open(os.path.join(OUT, "brief.md"), "w").write(job["brief"])
    probe = job.get("probe") or not job.get("url")
    serve_fixtures()
    url = job.get("url") or f"http://localhost:{FIXTURE_PORT}/keyboard.html"
    steps = job.get("steps") or (PROBE_STEPS if probe else [{"action": "screenshot", "name": "loaded"},
                                                          {"action": "swipe", "direction": "up", "name": "swipe-up"}])
    br = IOSBridge(job)
    status, error = "ok", None
    try:
        br.start()
        br.open(url)
        for step in steps[:40]:
            try:
                res = br.run_step(step)
            except Exception as e:
                res = {"action": step.get("action"), "name": step.get("name") or step.get("action"),
                       "selector": step.get("selector"), "error": f"{type(e).__name__}: {str(e)[:300]}"}
                try:
                    res["shot"] = br.shot((step.get("name") or "step") + "-error")
                except Exception:
                    pass
                log("step failed:", res["error"])
            br.steps.append(res)
            log(f"step {res['name']}: {'error' if res.get('error') else 'ok'}")
        try:
            blocked = br.wd.js("return window.__bbBlocked || []", timeout=20)
            if blocked:
                br.notes.append(f"Blocked writes (form submits / non-GET requests stopped in the page): {blocked[:10]}")
            with open(os.path.join(OUT, "page-log.json"), "w") as fh:
                json.dump(br.wd.js("return window.__bbLog || []", timeout=20), fh, indent=1)
        except Exception as e:
            br.notes.append(f"end-of-run page reads failed: {str(e)[:160]}")
        if any(s.get("error") for s in br.steps):
            status = "partial"
    except Exception as e:
        status, error = "failed", f"{type(e).__name__}: {str(e)[:500]}"
        log("FAILED:", error)
        try:
            if br.dev:
                br.shot("failure-state")
        except Exception:
            pass
    finally:
        br.finish()
    m = write_report(br, job, status, error)
    print(open(os.path.join(OUT, "summary.md")).read())
    if os.environ.get("PRINT_THUMBS"):
        print_thumbs(m)
    sys.exit(0 if status != "failed" else 1)


def print_thumbs(manifest):
    """Small images inline in the log (between BB-IMG markers) so a reader with only log access can still look."""
    for f in manifest["files"]:
        p = f["path"]
        if p.endswith(".jpg") and ("shots/" in p or p.endswith("filmstrip.jpg")):
            im = Image.open(os.path.join(OUT, p)).convert("RGB")
            im.thumbnail((360, 360) if "shots/" in p else (900, 600))
            import io
            buf = io.BytesIO()
            im.save(buf, "JPEG", quality=55)
            print(f"BB-IMG {p}\n{base64.b64encode(buf.getvalue()).decode()}\nBB-IMG-END", flush=True)


if __name__ == "__main__":
    main()
