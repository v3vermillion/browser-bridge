// browser-bridge "see": one link that lets any AI chat use a real browser (Cloudflare Worker).
//
// Paste a link like this into a chat with an AI that can browse:
//   https://<worker>/<ACCESS_KEY>/https://example.org/
//   https://<worker>/<ACCESS_KEY>/mobile,4g/https://example.org/        (options before the address)
//
// The Worker starts a live browser-bridge session on GitHub Actions (the repo's session.yml), queues a report
// (page load, what's on screen, holding still, scrolling), and answers at once with a page linking to the
// results. Chat browsing tools give up on slow pages (well under 10 seconds), so every page here answers within
// a few seconds; while the browser works, each results page links to the next check. Results are text the AI
// can read plus links to the images (filmstrips, screenshots) it can open and look at. Follow-up actions
// (hover, tap, inspect, zoom, watch longer, scroll) are links too.
//
// Secrets: ACCESS_KEY (the key in the path), GH_TOKEN (fine-grained token on REPO: Actions and Contents read/write).
// Vars: REPO (owner/name), REF (branch holding the workflows; default main), HOLD_MS (how long a results page may
// wait for progress before answering; default 4000), GH_API (default https://api.github.com).

const BUCKET_MS = 10 * 60 * 1000;   // the same start link within 10 minutes reuses the same job
const KEEP_MS = 6 * 60 * 60 * 1000; // job branches older than this are deleted when new jobs start
const IDLE_MINUTES = 5;             // the live browser closes after this long without a new action
const DEVICES = ['desktop', 'laptop', 'tablet', 'mobile', 'iphone', 'android'];
const BROWSERS = { chrome: 'chrome', chromium: 'chromium', webkit: 'webkit', safari: 'webkit', firefox: 'firefox' };

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (e) {
      return page('Something went wrong', `<p>The tool hit an error: ${esc(String(e.message || e))}</p>`, 500);
    }
  },
};

// ------------------------------------------------------------------------------------------------ routing
async function route(request, env, ctx) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Only GET', { status: 405 });
  const url = new URL(request.url);
  const key = env.ACCESS_KEY || '';
  const parts = url.pathname.split('/');   // ['', key, ...]
  if (!key || parts[1] !== key) return new Response('Not found', { status: 404 });
  const base = `${url.origin}/${key}`;
  const rest = url.pathname.slice(key.length + 2);   // everything after "/<key>/"
  if (!rest) return page('browser-bridge', helpHtml(base));
  const [kind, id, ...more] = rest.split('/');
  if (kind === 'j' && validId(id)) return jobPage(env, base, id, Number(more[0]) || 1);
  if (kind === 'a' && validId(id)) return actionPage(env, base, id, more);
  if (kind === 'f' && validId(id)) return fileProxy(env, id, more.join('/'));
  const start = parseStart(rest + url.search);
  if (start.error) return page('browser-bridge', `<p>${esc(start.error)}</p>${helpHtml(base)}`, 400);
  return startJob(env, ctx, base, start);
}

const validId = (id) => /^see-[a-z0-9]{4,12}-[a-f0-9]{6,12}$/.test(id || '');

// "/mobile,4g/https://site.com/page?x=1" -> options + target. Everything from the address on (including its
// query string) belongs to the site; options come before it.
export function parseStart(rest) {
  let opts = '', target = rest;
  const scheme = /^https?:\/\/?/i;
  if (!scheme.test(target)) {
    const slash = target.indexOf('/');
    const head = slash < 0 ? target : target.slice(0, slash);
    const tail = slash < 0 ? '' : target.slice(slash + 1);
    if (scheme.test(tail) || (tail && /^[\w-]+(\.[\w-]+)+/.test(tail) && !/^[\w-]+(\.[\w-]+)+$/.test(head))) { opts = head; target = tail; }
  }
  target = target.replace(/^(https?):\/\/?/i, '$1://');
  if (!/^https?:\/\//i.test(target)) target = 'https://' + target;
  let u;
  try { u = new URL(target); } catch { return { error: `"${target}" isn't a web address.` }; }
  if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.')) return { error: `"${target}" isn't a public web address.` };
  const o = { device: 'desktop', browser: 'chrome', network: null, reduced: false, fresh: false, steps: [], triggers: [] };
  for (const raw of decodeURIComponent(opts).split(/[,+]/).map((s) => s.trim()).filter(Boolean)) {
    const [k, ...v] = raw.split('=');
    const name = k.toLowerCase(), val = v.join('=');
    if (DEVICES.includes(name)) o.device = name;
    else if (BROWSERS[name]) o.browser = BROWSERS[name];
    else if (name === '4g' || name === '3g') o.network = name;
    else if (name === 'reduced') o.reduced = true;
    else if (name === 'new') o.fresh = true;
    else if (['load', 'still', 'scroll'].includes(name)) o.steps.push(name);
    else if (['hover', 'tap', 'click'].includes(name) && val) o.triggers.push({ action: name, text: val.slice(0, 80) });
    else return { error: `Unknown option "${raw}". Options: ${[...DEVICES, ...Object.keys(BROWSERS), '4g', '3g', 'reduced', 'new', 'load', 'still', 'scroll', 'hover=Text', 'tap=Text', 'click=Text'].join(', ')}.` };
  }
  if (!o.steps.length) o.steps = ['load', 'still', 'scroll'];
  return { target: u.href, opts: o };
}

// The report, as session commands in order. Each one publishes its own result, so results appear step by step.
export function buildPlan(o) {
  const plan = [];
  const add = (label, cmd) => plan.push({ seq: plan.length + 1, label, cmd });
  if (o.steps.includes('load')) add(`Page load, first visit${o.network ? ` on ${o.network}` : ''}`, { action: 'watch', fresh: 1, ms: 6000, ...(o.network ? { network: o.network } : {}) });
  if (o.reduced) add('Page load with reduced motion', { action: 'watch', fresh: 1, ms: 6000, reduced: 1 });
  add('What is on screen (numbered)', { action: 'observe' });
  if (o.steps.includes('still')) add('Holding still for 4 seconds', { action: 'watch', ms: 4000 });
  for (const t of o.triggers) add(`${t.action} "${t.text}"`, { action: 'watch', ms: 2000, after: { action: t.action, text: t.text } });
  if (o.steps.includes('scroll')) add('Scrolling from top to bottom', { action: 'livescroll', to: 'bottom', maxFrames: 24 });
  return plan;
}

// ------------------------------------------------------------------------------------------------ GitHub
function gh(env, method, path, body, accept = 'application/vnd.github+json') {
  return fetch(`${env.GH_API || 'https://api.github.com'}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.GH_TOKEN || ''}`, Accept: accept, 'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'browser-bridge-see', ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}
async function ghJson(env, method, path, body) {
  const r = await gh(env, method, path, body);
  if (r.status === 404) return null;
  if (!r.ok) throw new GitHubError(r.status, await r.text());
  return r.status === 204 ? {} : r.json();
}
async function ghRaw(env, path, ref) {
  const r = await gh(env, 'GET', `/repos/${env.REPO}/contents/${path}?ref=${encodeURIComponent(ref)}`, null, 'application/vnd.github.raw');
  if (r.status === 404) return null;
  if (!r.ok) throw new GitHubError(r.status, await r.text());
  return r;
}
class GitHubError extends Error {
  constructor(status, text) {
    const hint = status === 401 ? "the tool's GitHub token is missing, wrong or expired"
      : status === 403 ? "the tool's GitHub token lacks a permission (needs Actions and Contents read/write), or a rate limit was hit"
      : 'GitHub returned an error';
    super(`${hint} (HTTP ${status}: ${String(text).slice(0, 160)})`);
  }
}
const refSha = async (env, branch) => (await ghJson(env, 'GET', `/repos/${env.REPO}/git/ref/heads/${branch}`))?.object?.sha || null;
const cmdBranch = (id) => `bs-${id}-cmd`;
const outBranch = (id) => `bs-${id}-out`;

// ------------------------------------------------------------------------------------------------ start
async function startJob(env, ctx, base, { target, opts }) {
  const now = Date.now();
  const bucket = Math.floor(now / BUCKET_MS);
  const digest = await sha256(`${target}|${JSON.stringify(opts)}|${opts.fresh ? crypto.randomUUID() : ''}`);
  const id = `see-${bucket.toString(36)}-${digest.slice(0, 8)}`;
  const plan = buildPlan(opts);
  const job = { id, target, opts, createdAt: new Date(now).toISOString(), plan: plan.map(({ seq, label }) => ({ seq, label })) };

  // The command branch holds the job description and the queued commands, in one commit.
  const tree = await ghJson(env, 'POST', `/repos/${env.REPO}/git/trees`, {
    tree: [
      { path: 'job.json', mode: '100644', type: 'blob', content: JSON.stringify(job, null, 2) },
      ...plan.map((p) => ({ path: `cmd/${String(p.seq).padStart(4, '0')}.json`, mode: '100644', type: 'blob', content: JSON.stringify(p.cmd) })),
    ],
  });
  const commit = await ghJson(env, 'POST', `/repos/${env.REPO}/git/commits`, { message: `see: ${target}`, tree: tree.sha, parents: [] });
  const created = await gh(env, 'POST', `/repos/${env.REPO}/git/refs`, { ref: `refs/heads/${cmdBranch(id)}`, sha: commit.sha });
  let reused = false;
  if (created.status === 422) reused = true;   // the same link was opened moments ago: same job
  else if (!created.ok) throw new GitHubError(created.status, await created.text());
  if (!reused) {
    const config = { url: target, device: opts.device, browser: opts.browser, detail: 2, idleMinutes: IDLE_MINUTES, maxMinutes: 20, prescroll: false };
    const r = await gh(env, 'POST', `/repos/${env.REPO}/actions/workflows/session.yml/dispatches`, { ref: env.REF || 'main', inputs: { id, config: JSON.stringify(config) } });
    if (!r.ok) throw new GitHubError(r.status, await r.text());
    if (ctx && ctx.waitUntil) ctx.waitUntil(cleanup(env, now).catch(() => {}));
  }
  const next = `${base}/j/${id}/1`;
  return page(`Looking at ${target}`, `
<p>A real browser (${esc(browserName(opts.browser))}, ${esc(opts.device)} view) is ${reused ? 'already' : 'now'} starting up to look at
<a href="${esc(target)}">${esc(target)}</a> for you. Starting takes about 40-80 seconds; then it records:</p>
<ol>${plan.map((p) => `<li>${esc(p.label)}</li>`).join('')}</ol>
<p>Results (open this; if it says it's still working, it links to the next check): <a href="${next}">${next}</a></p>
${aboutHtml()}`);
}

async function cleanup(env, now) {
  const refs = (await ghJson(env, 'GET', `/repos/${env.REPO}/git/matching-refs/heads/bs-see-`)) || [];
  let n = 0;
  for (const r of refs) {
    const m = r.ref.match(/^refs\/heads\/bs-see-([a-z0-9]+)-/);
    if (!m || now - parseInt(m[1], 36) * BUCKET_MS < KEEP_MS) continue;
    await gh(env, 'DELETE', `/repos/${env.REPO}/git/refs/heads/${r.ref.slice('refs/heads/'.length)}`);
    if (++n >= 20) break;
  }
}

// ------------------------------------------------------------------------------------------------ results
async function loadState(env, id) {
  const sha = await refSha(env, outBranch(id));
  if (!sha) return { sha: null, status: null };
  const raw = await ghRaw(env, 'status.json', sha);
  return { sha, status: raw ? await raw.json() : null };
}

async function jobInfo(env, id) {
  const [rawJob, listing] = await Promise.all([
    ghRaw(env, 'job.json', cmdBranch(id)),
    ghJson(env, 'GET', `/repos/${env.REPO}/contents/cmd?ref=${encodeURIComponent(cmdBranch(id))}`),
  ]);
  if (!rawJob) return null;
  const job = await rawJob.json();
  job.maxSeq = Math.max(0, ...(listing || []).map((f) => Number((f.name.match(/^(\d+)\.json$/) || [])[1]) || 0));
  return job;
}

async function jobPage(env, base, id, n, note = '') {
  const job = await jobInfo(env, id);
  if (!job) return page('Not found', '<p>No such job. Open the original link again to start a new one.</p>', 404);
  // Wait a little for progress, so fewer checks are needed, but always answer within a few seconds.
  const hold = Number(env.HOLD_MS || 4000);
  const deadline = Date.now() + hold;
  let st = await loadState(env, id);
  const working = (s) => !s.status || s.status.state === 'starting' || (s.status.state === 'ready' && s.status.lastSeq < job.maxSeq);
  while (working(st) && Date.now() + 1000 < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    const s2 = await loadState(env, id);
    const moved = s2.sha !== st.sha;
    st = s2;
    if (moved && (!st.status || st.status.lastSeq >= 0)) break;
  }
  const s = st.status;
  const results = [];
  if (st.sha && s && s.lastSeq >= 0) {
    const seqs = Array.from({ length: s.lastSeq + 1 }, (_, i) => i);
    const raws = await Promise.all(seqs.map((q) => ghRaw(env, `out/${String(q).padStart(4, '0')}/result.json`, st.sha)));
    for (const [i, raw] of raws.entries()) if (raw) results.push(await raw.json());
  }
  return page(`Browser report: ${job.target}`, renderJob({ base, id, job, st, results, n, note, failure: s ? null : await bootFailure(env, id, job) }));
}

async function bootFailure(env, id, job) {
  const age = Date.now() - Date.parse(job.createdAt);
  if (age < 120000) return null;
  const runs = await ghJson(env, 'GET', `/repos/${env.REPO}/actions/workflows/session.yml/runs?event=workflow_dispatch&per_page=30`);
  const run = (runs?.workflow_runs || []).find((r) => r.display_title === id);
  if (run && run.status === 'completed' && run.conclusion !== 'success') return `The browser run ended (${run.conclusion}) before it was ready. Details: ${run.html_url}`;
  if (!run && age > 240000) return 'The browser run never started. GitHub Actions may be disabled for the repo, or the token lacks the Actions permission.';
  return null;
}

// ------------------------------------------------------------------------------------------------ actions
const ACTIONS = {
  hover: (r) => ({ action: 'watch', ms: 2000, after: { action: 'hover', ref: r } }),
  tap: (r) => ({ action: 'watch', ms: 2000, after: { action: 'tap', ref: r } }),
  click: (r) => ({ action: 'watch', ms: 2000, after: { action: 'click', ref: r } }),
  inspect: (r) => ({ action: 'inspect', ref: r }),
  zoom: (r) => ({ action: 'zoom', ref: r }),
  still: (s) => ({ action: 'watch', ms: Math.min(Math.max(Number(s) || 4, 1), 15) * 1000 }),
  scroll: () => ({ action: 'livescroll', to: 'bottom', maxFrames: 24 }),
  top: () => ({ action: 'scroll', to: 'top' }),
  observe: () => ({ action: 'observe' }),
  load: () => ({ action: 'watch', fresh: 1, ms: 6000 }),
  load4g: () => ({ action: 'watch', fresh: 1, ms: 8000, network: '4g' }),
  reduced: () => ({ action: 'watch', fresh: 1, ms: 6000, reduced: 1 }),
  fullpage: () => ({ action: 'fullpage' }),
};
const NEEDS_REF = ['hover', 'tap', 'click', 'inspect', 'zoom'];

async function actionPage(env, base, id, [seqStr, verb, arg]) {
  const seq = Number(seqStr);
  if (!Number.isInteger(seq) || seq < 1 || !ACTIONS[verb] || (NEEDS_REF.includes(verb) && !/^\d+$/.test(arg || ''))) {
    return page('Unknown action', '<p>That action link is malformed.</p>', 400);
  }
  const job = await jobInfo(env, id);
  if (!job) return page('Not found', '<p>No such job.</p>', 404);
  const { status } = await loadState(env, id);
  if (!status || status.state !== 'ready') {
    return jobPage(env, base, id, 1, status && status.state === 'ended'
      ? 'The live browser has closed, so that action could not run. The results so far are below; open the original link with "new," before the address to start again.'
      : 'The browser is not ready yet; try the action again once it is.');
  }
  const cmd = ACTIONS[verb](NEEDS_REF.includes(verb) ? Number(arg) : arg);
  // Links carry the step number they were made for, so opening the same link twice doesn't run it twice.
  // A different action made from the same page gets the next free number.
  if (seq <= job.maxSeq) {
    const existing = await ghRaw(env, `cmd/${String(seq).padStart(4, '0')}.json`, cmdBranch(id));
    if (existing && (await existing.text()) === JSON.stringify(cmd)) return jobPage(env, base, id, 1, 'That action was already queued (this link was opened before); its result is below when ready.');
  }
  const path = `cmd/${String(job.maxSeq + 1).padStart(4, '0')}.json`;
  const r = await gh(env, 'PUT', `/repos/${env.REPO}/contents/${path}`, { message: `see: ${verb} ${arg || ''}`, content: b64(JSON.stringify(cmd)), branch: cmdBranch(id) });
  if (!r.ok && r.status !== 422) throw new GitHubError(r.status, await r.text());
  return jobPage(env, base, id, 1, `Queued as step ${job.maxSeq + 1}: ${verb}${arg ? ' ' + arg : ''}.`);
}

// ------------------------------------------------------------------------------------------------ files
async function fileProxy(env, id, path) {
  if (!/^out\/[\w./-]+\.(jpg|png|json)$/.test(path) || path.includes('..')) return new Response('Not found', { status: 404 });
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const cacheKey = new Request(`https://see.cache/${id}/${path}`);
  if (cache) { const hit = await cache.match(cacheKey); if (hit) return hit; }
  const raw = await ghRaw(env, path, outBranch(id));
  if (!raw) return new Response('Not found (yet?)', { status: 404 });
  const type = path.endsWith('.json') ? 'application/json' : path.endsWith('.png') ? 'image/png' : 'image/jpeg';
  const res = new Response(raw.body, { headers: { 'Content-Type': type, 'Cache-Control': 'public, max-age=86400', 'X-Robots-Tag': 'noindex' } });
  if (cache) await cache.put(cacheKey, res.clone());
  return res;
}

// ------------------------------------------------------------------------------------------------ rendering
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const secs = (t) => (t === null || t === undefined ? '?' : `${t < 0 ? '-' : '+'}${(Math.abs(t) / 1000).toFixed(2)}s`);
const browserName = (b) => ({ chrome: 'Google Chrome', chromium: 'Chromium', webkit: 'Safari engine (WebKit)', firefox: 'Firefox' }[b] || b);

function page(title, body, status = 200) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:60rem;margin:1.5rem auto;padding:0 1rem;color:#111}pre{white-space:pre-wrap;background:#f4f4f4;padding:.75rem;border-radius:6px;font-size:14px}h2{margin-top:2rem;border-top:1px solid #ddd;padding-top:1rem}a{word-break:break-all}</style>
</head><body><h1>${esc(title)}</h1>${body}</body></html>`;
  return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } });
}

function aboutHtml() {
  return `<h2>About these results</h2><p>browser-bridge runs a real browser on GitHub Actions. Text marked "measured" comes from the browser
itself (animation settings, timings, layout shifts); pictures are linked as images, and an image is only seen once it is opened.
Frames show only what the browser painted; motion drawn by scripts, canvas, or video is visible in frames but not in the animation lists.</p>`;
}

function helpHtml(base) {
  return `<p>Put a web address after this link to have a real browser look at it, record its motion, and report back:</p>
<pre>${esc(base)}/https://example.org/</pre>
<p>Options go before the address, separated by commas:</p>
<pre>${esc(base)}/mobile,4g,reduced/https://example.org/</pre>
<ul><li>Device: ${DEVICES.join(', ')} (default desktop)</li><li>Browser: chrome (default, plays videos), chromium, safari, firefox</li>
<li>Connection for the page load: 4g or 3g</li><li>reduced: also record the load with reduced motion</li>
<li>Steps (default all): load, still, scroll</li><li>hover=Text, tap=Text, click=Text: record what that does</li>
<li>new: start a fresh run instead of reusing one from the last 10 minutes</li></ul>${aboutHtml()}`;
}

export function describeAnimation(a) {
  const kind = { CSSTransition: 'transition', CSSAnimation: 'animation', Animation: 'Web Animation (script)' }[a.type] || a.type;
  let where = a.target || '?';
  if (a.text) where += ` "${a.text.slice(0, 30)}"`;
  const ms = (v) => (typeof v === 'number' ? `${v}ms` : String(v));
  let timing = `${ms(a.duration)} ${a.easing || ''}`.trim();
  if (a.delay) timing += `, delay ${ms(a.delay)}`;
  if (a.iterations === 'infinite') timing += ', loops';
  else if (a.iterations !== undefined && a.iterations !== null && a.iterations !== 1) timing += `, x${a.iterations}`;
  if (a.direction && a.direction !== 'normal') timing += `, ${a.direction}`;
  if (a.startedAt !== undefined && a.startedAt !== null) timing += `, starts ${secs(a.startedAt)}`;
  if (a.timeline && a.timeline !== 'DocumentTimeline') timing += `, driven by ${a.timeline}`;
  const changes = (a.changes || []).map((c) => `${c.property} ${(c.values || [c.from, c.to]).join(' -> ')}`).join('; ');
  return `${kind} ${a.name || ''} on ${where}: ${timing}${changes ? ` | ${changes}` : ''}`;
}

export function watchText(w) {
  const L = [];
  const fr = w.frames || {};
  L.push(`Recorded: ${w.what}${w.conditions?.length ? ` (${w.conditions.join(', ')})` : ''}, ${(w.realMs / 1000).toFixed(1)} s real time; t=0 is ${w.zero}.`);
  L.push(`Frames: ${fr.inWindow} recorded (${fr.source}); ${fr.picked} picked for the filmstrip.`);
  const mo = w.motion;
  L.push(mo ? `Motion: starts ${secs(mo.startsAt)}, last change ${secs(mo.endsAt)}${mo.stillMovingAtEnd ? ' (still moving at the end)' : ''}; biggest change ${secs(mo.biggestChangeAt)}.` : 'Motion: nothing on screen changed.');
  if (w.region) L.push(`The filmstrip is cropped to the area that moved: x${w.region.x} y${w.region.y} ${w.region.w}x${w.region.h} (CSS px).`);
  const ex = w.explained;
  if (ex) L.push(`Visible change: ${ex.animatedElements}% on elements in the animation list, ${ex.media}% in video/canvas/iframes/GIFs, ${ex.elsewhere}% elsewhere (script-driven styles, loading, layout).`);
  const anims = w.animations || [];
  const shown = anims.filter((a) => a.visible !== false);
  const n = w.animationCount ?? anims.length;
  L.push(`Animations the browser reported (measured): ${n}${w.onScreen !== undefined && w.onScreen !== n ? `, ${w.onScreen} on screen` : ''}${!anims.length ? ' (none: any motion here was made by scripts or media)' : ''}`);
  for (const a of shown.slice(0, 12)) L.push(`  - ${describeAnimation(a)}`);
  if (n > shown.length) L.push(`  - ... ${n - shown.length} more off screen`);
  const ld = w.load;
  if (ld) {
    const done = (t) => (t ? secs(t) : 'not reached during the recording');
    const lcp = ld.largestContentfulPaint || {};
    L.push(`Load (measured): first contentful paint ${done(ld.firstContentfulPaint)}, largest contentful paint ${done(lcp.t)}${lcp.element ? ` (${lcp.element})` : ''}, load event ${done(ld.loadEvent)}.`);
  }
  for (const f of w.webFontsLoaded || []) L.push(`Web fonts finished loading ${secs(f.t)}: ${(f.families || []).join(', ')} (text in them may reflow then).`);
  L.push(`Layout shifts: ${w.layoutShifts || 0} (total ${w.layoutShiftTotal || 0}); long tasks: ${w.longTasks || 0}.`);
  for (const note of w.notes || []) L.push(`Note: ${note}`);
  return L.join('\n');
}

function scrollText(res) {
  const mo = res.motion || {};
  const ft = mo.frameTiming || {};
  const L = [`Scrolled ${mo.mode || ''} from y ${mo.from} to ${mo.to} (reached ${mo.reachedY}); frames: ${mo.frames?.streamed} recorded, ${mo.frames?.saved} saved.`];
  if (ft.medianMs !== undefined) L.push(`Frame timing (measured): median ${ft.medianMs} ms, 95th percentile ${ft.p95Ms} ms, worst ${ft.worstMs} ms, ${ft.over50ms} frames over 50 ms (16.7 ms = 60 fps).`);
  L.push(`Layout shifts during the scroll: ${mo.layoutShifts?.count ?? 0} (total ${mo.layoutShifts?.total ?? 0}); scroll reversals (page pulled back): ${mo.scrollReversals ?? 0}; long tasks: ${mo.longTasks ?? 0}.`);
  return L.join('\n');
}

function inspectText(ins) {
  const f = ins.font || {}, c = ins.contrast, t = ins.tapTarget || {};
  return [`<${ins.tag}> "${(ins.text || '').slice(0, 60)}", ${ins.box?.w}x${ins.box?.h} px at y=${ins.box?.y}`,
    `Type: ${(f.family || '').split(',')[0]} ${f.size}, weight ${f.weight}, line height ${f.lineHeight}, letter spacing ${f.letterSpacing}`,
    `Color ${ins.color} on ${ins.background}${c ? `; contrast ${c.ratio}:1 (WCAG AA ${c.wcagAA ? 'pass' : 'FAIL'}, ${c.largeText ? 'large' : 'normal'} text)` : ''}`,
    `Tap target ${t.w}x${t.h} px (WCAG 2.2 24 px minimum ${t.meetsWcag22Min24px ? 'met' : 'NOT met'})`].join('\n');
}

function stepTitle(res, job) {
  const planned = (job.plan || []).find((p) => p.seq === res.seq);
  if (res.seq === 0) return 'First look (screen as it loaded)';
  if (planned) return planned.label;
  if (res.watch) return `Watch: ${res.watch.what}`;
  return { livescroll: 'Scrolling', inspect: 'Inspect', zoom: 'Zoom', observe: 'What is on screen', fullpage: 'Whole page' }[res.action] || res.action;
}

const navigates = (res) => ['goto', 'back', 'reset', 'device', 'render'].includes(res.action) || res.watch?.zero === 'navigation start';

function renderJob({ base, id, job, st, results, n, note, failure }) {
  const s = st.status;
  const f = (file, seq) => `${base}/f/${id}/out/${String(seq).padStart(4, '0')}/${file}`;
  const H = [];
  if (note) H.push(`<p><strong>${esc(note)}</strong></p>`);
  const state = !s ? (failure ? 'failed' : 'starting') : s.state;
  const where = `${browserName(job.opts.browser)}, ${job.opts.device} view`;
  H.push(`<p>Site: <a href="${esc(job.target)}">${esc(job.target)}</a> | browser: ${esc(where)} | status: <strong>${esc(state)}</strong>${s?.error ? ` (${esc(s.error)})` : ''}</p>`);
  if (failure) H.push(`<p>${esc(failure)}</p>`);
  if (!s && !failure) H.push('<p>The browser is still starting on GitHub Actions (usually 40-80 seconds). Nothing to show yet.</p>');

  let lastMap = null;
  for (const res of results) {
    const parts = [];
    if (!res.ok) parts.push(`<pre>This step failed: ${esc(res.error || 'unknown error')}</pre>`);
    if (res.watch) parts.push(`<pre>${esc(watchText(res.watch))}</pre>`);
    if (res.action === 'livescroll' && res.motion) parts.push(`<pre>${esc(scrollText(res))}</pre>`);
    if (res.inspect) parts.push(`<pre>${esc(inspectText(res.inspect))}</pre>`);
    if (res.horizontalOverflow) parts.push(`<p>Layout issue: the page is ${res.horizontalOverflow}px wider than the screen.</p>`);
    const imgs = (res.files || []).filter((x) => /\.(jpg|png)$/.test(x));
    const label = { 'filmstrip.jpg': 'filmstrip: the frames where the picture changed, with times', 'sheet.jpg': 'contact sheet of the scroll', 'shot.jpg': 'screenshot', 'marks.jpg': 'screenshot with element numbers', 'zoom.jpg': 'sharp close-up', 'element.jpg': 'the element at the same moment', 'full.jpg': 'whole page' };
    if (imgs.length) parts.push(`<p>Images (open to see them):</p><ul>${imgs.map((x) => `<li>${esc(label[x] || x)}: <a href="${f(x, res.seq)}">${f(x, res.seq)}</a></li>`).join('')}</ul>`);
    if (res.files?.includes('watch.json')) parts.push(`<p>All measured data: <a href="${f('watch.json', res.seq)}">${f('watch.json', res.seq)}</a></p>`);
    // Element numbers are only valid until the page reloads or navigates.
    if (res.elements?.length) lastMap = res;
    else if (navigates(res)) lastMap = null;
    H.push(`<h2>Step ${res.seq}: ${esc(stepTitle(res, job))}</h2>${parts.join('') || '<p>Done.</p>'}`);
  }

  const lastSeq = s?.lastSeq ?? -1;
  const pending = [...(job.plan || []).filter((p) => p.seq > lastSeq).map((p) => `Step ${p.seq}: ${p.label}`),
    ...(job.maxSeq > Math.max(lastSeq, (job.plan || []).length) ? [`${job.maxSeq - Math.max(lastSeq, (job.plan || []).length)} follow-up action(s)`] : [])];
  if (state === 'ended' || state === 'failed') {
    H.push(`<h2>Session closed</h2><p>The live browser has closed${s?.reason ? ` (${esc(s.reason)})` : ''}. The results above stay available. To look again, open
<a href="${base}/new/${esc(job.target)}">${base}/new/${esc(job.target)}</a>.</p>`);
  } else if (pending.length || !s) {
    const next = `${base}/j/${id}/${n + 1}`;
    H.push(`<h2>Still working</h2><p>${esc(pending.join('; ') || 'Starting the browser')}. Each step takes about 5-25 seconds.</p>
<p>Next check: <a href="${next}">${next}</a></p>`);
  }
  if (state === 'ready') {
    const next = (job.maxSeq || 0) + 1;
    const a = (verb, arg) => `${base}/a/${id}/${next}/${verb}${arg !== undefined ? '/' + arg : ''}`;
    const items = (lastMap?.elements || []).slice(0, 25).map((e) => `<li>${e.ref}. ${esc(e.role || e.tag)} "${esc((e.name || '').slice(0, 40))}"${e.covered ? ' (covered)' : ''}: <a href="${a('hover', e.ref)}">hover</a>, <a href="${a('tap', e.ref)}">tap</a>, <a href="${a('inspect', e.ref)}">inspect</a></li>`);
    H.push(`<h2>Ask the browser to do more</h2><p>Each link queues one action in the same live browser (it closes after ${IDLE_MINUTES} idle minutes) and shows the result:</p>
<ul><li><a href="${a('still', 8)}">watch 8 seconds without doing anything</a></li><li><a href="${a('scroll')}">scroll top to bottom again</a></li>
<li><a href="${a('load')}">reload as a first visit and record it</a></li><li><a href="${a('load4g')}">record the load on a phone-like 4G connection</a></li>
<li><a href="${a('reduced')}">record the load with reduced motion</a></li><li><a href="${a('fullpage')}">whole-page screenshot</a></li></ul>
${lastMap ? `<p>Elements on screen (numbers from step ${lastMap.seq}; after the page changes, refresh the numbers with <a href="${a('observe')}">observe</a>):</p><ul>${items.join('')}</ul>`
    : `<p>To act on a specific element (hover, tap, inspect, zoom), first get fresh element numbers: <a href="${a('observe')}">observe</a>${pending.length ? ' (or wait for the step that does this)' : ''}.</p>`}`);
  }
  H.push(aboutHtml());
  return H.join('\n');
}

// ------------------------------------------------------------------------------------------------ utils
async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function b64(text) {
  const bytes = new TextEncoder().encode(text);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
