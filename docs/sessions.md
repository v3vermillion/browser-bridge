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
| `scroll [px\|top\|bottom\|N]` | Mouse-wheel scroll, jump, or scroll an element into view. |
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
