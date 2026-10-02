#!/usr/bin/env python3
"""browser-bridge client: run capture jobs on GitHub Actions and pull back the results.

Standard library only (works in locked-down sandboxes that can reach api.github.com).

Configuration (flags override env):
  --repo / BRIDGE_REPO          owner/name of your browser-bridge repo
  --token-file, or env GH_TOKEN / GITHUB_TOKEN / BRIDGE_TOKEN,
      or ~/.config/browser-bridge/token
  BRIDGE_WORKFLOW               workflow file name (default capture.yml)
  BRIDGE_API                    API base (default https://api.github.com)

Commands:
  check                         verify token, repo access, and workflow
  run JOB|--url URL [...]       dispatch a capture, wait, download summary
  status LABEL                  show the run's state
  fetch LABEL [--include GLOB]  download result files (default: summaries only)
  list                          list result labels on the results branch
  session start --url URL       open a live browser (see docs/sessions.md)
  session do ACTION [ARGS]      act in the live browser and get a screenshot back
                                several at once: session do "tap 4" "swipe left" "zoom 7"
  session end                   close the live browser
  playbook list|get|put         shared expert briefs (see docs/expert-brief.md)

Examples:
  python3 bridge.py check
  python3 bridge.py run --url https://example.org --preset glance --no-brief "quick look"
  python3 bridge.py run job.json --label myaudit-001 --brief brief.md
  python3 bridge.py fetch myaudit-001 --include "*/chromium-desktop/full.jpg" --include "*/forms.json"
  python3 bridge.py fetch myaudit-001 --all
  python3 bridge.py session start --url https://example.org --device mobile --brief brief.md
  python3 bridge.py session do swipe up
  python3 bridge.py session do tap 7
"""
import argparse
import base64
import datetime as dt
import fnmatch
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

API = os.environ.get("BRIDGE_API", "https://api.github.com").rstrip("/")
WORKFLOW = os.environ.get("BRIDGE_WORKFLOW", "capture.yml")
RESULTS_BRANCH = "results"
LABEL_RE = re.compile(r"^[A-Za-z0-9._-]{1,80}$")


class BridgeError(Exception):
    pass


# --------------------------------------------------------------------------- config
def load_token(args):
    if args.token_file:
        return open(os.path.expanduser(args.token_file)).read().strip()
    for var in ("GH_TOKEN", "GITHUB_TOKEN", "BRIDGE_TOKEN"):
        if os.environ.get(var):
            return os.environ[var].strip()
    default = os.path.expanduser("~/.config/browser-bridge/token")
    if os.path.exists(default):
        return open(default).read().strip()
    raise BridgeError(
        "No token found. Set GH_TOKEN, or write it to ~/.config/browser-bridge/token, or pass --token-file."
    )


def load_repo(args):
    repo = args.repo or os.environ.get("BRIDGE_REPO")
    if not repo or not re.match(r"^[\w.-]+/[\w.-]+$", repo):
        raise BridgeError("Repo not set. Pass --repo owner/name or set BRIDGE_REPO.")
    return repo


# --------------------------------------------------------------------------- http
HINTS = {
    401: "Token rejected (expired, revoked, or mistyped).",
    403: "Forbidden. The token may lack a permission (needs Actions: write and Contents: read on this repo), "
         "or you hit a rate limit.",
    404: "Not found. Check the repo name, that the token has access to this repo, and that "
         ".github/workflows/capture.yml exists on the default branch.",
    422: "GitHub rejected the request. Usually: the workflow file is missing on that branch, "
         "or Actions is disabled for the repo.",
}


def request(token, method, path, body=None, accept="application/vnd.github+json", raw=False):
    url = path if path.startswith("http") else f"{API}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Accept", accept)
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    req.add_header("User-Agent", "browser-bridge-client")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                payload = resp.read()
                if raw:
                    return payload
                return json.loads(payload) if payload else {}
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")[:300]
            if e.code in (502, 503, 504) and attempt < 2:
                time.sleep(3 * (attempt + 1))
                continue
            raise BridgeError(f"HTTP {e.code} on {method} {path}. {HINTS.get(e.code, '')} GitHub said: {detail}")
        except urllib.error.URLError as e:
            if attempt < 2:
                time.sleep(3)
                continue
            raise BridgeError(f"Network error reaching {url}: {e.reason}. Is api.github.com reachable from here?")


# --------------------------------------------------------------------------- operations
def default_branch(token, repo):
    return request(token, "GET", f"/repos/{repo}").get("default_branch", "main")


def find_run(token, repo, label, since, wait_s=120):
    deadline = time.time() + wait_s
    while time.time() < deadline:
        runs = request(token, "GET", f"/repos/{repo}/actions/workflows/{WORKFLOW}/runs?event=workflow_dispatch&per_page=30")
        for r in runs.get("workflow_runs", []):
            created = dt.datetime.fromisoformat(r["created_at"].replace("Z", "+00:00"))
            if r.get("display_title") == label and created >= since - dt.timedelta(minutes=2):
                return r
        time.sleep(5)
    raise BridgeError(f"Dispatched, but no run titled '{label}' appeared within {wait_s}s. Check the repo's Actions tab.")


def latest_run_for_label(token, repo, label):
    runs = request(token, "GET", f"/repos/{repo}/actions/workflows/{WORKFLOW}/runs?event=workflow_dispatch&per_page=50")
    for r in runs.get("workflow_runs", []):
        if r.get("display_title") == label:
            return r
    return None


def wait_for(token, repo, run, timeout_s):
    start = time.time()
    last_note = 0
    while True:
        run = request(token, "GET", f"/repos/{repo}/actions/runs/{run['id']}")
        if run["status"] == "completed":
            return run
        elapsed = time.time() - start
        if elapsed - last_note >= 30:
            print(f"  ...{run['status']} ({int(elapsed)}s)", flush=True)
            last_note = elapsed
        if elapsed > timeout_s:
            raise BridgeError(f"Still running after {timeout_s}s. Check later with: status {run['display_title']}  ({run['html_url']})")
        time.sleep(8)


def result_files(token, repo, label):
    try:
        tree = request(token, "GET", f"/repos/{repo}/git/trees/{RESULTS_BRANCH}?recursive=1")
    except BridgeError as e:
        if "HTTP 404" in str(e) or "HTTP 409" in str(e):
            raise BridgeError("No results branch yet. It is created by the first completed capture run.")
        raise
    prefix = f"results/{label}/"
    files = [(t["path"][len(prefix):], t.get("size", 0)) for t in tree.get("tree", []) if t["type"] == "blob" and t["path"].startswith(prefix)]
    if tree.get("truncated"):
        print("  note: file listing was truncated by GitHub; consider running maintenance reset-results.", file=sys.stderr)
    return files


def download(token, repo, label, rel_paths, out_dir):
    saved = []
    for rel in rel_paths:
        quoted = urllib.parse.quote(f"results/{label}/{rel}")
        data = request(token, "GET", f"/repos/{repo}/contents/{quoted}?ref={RESULTS_BRANCH}", accept="application/vnd.github.raw", raw=True)
        dest = os.path.join(out_dir, rel)
        os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
        with open(dest, "wb") as fh:
            fh.write(data)
        saved.append(dest)
    return saved


def select(files, includes, take_all):
    if take_all:
        return [f for f, _ in files]
    patterns = includes or ["summary.md", "manifest.json"]
    return [f for f, _ in files if any(fnmatch.fnmatch(f, p) for p in patterns)]


# --------------------------------------------------------------------------- commands
def cmd_check(token, repo, args):
    info = request(token, "GET", f"/repos/{repo}")
    print(f"repo: {info['full_name']} (private={info['private']}, default branch={info['default_branch']})")
    perms = info.get("permissions")
    if perms:
        print(f"token permissions on repo: {perms}")
    wf = request(token, "GET", f"/repos/{repo}/actions/workflows/{WORKFLOW}")
    print(f"workflow: {wf['name']} ({wf['state']})")
    try:
        request(token, "GET", f"/repos/{repo}/branches/{RESULTS_BRANCH}")
        print("results branch: present")
    except BridgeError:
        print("results branch: not yet created (appears after the first run)")
    print("OK - ready to run captures.")


def build_job(args):
    if args.url:
        job = {"url": args.url, "preset": args.preset or "standard"}
        if args.devices:
            job["devices"] = args.devices.split(",")
        if args.browsers:
            job["browsers"] = args.browsers.split(",")
        return job
    if not args.job:
        raise BridgeError("Give a job file/JSON or --url.")
    text = sys.stdin.read() if args.job == "-" else (args.job if args.job.strip().startswith("{") else open(args.job).read())
    job = json.loads(text)
    if args.preset:
        job["preset"] = args.preset
    return job


def load_brief(args):
    """Every run/session states its brief: a file, or an explicit reason for going without one."""
    if getattr(args, "brief", None):
        return open(args.brief).read()
    if getattr(args, "no_brief", None):
        return None
    raise BridgeError('State the brief: --brief FILE (see docs/expert-brief.md), or --no-brief "reason" '
                      '(e.g. --no-brief "quick look at wording"). Critiques should use a brief.')


def cmd_run(token, repo, args):
    job = build_job(args)
    brief = load_brief(args)
    if brief:
        job["brief"] = brief
    elif args.no_brief:
        job["notes"] = (job.get("notes") + " | " if job.get("notes") else "") + f"No brief: {args.no_brief}"
    label = args.label or f"run-{dt.datetime.now(dt.timezone.utc).strftime('%Y%m%d-%H%M%S')}"
    if not LABEL_RE.match(label):
        raise BridgeError("Label may only contain letters, numbers, dot, dash, underscore (max 80).")
    job_json = json.dumps(job, separators=(",", ":"))
    if len(job_json) > 60000:
        raise BridgeError("Job JSON is too large for a workflow input; split it into smaller jobs.")
    ref = args.ref or default_branch(token, repo)
    since = dt.datetime.now(dt.timezone.utc)
    resp = request(token, "POST", f"/repos/{repo}/actions/workflows/{WORKFLOW}/dispatches",
                   body={"ref": ref, "inputs": {"label": label, "job": job_json}})
    print(f"dispatched: {label}")
    run = None
    if isinstance(resp, dict) and resp.get("workflow_run_id"):
        run = request(token, "GET", f"/repos/{repo}/actions/runs/{resp['workflow_run_id']}")
    if args.no_wait:
        print(f"not waiting. Later: python3 bridge.py status {label}  /  fetch {label}")
        return
    run = run or find_run(token, repo, label, since)
    print(f"run: {run['html_url']}")
    run = wait_for(token, repo, run, args.timeout)
    print(f"finished: {run['conclusion']}")
    fetch_and_report(token, repo, label, args)


def fetch_and_report(token, repo, label, args):
    out_dir = os.path.join(args.out, label)
    try:
        files = result_files(token, repo, label)
    except BridgeError as e:
        print(f"no results to fetch: {e}")
        return
    if not files:
        print("No result files for this label (the run may have failed before publishing). Check the run page.")
        return
    chosen = select(files, args.include, args.all)
    saved = download(token, repo, label, chosen, out_dir)
    summary = os.path.join(out_dir, "summary.md")
    if os.path.exists(summary) and not args.include and not args.all:
        print("\n" + open(summary).read())
    total = sum(s for _, s in files)
    print(f"\ndownloaded {len(saved)} of {len(files)} files ({total // 1024} KB available) to {out_dir}")
    for p in saved:
        print(f"  {p}")
    if not args.all and len(saved) < len(files):
        print("more: fetch LABEL --include '<glob>' (e.g. '*/full.jpg', '*/tiles/*', '*/forms.json') or --all")


def cmd_fetch(token, repo, args):
    fetch_and_report(token, repo, args.label, args)


def cmd_status(token, repo, args):
    run = latest_run_for_label(token, repo, args.label)
    if not run:
        print(f"No run titled '{args.label}' found.")
        return
    print(f"{args.label}: {run['status']} / {run['conclusion']}  {run['html_url']}")


def cmd_list(token, repo, args):
    try:
        items = request(token, "GET", f"/repos/{repo}/contents/results?ref={RESULTS_BRANCH}")
    except BridgeError:
        print("No results yet.")
        return
    labels = sorted(i["name"] for i in items if i["type"] == "dir")
    print("\n".join(labels) if labels else "No results yet.")


# --------------------------------------------------------------------------- live sessions
SESSION_FILE = ".bridge-session.json"
SESSION_WORKFLOW = os.environ.get("BRIDGE_SESSION_WORKFLOW", "session.yml")


def ref_sha(token, repo, branch):
    try:
        return request(token, "GET", f"/repos/{repo}/git/ref/heads/{branch}")["object"]["sha"]
    except BridgeError as e:
        if "HTTP 404" in str(e):
            return None
        raise


def get_raw(token, repo, path, ref):
    try:
        return request(token, "GET", f"/repos/{repo}/contents/{urllib.parse.quote(path)}?ref={urllib.parse.quote(ref)}",
                       accept="application/vnd.github.raw", raw=True)
    except BridgeError as e:
        if "HTTP 404" in str(e):
            return None
        raise


def put_file(token, repo, path, content_bytes, branch, message, sha=None):
    body = {"message": message, "content": base64.b64encode(content_bytes).decode(), "branch": branch}
    if sha:
        body["sha"] = sha
    return request(token, "PUT", f"/repos/{repo}/contents/{urllib.parse.quote(path)}", body=body)


def load_session():
    if not os.path.exists(SESSION_FILE):
        raise BridgeError("No active session here. Start one: session start --url URL")
    return json.load(open(SESSION_FILE))


def save_session(st):
    json.dump(st, open(SESSION_FILE, "w"), indent=2)


def print_result(res, saved):
    if res.get("action") == "batch":
        print(f"[{res['seq']}] batch: {res['steps']} of {res['of']} steps run, {'all ok' if res['ok'] else 'stopped at a failure'}")
        for sub in res["results"]:
            print_result(sub, [p for p in saved if f"/{str(sub['seq']).split('.')[-1]}/" in p.replace(os.sep, "/")])
        return
    state = "ok" if res.get("ok") else f"ERROR: {res.get('error')}"
    print(f"[{res.get('seq')}] {res.get('action')} {state} ({res.get('ms')}ms)")
    if res.get("url"):
        print(f"  page: {res.get('title') or ''} | {res['url']}")
        print(f"  view: {res.get('device')} {res.get('viewport')} scrollY {res.get('scrollY')} of {res.get('pageHeight')}px")
    if res.get("horizontalOverflow"):
        print(f"  layout issue: page is {res['horizontalOverflow']}px wider than the screen (sideways scrolling on this device)")
    if res.get("method") == "wheel-fallback":
        print("  note: this browser can't inject real touch; swipe was approximated with scrolling")
    if res.get("applied") is not None:
        print(f"  injected changes applied: {res['applied']}")
    if res.get("blockedWrites"):
        print(f"  write requests blocked so far (nothing sent): {res['blockedWrites']}")
    ins = res.get("inspect")
    if ins:
        f = ins["font"]
        print(f"  element: <{ins['tag']}> {ins['text'][:60]!r} box {ins['box']['w']}x{ins['box']['h']} at y={ins['box']['y']}")
        print(f"  type: {f['family'].split(',')[0]} {f['size']} weight {f['weight']}, line-height {f['lineHeight']}, letter-spacing {f['letterSpacing']}, {f['transform']}")
        print(f"  color {ins['color']} on {ins['background']}")
        c = ins.get("contrast")
        if c:
            print(f"  contrast {c['ratio']}:1 -> WCAG AA {'pass' if c['wcagAA'] else 'FAIL'}, AAA {'pass' if c['wcagAAA'] else 'fail'} ({'large' if c['largeText'] else 'normal'} text)")
        t = ins["tapTarget"]
        print(f"  tap target {t['w']}x{t['h']}px -> WCAG 2.2 24px minimum {'met' if t['meetsWcag22Min24px'] else 'NOT met'}")
        print(f"  spacing: padding {ins['spacing']['padding']}, margin {ins['spacing']['margin']}; radius {ins['shape']['borderRadius']}")
    if "value" in res:
        print(f"  value: {json.dumps(res['value'])[:500]}")
    els = res.get("elements")
    if els:
        print(f"  elements on screen ({len(els)}; use the number to act, e.g. 'tap 3'):")
        for e in els:
            kind = e.get("role") or (e["tag"] if e["tag"] != "input" else f"input:{e.get('type') or 'text'}")
            extra = " [covered]" if e.get("covered") else ""
            href = f" -> {e['href']}" if e.get("href") and not str(e["href"]).startswith("javascript") else ""
            print(f"   {e['ref']:>3} {kind:<12} {e['name'][:50]!r}{href}{extra}")
    for p in saved:
        print(f"  file: {p}")


def wait_result(token, repo, st, seq, timeout_s=120):
    out_branch = f"bs-{st['id']}-out"
    seq_dir = f"out/{seq:04d}"
    deadline = time.time() + timeout_s
    last = None
    while time.time() < deadline:
        sha = ref_sha(token, repo, out_branch)
        if sha and sha != last:
            last = sha
            raw = get_raw(token, repo, f"{seq_dir}/result.json", sha)
            if raw:
                res = json.loads(raw)
                local = os.path.join(st["out"], f"{seq:04d}")
                os.makedirs(local, exist_ok=True)
                saved = []
                wanted = res.get("files", [])
                for sub in res.get("results", []):
                    k = str(sub["seq"]).split(".")[-1]
                    wanted += [f"{k}/{f}" for f in sub.get("files", [])]
                for f in wanted:
                    data = get_raw(token, repo, f"{seq_dir}/{f}", sha)
                    if data is not None:
                        dest = os.path.join(local, f)
                        os.makedirs(os.path.dirname(dest), exist_ok=True)
                        open(dest, "wb").write(data)
                        saved.append(dest)
                json.dump(res, open(os.path.join(local, "result.json"), "w"), indent=2)
                return res, saved
            status = get_raw(token, repo, "status.json", sha)
            if status and json.loads(status).get("state") in ("ended", "failed"):
                s = json.loads(status)
                raise BridgeError(f"Session is {s['state']} ({s.get('reason') or s.get('error')}). Start a new one.")
        time.sleep(1.2)
    raise BridgeError(f"No result for step {seq} within {timeout_s}s. Check: session status")


def parse_action(tokens, args):
    """Shorthand: 'tap 7', 'swipe left', 'scroll 600', 'type 4 hello', 'goto https://...'."""
    if args.json:
        return json.loads(args.json)
    if not tokens:
        raise BridgeError("Give an action, e.g. observe | tap 3 | swipe up | scroll 600 | zoom 5 | goto URL")
    a, rest = tokens[0], tokens[1:]
    cmd = {"action": a}

    def target(tok):
        return {"ref": int(tok)} if tok.isdigit() else {"text": tok}
    if a in ("click", "tap", "hover", "zoom", "inspect") and rest:
        cmd.update(target(" ".join(rest) if not rest[0].isdigit() else rest[0]))
    elif a in ("type", "fill"):
        if len(rest) < 2:
            raise BridgeError("type needs a target and text: type 4 hello@example.org")
        cmd.update(target(rest[0]))
        cmd["value"] = " ".join(rest[1:])
        cmd["submit"] = bool(args.submit)
    elif a == "scroll" and rest:
        cmd.update({"to": rest[0]} if rest[0] in ("top", "bottom") else ({"dy": int(rest[0])} if rest[0].lstrip("-").isdigit() else target(" ".join(rest))))
    elif a == "swipe":
        cmd["direction"] = rest[0] if rest else "up"
        if len(rest) > 1:
            cmd.update(target(rest[1]))
    elif a == "goto" and rest:
        cmd["url"] = rest[0]
    elif a == "press" and rest:
        cmd["key"] = rest[0]
    elif a == "device" and rest:
        cmd["name"] = " ".join(rest)
    elif a == "frames" and rest:
        cmd["count"] = int(rest[0])
    elif a == "wait" and rest:
        cmd["ms"] = int(rest[0])
    elif a == "analyze":
        cmd["what"] = rest[0].split(",") if rest else ["meta", "styles", "images"]
    if a == "inject" and args.css_file:
        cmd["css"] = open(args.css_file).read()
    if a == "inject" and args.css:
        cmd["css"] = args.css
    if a == "render" and args.html_file:
        cmd["html"] = open(args.html_file).read()
    if args.no_shot:
        cmd["shot"] = False
    return cmd


def cmd_session(token, repo, args):
    if args.session_cmd == "start":
        brief = load_brief(args)  # decide before creating anything
        sid = args.id or f"s{dt.datetime.now(dt.timezone.utc).strftime('%m%d%H%M%S')}"
        if not re.match(r"^[A-Za-z0-9._-]{1,60}$", sid):
            raise BridgeError("Session id may only contain letters, numbers, dot, dash, underscore.")
        ref = args.ref or default_branch(token, repo)
        base = ref_sha(token, repo, ref)
        cmd_branch = f"bs-{sid}-cmd"
        if not ref_sha(token, repo, cmd_branch):
            request(token, "POST", f"/repos/{repo}/git/refs", body={"ref": f"refs/heads/{cmd_branch}", "sha": base})
        if brief:
            put_file(token, repo, "brief.md", brief.encode(), cmd_branch, "session brief")
        config = {"url": args.url, "device": args.device, "browser": args.browser, "detail": args.detail,
                  "maxMinutes": args.minutes, "idleMinutes": args.idle}
        if args.hide:
            config["hide"] = args.hide
        request(token, "POST", f"/repos/{repo}/actions/workflows/{SESSION_WORKFLOW}/dispatches",
                body={"ref": ref, "inputs": {"id": sid, "config": json.dumps(config)}})
        st = {"id": sid, "repo": repo, "seq": 0, "out": os.path.join(args.out, sid), "startedAt": time.time(),
              "brief": "attached" if brief else f"none ({args.no_brief})"}
        save_session(st)
        print(f"starting live session {sid} ({args.browser}/{args.device}); brief: {st['brief']}. First start takes about a minute...")
        out_branch = f"bs-{sid}-out"
        deadline = time.time() + args.timeout
        last_run_check = time.time()
        while time.time() < deadline:
            if time.time() - last_run_check > 15:  # surface a crashed run immediately instead of waiting out the timeout
                last_run_check = time.time()
                try:
                    runs = request(token, "GET", f"/repos/{repo}/actions/workflows/{SESSION_WORKFLOW}/runs?event=workflow_dispatch&per_page=10")
                    run = next((r for r in runs.get("workflow_runs", []) if r.get("display_title") == sid), None)
                    if run and run["status"] == "completed" and run["conclusion"] != "success":
                        raise BridgeError(f"The session run ended ({run['conclusion']}) before it was ready. Details: {run['html_url']}")
                except BridgeError as e:
                    if "session run ended" in str(e):
                        raise
            sha = ref_sha(token, repo, out_branch)
            if sha:
                raw = get_raw(token, repo, "status.json", sha)
                state = json.loads(raw)["state"] if raw else "starting"
                if state == "ready":
                    break
                if state == "failed":
                    raise BridgeError(f"Session failed to start: {json.loads(raw).get('error')}")
            time.sleep(3)
        else:
            raise BridgeError(f"Not ready after {args.timeout}s. Check the repo's Actions tab (workflow: session).")
        res, saved = wait_result(token, repo, st, 0)
        print_result(res, saved)
        return

    st = load_session()
    if args.session_cmd == "status":
        sha = ref_sha(token, repo, f"bs-{st['id']}-out")
        raw = get_raw(token, repo, "status.json", sha) if sha else None
        print(json.dumps(json.loads(raw), indent=2) if raw else "No status yet (still starting?).")
        return
    if args.session_cmd == "end":
        args.tokens, args.json = ["end"], None
    tokens = args.tokens if args.session_cmd == "do" else ["end"]
    if args.session_cmd == "do" and not args.json and (";" in tokens or any(" " in t for t in tokens)):
        groups, cur = [], []
        if ";" in tokens:  # do tap 4 ; swipe left
            for t in tokens + [";"]:
                if t == ";":
                    if cur:
                        groups.append(cur)
                    cur = []
                else:
                    cur.append(t)
        else:              # do "tap 4" "swipe left"
            groups = [t.split() for t in tokens]
        cmd = {"actions": [parse_action(g, args) for g in groups]}
        cmd["action"] = "batch"
    else:
        cmd = parse_action(tokens, args)
    st["seq"] += 1
    seq = st["seq"]
    save_session(st)
    put_file(token, repo, f"cmd/{seq:04d}.json", json.dumps(cmd).encode(), f"bs-{st['id']}-cmd", f"cmd {seq}: {cmd['action']}")
    res, saved = wait_result(token, repo, st, seq, timeout_s=args.timeout)
    print_result(res, saved)
    if args.session_cmd == "end":
        if args.cleanup:
            # Wait for the runner's final "ended" status push, or it would recreate the branch after we delete it.
            deadline = time.time() + 30
            while time.time() < deadline:
                sha = ref_sha(token, repo, f"bs-{st['id']}-out")
                raw = get_raw(token, repo, "status.json", sha) if sha else None
                if not raw or json.loads(raw).get("state") in ("ended", "failed"):
                    break
                time.sleep(1.5)
            for b in (f"bs-{st['id']}-cmd", f"bs-{st['id']}-out"):
                try:
                    request(token, "DELETE", f"/repos/{repo}/git/refs/heads/{b}")
                except BridgeError:
                    pass
            print("session branches deleted")
        os.remove(SESSION_FILE)
        print("session closed")


# --------------------------------------------------------------------------- playbooks
def cmd_playbook(token, repo, args):
    ref = default_branch(token, repo)
    if args.pb_cmd == "list":
        try:
            items = request(token, "GET", f"/repos/{repo}/contents/playbooks?ref={ref}")
        except BridgeError:
            print("No playbooks yet.")
            return
        names = sorted(i["name"][:-3] for i in items if i["name"].endswith(".md") and i["name"] != "README.md")
        print("\n".join(names) if names else "No playbooks yet.")
    elif args.pb_cmd == "get":
        raw = get_raw(token, repo, f"playbooks/{args.name}.md", ref)
        if raw is None:
            print(f"No playbook named '{args.name}'.")
            return
        os.makedirs("playbooks", exist_ok=True)
        open(f"playbooks/{args.name}.md", "wb").write(raw)
        print(raw.decode())
    elif args.pb_cmd == "put":
        if not re.match(r"^[a-z0-9][a-z0-9._-]{0,60}$", args.name):
            raise BridgeError("Playbook names: lowercase letters, numbers, dot, dash, underscore.")
        existing = None
        try:
            existing = request(token, "GET", f"/repos/{repo}/contents/playbooks/{args.name}.md?ref={ref}").get("sha")
        except BridgeError:
            pass
        put_file(token, repo, f"playbooks/{args.name}.md", open(args.file, "rb").read(), ref,
                 f"playbook: {args.name}", sha=existing)
        print(f"saved playbooks/{args.name}.md")


def main():
    p = argparse.ArgumentParser(description="browser-bridge client", formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__)
    p.add_argument("--repo")
    p.add_argument("--token-file")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("check")
    r = sub.add_parser("run")
    r.add_argument("job", nargs="?", help="path to job JSON, inline JSON, or - for stdin")
    r.add_argument("--url", help="quick job for a single URL")
    r.add_argument("--preset", choices=["glance", "standard", "deep"])
    r.add_argument("--devices", help="comma list, e.g. desktop,mobile (with --url)")
    r.add_argument("--browsers", help="comma list, e.g. chromium,webkit (with --url)")
    r.add_argument("--label")
    r.add_argument("--ref", help="branch holding the workflow (default: repo default branch)")
    r.add_argument("--no-wait", action="store_true")
    r.add_argument("--timeout", type=int, default=1200, help="seconds to wait (default 1200)")
    r.add_argument("--include", action="append", help="glob of result files to download after the run")
    r.add_argument("--all", action="store_true")
    r.add_argument("--out", default="bridge-results")
    r.add_argument("--brief", help="expert brief markdown file (docs/expert-brief.md); saved with the results")
    r.add_argument("--no-brief", metavar="REASON", help='run without a brief, stating why (e.g. "quick look at wording")')
    s = sub.add_parser("status")
    s.add_argument("label")
    f = sub.add_parser("fetch")
    f.add_argument("label")
    f.add_argument("--include", action="append", help="glob relative to the run folder; repeatable")
    f.add_argument("--all", action="store_true")
    f.add_argument("--out", default="bridge-results")
    sub.add_parser("list")

    se = sub.add_parser("session", help="live browser session")
    ss = se.add_subparsers(dest="session_cmd", required=True)
    st = ss.add_parser("start")
    st.add_argument("--url", required=True)
    st.add_argument("--device", default="desktop", help="desktop | laptop | tablet | mobile | android | Playwright device name")
    st.add_argument("--browser", default="chromium", choices=["chromium", "webkit", "firefox"])
    st.add_argument("--detail", type=int, default=2, help="pixel ratio for zoom crops (default 2)")
    st.add_argument("--minutes", type=int, default=30, help="max session length (cap 60)")
    st.add_argument("--idle", type=int, default=10, help="auto-close after this many idle minutes")
    st.add_argument("--hide", action="append", help="CSS selector to hide (cookie banners...)")
    st.add_argument("--id")
    st.add_argument("--ref")
    st.add_argument("--timeout", type=int, default=300)
    st.add_argument("--out", default="bridge-sessions")
    st.add_argument("--brief", help="expert brief markdown file; kept with the session's evidence")
    st.add_argument("--no-brief", metavar="REASON", help="start without a brief, stating why")
    sd = ss.add_parser("do")
    sd.add_argument("tokens", nargs="*")
    for p_ in (sd, ss.add_parser("end"), ss.add_parser("status")):
        p_.add_argument("--json")
        p_.add_argument("--css")
        p_.add_argument("--css-file")
        p_.add_argument("--html-file")
        p_.add_argument("--submit", action="store_true")
        p_.add_argument("--no-shot", action="store_true")
        p_.add_argument("--cleanup", action="store_true", help="(end) delete the session branches afterwards")
        p_.add_argument("--timeout", type=int, default=120)

    pb = sub.add_parser("playbook", help="shared expert briefs")
    pbs = pb.add_subparsers(dest="pb_cmd", required=True)
    pbs.add_parser("list")
    pg = pbs.add_parser("get")
    pg.add_argument("name")
    pp = pbs.add_parser("put")
    pp.add_argument("name")
    pp.add_argument("file")

    args = p.parse_args()
    try:
        token = load_token(args)
        repo = load_repo(args)
        {"check": cmd_check, "run": cmd_run, "status": cmd_status, "fetch": cmd_fetch, "list": cmd_list,
         "session": cmd_session, "playbook": cmd_playbook}[args.cmd](token, repo, args)
    except BridgeError as e:
        print(f"error: {e}", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        sys.exit(130)
    except BrokenPipeError:  # output piped into head/grep that closed early
        sys.stderr.close()
        sys.exit(0)


if __name__ == "__main__":
    main()
