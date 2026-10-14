# Live sessions

A live session keeps one browser open (desktop, phone, or tablet) so you can look, decide, and act in
seconds: the same loop a person uses. Measured on GitHub-hosted runners: about 70 seconds to start, then
about 5-6 seconds per round trip. Each session uses GitHub Actions minutes while open (closes after `--idle` minutes, max 60).

```bash
python3 bridge.py session start --url https://example.org --device mobile --brief brief.md   # first look arrives with "ready"
python3 bridge.py session do swipe up
python3 bridge.py session do tap 7            # numbers come from the element map of the last observe
python3 bridge.py session do observe          # fresh screenshot + numbered map (marks.jpg shows the numbers)
python3 bridge.py session do "inspect 7" "swipe left 4" "zoom 7"   # several actions, one round trip
python3 bridge.py session do watch hover 7    # record what a hover does: animation data + filmstrip.jpg
python3 bridge.py session end --cleanup
```

Each result prints the action outcome, page state, any layout issue (e.g. horizontal overflow), and the
local paths of the screenshots it downloaded. Open them with your image tool.

## Actions

| Action (shorthand) | What it does |
|---|---|
| `observe` | Screenshot + numbered map of everything tappable on screen (+ `marks.jpg` with numbers drawn on). |
| `tap N` / `tap "Donate"` | Touch tap (phones) at an element. Falls back to a click on desktop. |
| `click N` / `click "text"` | Mouse click. |
| `hover N` | Hover (menus, hover states). |
| `type N some text [--submit]` | Fill a field (writes are blocked: nothing is actually sent). |
| `press Enter` | Keyboard key. |
| `scroll [px\|top\|bottom\|N]` / `scroll to 1316` | `scroll 600` scrolls *by* 600px with the wheel; `scroll to 1316`, `scroll top`, `scroll bottom` jump to an exact position (instantly, even on smooth-scrolling sites); `scroll N` brings element N into view. |
| `watch [load\|ACTION] [3s] [slowmo=0.25] [reduced=1]` | Record motion without scrolling: a page load, the page holding still (carousels, loops), or what one action does (`watch hover 7`, `watch tap "Menu"`, `watch press Escape`). Returns `filmstrip.jpg` (the frames where the picture changed, cropped to what moved, with timestamps) and the animations the browser itself reports (element, properties, duration, delay, easing, repeats). See "Motion" below. |
| `livescroll [bottom\|to Y\|distance] [fresh=1] [mode=touch\|wheel] [speed=900]` | Continuous scroll with real input while recording frames (Chromium streams them as it paints) plus motion metrics: frame timing, elements jumping on their own (layout shifts), scroll position snapping back, long tasks. Returns `sheet.jpg` (contact sheet) and `motion.json`; add `--frames` to download all frames. See "Motion" below. |
| `swipe up\|down\|left\|right [N]` | Finger swipe (real touch events in Chromium; wheel approximation in WebKit/Firefox). "Up" moves the finger up, so content scrolls down. Start on element N to swipe a carousel. |
| `zoom N` | Sharp, device-pixel crop of one element: typography, spacing, image quality. |
| `inspect N` | Exact facts for one element: font family/size/weight/line height, color on background with WCAG contrast ratio (AA/AAA), tap-target size vs the WCAG 2.2 24px minimum, padding/margin, radius, shadow. |
| `fullpage` | Whole-page screenshot from here. |
| `frames [count]` | A sequence of frames while scrolling: motion, sticky headers, scroll effects. |
| `inject --css-file f.css` / `--css "..."` | Apply proposed styles live, then screenshot: before/after previews on the real page. `--json` also accepts `html`, `text`, `hide`, `remove` edits. |
| `render --html-file mock.html` | Render a standalone mockup at the session's device size. |
| `reset` | Reload (drops injected changes). |
| `analyze styles,images,a11y,...` | Run measurements on the current state (meta, styles, images, links, forms, a11y). |
| `device mobile\|desktop\|tablet\|...` | Switch device, same page. |
| `goto URL` / `back` / `wait ms` | Navigation and timing. |
| `end` | Close the session. |

Full control: `session do --json '{"action":"swipe","direction":"left","ref":4,"distance":300}'`.

## Motion

Some things exist only while they move: entrance animations, hover and menu transitions, carousels, loops,
flicker, sections blanking out, headers jittering, images popping in late, the page snapping back mid-scroll.
Still screenshots can't show these, and an animated GIF reaches an AI as a single frame. So the bridge turns
motion into two things an AI can read: **a few well-chosen stills with timestamps**, and **the animations'
actual settings, read from the browser**.

### `watch`: motion without scrolling

```bash
python3 bridge.py session do watch load 4s          # a first visit, from a blank tab: what loads and moves, when
python3 bridge.py session do watch hover 7          # what hovering element 7 does
python3 bridge.py session do watch tap "Menu" 2s    # a menu opening (text targets work too)
python3 bridge.py session do watch 5s               # the page holding still: carousels, loops, delayed popups
python3 bridge.py session do watch hover 7 slowmo=0.1   # 10x slower, for fast transitions
python3 bridge.py session do "watch load 3s" "watch load 3s reduced=1"   # with and without reduced motion, one round trip
```

Each result has:
- **`filmstrip.jpg`, the image to look at.** It keeps only the frames where the picture changed: the first, where
  motion starts and ends, the biggest change, and the rest spread over the moments when something changed (still
  stretches get none). The filmstrip is cropped to the area that moved (the first cell shows where that is on the
  screen), and each frame is captioned with its time. `t = 0` is the action, the navigation start, or the start
  of the recording.
- **The animations the browser reported**, printed and in `watch.json`: type (CSS animation, CSS transition, Web
  Animation), element and its text, properties with their keyframe values (`transform translateY(24px) -> none;
  opacity 0 -> 1`), duration, delay, easing, repeats, direction, and when each one started. These are exact,
  not inferred from pictures.
- **How much of the visible change those animations explain**: "92% on elements in the animation list, 0% in
  video/canvas/iframes, 8% elsewhere". Motion made by scripts (GSAP, Lottie, Framer, Webflow interactions,
  canvas, WebGL, video) isn't in the browser's animation list, so when much of the change is "elsewhere" or in
  media, the frames are the evidence. Detected libraries, videos, and canvases are listed.
- For `load`: first and largest contentful paint, load event, layout shifts with the elements that moved.

Options (`key=value`):

| Option | Meaning |
|---|---|
| `3s`, `800ms`, `ms=3000` | How much of the page's time to cover (default 3 s, max 20 s of real time). |
| `load` / `fresh=1` | Record a first visit: blank tab, then the page loading, with the HTTP cache cleared (Chromium; cookies kept). |
| `slowmo=0.1` | Slow every CSS and Web Animation (0.02-1). Captions show real time and the matching normal-speed time. Script-driven motion runs at normal speed. |
| `reduced=1` | Emulate `prefers-reduced-motion: reduce` for this recording. Compare with a normal recording to check the reduced-motion version. |
| `network=4g\|3g`, `cpu=4` | Throttle network and CPU for this recording (Chromium), so loading looks like it does on a phone, not a datacenter. `4g` is Lighthouse's mobile setting (150 ms, 1.6 Mbps). |
| `max=12` | How many frames go on the filmstrip (4-24). |
| `crop=0` | Show whole frames instead of cropping to what moved. |

Add `--frames` to download the picked frames at full size. `python3 perceive.py motion <folder> --gif motion.gif`
makes a GIF of them for a person to watch.

**Gotcha: other actions' screenshots don't show animations in progress.** To keep stills stable, screenshots
finish running CSS animations instantly and restart loops. To see an animation, record what starts it: `watch
load` for entrance animations, `watch hover N` for hover effects, `watch tap N` for menus.

### `livescroll`: motion while scrolling

```bash
python3 bridge.py session do livescroll bottom fresh=1 --frames      # first-visit scroll, top to bottom
python3 perceive.py motion bridge-sessions/<id>/<seq> --gif scroll.gif
```

- **`fresh=1`** reloads the page without the tool's lazy-load pre-scroll first. Use it when hunting
  motion bugs: many effects (reveal animations, one-time banners, sticky headers activating) fire only on
  the first scroll, and the pre-scroll would otherwise use them up before recording. To keep a whole
  session first-visit-faithful, start it with `--no-prescroll`.
- **`mode`**: `touch` (default on phones: repeated finger flicks with momentum) or `wheel` (steady mouse
  wheel; also the WebKit/Firefox path). Momentum flicks can override a page's own scroll scripts, so if a
  scroll-related bug is suspected, try both.
- **Reading results**: `motion.json` has frame timing (rAF intervals; ~16.7ms = 60fps), layout shifts
  with the elements that moved, scroll reversals (position going backward while scrolling forward), and
  long tasks, all on one clock (ms since the recording started). `frames.streamed` vs `frames.pageFrames`
  shows how many of the page's frames the stream caught. `perceive.py motion` compares consecutive frames
  after cancelling the scroll movement, so what's left is content changing on its own; it lists spikes and
  blank frames with the frame files to view.
- **Verify by looking**: open each flagged frame next to the one before it. Reveal animations are
  expected change; flicker, blanking, and pop-in at odd moments are bugs.

**Limits:** Chromium streams frames as it paints them (it can skip some under load; the counts say how many);
WebKit and Firefox take screenshots in a loop instead (roughly 10 per second, and none while a page is busy
loading; the result says which stretch is missing), and have no layout-shift data or throttling. Animation
data works in all three. Chromium's scroll anchoring hides some content jumps from users (and from the
metrics); Safari has historically handled scroll anchoring differently, so a jump that's invisible in
Chromium may still affect iPhone users. Headless frame timing is indicative, not a device benchmark. Canvas
and WebGL effects can be judged only from frames.

## Several actions per round trip

Each round trip costs about 5-6 seconds, so when you already know the next steps, send them together:
`session do "tap 3" "swipe up" "zoom 8"` (or `session do tap 3 ; swipe up ; zoom 8`). They run in order and
each returns its own result and screenshot. The batch stops at the first failure (later steps usually
depend on earlier ones); with `--json`, add `"continueOnError": true` to change that. Element numbers in a
batch refer to the map from the last `observe`, so observe again before batching after the page changes.

## Brief

`session start` requires `--brief FILE` (see docs/expert-brief.md) or `--no-brief "reason"`. The brief is
kept on the session's results branch next to the screenshots, so the criteria and the evidence stay together.

## Tips

- The element map is a snapshot: after the page changes (menu opens, navigation), `observe` again
  before using numbers. A stale number fails immediately with that instruction.
- For design judgment, pair what you see with `perceive.py analyze <shot>` and zoom crops.
- For before/after proposals: `observe` (before) -> `inject` -> screenshot (after) -> `perceive.py compare`.
- Use batch captures (`run`) for broad coverage across many pages/devices; sessions for exploring and
  iterating on specific parts.
