# Job spec reference

A job is a JSON object. Only a URL is required; everything else has defaults.

```json
{ "url": "https://example.org" }
```

## Top-level fields

| Field | Type | Default | Meaning |
|---|---|---|---|
| `url` / `urls` / `targets` | string / string[] / object[] | (required) | Pages to capture. Up to 20 per job. Targets can be objects (below). |
| `preset` | `glance` \| `standard` \| `deep` | `standard` | Starting set of capture options. |
| `devices` | string[] or objects | glance: `["desktop"]`, others: `["desktop","mobile"]` | Screen sizes to emulate. |
| `browsers` | string[] | `["chromium"]` | `chromium`, `webkit` (Safari engine), `firefox`. |
| `capture` | object | from preset | Overrides for capture options (below). |
| `steps` | object[] | `[]` | Interactions run on every target after the initial capture. |
| `notes` | string | - | Free text echoed into the summary (e.g. why this run exists). |
| `brief` | string (markdown) | - | The expert brief for this run; saved as `brief.md` next to the results. The client fills this from `--brief FILE`. |

Target object: `{ "url": "...", "name": "home", "capture": { ... }, "steps": [ ... ] }`
- `name` sets the results folder name (otherwise derived from the URL).
- `capture` and `steps` here apply to that target only (global `steps` run first).

## Presets

| Option | glance | standard | deep |
|---|---|---|---|
| screenshot | viewport | full | full |
| tiles | - | yes | yes |
| text, meta | yes | yes | yes |
| html, links, images, styles, forms | - | yes | yes |
| a11y (axe), aria tree, checkLinks, lighthouse | - | - | yes |
| detail (pixel ratio) | 1 | 1 | 2 |

## Capture options

| Option | Default | Notes |
|---|---|---|
| `screenshot` | per preset | `none`, `viewport` (what's visible first), `full` (entire page). |
| `tiles` | per preset | Splits the page into screen-height tiles. Best for reading detail. |
| `tileHeight` | viewport height | Pixels per tile. |
| `maxTiles` | 25 | Cap for very long pages (`facts.tiles.truncated` reports if hit). |
| `format` | `jpeg` | `png` for pixel-exact images (larger files). |
| `quality` | 80 | JPEG quality. |
| `detail` | 1 | Device pixel ratio. 2 = retina sharpness. |
| `animations` | `disabled` | Freezes CSS animations for stable captures; `allow` keeps them. |
| `waitMs` | 800 | Extra settle time after load. |
| `timeoutMs` | 45000 | Page load timeout. |
| `revealLazyContent` | true | Scrolls through the page first so lazy images and scroll-reveal sections render. |
| `hide` | [] | CSS selectors to hide (cookie banners, chat bubbles) when they block the view. |
| `blockWrites` | true | Aborts all non-GET requests and logs them. Keeps forms from sending. |
| `text` | true | Visible text to `text.md`. |
| `meta` | true | Title, description, canonical, lang, OG/Twitter tags, headings outline, JSON-LD. |
| `html` | per preset | Rendered DOM to `page.html`. |
| `links` | per preset | Every link with kind and flags (goes nowhere, generic text, missing anchor, no name). |
| `checkLinks` | per preset | Requests each http(s) link and records status (max 150). |
| `images` | per preset | `<img>` and large CSS backgrounds: alt, natural vs displayed size, broken, blurry. |
| `styles` | per preset | Font families, sizes, weights, text/background colors actually rendered, weighted by text volume. |
| `forms` | per preset | Fields, required flags, label wiring, labels pointing to missing ids, submit destination. |
| `a11y` | per preset | axe-core WCAG 2.1 A/AA + best-practice scan, summarized. |
| `aria` | per preset | Accessibility tree as YAML (what assistive tech receives). |
| `lighthouse` | per preset | Performance / accessibility / best practices / SEO scores (chromium only, once per target per form factor). |

## Devices

Named: `desktop` (1440x900), `laptop` (1280x800), `tablet` (iPad Mini), `mobile` / `iphone` (iPhone 15),
`android` (Pixel 7). Any Playwright device name also works (e.g. `"iPhone 13"`, `"Pixel 5"`).
Custom: `{ "name": "wide", "width": 1920, "height": 1080 }` (add `"isMobile": true, "hasTouch": true` for phones).
Firefox ignores mobile emulation flags (Playwright limitation); viewport size still applies.

## Steps

Every step has `action`; most accept `selector` (CSS or Playwright selector) or `text` (visible text match).
Optional fields on any step: `optional` (fail fast, 3s, without noise), `timeoutMs`, `waitMs` (pause after).

| action | fields | does |
|---|---|---|
| `click` | selector / text | Clicks an element. |
| `hover` | selector / text | Hovers (for hover states, dropdowns). |
| `fill` | selector, value | Types into a field. |
| `select` | selector, value | Chooses a dropdown option. |
| `check` | selector | Ticks a checkbox / radio. |
| `press` | key, selector? | Presses a key (`Enter`, `Escape`, `Tab`...). |
| `scroll` | to (`top`/`bottom`/px) or selector | Scrolls. |
| `wait` | ms or selector | Waits. |
| `screenshot` | name, fullPage?, selector? | Captures the viewport, full page, or one element. |
| `burst` | name, count (max 20), intervalMs | Several frames in a row, animations running. |
| `tabWalk` | count (max 60), screenshots (default true) | Presses Tab repeatedly; records focused element and whether a focus indicator is visible. |
| `goto` | url | Navigates elsewhere (then continues). |
| `setViewport` | width, height | Resizes mid-run (e.g. to test a breakpoint). |
| `evaluate` | script | Runs JavaScript in the page; the return value is saved in `steps.json`. |

## Output layout

```
results/<label>/
  summary.md                  read first: every variant, counts, flags, file list
  manifest.json               machine-readable index (status, files, byte sizes, normalized job)
  run.log                     engine console output
  <target>/<browser>-<device>/
    summary.md
    full.jpg | viewport.jpg   page screenshot
    tiles/tile-NN.jpg         screen-height slices
    text.md  meta.json  page.html  links.json  images.json  styles.json  forms.json
    a11y.json  aria.yaml  lighthouse.json
    steps/NN-name.jpg  steps.json
    network.json              HTTP errors, failed requests, JS errors, blocked writes
    error-state.jpg           only if the page failed to load
```

## Examples

See `examples/` for ready-to-edit jobs.
