# browser-bridge: guide for AI agents

You're probably here because a user wants you to see, use, or professionally critique a live website, and
your own tools can't (sandboxes often block websites; screenshot links from scraping tools can't be
opened; text-only browser agents can describe things that aren't there). This repo gives you a real
browser through GitHub Actions, plus tools to judge what you see like an expert would.

It describes judgment, not a checklist. Adapt to what the user actually needs.

## What you get

**Three ways to look** (pick the lightest that answers the question):

| Mode | Use it for | Speed |
|---|---|---|
| Quick look: `run --url URL --preset glance --no-brief "quick look"` | What a page says / roughly looks like | ~75 s measured |
| Batch capture: `run job.json --brief brief.md` | Broad coverage: many pages x devices x browsers, plus measurements | a few minutes, more with WebKit/Firefox/Lighthouse |
| Live session: `session start --brief brief.md` / `session do ...` | Exploring and interacting like a person: swipe, tap, open menus, zoom, inspect exact styles, try design changes live | ~70 s to start, ~5-6 s per round trip (measured); batch several actions into one round trip |

**Measurements**, as much as the request needs (quick looks include text and page metadata; `standard`
and `deep` batch presets add the rest): headings, SEO/meta, structured data, links and where they go,
image alt text and sharpness, fonts/colors/sizes actually rendered, form wiring, accessibility scan
(axe-core), accessibility tree, network/JS errors, Lighthouse. In sessions: `analyze` for the page and
`inspect N` for one element's exact typography, contrast ratio, and tap-target size.

**Perception** (`client/perceive.py`): turns what people say about visuals into measurements on the
pixels (palette, color harmony, colorfulness, tonal range, section seams vs smooth fades, visual density)
and makes before/after composites. Use it to check impressions, not to replace them.

**The brief is a required choice.** Every `run` and `session start` takes either `--brief FILE` (saved
with the results) or `--no-brief "reason"`. Skipping is allowed, but it's always a stated decision.

**The expert brief** (`docs/expert-brief.md`): how to put the right experts' knowledge in front of
yourself *before* you look, so critiques come from current standards, research, and the best comparable
sites, not from generic instincts. **Read that file before any design, UX, content, or accessibility
critique.** It's the difference between "looks fine, maybe add more spacing" and an audit a professional
would sign.

## Decide what the request needs

- Plain facts or wording: a normal web fetch may suffice; if yours works, use it. No brief needed.
- Anything about how it looks or behaves: use the bridge.
- Anything evaluative ("critique", "audit", "make it premium", "what would a top agency change"):
  run the expert brief at the depth the request deserves, then look.
- The user's own words about what they see ("bland", "doesn't blend", "cluttered") are direction:
  record them, translate them into professional terms and checks, and test them (expert-brief.md, step 1).

## Setup in your sandbox

You need the user's token and repo name (`owner/name`). Never print the token back, never save it to
memory or persistent notes, and never put it in a job file, session setting, or command argument (those
can show up in the Actions UI). Store it once in the file the client reads automatically:

```bash
mkdir -p ~/.config/browser-bridge && (umask 077; printf '%s' 'TOKEN_FROM_USER' > ~/.config/browser-bridge/token)
export GH_TOKEN="$(cat ~/.config/browser-bridge/token)" BRIDGE_REPO='OWNER/REPO'
curl -fsSL -H "Authorization: Bearer $GH_TOKEN" \
  https://raw.githubusercontent.com/OWNER/REPO/main/client/bridge.py -o bridge.py      # private repo
curl -fsSL -H "Authorization: Bearer $GH_TOKEN" \
  https://raw.githubusercontent.com/OWNER/REPO/main/client/perceive.py -o perceive.py   # optional
pip install numpy pillow 2>/dev/null   # for perceive.py, if missing
python3 bridge.py check
```
(Public repo: drop the auth header. If raw.githubusercontent.com is blocked, the contents API works:
`curl -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github.raw" https://api.github.com/repos/OWNER/REPO/contents/client/bridge.py`.)

If `check` fails, its message says why. Tell the user plainly what to fix.

## A professional audit, end to end (adapt freely)

1. **Brief** at the right depth (docs/expert-brief.md): direction -> context -> panel -> floor and
   ceiling references (capture exemplars with the bridge) -> rubric. Load a playbook if one fits.
2. **Look**: batch capture for coverage; a live session to explore and interact where it matters
   (mobile menu, carousels, forms, hover states, scroll effects).
3. **Measure** what's measurable: extractors, `analyze`, `inspect N` (exact type, contrast, tap size,
   with a same-moment image), `perceive.py`, zoom crops.
4. **Findings** that meet the evidence contract (what / evidence / criterion / source / lens /
   severity / confidence / fix). Opinions labeled as opinions.
5. **Show, don't just tell**: for proposed visual changes, preview them on the real page (`inject` +
   screenshot) or render a mockup at real device sizes (`render`), and pair before/after with
   `perceive.py compare`. Share the images with the user.
6. **Challenge pass**, then **keep what you learned** (playbook for reusable knowledge; the project's
   taste/decisions file for what this user decided).

## Reading results efficiently

- Batch runs: read `summary.md` first; download only what you need with `fetch LABEL --include GLOB`
  (`'*/tiles/*'` for readable detail, `'*/forms.json'`, `'*/a11y.json'`, `'*/styles.json'`, ...).
- Sessions: each action returns a screenshot (and `observe` returns a numbered element map). Look at
  the images before making visual claims.
- Styles can change with scroll position, hover, and "current section" states. Compare an inspection with
  its `element.jpg`, not with a screenshot taken at a different moment.
- "JS errors" caused by the write-blocking itself are filtered out and counted separately; the blocked
  requests (often analytics and video embeds) are grouped by site in `summary.md`.
- Very tall full-page images get scaled down when viewed; use tiles, `zoom`, or element screenshots for
  fine detail. `detail: 2` (default in sessions) keeps zoom crops sharp.

## Safety and respect

- Write requests are blocked by default: forms can be filled and "submitted" without sending anything.
  Only turn that off if the user explicitly wants a real submission and understands it reaches the site owner.
- Public pages only; no credentials in jobs or commands.
- Be a considerate visitor: no tight loops, no load testing. Close sessions when done (`session end`).
- GitHub's terms allow Actions for developing and testing your own applications; that's this tool's
  natural use (the user's site, its references, its redesign). Don't turn it into a bulk scraping service.

## Honesty about what you saw

- Separate what you **saw**, what was **measured**, and what you **infer**.
- When code and screenshot disagree, say so and investigate.
- If a capture failed or a section didn't render, report it; don't fill gaps from assumptions.
- Automated checks (axe, Lighthouse, perceive.py) are partial evidence, not verdicts.
- If you shortened or skipped the brief, say so in one line.

## Troubleshooting

| Symptom | Likely cause / what to do |
|---|---|
| `HTTP 401` | Token wrong or expired. Ask for a new one. |
| `HTTP 403` | Token missing a permission (Actions: write; Contents: write for sessions/playbooks), or a rate limit. |
| `HTTP 404` on check | Repo name wrong, token not granted this repo, or workflow file missing on the default branch. Note: GitHub answers **404, not 403**, when a fine-grained token lacks a permission or repo access, so check the token's repository list and permissions before concluding the repo is missing. |
| Push refused: "Write access to repository not granted" | Token lacks Contents (and, for workflow files, Workflows) write on this repo. Tokens can be edited at github.com/settings/personal-access-tokens without changing their value. |
| `HTTP 422` on run/session | Actions disabled, or the workflow isn't on the branch used. |
| Session never becomes ready | The client reports a failed session run with its link within ~15 s; otherwise check the repo's Actions tab (workflow "session") for a slow browser install or an unreachable URL. Unused sessions close themselves after the idle timeout. |
| "Element N is not in the current map" | The page changed; `observe` again and use the new numbers. |
| Variant `status: error` in a batch run | Read `summary.md`; `error-state.jpg` shows what the browser saw. |
| Page looks half-empty | Content appears on scroll or after a delay: `scroll`/`frames` in a session, or raise `waitMs`. |
| Bot protection / CAPTCHA | Datacenter IPs are sometimes blocked. Report it; don't try to evade it. |

## Reference

- `docs/expert-brief.md` - the expert layer (read before critiques)
- `docs/sessions.md` - live session actions
- `docs/job-spec.md` - batch job options and outputs
- `templates/` - brief and findings templates; `playbooks/` - shared expert knowledge
- `examples/` - ready-to-edit batch jobs
