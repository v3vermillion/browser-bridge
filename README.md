# browser-bridge

**Real eyes and hands on live websites for AI assistants working in a chat, plus the frame of reference
to critique what they see like a team of experts would.**

browser-bridge runs a real browser on GitHub Actions and lets an AI drive it from its code sandbox:
capture pages, swipe and tap through them like a person on a phone, inspect exact styles, preview design
changes live on the real page, and bring back screenshots it can actually look at, along with measured
data and a structured, evidence-based way to judge them.

It is not an MCP server or a hosted service. It's a small, self-hosted toolkit (two GitHub workflows, a
Node capture engine, and two Python scripts) that works anywhere an AI can run Python and reach GitHub's API.

---

## Why it exists

Ask an AI in a typical chat to "look at this website and tell me what a top design team would change,"
and it hits a series of walls:

- **Its sandbox usually can't reach the website** (network allowlists).
- **Scraping tools can take screenshots, but return links the AI can't open.**
- **Text-based browser agents describe pages in words, and can describe things that aren't there.** In the
  audit that led to this project, one such tool got 16 of 32 checkable claims about a site wrong, several
  of them invented details.
- **Even with a screenshot, feedback tends to be generic:** "add more whitespace," not what an accessibility
  specialist, a brand designer, and a fundraising lead would each actually say about *this* site.

browser-bridge routes around the first three through GitHub, which these sandboxes can typically reach,
and addresses the fourth with a working method (the expert brief) built into how the AI is told to operate.

## What it does

| | |
|---|---|
| **Quick look** | One screenshot plus page text and metadata. Measured: ~75 seconds end to end. |
| **Batch capture** | Many pages × desktop/tablet/phone × Chromium/WebKit (Safari engine)/Firefox in one run: full pages, readable tiles, and measurements (headings, SEO tags, structured data, links, image sharpness and alt text, rendered fonts/colors/sizes, form label wiring, axe-core accessibility scan, accessibility tree, optional link checks and Lighthouse). |
| **Live session** | A browser stays open and the AI acts in it: tap, swipe (real touch events in Chromium), scroll, type, hover, zoom, inspect an element's exact typography/contrast/tap-target size, record scroll frames, and inject CSS or HTML to preview proposed changes on the real page. Each response includes a screenshot and a numbered map of what's tappable on screen. Measured: ~70 s to start, ~5-6 s per round trip; several actions can share one round trip. |
| **Perception** | `perceive.py` measures on the pixels what people describe in words ("bland," "doesn't blend," "cluttered"): palette, hue relationships, colorfulness (Hasler & Süsstrunk 2003 scale), tonal range, abrupt section seams vs smooth fades, visual density. Also builds before/after composites. |
| **Expert brief** | Before critiquing, the AI captures the user's direction, profiles the site's genre, assembles the expert panel that genre calls for, gathers current standards, research, and live exemplars, and writes criteria. Every finding must cite a criterion, a source, and what was seen; anything else is labeled opinion. Every run requires `--brief FILE` or an explicit `--no-brief "reason"`. |
| **Safe by default** | Form submissions and other write requests are blocked and logged, so forms can be tested without sending anything to the site owner. |

```
AI's code sandbox                                   GitHub Actions
  bridge.py run / session  --(GitHub API)-->   real browser (Playwright)
        ^                                           |
        |                                screenshots + measurements
        +-----(GitHub API: fetch only what's needed)--+   (results / session branches)
```

## Measured performance

From the first live tests on GitHub-hosted runners (October 2026; one site, small sample, so treat as indicative):

| Operation | Time |
|---|---|
| Quick look (dispatch -> screenshot downloaded) | 75 s |
| Live session start (phone emulation, first screen + element map) | 70 s |
| Live session round trip, one action | 5-6.4 s |
| Live session round trip, two actions batched | 5.0 s |

Browser installs are cached between runs, so later starts may be faster; Safari-engine and Firefox runs
install extra browsers and take longer.

## When to use it, and when not to

**Good fit:**
- You're working in a regular AI chat (including on a phone) and need the AI to genuinely see and use a site.
- Design, UX, content, and accessibility reviews where evidence matters: claims tied to screenshots and measurements.
- Iterating on a redesign: preview changes on the real page, compare before/after, keep the evidence in git.

**Better alternatives exist when:**
- You're in Claude Code or Claude Desktop with a local browser tool (e.g. Playwright MCP) or Claude in Chrome:
  those are interactive in real time with no round trip. browser-bridge is for when those aren't available.
- You only need page text: a normal web fetch or scraping tool is faster.
- You need logged-in areas, physical-device testing, or real visitor analytics: out of scope.

**Terms:** GitHub's Actions terms permit using Actions to develop and test your own applications, which is
this tool's natural use (your site, its references, its redesign). Don't run it as a bulk scraping service
or offer it as a commercial service built on Actions.

## Requirements

- A GitHub account and a repository containing these files (private recommended: results are stored in it).
- An AI assistant that can **run Python and reach `api.github.com`** from its sandbox (and ideally
  `raw.githubusercontent.com` or `github.com` to download the client). If the AI's environment has a
  network allowlist, these domains must be on it.
- A fine-grained GitHub token for that repo (below).

## Setup (about 10 minutes, once)

1. **Put these files in a repo you own**: copy, fork, or upload them. Keep it private unless you're sure
   you want captured screenshots public.
2. **Allow Actions**: repo Settings -> Actions -> General. If a run's "Publish results" step fails with a
   permission error, set "Workflow permissions" to "Read and write" on that page.
3. **Create a fine-grained token** at https://github.com/settings/personal-access-tokens:
   - Repository access: only this repo.
   - Permissions: **Actions: Read and write** and **Contents: Read and write**. Add **Workflows: Read and
     write** only if you want an AI to update the repo's own code.
   - A short expiry. Tokens can be edited later without changing their value.
4. **Check it** (from any terminal, or let the AI do it):
   ```bash
   export GH_TOKEN=...  BRIDGE_REPO=you/browser-bridge
   python3 client/bridge.py check
   python3 client/bridge.py run --url https://example.org --preset glance --no-brief "setup test"
   ```

## Using it in a chat

Start the conversation with something like:

> I have a browser-bridge repo at `OWNER/REPO`. Read its `AGENTS.md` first (via the GitHub API or
> raw.githubusercontent.com), then use `client/bridge.py`. For any critique, follow `docs/expert-brief.md`.
> My token: `...`. Task: ...

The AI should then download the client, run `check`, decide how much to capture, write a brief when the
task is evaluative, look, measure, and report findings tied to evidence, including before/after images
for proposed changes.

## Safety and privacy

- **Tokens**: anything pasted into a chat stays in that chat's history. Limit the token to this repo, keep
  the expiry short, and revoke it when you're done.
- **Job inputs and session settings are visible** in the repo's Actions tab. Never put secrets in them.
- **Write requests are blocked by default.** Turning that off makes form submissions real.
- **Public pages only**: no logins by design.
- Be a considerate visitor: reviews, not load testing or mass scraping.

## Costs

- Private repos use GitHub Actions minutes (GitHub Free includes 2,000/month): roughly 1-5 minutes per
  batch run; a live session uses minutes while open (it auto-closes when idle, 60 minutes max).
  Public repos: Actions minutes are free.
- Storage: results older than 30 days are pruned automatically (repo variable `BRIDGE_KEEP_DAYS`). The
  **maintenance** workflow can wipe results (`reset-results`) or delete leftover session branches
  (`clean-sessions`).

## Limitations

- Phone captures emulate devices (size, touch, user agent): close to, not identical with, real hardware.
  Real touch swipes work in Chromium; WebKit and Firefox approximate swipes with scrolling.
- Live sessions are fast, not instant: seconds per round trip, not milliseconds.
- Styles can change with scroll position, hover, and "current section" states; inspections include a
  same-moment image of the element so values and pictures match.
- Some sites block datacenter traffic or show CAPTCHAs to automated browsers.
- Very tall full-page screenshots are scaled down when viewed; tiles, zoom, and element captures keep detail.
- The expert brief raises the floor and consistency of feedback; it doesn't replace human taste or user
  research. Automated checks (axe, Lighthouse, perceive.py) are evidence, not verdicts.

## Repo layout

```
AGENTS.md / CLAUDE.md            operating guide for AI assistants (start here if you're an AI)
docs/expert-brief.md             the expert layer: panel, references, rubric, evidence contract
docs/sessions.md                 live session actions
docs/job-spec.md                 batch job options, step actions, output files
templates/                       brief and findings templates
playbooks/                       shared, reusable expert knowledge, written during audits
examples/                        ready-to-edit batch jobs
client/bridge.py                 dependency-free client: check, run, fetch, session, playbook
client/perceive.py               visual measurements and before/after composites (numpy, Pillow)
engine/capture.mjs               batch capture engine (Node, Playwright, axe-core)
engine/session.mjs               live session runner
engine/plan.mjs, prune.mjs       browser install planning, result pruning
.github/workflows/capture.yml    batch runs -> `results` branch
.github/workflows/session.yml    live sessions -> `bs-<id>-cmd` / `bs-<id>-out` branches
.github/workflows/maintenance.yml  housekeeping
```

MIT licensed.
