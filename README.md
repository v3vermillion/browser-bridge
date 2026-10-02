# browser-bridge

Give an AI assistant real eyes and hands on live websites from inside a chat, and the frame of
reference to critique them like a team of experts would.

Many AI chat sandboxes can't reach arbitrary websites, can't open screenshot links that scraping tools
return, and get only text from "browser agent" tools (which can describe things that aren't there).
browser-bridge closes that gap with something most sandboxes *can* reach: GitHub.

```
AI in a chat  --(GitHub API: run this job)-->  GitHub Actions runs a real browser
      ^                                                   |
      |                                         screenshots + page data
      +------(GitHub API: download files)-------  committed to `results` branch
```

Three ways to look, chosen per request:

- **Quick look / batch capture**: the AI writes a JSON job (pages, devices, browsers, how much detail),
  triggers the workflow, and a few minutes later downloads only the screenshots and data it needs.
- **Live session**: a browser stays open and the AI drives it like a person: swipe, tap, scroll, open
  menus, zoom into details, and try design changes live on the real page, with a screenshot back in
  seconds after each action.

Around those, two layers make the feedback professional rather than generic:

- **Perception** (`client/perceive.py`): measures what people describe ("bland", "doesn't blend",
  "cluttered") on the actual pixels: palette, harmony, colorfulness, tonal range, section seams vs
  smooth fades, visual density; plus before/after composites.
- **The expert brief** (`docs/expert-brief.md`): before looking, the AI assembles the right expert panel
  for the site's genre and the question, gathers current standards, research, and live exemplars, and
  writes criteria. Every finding must cite a criterion, a source, and what it saw. Playbooks save that
  research for reuse across projects.

## What a run can produce

- Screenshots: full page, screen-sized tiles for detail, single elements, states after clicks or typing,
  animation frames, keyboard focus walk-throughs. Desktop, tablet, and phone sizes. Chromium, WebKit
  (Safari engine), and Firefox.
- Measurements: visible text, headings, SEO/meta/social tags, structured data, every link and where it
  goes, image alt text and real-vs-displayed resolution, fonts/colors/sizes actually rendered, form
  fields and label wiring, accessibility scan (axe-core), accessibility tree, network and JS errors,
  optional link status checks and Lighthouse scores.
- Safety by default: form submissions and other write requests are blocked and logged, so forms can be
  tested without sending anything.

How much it captures is up to the job, from a single glance to a deep audit. See `docs/job-spec.md`.

## One-time setup (about 10 minutes)

1. **Create a repo** with these files (or "Use this template" if this repo is a template). Private is
   recommended, since results (screenshots of whatever you capture) are stored in it.
2. **Make sure Actions is enabled**: repo Settings -> Actions -> General -> allow actions. If the first run's
   "Publish results" step fails with a permission error, set Workflow permissions to "Read and write" on
   that same page.
3. **Create a fine-grained token**: GitHub -> Settings -> Developer settings -> Personal access tokens ->
   Fine-grained tokens -> Generate.
   - Repository access: *Only select repositories* -> this repo.
   - Permissions: **Actions: Read and write** (to start runs and sessions) and **Contents: Read and write**
     (to download results, send live-session commands, and save playbooks). Batch captures alone only
     need Contents: Read-only.
   - Only if you want an AI to also update this repo's code: add Workflows: Read and write.
   - Expiration: as short as is practical for you. You can always make a new one.
4. **Test it** (optional, from any terminal):
   ```bash
   export GH_TOKEN=...; export BRIDGE_REPO=you/browser-bridge
   python3 client/bridge.py check
   python3 client/bridge.py run --url https://example.org --preset glance --no-brief "setup test"
   ```

## Using it in a chat

Paste something like this at the start of a conversation (fill in the repo; give the token separately
when the assistant asks, or in the same message if you're comfortable with it being in the chat history):

> I have a browser-bridge repo at `OWNER/REPO` that lets you capture and view live websites through
> GitHub Actions. Read `AGENTS.md` in that repo first (fetch it from raw.githubusercontent.com or via the
> GitHub API), then use `client/bridge.py`. Here's my token: `...`. Task: ...

The assistant should then: download the client, run `check`, choose a capture size that fits the task,
run it, read `summary.md`, and pull only the screenshots/data it needs.

## Costs

- Public repos: GitHub Actions is free.
- Private repos: uses Actions minutes (GitHub Free includes 2,000/month). A batch run takes 1-5 minutes;
  a live session uses minutes for as long as it's open (auto-closes when idle, 60 minutes max).
- Storage: results older than 30 days are pruned automatically (change with a repo variable
  `BRIDGE_KEEP_DAYS`). The **maintenance** workflow can wipe results (`reset-results`) or delete old
  live-session branches (`clean-sessions`).

## Safety and privacy

- **Tokens**: anything pasted into a chat stays in that chat's history. Use a token limited to this one repo,
  with a short expiry, and revoke it when you're done.
- **Job inputs are visible** in the repo's Actions tab. Never put passwords or secrets in a job.
- **Write requests are blocked by default** (`blockWrites`). Turning that off makes form submissions real.
- **Public pages only**: logging into accounts is out of scope by design.
- Be a considerate visitor: this is for reviewing sites, not load testing or scraping at volume.

## Limitations

- Phone captures emulate devices (size, touch, user agent); they're close to, not the same as, real hardware.
  Real touch swipes work in Chromium; WebKit and Firefox approximate swipes with scrolling.
- Live sessions are fast, not instant: expect a few seconds per action over GitHub.
- The expert brief raises the floor and consistency of feedback; it doesn't replace human taste or real
  user research.
- Some sites block datacenter traffic or show CAPTCHAs to automated browsers.
- Very tall full-page screenshots get scaled down when an AI views them; tiles and element screenshots
  keep detail readable.
- Automated accessibility checks and Lighthouse cover part of what matters; they inform judgment, not replace it.

## Repo layout

```
AGENTS.md / CLAUDE.md          operating guide for AI assistants
README.md                      this file
docs/expert-brief.md           the expert layer: panel, references, rubric, evidence contract
docs/sessions.md               live session actions
docs/job-spec.md               batch job options, step actions, output files
templates/                     brief and findings templates
playbooks/                     shared, reusable expert knowledge (written during audits)
examples/                      ready-to-edit batch jobs
client/bridge.py               dependency-free client: check, run, fetch, session, playbook
client/perceive.py             visual measurements and before/after composites (numpy, Pillow)
engine/capture.mjs             batch capture engine (Node + Playwright + axe-core)
engine/session.mjs             live session runner
engine/plan.mjs, prune.mjs     install planning and result pruning
.github/workflows/capture.yml  batch runs -> `results` branch
.github/workflows/session.yml  live sessions -> `bs-<id>-cmd` / `bs-<id>-out` branches
.github/workflows/maintenance.yml  housekeeping
```
