# Real iPhone Safari (iOS Simulator)

The `iphone` / `mobile` device in batch runs and sessions is desktop WebKit sized like a phone. It can't show
anything that belongs to iOS rather than the page: the **on-screen keyboard**, Safari's **collapsing address
bar**, the **notch / Dynamic Island and home indicator**, and **native pickers** (select wheels, date pickers).
Bugs often live exactly there (a fixed bar hidden behind the keyboard, a field scrolled out of view as the
keyboard opens, a layout jump when the address bar collapses).

`bridge.py ios` runs the real thing: Mobile Safari in Apple's iOS Simulator on a free GitHub macOS runner,
driven by Apple's own `safaridriver`. Screenshots are the **whole device screen**, as a person sees it.

```bash
python3 bridge.py ios --url https://example.org --keyboard "input[type=email]" --no-brief "keyboard check"
python3 bridge.py ios --url https://example.org --steps steps.json --brief brief.md
python3 bridge.py ios --probe --no-brief "check the simulator works"      # built-in test page
python3 bridge.py fetch LABEL --include 'keyboard-*/keyboard.mp4'         # the keyboard video
```

It's a batch run (steps in, results out), not a live session: a macOS runner and a simulator boot take a few
minutes, so put everything you want to see in one run. Results land on the `results` branch like any other run.

## Steps

`--steps` takes a JSON list. Every step accepts `name`, `waitMs` (pause after, default 700) and
`screenshot: false`. Elements are found by `selector` (CSS) or `text` (visible text, label, placeholder).

| action | fields | does |
|---|---|---|
| `keyboard` | selector / text, `ms` (default 1500) | Taps the field like a finger and records the real keyboard opening: screen video, a filmstrip of the frames that changed (with ms since the tap), how much the visual viewport shrank (= keyboard height in CSS px), and where every fixed/sticky element ended up (visible above the keyboard, or hidden behind it and by how much). Tries several ways to raise the keyboard and reports which worked. |
| `tap` | selector / text, `method` | Taps an element (opens native pickers for `select` and date inputs). `touch` (default) is a quick W3C touch tap; `click` is safaridriver's element click (seen arriving as a long press on iOS 26: selection handles and loupe); `hid` is a real touch through idb (needs `--idb`). |
| `type` | selector / text, `value` | Types into a field (focuses it first). Nothing is submitted. |
| `blur` | | Unfocuses the field (closes the keyboard). |
| `swipe` | `direction` up/down | Finger swipe. Real touch scrolling is what collapses Safari's address bar; the result reports the viewport height before/after. |
| `scroll` | `to` top/bottom/px | Instant programmatic scroll (doesn't move Safari's bars). |
| `goto` | url | Opens another page. |
| `wait` | ms | Waits (max 20 s). |
| `evaluate` | script | Runs JavaScript (a function body; `return` a value) and saves the result. |
| `screenshot` | | Just the device screenshot. |

Example (`steps.json`):
```json
[
  {"action": "screenshot", "name": "loaded"},
  {"action": "keyboard", "selector": "#email"},
  {"action": "type", "selector": "#email", "value": "test@example.org"},
  {"action": "blur"},
  {"action": "tap", "text": "Country", "name": "country-picker"},
  {"action": "swipe", "direction": "up"}
]
```
Options: `--device "iPhone 16 Pro"` (any installed simulator; default: a current iPhone on the newest iOS),
`--idb` (also install idb for real HID touches: slower start; a fallback if Safari's own taps misbehave).

## Results

- `summary.md`: device and iOS/Safari version, screen and viewport sizes, safe-area insets, each keyboard
  attempt (strategy, viewport before/after, motion window, fixed elements), every step.
- `shots/NN-name.jpg`: whole-device screenshots (status bar fixed at 9:41 so runs compare).
- `keyboard-NN-K/`: `keyboard.mp4` (screen video) and `filmstrip.jpg` per keyboard attempt.
- `steps.json`: every measurement per step; `page-log.json`: timestamped viewport changes recorded in the page
  (`vv-resize` events show when Safari reports the keyboard's effect).

**Reading keyboard results.** In iOS Safari the keyboard doesn't change `window.innerHeight`; it shrinks the
*visual* viewport. So "the keyboard is open" = visual viewport height dropped (by the keyboard's height), and a
`position: fixed; bottom: 0` element stays attached to the layout viewport, i.e. behind the keyboard, unless the
page moves it using `visualViewport`. The summary says which fixed elements ended up hidden and by how much.
Confirm on the screenshot and filmstrip before reporting.

## Limits and honesty

- It's the **iOS Simulator**: real iOS and real Mobile Safari on a Mac, not a physical phone. Rendering,
  keyboard, pickers and browser UI match iOS; performance, GPU, camera, Face ID and haptics don't.
- **Write blocking is best-effort** here: Safari offers no request interception, so the page's form submits and
  non-GET `fetch`/XHR/beacons are stopped by a script injected after load. Requests made during page load, or
  by code that kept its own reference to `fetch`, aren't covered. Avoid tapping submit/pay buttons.
- Simulator keyboard settings are known to be unreliable in CI; each `keyboard` step verifies the keyboard
  actually appeared (viewport measurement + video) rather than assuming it.
- Slow start (a macOS runner plus a simulator boot). macOS minutes are free on public repos; on private repos
  they count 10x against the Actions quota.
- Public repo = public results, as with every other mode.
