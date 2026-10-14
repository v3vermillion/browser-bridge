# Chronoscope: teaching browser-bridge to watch

Status: proposal (design only, nothing here is implemented yet). Written October 2026 after a full read of
the repo. It describes the system as if it existed, then how to build it.

## In one paragraph

A model can't watch a 60 fps stream. It reads a few images per turn and thinks for seconds between turns.
People don't take in 60 fps either: they fixate a few times a second, get pulled toward anything that
starts moving, and remember *what changed*. So "watching" for an AI shouldn't mean piping video into it.
Chronoscope records everything at full fidelity where the browser runs, ties every pixel change to its
cause in the page, compiles time into a handful of images and a timestamped transcript the model can
read, gives the model control over time (pause, slow down, rewind, step a frame, inspect mid-animation,
replay with a fix), and keeps watching between turns so it can tell the model what happened while it was
thinking. The result is closer to how a motion designer reviews work in an editor than to a person
glancing at a screen, and in a few ways it sees more than a person can.

---

## 1. What "watching" has to mean for an AI

Three facts shape the design:

1. **The AI's eyes are discrete.** Chat models take images and text. Even models with native video input
   sample it, by default at about 1 frame per second (Gemini). One frame per second of a 300 ms transition
   shows nothing, and of a 3 Hz flicker it shows noise.
2. **The AI's attention is turn-based.** A round trip here costs about 5-6 s, and the model thinks in
   between. It can't react 16 ms after a frame is painted, and it doesn't need to. What it needs is to
   know afterwards exactly what happened, and to be able to go back and look again.
3. **Human watching is mostly not pixels.** People fixate a few times per second. Motion onset grabs
   their attention without their choosing (Abrams & Christ 2003). The eye integrates light over roughly
   50-100 ms, so fast motion blurs and fast flicker fuses. And people mostly remember events: "the button
   jumped", "the picture took ages", "I couldn't read the text over the video".

So the system has to do for the AI what the visual system does for a person: turn a stream into events,
objects, and changes at the right moments, and keep the ability to look again. The AI also gets two
things people don't: exact causes (which CSS animation, which network response, which script) and
control over time.

**Two kinds of time.** *As experienced* means real time on a realistic, throttled device, with jank, late
images, and font swaps. *As designed* means virtual time, where every frame is rendered exactly however
slow the runner is. The difference between the two is, by definition, the performance problem.
Chronoscope can record both.

---

## 2. Where browser-bridge is today (the motion-relevant parts)

What exists is a good seed. `livescroll` streams screencast frames alongside a requestAnimationFrame
trace, layout shifts, scroll reversals, and long tasks. `perceive.py motion` cancels out the scroll
movement to find content changing on its own, and can write a GIF. `frames` and `burst` take strobe
shots. Here are the gaps and issues the read turned up:

| Where | What | Why it matters for watching |
|---|---|---|
| `engine/session.mjs:274` | Each frame's time is `Date.now() - tStart` at the moment Node *receives* it, not the screencast's `metadata.timestamp` (the compositor swap time). | Frame times include transport jitter. |
| `engine/session.mjs:253-255` vs `:270` | The in-page trace, layout shifts, and long tasks are timed with `performance.now()` from `m.t0`. Frames use Node's clock from `tStart`. | A shift can't be matched to the frame that shows it. Everything below depends on one shared clock. |
| `engine/session.mjs:278`, `docs/sessions.md:30`, README | The docs say "every painted frame". Screencast frames are paced by acknowledgements and get skipped when acks lag, and coverage is never reported. | Report streamed frames against rAF frames so the AI knows how complete a recording is. Use deterministic capture when completeness matters. |
| `engine/session.mjs:323-325` | Long streams are thinned to 80 evenly spaced frames. | Even sampling throws away exactly the brief frames that matter, like a 2-frame flash. Pick frames by event and keep the rest in a pack. |
| `engine/session.mjs:287-313` | Touch scrolling is hand-built drags with sleeps, and wheel mode awaits every tick. | CDP `Input.synthesizeScrollGesture` produces native gestures, including fling, at a set speed. That's closer to a real thumb. |
| `engine/session.mjs:76-78` | The page loads and gets pre-scrolled before any recording starts. | The AI never sees a page load: the blank screen, font swap, skeletons, and pop-in. |
| `engine/session.mjs:607-634` | Between commands the runner only polls git. | A modal that appears, a carousel that advances, or a video that ends while the AI is thinking goes unseen. |
| `client/bridge.py:438-444` | Each frame is downloaded with its own contents-API request, and `perceive.py motion` runs in the AI's sandbox. | 80 frames means 80 requests before analysis can start. Analyze on the runner, ship the results, and pack the frames into one file. |
| `client/perceive.py:292-303` | Scroll compensation assumes the whole frame shifts vertically by the scroll distance. | Parallax, horizontal carousels, scale and zoom effects, and partly sticky regions all show up as "change". Real motion needs motion vectors per region. |
| everywhere | No `prefers-reduced-motion`, no CPU or network throttling, no handling of `<video>`, canvas, or audio. | This is where most real motion problems live: what a mid-range phone on 4G sees, what reduced-motion users get, what plays in the hero. |

None of this is wrong for a first version. It marks where to build.

---

## 3. The invention

Each part is named after the piece of the human visual system that does the same job for people.

```
 runner (GitHub Actions, or any host that can run a browser)
 +---------------------------------------------------------------------------+
 |  browser --pixels--> [1 Retina] <--- one clock ---> [2 Ledger] <-causes-- |
 |                          |                              |                 |
 |                          +-----> [3 Visual cortex] <----+                 |
 |                                   |             |                         |
 |                          [4 Narrator]     [6 Time machine]                |
 |                                   |      (replay, freeze, step, twin)     |
 |   [7 Peripheral vision] keeps watching between turns and logs events      |
 +-----------------------------------|---------------------------------------+
                                     |  [8 Live wire]: git chunks, optional relay
 +-----------------------------------v---------------------------------------+
 |  AI sandbox: watch.md + a few images  --[5 Saccades]-->  "look closer at  |
 |  the header 0.8-1.6s", "freeze at 1.25s, inspect 7", "replay with fix"    |
 +---------------------------------------------------------------------------+
```

### 3.1 Retina: record everything, on one clock

- **Frames, in two modes.**
  - *Real time (as experienced).* The CDP screencast, stamped with `metadata.timestamp`. During page
    loads, also a DevTools trace that includes `disabled-by-default-devtools.screenshot`: the same
    filmstrip DevTools' Performance panel shows, with compositor timestamps. Coverage is always reported.
  - *Deterministic (as designed).* chrome-headless-shell with BeginFrame control
    (`HeadlessExperimental.beginFrame`, `--run-all-compositor-stages-before-draw`, `--deterministic-mode`),
    the technique HTML-to-video renderers use. The runner advances virtual time 16.67 ms (8.33 ms for
    120 Hz) and takes exactly one frame per step, so a slow runner produces the same frames, just slower.
    Playwright creates its own targets, so this probably needs a small raw-CDP path, the way
    `puppeteer-capture` does it.
- **One clock.** Everything is stamped in milliseconds since navigation start: frames (screencast swap
  time), trace events (trace clock), in-page events (`performance.timeOrigin + performance.now()`), input
  events, and network. At the start, the runner paints a one-frame marker and checks that every stream
  puts it at the same moment.
- **Realistic conditions.** CPU throttling (`Emulation.setCPUThrottlingRate`), network profiles
  (`Network.emulateNetworkConditions`), `reducedMotion`, color scheme, and 60 or 120 Hz frame pacing.
  These come as named profiles: `phone-4g` (4x CPU, 4G), `desktop-fiber`, `old-android-3g`.
- **Recording starts before navigation**, so a load is seen from its first white frame.
- **Storage.** Every frame of a recording goes into one pack (`frames.pack`, a zip, or a sprite plus an
  index). By default only the selected images are shipped.

### 3.2 Ledger: what caused each change

The pixels say *what* changed and the ledger says *why*. Everything is collected on the same clock:

| Source | What it gives |
|---|---|
| CDP `Animation` domain | Every CSS animation, transition, and Web Animation: target node, keyframes, duration, delay, easing, iterations, play state, including scroll-driven timelines |
| PerformanceObserver | Layout shifts (with the elements that moved and their rects), long animation frames with script attribution (LoAF), LCP, paints, event timing (input to next paint) |
| MutationObserver + IntersectionObserver | Elements added, removed, or changing class, and when each one enters and leaves the viewport |
| Element geometry sampling | Boxes, per frame, for the elements the Animation domain or the mutation stream marks as active |
| Network + fonts | When each image, video, and font arrived; `document.fonts` loading and swap events |
| Media | `play`, `pause`, `waiting`, `stalled`, `ended`, frames presented via `requestVideoFrameCallback`, text tracks |
| Top layer | Dialogs and popovers opening (modals, cookie banners) |
| Input | Every synthetic touch, wheel, and key event the runner sent, with intended vs actual scroll |

The ledger is stored as `timeline.jsonl`. The AI can query it cheaply, without images (section 3.5).

### 3.3 Visual cortex: compiling time into images a model can read

Vision models read single images well and long image sequences badly. So the runner encodes time *into*
images, using whichever encoding answers the question being asked:

| Question | Encoding | How it reads |
|---|---|---|
| What happened, in order? | **Storyboard**: 6-12 keyframes picked at events (animation start and end, a shift, a pop-in, peak change), each captioned with its time and cause | A comic strip |
| How did this element move? | **Chronophotograph** (after Marey): ghosted copies of the element at even time steps on one frame, colored by time, with the path drawn. Plus a **property curve** (y, opacity, or scale against time) naming the closest standard easing | The shape of the motion in one image |
| Is something jittering or stuttering? | **Slit-scan** (like a photo-finish camera): one row or column of pixels from every frame, stacked so x is time | A sticky header that should draw a straight line wobbles; stutter shows as steps, flicker as stripes |
| What loaded when? | **Settle map**: each pixel colored by when it last changed (an event camera's "time surface"), plus a filmstrip and a visual-progress curve in the style of Speed Index | Load order in one image; late regions stand out |
| Where is the motion, and what competes for attention? | **Motion-energy heatmap** over the whole recording, with the call to action and headline outlined | |
| How is the choreography timed? | **Animation Gantt** from the ledger: one row per animation, bars for delay and duration, a glyph for the easing | How a motion designer reads a timeline |
| What would a person actually perceive during fast motion? | **Perceived frame**: frames integrated over about 60-100 ms | Text in fast parallax blurs, 30 Hz flicker fuses, a one-frame blank may not register |
| Did the fix help? | **Twin** storyboard or slit-scan: before vs after under identical replay | |

Underneath sit scroll-compensated motion vectors per region (OpenCV Farneback optical flow on
downscaled frames, which runs fine on a CPU). Moving regions are connected and linked to ledger
elements by box overlap. On top of that: scene-change detection in media regions, blank and placeholder
detection, and flash analysis. Every event detected lists the frame files that show it.

Images are sized for the model that will read them. Claude's vision cost, for example, is about
width x height / 750 tokens, and images longer than 1568 px on the long edge are scaled down, so each
encoding is composed at a size that keeps its labels legible after any scaling. Each request carries a
budget (`budget=6` images, or a token count), and the compiler spends it on the most informative
encodings.

### 3.4 Narrator: a motion transcript

Blind viewers get audio description for video. The AI is in a similar position: it reads text and sees
stills. So every recording comes with a timestamped transcript. It's in `watch.md`, and it's also
exported as WebVTT next to `watch.mp4`, so a person can watch the same recording with the same captions.

```
Illustrative output (profile phone-4g, fresh visit, livescroll to bottom)
00:00.000  navigation start                                                   measured
00:00.412  first paint: white page, header bar only                   f007   pixel+trace
00:00.890  headline visible in fallback font                          f021   measured (fonts)
00:01.340  web font swaps in; headline 3 -> 2 lines; content below
           moves up 38px (layout shift 0.061)                         f041   measured
00:01.520  hero <video> box black for 0.79s (no poster); first
           video frame at 02.310                                 f046-071   pixel+media
00:02.310  headline over video: contrast 5.8:1, falls to 2.1:1
           from 07.4s to 09.1s (bright sky shot)                             measured per frame
00:03.000  scroll starts (touch fling, 900 px/s)                             input
00:03.820  section 2: 6 cards fade up, 600ms ease-out, 80ms stagger          measured (Animation)
00:04.410  image 3 enters view; painted at 05.050: 640ms gray box     f088   pixel+network
00:06.200  sticky header jitters 3px for 9 frames          slitscan-header.png   pixel
00:09.000  scroll reversal: page pulled back 240px (scroll snap)             measured
```

Each line says how it's known: *measured* (from the ledger), *pixel* (from computer vision), or *model*
(a vision model's description, only when that optional pass runs). That extends the repo's existing
rule of separating what was seen, what was measured, and what was inferred.

### 3.5 Saccades: looking closer at one place and moment

People glance, then look closer. The AI's version:

- `look header t=0.8-1.6 fps=30 scale=2` returns a strip of sharp crops of one region over a time
  window. It reads from the pack, so nothing is re-recorded.
- `ask "when was the Donate button first fully visible and readable?"` or
  `ask "what moved between 1.0 and 2.0s?"` gets an answer in text from the ledger and the motion
  regions, at almost no image cost.
- `frame 1.25s` returns the exact frame at that moment, and `diff 1.20s 1.25s` returns the change
  between two moments, with boxes drawn around it.

The AI starts from the overview (transcript and storyboard) and spends images only where something is
worth seeing. Google's agentic video understanding for Gemini (September 2026) applies the same idea to
video files: the model picks what to watch and resamples the interesting windows at higher frame rates.
Chronoscope gives any model that behavior on live websites, with exact causes attached.

### 3.6 Time machine: pause, rewind, slow down, inspect mid-motion, replay with a fix

This is where an AI can do what people can't:

- **Deterministic replay.** The first visit records the network to a HAR (`recordHar`), and replays
  serve it back (`routeFromHAR`). JS time is controlled with `page.clock` (Date, timers, rAF,
  performance) and `Math.random` is seeded. CSS and Web Animations are controlled through the CDP
  Animation domain (`setPlaybackRate`, `seekAnimations`, `setPaused`), media through `currentTime`, and
  the compositor through BeginFrame. Inputs (scroll paths, taps) are recorded and replayed exactly.
- **Freeze a moment, then use every existing tool on it.** `freeze at=1.25s` replays up to that moment
  and stops time. `inspect 7` then reports the button's exact opacity, transform, color, and contrast
  *in the middle of the animation*. `zoom`, `observe`, and `analyze` all work on the frozen moment too.
- **Step, slow down, scrub.** `step +1f`, `slowmo 0.1` (every animation and timer at 10% speed),
  `scrub 1.0-1.6s every=1f`.
- **Before and after, in motion.** `replay css-file=fix.css` re-runs the same inputs on the same
  network bytes with the fix injected, then compares the two recordings: matching storyboard moments
  side by side, slit-scans compared, shifts and blank time counted. It's the motion version of today's
  `inject` plus `perceive.py compare`.
- **Twin runs.** `twin=1` records both as-experienced (throttled, real time) and as-designed (virtual
  time), and reports where they differ: frames the user never saw, animations that started late, images
  that missed their entrance.
- **Counterfactuals.** One call can sweep a variable and report what changes: reduced motion on or off,
  scroll speed at 500, 1500, or 3000 px/s, 4G or fiber, a 375 or 430 px wide screen. Reduced-motion
  compliance becomes a diff showing which animations still run under `prefers-reduced-motion: reduce`
  (WCAG 2.3.3).

### 3.7 Peripheral vision: still watching between turns

Today a session stops seeing anything between commands. Chronoscope keeps a cheap sentinel running:
pixel motion energy, mutation rate, top-layer changes, media events, navigation, console errors. It logs
while the AI thinks, and the next result opens with a short "while you were away" digest:

```
since your last action (14.2s): newsletter modal opened at +12.4s (top-layer dialog, covers 71% of
the screen); carousel advanced twice (period 6.0s, doesn't pause on hover); video ended at +9.0s and looped
```

The AI can also wait for a condition instead of guessing sleep lengths: `wait-for settle` (no pixel
change for 500 ms outside known loops), `wait-for change region=hero`, or
`wait-for event=dialog|media-ended|navigation max=30s`. Visual settle can also replace `networkidle`
plus fixed sleeps in `preparePage` for still captures, so screenshots are taken once the page actually
looks finished.

### 3.8 Live wire: how fast the AI and the person can follow

| Tier | Path | Latency | Needs |
|---|---|---|---|
| 0 (default) | Git, as today, but each result is one packed blob. Polling uses conditional requests (`If-None-Match`; GitHub doesn't count 304 responses against the primary rate limit), and results come down in one shallow `git fetch` when github.com is reachable. | ~2-4 s | Nothing new |
| 0+ | `watch --follow`: the runner commits a rolling chunk every 2-3 s (digest, keyframe, events) and the client tails them. | Live at the pace an AI can think | Nothing new |
| 1 | The runner holds an outbound WebSocket to a small relay (e.g. a Cloudflare Worker with a Durable Object, frames in R2), and the client long-polls it over HTTPS. | Under a second | One more allowed host |
| 2 | A co-watch page on the relay: the user watches the same session live on their phone and taps the frame to point ("this, here"). The tap shows up as an annotation in the AI's next result. | Under a second | Same as tier 1 |
| 3 | Hosted browsers with built-in live view and recording as alternative backends. Cloudflare Browser Run added Live View and session recordings in April 2026. | Varies | An account |

### 3.9 Media: eyes and ears

- **Video elements.** For each `<video>`, Chronoscope records: poster vs first frame, time to first
  frame, the autoplay, muted, loop, controls, and caption settings, stalls, and rendition sharpness
  (`videoWidth` vs displayed size). When the source is a file or HLS stream the site itself serves, the
  runner analyzes the file directly: shot boundaries (scene detection), keyframes per shot, on-screen
  text (OCR), and speech (Whisper on CPU). The result is a **video storyboard** with a transcript.
  Third-party players (YouTube, Vimeo) are only observed as they render on the page, never downloaded.
- **Text over moving backgrounds.** The contrast of overlaid text is measured against every frame behind
  it, giving the worst case and the share of time below 4.5:1. No still screenshot can answer that.
- **Flashing.** WCAG 2.3.1 general-flash and red-flash analysis runs over the frames (open
  implementations exist, e.g. EA's IRIS). Content that moves automatically for more than 5 s is checked
  for a way to pause or stop it (WCAG 2.2.2).
- **Canvas, WebGL, Lottie.** No DOM explains these, so pixels and motion vectors carry the analysis, and
  deterministic mode makes them frame-exact. Lottie and GSAP timelines are read from their globals when
  they're present.
- **Audio.** Optionally, headful Chromium under Xvfb with a PulseAudio null sink, recorded by ffmpeg.
  That answers whether sound autoplays, what's said (a transcript), and how loud it is. People hear
  pages too.

### 3.10 A model of the human watching

To judge a page "as a human would", the measurements are read against what's known about people:

- **Response-time limits.** About 0.1 s feels instant, about 1 s keeps the flow of thought, about 10 s
  loses attention (Card et al. 1991; Nielsen 1993). For each interaction, feedback latency is measured
  from the input to the first painted frame that shows a change.
- **Readable dwell.** Auto-advancing slides and timed text are checked against reading speed. Adults
  silently read non-fiction at about 238 words per minute (Brysbaert 2019). Example: "slide 2 shows 41
  words for 4.0 s; a typical reader needs about 10 s."
- **Motion captures attention.** The share of motion energy around the call to action is compared with
  everywhere else. Example: "for the first 5 s, the looping background video has 6x the motion energy of
  anything else on screen."
- **Blank exposure.** Area times duration of placeholder or unpainted content inside the viewport, put in
  human terms: "a gray box half the size of the screen, for 0.6 s."
- **Predicted gaze.** An optional UI-saliency model, trained on eye-tracking data such as UEyes (CHI 2023)
  and extended with motion onset, predicts a likely fixation path over the recording. It's always
  labeled a prediction, never an observation.
- **Persona viewers.** One recording is read for several people: a fast flick-scroller, a slow reader, a
  reduced-motion user, someone zoomed to 200%, someone on a mid-range Android phone over 4G.

### 3.11 Taste in motion

The expert brief already asks for live exemplars, and Chronoscope makes their motion comparable. It
records 3-5 exemplar sites with the same profile, extracts each one's motion signature, and compares
them numerically. A signature covers durations, easing families, stagger, distances, how much moves at
once, total entrance time, and scroll-linked effects. Example: "your entrance choreography runs 2.4 s
with 14 simultaneous animations; the exemplars average 0.9 s with 3-5." Signatures are saved in
playbooks (e.g. `agency-portfolio-motion.md`), so the knowledge compounds.

---

## 4. What the AI experiences

**"How does my homepage load on a phone?"** The AI runs
`session start --url URL --profile phone-4g --record-load`. The first result holds a transcript (first
paint, font swap, hero arrival, shifts, when the headline became readable, when the page settled), a
10-frame storyboard, a settle map, and a visual-progress curve. The AI sees the 0.8 s black hero box in
frames 46-71 and the font-swap shift in frame 41, and reports exactly that. It can then
`freeze at=1.34s` and inspect the reflowed headline.

**"Does the scroll feel broken?"** The AI runs `watch scroll bottom fresh=1 twin=1`. It gets the
transcript, the header's slit-scan (wobbling from 6.2 s), a Gantt of the reveal animations, and blank
exposure per section. It replays with a candidate fix, and the twin storyboard shows the jitter gone and
the cards now revealing before they reach mid-screen.

**"Is the hero video working?"** The AI runs `watch media 1 seconds=20`. It gets a video storyboard with
shot boundaries and a transcript, and the headline's contrast over every frame (down to 2.1:1 for
1.7 s). The flash check passes. The video autoplays muted with no pause control, and its motion energy
dominates the call to action.

---

## 5. Command sketch

```
session start --url URL --profile phone-4g [--record-load] [--sentinel]
session do watch load | scroll [bottom|to Y] | idle 10s | hover N | tap N | media N [seconds=20]
                 [fresh=1] [twin=1] [mode=touch|wheel] [speed=900] [budget=6] [deterministic=1]
session do look REGION|N t=A-B [fps=30] [scale=2]
session do ask "what moved between 1.0 and 2.0s?"
session do frame 1.25s | diff 1.20s 1.25s
session do freeze at=1.25s | step +1f | slowmo 0.1 | resume
session do replay [css-file=fix.css] [vary=reducedMotion | speed=500,1500 | network=4g,fiber]
session do wait-for settle | change region=hero | event=dialog,media-ended [max=30s]
bridge.py watch --follow                     # tail a live session's chunks
job spec: "watch": { "load": true, "scroll": "bottom", "idle": 10, "media": true, "profile": "phone-4g" }
```

Each recording writes these files (`out/NNNN/watch/`):

- `watch.md`, the transcript and event table (read this first)
- `timeline.jsonl`, the ledger
- `storyboard.jpg`
- the other encodings: `trails-*.jpg`, `slitscan-*.png`, `settle.jpg`, `heat.jpg`, `gantt.png`,
  `curves-*.png`
- `frames.pack`, every frame of the recording
- `watch.mp4` and `watch.vtt`, so a person can watch the recording with the transcript as captions
  (Playwright 1.59 added a screencast API with action annotations; the engine pins 1.63)
- `replay.json`, the inputs, HAR, and seeds needed to re-run the recording exactly

---

## 6. Making it reliable

"Reliable" has to be measured, not claimed.

- **An eye chart.** A suite of synthetic test pages with known ground truth:
  - a box moving 200 px in 300 ms with ease-out
  - a 4 Hz flicker
  - a banner that pushes content down 120 px at 1.2 s
  - a lazy image painted 800 ms after it enters view
  - a header that jitters 2 px
  - scroll-jacking
  - a carousel that auto-advances every 5 s
  - a video with one bright frame at 3.2 s
  - a WebGL spinner

  Every engine change runs the suite in CI, and each detector has to recover the true parameters within
  tolerance (duration within 1 frame, distance within 2 px, the right easing family). Precision and
  recall are published in the repo.
- **Three witnesses.** The ledger (what the page declared), the pixels (what was painted), and,
  optionally, a model (what it looks like). When they agree, confidence goes up. When they disagree,
  that's a finding in itself. The ledger can report an animation the pixels never show (off screen,
  opacity 0, covered). Or pixels can move with no DOM cause (canvas, video, WebGL).
- **Coverage, stated.** Every recording reports its frame coverage, its mode (real time or
  deterministic), its profile, and what it didn't capture.
- **Provenance on every line** (measured, pixel, or model), and frame references for every event.
- **Golden recordings.** Deterministic replays of saved HARs serve as regression tests for the
  perception code itself.

---

## 7. Build plan

| Phase | Scope | Main changes |
|---|---|---|
| 0. Foundations (days) | One clock; screencast timestamps; coverage report; frames picked by event; one pack file per recording; analysis on the runner (Python, numpy, and OpenCV there); `synthesizeScrollGesture`; recording from before navigation; profiles (CPU, network, reduced motion) | Split livescroll out of `session.mjs` into `engine/watch/` (`retina.mjs`, `ledger.mjs`); move `perceive.py motion` to `engine/cortex/`; `bridge.py` fetches one pack |
| 1. Watch reports | `watch load/scroll/idle/hover/tap`; the ledger (Animation domain, LoAF, shifts, mutations, intersections, network, fonts, top layer); the transcript; storyboard, chronophotograph, slit-scan, settle map, Gantt, and curves; eye chart v1 in CI | `engine/watch/*`, `engine/cortex/*`, `test/eyechart/*`, an eye-chart workflow, docs |
| 2. Time machine | HAR replay, clock control, Animation control, freeze/step/slowmo/scrub, inspect on a frozen moment, replay with injection, twin runs, deterministic BeginFrame capture | `engine/watch/timemachine.mjs`, new session actions |
| 3. Media | Video storyboard (ffmpeg, scene detection, Whisper, OCR), contrast of text over video, flash analysis, reduced-motion diff, carousel dwell, optional audio | `engine/cortex/media.py` |
| 4. Live | Sentinel and "while you were away"; `wait-for`; `watch --follow` over git chunks; an optional relay and co-watch page with pointing; an optional streaming-model co-watcher (using the user's own API key, stored as an Actions secret) | `engine/watch/sentinel.mjs`, `relay/` (a Worker), client |
| 5. Human model | Gaze prediction, competition for attention, persona viewers, motion signatures and motion playbooks | `engine/cortex/human.py`, playbooks |

Phases 0 and 1 on their own change the experience from "the AI looks at 24 thumbnails" to "the AI reads
what happened, when, and why, with the frames to prove it."

---

## 8. Limits and boundaries

- **Not a real device.** Headless rendering on runner CPUs takes software GPU paths, so real-time frame
  timing is only indicative. Deterministic mode shows design intent, not device performance. Safari's
  scroll anchoring and 120 Hz phones behave differently from emulation. When a question needs higher
  fidelity, the next steps up are WebKit on macOS runners, then real-device clouds that record video.
- **Deterministic time changes behavior** that depends on real timing, and some sites break under fake
  clocks. That's why twin runs exist, and why every result states its mode.
- **Protected and third-party media.** DRM video doesn't play in headless Chromium and shouldn't be
  captured. Third-party players are observed, not downloaded. Recordings stay private and get pruned.
- **Cost.** Deterministic capture is slower than real time, with hundreds of frames for every few
  seconds of motion, so Actions minutes and storage go up. Budgets and pruning are part of the design.
- **Same rules as today.** Public pages only, writes blocked, no evading bot protection, considerate
  traffic, and Actions used to test one's own sites.

---

## 9. Further out

- **Learn what a person would notice.** Train a small model on eye-chart recordings plus human labels of
  which events people notice and dislike.
- **Motion embeddings**, to compare a site's overall "feel" with exemplars beyond hand-picked features.
- **Event-camera-style sparse change streams** as the native format between runner and AI, to cut cost
  further.
- **Watching together**: the AI and the person watch in real time, each pointing at what they see.

---

## Sources

- CDP `HeadlessExperimental.beginFrame`: https://chromedevtools.github.io/devtools-protocol/tot/HeadlessExperimental/
- Deterministic HTML-to-video capture in headless shell: https://www.heygen.com/research/html-to-video ;
  `puppeteer-capture`: https://cdn.jsdelivr.net/npm/puppeteer-capture@1.58.0/README.md
- Playwright 1.59 screencast API (verify signatures in the official docs): https://newreleases.io/project/npm/playwright/release/1.59.0
- Gemini video sampling (1 fps default) and agentic video understanding (Sept 2026):
  https://ai.google.dev/gemini-api/docs/video-understanding ; https://www.fonearena.com/blog/491156/google-gemini-agentic-video-understanding.html
- Cloudflare Browser Run Live View and session recordings (April 2026): https://developers.cloudflare.com/browser-run/features/live-view/ ;
  https://developers.cloudflare.com/changelog/post/2026-04-15-br-observability/
- Abrams, R. A., & Christ, S. E. (2003). Motion onset captures attention. *Psychological Science*, 14(5).
- Brysbaert, M. (2019). How many words do we read per minute? *Journal of Memory and Language*, 109.
- Card, S. K., Robertson, G. G., & Mackinlay, J. D. (1991). The information visualizer. *CHI '91*; Nielsen, J. (1993). *Usability Engineering*.
- Jiang, Y., et al. (2023). UEyes: Understanding visual saliency across user interface types. *CHI '23*.
- WCAG 2.2: 2.2.2 Pause, Stop, Hide; 2.3.1 Three Flashes or Below Threshold; 2.3.3 Animation from Interactions.
