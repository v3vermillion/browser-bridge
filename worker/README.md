# see: browser-bridge behind one link

Lets any AI chat that can open links use browser-bridge with no setup in the chat: no token, no Python, no
downloads. You paste one link; the AI opens it and gets back what a real browser saw.

```
https://see.<your-subdomain>.workers.dev/<ACCESS_KEY>/https://www.apple.com/airpods-pro/
```

Example prompt: *"Open this link and follow it to the results, then tell me how the page animates:
https://see.…/<key>/https://www.apple.com/airpods-pro/"*

## What happens

1. The link answers at once. A Cloudflare Worker starts a live browser-bridge session on GitHub Actions
   (`.github/workflows/session.yml`, Google Chrome by default so videos play) and queues a report:
   - the page load as a first visit
   - what's on screen, with numbered elements
   - 4 seconds holding still
   - a scroll from top to bottom
2. The page links to the results. Chat browsing tools give up on slow pages (ChatGPT's gave up before
   10 seconds in testing), so every page answers within about 4 seconds. While the browser works, each
   results page shows what's done so far and links to the next check.
3. Results are text the AI can read (animation settings, load timings, layout shifts, notes) plus links to
   images it can open: filmstrips of the frames where the picture changed, screenshots, and a contact sheet
   of the scroll.
4. Follow-up actions are links too: hover, tap, or inspect a numbered element, watch longer, scroll again,
   record the load on 4G or with reduced motion.

The browser closes after 5 idle minutes. Opening the same start link within 10 minutes shows the same job
instead of starting another one.

## Options (before the address, comma-separated)

```
…/<key>/mobile,4g,reduced/https://example.org/
```

| Option | Meaning |
|---|---|
| `desktop` (default), `laptop`, `tablet`, `mobile`, `iphone`, `android` | Screen to emulate |
| `chrome` (default), `chromium`, `safari`, `firefox` | Browser. `chrome` plays H.264/MP4 video; Playwright's Chromium can't |
| `4g`, `3g` | Throttle the page-load recording (Chromium-based browsers) |
| `reduced` | Also record the load with `prefers-reduced-motion: reduce` |
| `load`, `still`, `scroll` | Run only these steps (default: all three) |
| `hover=Text`, `tap=Text`, `click=Text` | Also record what that does |
| `new` | Start a fresh run instead of reusing one from the last 10 minutes |

## Setup (once)

1. **Deploy the Worker** (`worker/see.js`) to Cloudflare as `see`, e.g. `npx wrangler deploy` from this
   folder (see `wrangler.toml`), or paste `see.js` into a new Worker in the dashboard.
2. **Set two secrets** on the Worker (Cloudflare dashboard: Workers & Pages -> see -> Settings -> Variables
   and Secrets, type "Secret"):
   - `ACCESS_KEY`: any long random string. It is the only key; anyone with a link containing it can use the
     tool (and your Actions minutes). Change it to revoke all links.
   - `GH_TOKEN`: a fine-grained GitHub token for this repo only, with **Actions: Read and write** and
     **Contents: Read and write**. It stays in Cloudflare and never appears in a chat.
3. Variables (already in `wrangler.toml`): `REPO` (owner/name), `REF` (branch with the workflows, `main`),
   `HOLD_MS` (how long a results page waits for progress before answering, default 4000).

Cost: the Worker fits Cloudflare's free plan. The browser runs on GitHub Actions: free on public repos, about
2-4 minutes per report otherwise (sessions close after 5 idle minutes).

## Privacy and safety

- Results are stored on `bs-see-*` branches of the repo. In a public repo they are public; the Worker deletes
  its own branches older than 6 hours when new jobs start.
- Session inputs (the target address and options) are visible in the repo's Actions tab.
- Write requests from the visited page are blocked, as in every browser-bridge session.
- Public pages only; no logins.

## Tests

`node worker/test.mjs` runs the Worker against a fake GitHub API (routing, link parsing, job reuse, polling,
actions, image proxy, cleanup, error pages). It runs in CI with the engine self-test.
